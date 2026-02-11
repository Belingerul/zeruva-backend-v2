require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const nacl = require("tweetnacl");
const bs58 = require("bs58").default;
const { nanoid } = require("nanoid");
const { PublicKey, Keypair, Connection, SystemProgram, Transaction } = require("@solana/web3.js");
const { buildTransferTx, verifySolPayment } = require("./src/sol");
const { getSolUsdPrice, usdToLamports } = require("./src/pricing");
const { initDb, query } = require("./db");

const app = express();
app.set("trust proxy", 1);

// Basic hardening
// NOTE: This service hosts cross-origin static assets (/static/*.png) used by the frontend.
// Helmet defaults (CORP same-origin + strict CSP) can block those images in the browser.
app.use(
  helmet({
    // Allow other origins (frontend) to load images from /static
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // CSP is more appropriate on the frontend; disable here to avoid breaking assets.
    contentSecurityPolicy: false,
  })
);

// Global request rate limiting (coarse)
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// CORS: use explicit allow-list (no wildcard strings).
// Set FRONTEND_ORIGINS as comma-separated list (e.g. "https://app.example.com,https://staging.example.com")
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server or curl
  // Always allow localhost during dev
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (FRONTEND_ORIGINS.includes(origin)) return true;
  return false;
}

app.use(
  cors({
    origin: function (origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      // Do not hard-fail the request (this can break /static image loads).
      // Instead, deny CORS by omitting headers; browser fetches will be blocked by CORS,
      // but simple asset loads can still work.
      return cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));
app.use("/static", express.static(path.join(__dirname, "public")));

const ADMIN_WALLET = process.env.ADMIN_WALLET;
const DEV_WALLET_SECRET_KEY = process.env.DEV_WALLET_SECRET_KEY;
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || "";

// Claim cooldown (default: 24h)
const CLAIM_COOLDOWN_MS = Number(process.env.CLAIM_COOLDOWN_MS || 24 * 60 * 60 * 1000);
const ALIEN_COUNT = parseInt(process.env.ALIEN_COUNT || "60", 10);

// ===== Auth (Solana signature -> JWT) =====
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if ((process.env.NODE_ENV || "development") !== "production") {
    JWT_SECRET = crypto.randomBytes(32).toString("hex");
    console.warn(
      "⚠️  JWT_SECRET is not set. Generated a temporary dev JWT secret (tokens will reset on restart)."
    );
  } else {
    console.warn("⚠️  JWT_SECRET is not set. Auth will fail. Set JWT_SECRET in your environment.");
  }
}

// short-lived nonce store (in-memory). For multi-instance, move to Redis.
const nonces = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000;

function createNonce(wallet) {
  const nonce = nanoid(32);
  nonces.set(wallet, { nonce, exp: Date.now() + NONCE_TTL_MS });
  return nonce;
}

function getNonce(wallet) {
  const entry = nonces.get(wallet);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    nonces.delete(wallet);
    return null;
  }
  return entry.nonce;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing Bearer token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid/expired token" });
  }
}

// ======= Helper to build absolute image URLs =======
// NOTE: If PUBLIC_BASE_URL is misconfigured (e.g. includes "/api" or points at localhost),
// images will break. To be resilient, derive base URL from the request when possible.
function requestBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = req.get("host");
  const proto = req.protocol || "https";
  return `${proto}://${host}`;
}

const imgUrl = (req, id) => `${requestBaseUrl(req)}/static/${id}.png`;
const nothingUrl = (req) => `${requestBaseUrl(req)}/static/nothing.png`;

// ======= Game configuration (dollar-per-day model) =======

// Base weights now include a "Nothing" outcome: alien with 0 $/day
const BASE_WEIGHTS = {
  Nothing: 20,   // 20% weight -> 0$/day alien
  Common: 60,
  Rare:   25,
  Epic:   10,
  Legendary: 5,
};

// Egg modifiers still boost Epic / Legendary chances.
// "Nothing", Common, Rare stay unchanged by egg type (for now).
const EGG_MOD = {
  basic: { Epic: 0,  Legendary: 0 },
  rare:  { Epic: 10, Legendary: 5 },
  ultra: { Epic: 25, Legendary: 10 },
};

// Daily payout in “dollars per day” for each tier.
// This replaces the old percentage ROI (0.02–0.10).
const DAILY_REWARD = {
  Nothing:   0,  // $0 / day
  Common:    2,  // $2 / day
  Rare:      5,  // $5 / day
  Epic:      8,  // $8 / day
  Legendary: 10, // $10 / day (max)
};

// ======= Weighted random =======
function weightedPick(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [tier, w] of Object.entries(weights)) {
    if (r < w) return tier;
    r -= w;
  }
  return "Common";
}

// ======= Rate limiter =======
const spinBuckets = new Map();
const SPIN_WINDOW_MS = 10_000;
const SPINS_PER_WINDOW = 8;
function limitSpin(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = spinBuckets.get(ip) || { count: 0, ts: now };
  if (now - bucket.ts > SPIN_WINDOW_MS) { bucket.count = 0; bucket.ts = now; }
  bucket.count++;
  spinBuckets.set(ip, bucket);
  if (bucket.count > SPINS_PER_WINDOW)
    return res.status(429).json({ error: "Too many spins, slow down." });
  next();
}
const LEVEL_SLOTS = {
  1: 2,
  2: 4,
  3: 6,
};

// ======= Payments (Option A) =======
// Prices are denominated in USD; we quote SOL at purchase time via a public SOL/USD feed.
// USD_PER_SOL remains as a fallback constant for when the price feed is down.
const EGG_PRICE_USD = {
  basic: 20,
  rare: 40,
  ultra: 60,
};
const SHIP_PRICE_USD = {
  1: 30,
  2: 60,
  3: 120,
};

function lamportsToSol(lamports) {
  return Number(lamports) / 1e9;
}

function parseSecretKeyBytes(secret) {
  if (!secret) return null;
  const trimmed = String(secret).trim();
  if (!trimmed) return null;

  // JSON array of numbers
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) throw new Error("DEV_WALLET_SECRET_KEY JSON must be an array");
    return Uint8Array.from(arr);
  }

  // base58-encoded secretKey bytes
  return bs58.decode(trimmed);
}

let _devKeypair = null;
function getDevKeypair() {
  if (_devKeypair) return _devKeypair;
  if (!DEV_WALLET_SECRET_KEY) {
    throw new Error("Server misconfigured: DEV_WALLET_SECRET_KEY not set");
  }
  const bytes = parseSecretKeyBytes(DEV_WALLET_SECRET_KEY);
  if (!bytes || bytes.length < 32) {
    throw new Error("Server misconfigured: DEV_WALLET_SECRET_KEY invalid");
  }
  _devKeypair = Keypair.fromSecretKey(bytes);

  // Optional safety check: ensure it matches ADMIN_WALLET if provided.
  if (ADMIN_WALLET) {
    const expected = new PublicKey(ADMIN_WALLET).toBase58();
    const actual = _devKeypair.publicKey.toBase58();
    if (expected !== actual) {
      throw new Error(
        `DEV_WALLET_SECRET_KEY pubkey (${actual}) does not match ADMIN_WALLET (${expected})`
      );
    }
  }

  return _devKeypair;
}

async function sendSolPayout({ rpcUrl, toPubkey, lamports }) {
  const payer = getDevKeypair();
  const connection = new Connection(rpcUrl, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: payer.publicKey,
  });

  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(toPubkey),
      lamports: Math.floor(Number(lamports)),
    })
  );

  const sig = await connection.sendTransaction(tx, [payer], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });

  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

function eggColumn(eggType) {
  if (eggType === "basic") return "eggs_basic";
  if (eggType === "rare") return "eggs_rare";
  if (eggType === "ultra") return "eggs_ultra";
  return null;
}

// ======= Validate Solana address (basic check) =======
function isProbableSolanaAddress(address) {
  return (
    typeof address === "string" &&
    address.length >= 32 &&
    address.length <= 44
  );
}

// ======= Routes =======
const BASE_POINTS_PER_DAY = 1;

function calculateUnclaimedEarnings(lastClaimAt, totalRoiPerDay, now) {
  if (!lastClaimAt || totalRoiPerDay === 0) return 0;
  const lastClaim = new Date(lastClaimAt);
  const diffMs = now.getTime() - lastClaim.getTime();
  if (diffMs <= 0) return 0;
  const elapsedSeconds = diffMs / 1000;
  const earningsPerSecond = (totalRoiPerDay * BASE_POINTS_PER_DAY) / 86400;
  const earnings = elapsedSeconds * earningsPerSecond;
  return Math.round(earnings * 1000000) / 1000000;
}

async function calculateCurrentROI(wallet) {
  // IMPORTANT: Only count aliens assigned to slots that are actually available for the user's current ship_level.
  // Otherwise, old/stale assignments in higher slot indexes (e.g. from a previously-higher ship level)
  // will incorrectly inflate ROI and rewards.
  const userRes = await query(`SELECT ship_level FROM users WHERE wallet = $1`, [wallet]);
  const level = Number(userRes.rows[0]?.ship_level || 1);
  const maxSlots = LEVEL_SLOTS[level] || 2;

  const activeResult = await query(
    `SELECT a.roi
     FROM ship_slots s
     JOIN aliens a ON a.id = s.alien_fk
     WHERE s.wallet = $1 AND s.slot_index < $2`,
    [wallet, maxSlots]
  );

  let totalRoiPerDay = 0;
  for (const row of activeResult.rows) {
    totalRoiPerDay += Number(row.roi);
  }
  return totalRoiPerDay;
}

app.get("/api/rewards/:wallet", requireAuth, async (req, res) => {
  try {
    const { wallet } = req.params;
    if (!wallet) {
      return res.status(400).json({ error: "Missing wallet" });
    }
    if (!isProbableSolanaAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address" });
    }
    if (req.auth?.wallet !== wallet) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const now = new Date();

    let userResult = await query(
      `SELECT wallet, last_claim_at, total_claimed_points, pending_earnings
       FROM users
       WHERE wallet = $1`,
      [wallet]
    );

    let user = userResult.rows[0];

    if (!user) {
      const insertResult = await query(
        `INSERT INTO users (wallet, last_claim_at, total_claimed_points, pending_earnings)
         VALUES ($1, $2, 0, 0)
         RETURNING wallet, last_claim_at, total_claimed_points, pending_earnings`,
        [wallet, now]
      );
      user = insertResult.rows[0];
    }

    const totalRoiPerDay = await calculateCurrentROI(wallet);

    const unclaimedEarnings = calculateUnclaimedEarnings(
      user.last_claim_at,
      totalRoiPerDay,
      now
    );

    const totalPending = Number(user.pending_earnings || 0) + Number(unclaimedEarnings);

    const lastClaimAt = user.last_claim_at ? new Date(user.last_claim_at) : null;
    const nextClaimAt = lastClaimAt && CLAIM_COOLDOWN_MS > 0
      ? new Date(lastClaimAt.getTime() + CLAIM_COOLDOWN_MS)
      : null;

    return res.json({
      unclaimed_earnings: Number(unclaimedEarnings),
      pending_earnings: Number(user.pending_earnings || 0),
      total_claimed_points: Number(user.total_claimed_points || 0),
      last_claim_at: user.last_claim_at,
      next_claim_at: nextClaimAt ? nextClaimAt.toISOString() : null,
      total_roi_per_day: totalRoiPerDay,
      base_points_per_day: BASE_POINTS_PER_DAY,
    });
  } catch (e) {
    console.error("GET /api/rewards error", e);
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/claim-rewards", requireAuth, async (req, res) => {
  try {
    const { expected_earnings } = req.body || {};
    const wallet = req.auth?.wallet;
    if (!wallet) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!isProbableSolanaAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address" });
    }

    await query("BEGIN");

    try {
      const now = new Date();

      let userResult = await query(
        `SELECT wallet, last_claim_at, total_claimed_points, pending_earnings
         FROM users
         WHERE wallet = $1`,
        [wallet]
      );

      let user = userResult.rows[0];

      if (!user) {
        const insertResult = await query(
          `INSERT INTO users (wallet, last_claim_at, total_claimed_points, pending_earnings)
           VALUES ($1, $2, 0, 0)
           RETURNING wallet, last_claim_at, total_claimed_points, pending_earnings`,
          [wallet, now]
        );
        await query("COMMIT");
        user = insertResult.rows[0];
        return res.json({
          claimed: 0,
          total_claimed_points: 0,
          message: "First time claim, starting timer now.",
        });
      }

      // Enforce 24h claim cooldown (server-authoritative)
      if (user.last_claim_at && CLAIM_COOLDOWN_MS > 0) {
        const last = new Date(user.last_claim_at);
        const next = new Date(last.getTime() + CLAIM_COOLDOWN_MS);
        if (Date.now() < next.getTime()) {
          await query("ROLLBACK");
          return res.status(429).json({
            error: "Claim cooldown",
            next_claim_at: next.toISOString(),
            seconds_left: Math.ceil((next.getTime() - Date.now()) / 1000),
          });
        }
      }

      const totalRoiPerDay = await calculateCurrentROI(wallet);

      const newEarnings = calculateUnclaimedEarnings(
        user.last_claim_at,
        totalRoiPerDay,
        now
      );

      const pendingEarnings = Number(user.pending_earnings || 0);
      const totalToClaim = pendingEarnings + newEarnings;

      // Anti-cheat validation: client supplies expected_earnings and we compare.
      // NOTE: Real networks have latency and client/server clocks differ. Keep a sane tolerance.
      const CLAIM_TOLERANCE = Number(process.env.CLAIM_TOLERANCE || "0.05");

      if (expected_earnings !== undefined && expected_earnings !== null) {
        const expectedNum = Number(expected_earnings);
        const diff = Math.abs(totalToClaim - expectedNum);
        if (diff > CLAIM_TOLERANCE) {
          await query("ROLLBACK");
          return res.status(400).json({
            error: "Earnings mismatch",
            server_calculated: Number(totalToClaim.toFixed(6)),
            client_expected: Number(expectedNum.toFixed(6)),
            diff: Number(diff.toFixed(6)),
            tolerance: CLAIM_TOLERANCE,
          });
        }
      }

      let updateResult;
      if (totalToClaim <= 0) {
        updateResult = await query(
          `UPDATE users
           SET last_claim_at = $1
           WHERE wallet = $2
           RETURNING total_claimed_points`,
          [now, wallet]
        );
      } else {
        updateResult = await query(
          `UPDATE users
           SET total_claimed_points = COALESCE(total_claimed_points, 0) + $1,
               pending_earnings = 0,
               last_claim_at = $2
           WHERE wallet = $3
           RETURNING total_claimed_points`,
          [totalToClaim, now, wallet]
        );
      }

      await query("COMMIT");

      const totalClaimed = Number(updateResult.rows[0].total_claimed_points);

      return res.json({
        claimed: totalToClaim > 0 ? totalToClaim : 0,
        total_claimed_points: totalClaimed,
      });
    } catch (e) {
      await query("ROLLBACK").catch(() => {});
      throw e;
    }
  } catch (e) {
    console.error("POST /api/claim-rewards error", e);
    res.status(500).json({ error: e.message });
  }
});

// --- Claim payouts (server sends SOL from DEV wallet) ---
app.post("/api/claim-sol-intent", requireAuth, async (req, res) => {
  try {
    const { expected_earnings } = req.body || {};
    const wallet = req.auth?.wallet;
    if (!wallet) return res.status(401).json({ error: "Unauthorized" });

    const now = new Date();

    // ensure user exists
    await query(
      `INSERT INTO users (wallet)
       VALUES ($1)
       ON CONFLICT (wallet) DO NOTHING`,
      [wallet]
    );

    const userRes = await query(
      `SELECT last_claim_at, pending_earnings
       FROM users
       WHERE wallet=$1`,
      [wallet]
    );

    const user = userRes.rows[0];

    // Enforce 24h claim cooldown (server-authoritative)
    const lastClaimAt = user.last_claim_at ? new Date(user.last_claim_at) : null;
    if (lastClaimAt && CLAIM_COOLDOWN_MS > 0) {
      const nextClaimAt = new Date(lastClaimAt.getTime() + CLAIM_COOLDOWN_MS);
      if (Date.now() < nextClaimAt.getTime()) {
        const secondsLeft = Math.ceil((nextClaimAt.getTime() - Date.now()) / 1000);
        return res.status(429).json({
          error: "Claim cooldown",
          next_claim_at: nextClaimAt.toISOString(),
          seconds_left: secondsLeft,
        });
      }
    }

    const totalRoiPerDay = await calculateCurrentROI(wallet);
    const newEarnings = calculateUnclaimedEarnings(user.last_claim_at, totalRoiPerDay, now);
    const pendingEarnings = Number(user.pending_earnings || 0);
    const totalToClaimUsd = pendingEarnings + newEarnings;

    const CLAIM_TOLERANCE = Number(process.env.CLAIM_TOLERANCE || "0.05");
    if (expected_earnings !== undefined && expected_earnings !== null) {
      const expectedNum = Number(expected_earnings);
      const diff = Math.abs(totalToClaimUsd - expectedNum);
      if (diff > CLAIM_TOLERANCE) {
        return res.status(400).json({
          error: "Earnings mismatch",
          server_calculated: Number(totalToClaimUsd.toFixed(6)),
          client_expected: Number(expectedNum.toFixed(6)),
          diff: Number(diff.toFixed(6)),
          tolerance: CLAIM_TOLERANCE,
        });
      }
    }

    if (totalToClaimUsd <= 0) {
      return res.json({ ok: true, intentId: null, earningsUsd: 0, lamports: 0, amountSol: 0 });
    }

    const { solUsd, source } = await getSolUsdPrice();
    const lamports = usdToLamports({ usd: totalToClaimUsd, solUsd });
    const amountSol = lamportsToSol(lamports);

    const intentId = nanoid(24);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await query(
      `INSERT INTO claim_intents (id, wallet, earnings_usd, sol_usd, lamports, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [intentId, wallet, totalToClaimUsd, solUsd, String(lamports), expiresAt]
    );

    return res.json({
      ok: true,
      intentId,
      earningsUsd: Number(totalToClaimUsd.toFixed(6)),
      lamports,
      amountSol,
      solUsd,
      solUsdSource: source,
      expiresAt: expiresAt.toISOString(),
      to: wallet,
      from: ADMIN_WALLET || null,
    });
  } catch (e) {
    console.error("POST /api/claim-sol-intent error", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/confirm-claim-sol", requireAuth, async (req, res) => {
  try {
    const { intentId } = req.body || {};
    const wallet = req.auth?.wallet;
    if (!wallet || !intentId) return res.status(400).json({ error: "missing fields" });

    const intentRes = await query(
      `SELECT id, wallet, earnings_usd, lamports, expires_at, status, tx_signature
       FROM claim_intents
       WHERE id=$1`,
      [intentId]
    );

    if (intentRes.rowCount === 0) return res.status(400).json({ error: "invalid intent" });
    const intent = intentRes.rows[0];

    if (intent.wallet !== wallet) return res.status(403).json({ error: "intent wallet mismatch" });
    if (new Date(intent.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "intent expired" });

    if (intent.status === "paid") {
      return res.json({ ok: true, signature: intent.tx_signature, alreadyPaid: true });
    }

    const lamports = Number(intent.lamports);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      return res.status(400).json({ error: "invalid lamports" });
    }

    // Perform on-chain payout first, then finalize accounting in DB.
    const signature = await sendSolPayout({ rpcUrl: RPC_URL, toPubkey: wallet, lamports });

    await query("BEGIN");
    try {
      const now = new Date();

      // Mark intent paid (idempotency guard)
      await query(
        `UPDATE claim_intents
         SET status='paid', tx_signature=$1, paid_at=$2
         WHERE id=$3`,
        [signature, now, intentId]
      );

      // Advance claim state (claim-all)
      await query(
        `UPDATE users
         SET total_claimed_points = COALESCE(total_claimed_points, 0) + $1,
             pending_earnings = 0,
             last_claim_at = $2
         WHERE wallet = $3`,
        [Number(intent.earnings_usd), now, wallet]
      );

      await query("COMMIT");
    } catch (e) {
      await query("ROLLBACK").catch(() => {});
      throw e;
    }

    return res.json({ ok: true, signature });
  } catch (e) {
    console.error("POST /api/confirm-claim-sol error", e);
    res.status(500).json({ error: e.message });
  }
});


app.get("/api/health", (_, res) => {
  res.json({ ok: true, aliens: ALIEN_COUNT });
});

// Price helper (used by frontend to show SOL/USD quote without creating an intent)
app.get("/api/price/sol-usd", async (_req, res) => {
  try {
    const { solUsd, source } = await getSolUsdPrice();
    res.json({ ok: true, solUsd, source, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get a nonce to sign for login
app.post("/api/auth/nonce", (req, res) => {
  const { wallet } = req.body || {};
  if (!wallet || !isProbableSolanaAddress(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }
  const nonce = createNonce(wallet);
  const message = `Zeruva login\nWallet: ${wallet}\nNonce: ${nonce}`;
  res.json({ wallet, nonce, message, ttl_ms: NONCE_TTL_MS });
});

// Verify signature and issue JWT
app.post("/api/auth/verify", (req, res) => {
  if (!JWT_SECRET) return res.status(500).json({ error: "Server misconfigured (JWT_SECRET missing)" });

  const { wallet, signature, nonce } = req.body || {};
  if (!wallet || !signature || !nonce) {
    return res.status(400).json({ error: "Missing fields" });
  }
  if (!isProbableSolanaAddress(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  const expected = getNonce(wallet);
  if (!expected || expected !== nonce) {
    return res.status(400).json({ error: "Invalid/expired nonce" });
  }

  const message = `Zeruva login\nWallet: ${wallet}\nNonce: ${nonce}`;

  try {
    const pubkey = new PublicKey(wallet);
    const sigBytes = bs58.decode(signature);
    const ok = nacl.sign.detached.verify(
      Buffer.from(message),
      sigBytes,
      pubkey.toBytes()
    );

    if (!ok) return res.status(401).json({ error: "Signature verification failed" });

    // Consume nonce (one-time)
    nonces.delete(wallet);

    const token = jwt.sign({ wallet }, JWT_SECRET, { expiresIn: "12h" });
    return res.json({ token, wallet, expires_in: "12h" });
  } catch (e) {
    return res.status(400).json({ error: "Bad signature format" });
  }
});

app.get("/api/db-health", async (req, res) => {
  try {
    const result = await query("SELECT NOW() as now");
    res.json({ ok: true, now: result.rows[0].now });
  } catch (err) {
    console.error("DB health error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/get-random-aliens", (req, res) => {
  const count = Math.min(parseInt(req.query.count || "16", 10), ALIEN_COUNT);

  // Build list with request-derived base URL to avoid broken PUBLIC_BASE_URL.
  const pool = Array.from({ length: ALIEN_COUNT }, (_, i) => ({
    id: i + 1,
    image: imgUrl(req, i + 1),
  }));

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  res.json(pool.slice(0, count));
});
app.get("/api/aliens/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    const result = await query(
      `SELECT * FROM aliens WHERE wallet = $1 ORDER BY id DESC`,
      [wallet]
    );

    // IMPORTANT: Older DB rows may contain stale/incorrect absolute URLs.
    // Always re-derive image URLs from the request.
    const normalized = result.rows.map((row) => ({
      ...row,
      image: row.alien_id ? imgUrl(req, row.alien_id) : row.image,
    }));

    res.json(normalized);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/ship/:wallet", async (req, res) => {
  const { wallet } = req.params;

  try {
    const user = await query(
      `SELECT ship_level FROM users WHERE wallet = $1`,
      [wallet]
    );

    const level = user.rows[0]?.ship_level || 1;
    const maxSlots = LEVEL_SLOTS[level] || 2;

    const slots = await query(
      `SELECT s.slot_index, a.*
       FROM ship_slots s
       LEFT JOIN aliens a ON a.id = s.alien_fk
       WHERE s.wallet = $1
       ORDER BY slot_index`,
      [wallet]
    );

    const slotArray = [];
    for (let i = 0; i < maxSlots; i++) {
      const found = slots.rows.find((row) => row.slot_index === i);
      if (found && found.id) {
        slotArray.push({
          slot_index: i,
          alien: {
            id:       found.id,
            alien_id: found.alien_id,
            image:    found.alien_id ? imgUrl(req, found.alien_id) : found.image,
            tier:     found.tier,
            roi:      Number(found.roi),
          },
        });
      } else {
        slotArray.push({ slot_index: i, alien: null });
      }
    }

    res.json({
      level,
      maxSlots,
      slots: slotArray,
    });
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: e.message });
  }
});

// Legacy endpoint (kept for compatibility): only allow the authenticated user to upgrade their own ship.
// NOTE: Real upgrades should go through the paid flow + /confirm-buy-spaceship.
app.post("/api/upgrade-ship", requireAuth, async (req, res) => {
  const { newLevel } = req.body || {};
  const wallet = req.auth?.wallet;

  if (!wallet || !newLevel) return res.status(400).json({ error: "Missing fields" });

  try {
    const lvl = Number(newLevel);
    if (![1, 2, 3].includes(lvl)) return res.status(400).json({ error: "Invalid level" });

    // Prevent downgrades (downgrades can hide slots and cause ROI confusion)
    await query(
      `UPDATE users
       SET ship_level = GREATEST(COALESCE(ship_level, 1), $1)
       WHERE wallet = $2`,
      [lvl, wallet]
    );

    res.json({ ok: true, level: lvl });
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/assign-slot", requireAuth, async (req, res) => {
  const { slotIndex, alienDbId } = req.body || {};
  const wallet = req.auth?.wallet;

  if (!wallet || slotIndex == null || !alienDbId)
    return res.status(400).json({ error: "Missing fields" });

  try {
    await query("BEGIN");
    
    const now = new Date();
    const userResult = await query(
      `SELECT last_claim_at, total_claimed_points, pending_earnings
       FROM users
       WHERE wallet = $1`,
      [wallet]
    );
    
    let user = userResult.rows[0];
    if (!user) {
      await query(
        `INSERT INTO users (wallet, last_claim_at, total_claimed_points, pending_earnings)
         VALUES ($1, $2, 0, 0)
         ON CONFLICT (wallet) DO NOTHING
         RETURNING last_claim_at, total_claimed_points, pending_earnings`,
        [wallet, now]
      );
      const newUserResult = await query(
        `SELECT last_claim_at, total_claimed_points, pending_earnings
         FROM users WHERE wallet = $1`,
        [wallet]
      );
      user = newUserResult.rows[0];
    }

    const oldROI = await calculateCurrentROI(wallet);

    let earnings = 0;
    if (oldROI > 0 && user.last_claim_at) {
      earnings = calculateUnclaimedEarnings(user.last_claim_at, oldROI, now);
      if (earnings < 0) earnings = 0;
    }

    // CRITICAL: Always advance last_claim_at when ROI changes.
    // Otherwise, after an assign/unassign, /api/rewards will accrue with the NEW ROI
    // starting from an OLD last_claim_at → "ghost" earnings.
    await query(
      `UPDATE users
       SET pending_earnings = COALESCE(pending_earnings, 0) + $1,
           last_claim_at = $2
       WHERE wallet = $3`,
      [earnings, now, wallet]
    );

    await query(
      `INSERT INTO ship_slots (wallet, slot_index, alien_fk)
       VALUES ($1, $2, $3)
       ON CONFLICT (wallet, slot_index)
       DO UPDATE SET alien_fk = $3`,
      [wallet, slotIndex, alienDbId]
    );

    await query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await query("ROLLBACK").catch(() => {});
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/unassign-slot", requireAuth, async (req, res) => {
  const { alienDbId } = req.body || {};
  const wallet = req.auth?.wallet;

  if (!wallet || !alienDbId)
    return res.status(400).json({ error: "Missing fields" });

  try {
    await query("BEGIN");

    const now = new Date();
    const userResult = await query(
      `SELECT last_claim_at, total_claimed_points, pending_earnings
       FROM users
       WHERE wallet = $1`,
      [wallet]
    );
    
    let user = userResult.rows[0];
    if (!user) {
      await query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }

    const oldROI = await calculateCurrentROI(wallet);

    let earnings = 0;
    if (oldROI > 0 && user.last_claim_at) {
      earnings = calculateUnclaimedEarnings(user.last_claim_at, oldROI, now);
      if (earnings < 0) earnings = 0;
    }

    // CRITICAL: Always advance last_claim_at when ROI changes.
    // Otherwise, after an assign/unassign, /api/rewards will accrue with the NEW ROI
    // starting from an OLD last_claim_at → "ghost" earnings.
    await query(
      `UPDATE users
       SET pending_earnings = COALESCE(pending_earnings, 0) + $1,
           last_claim_at = $2
       WHERE wallet = $3`,
      [earnings, now, wallet]
    );

    const result = await query(
      `DELETE FROM ship_slots
       WHERE wallet = $1 AND alien_fk = $2
       RETURNING id`,
      [wallet, alienDbId]
    );

    if (result.rowCount === 0) {
      await query("ROLLBACK");
      return res.status(404).json({ error: "No such slot assignment" });
    }

    await query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await query("ROLLBACK").catch(() => {});
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/register", requireAuth, async (req, res) => {
  const wallet = req.auth?.wallet;
  if (!wallet) return res.status(401).json({ error: "Unauthorized" });

  try {
    await query(
      `INSERT INTO users (wallet)
       VALUES ($1)
       ON CONFLICT (wallet) DO NOTHING`,
      [wallet]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/spin", requireAuth, limitSpin, async (req, res) => {
  const { eggType = "basic" } = req.body || {};
  const wallet = req.auth?.wallet;

  if (!wallet) return res.status(401).json({ error: "Unauthorized" });

  // Require an egg credit for the selected eggType
  const col = eggColumn(eggType);
  if (!col) return res.status(400).json({ error: "Invalid eggType" });

  const credits = await query(`SELECT ${col} FROM users WHERE wallet = $1`, [
    wallet,
  ]);
  const count = Number(credits.rows[0]?.[col] ?? 0);
  if (count <= 0) {
    return res.status(402).json({
      error: "No egg credits",
      eggType,
      message: "Buy an egg first.",
    });
  }

  // Decrement credit immediately (best-effort). If we crash mid-spin, user lost 1 credit;
  // in production we'd wrap purchase/spin in a stronger transaction model.
  await query(`UPDATE users SET ${col} = GREATEST(${col} - 1, 0) WHERE wallet = $1`, [
    wallet,
  ]);

  // Apply egg modifiers
  const mod = EGG_MOD[eggType] || EGG_MOD.basic;

  // Include "Nothing" in the roulette
  const weights = {
    Nothing:   BASE_WEIGHTS.Nothing,
    Common:    BASE_WEIGHTS.Common,
    Rare:      BASE_WEIGHTS.Rare,
    Epic:      BASE_WEIGHTS.Epic + (mod.Epic || 0),
    Legendary: BASE_WEIGHTS.Legendary + (mod.Legendary || 0),
  };

  const tier = weightedPick(weights);
  const roi = DAILY_REWARD[tier] ?? 0; // dollars per day

  const basePayload = {
    spinId: nanoid(),
    wallet,
    tier,
    roi,
    timestamp: Date.now(),
  };

  // Special case: Nothing → show image, but DO NOT save to DB
  if (tier === "Nothing") {
    const alien = { id: null, image: nothingUrl(req) };

    const payload = { ...basePayload, alien };

    const signature = crypto
      .createHmac("sha256", process.env.SERVER_HMAC_SECRET)
      .update(JSON.stringify(payload))
      .digest("hex");

    return res.json({
      ...payload,
      db_id: null, // no DB row
      serverSignature: signature,
    });
  }

  // Normal case: real alien stored in DB and appears in hangar
  const randId = 1 + Math.floor(Math.random() * ALIEN_COUNT);
  const alien = { id: randId, image: imgUrl(req, randId) };

  const payload = { ...basePayload, alien };

  const signature = crypto
    .createHmac("sha256", process.env.SERVER_HMAC_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex");

  const result = await query(
    `INSERT INTO aliens (wallet, alien_id, image, tier, roi)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [wallet, randId, alien.image, tier, roi]
  );

  res.json({
    ...payload,
    db_id: result.rows[0].id,
    serverSignature: signature,
  });
});



// --- Payments API (devnet) ---
// Prepare a SOL transfer tx for an egg purchase
app.post("/api/buy-egg", requireAuth, async (req, res) => {
  try {
    const { eggType = "basic" } = req.body || {};
    const wallet = req.auth?.wallet;
    if (!wallet) return res.status(400).json({ error: "missing wallet" });

    const priceUsd = EGG_PRICE_USD[eggType];
    if (!priceUsd) return res.status(400).json({ error: "invalid eggType" });

    const { solUsd, source } = await getSolUsdPrice();
    const lamports = usdToLamports({ usd: priceUsd, solUsd });
    const amountSol = lamportsToSol(lamports);

    // Save a short-lived intent so confirmation uses the exact quoted amount.
    const intentId = nanoid(24);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      `INSERT INTO payment_intents (id, wallet, kind, price_usd, sol_usd, lamports, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [intentId, wallet, `buy_egg:${eggType}`, priceUsd, solUsd, String(lamports), expiresAt]
    );

    const admin = new PublicKey(ADMIN_WALLET);
    const tx = await buildTransferTx({
      rpcUrl: RPC_URL,
      fromPubkey: wallet,
      toPubkey: admin,
      lamports,
    });

    const serialized = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    ).toString("base64");

    res.json({
      serialized,
      intentId,
      amountSol,
      lamports,
      solUsd,
      solUsdSource: source,
      admin: admin.toBase58(),
      eggType,
      priceUsd,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Confirm a signed payment and credit the egg
app.post("/api/confirm-buy-egg", requireAuth, async (req, res) => {
  try {
    const { eggType = "basic", signature, intentId } = req.body || {};
    const wallet = req.auth?.wallet;
    if (!wallet || !signature || !intentId)
      return res.status(400).json({ error: "missing fields" });

    const priceUsd = EGG_PRICE_USD[eggType];
    if (!priceUsd) return res.status(400).json({ error: "invalid eggType" });

    // Load intent quoted at tx-build time
    const intent = await query(
      `SELECT id, wallet, kind, price_usd, sol_usd, lamports, expires_at
       FROM payment_intents
       WHERE id = $1`,
      [intentId]
    );
    if (intent.rowCount === 0) return res.status(400).json({ error: "invalid intent" });

    const row = intent.rows[0];
    if (row.wallet !== wallet) return res.status(403).json({ error: "intent wallet mismatch" });
    if (row.kind !== `buy_egg:${eggType}`) return res.status(400).json({ error: "intent kind mismatch" });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "intent expired" });

    const minLamports = Number(row.lamports);
    const amountSol = lamportsToSol(minLamports);

    // Prevent replay
    const already = await query(`SELECT signature FROM payments WHERE signature=$1`, [signature]);
    if (already.rowCount > 0) {
      return res.status(409).json({ error: "payment already processed" });
    }

    const verify = await verifySolPayment({
      rpcUrl: RPC_URL,
      signature,
      expectedFrom: wallet,
      expectedTo: ADMIN_WALLET,
      minLamports,
    });

    if (!verify.ok) {
      return res.status(400).json({ error: "invalid payment", detail: verify });
    }

    // Ensure user exists
    await query(
      `INSERT INTO users (wallet)
       VALUES ($1)
       ON CONFLICT (wallet) DO NOTHING`,
      [wallet],
    );

    const col = eggColumn(eggType);
    if (!col) return res.status(400).json({ error: "invalid eggType" });

    await query("BEGIN");
    try {
      await query(
        `INSERT INTO payments (signature, wallet, kind, amount_sol, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          signature,
          wallet,
          `buy_egg:${eggType}`,
          amountSol,
          JSON.stringify({ eggType, intentId, solUsd: Number(row.sol_usd), priceUsd: Number(row.price_usd) }),
        ],
      );

      // Intent is single-use
      await query(`DELETE FROM payment_intents WHERE id=$1`, [intentId]);

      await query(
        `UPDATE users SET ${col} = COALESCE(${col}, 0) + 1 WHERE wallet = $1`,
        [wallet],
      );

      await query("COMMIT");
    } catch (e) {
      await query("ROLLBACK");
      throw e;
    }

    res.json({ ok: true, eggType, credited: 1, signature, amountSol });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Prepare a SOL transfer tx for a ship purchase
app.post("/api/buy-spaceship", requireAuth, async (req, res) => {
  try {
    const { level } = req.body || {};
    const wallet = req.auth?.wallet;
    if (!wallet || !level)
      return res.status(400).json({ error: "missing fields" });

    const priceUsd = SHIP_PRICE_USD[String(level)];
    if (!priceUsd) return res.status(400).json({ error: "invalid level" });

    const { solUsd, source } = await getSolUsdPrice();
    const lamports = usdToLamports({ usd: priceUsd, solUsd });
    const amountSol = lamportsToSol(lamports);

    const intentId = nanoid(24);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      `INSERT INTO payment_intents (id, wallet, kind, price_usd, sol_usd, lamports, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [intentId, wallet, `buy_ship:${level}`, priceUsd, solUsd, String(lamports), expiresAt]
    );

    const admin = new PublicKey(ADMIN_WALLET);
    const tx = await buildTransferTx({
      rpcUrl: RPC_URL,
      fromPubkey: wallet,
      toPubkey: admin,
      lamports,
    });

    const serialized = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    ).toString("base64");

    res.json({
      serialized,
      intentId,
      amountSol,
      lamports,
      solUsd,
      solUsdSource: source,
      admin: admin.toBase58(),
      level,
      priceUsd,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Confirm ship payment and set ship_level
app.post("/api/confirm-buy-spaceship", requireAuth, async (req, res) => {
  try {
    const { level, signature, intentId } = req.body || {};
    const wallet = req.auth?.wallet;
    if (!wallet || !level || !signature || !intentId)
      return res.status(400).json({ error: "missing fields" });

    const priceUsd = SHIP_PRICE_USD[String(level)];
    if (!priceUsd) return res.status(400).json({ error: "invalid level" });

    const intent = await query(
      `SELECT id, wallet, kind, price_usd, sol_usd, lamports, expires_at
       FROM payment_intents
       WHERE id = $1`,
      [intentId]
    );
    if (intent.rowCount === 0) return res.status(400).json({ error: "invalid intent" });

    const row = intent.rows[0];
    if (row.wallet !== wallet) return res.status(403).json({ error: "intent wallet mismatch" });
    if (row.kind !== `buy_ship:${level}`) return res.status(400).json({ error: "intent kind mismatch" });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "intent expired" });

    const minLamports = Number(row.lamports);
    const amountSol = lamportsToSol(minLamports);

    const already = await query(`SELECT signature FROM payments WHERE signature=$1`, [signature]);
    if (already.rowCount > 0) {
      return res.status(409).json({ error: "payment already processed" });
    }

    const verify = await verifySolPayment({
      rpcUrl: RPC_URL,
      signature,
      expectedFrom: wallet,
      expectedTo: ADMIN_WALLET,
      minLamports,
    });

    if (!verify.ok) {
      return res.status(400).json({ error: "invalid payment", detail: verify });
    }

    await query(
      `INSERT INTO users (wallet)
       VALUES ($1)
       ON CONFLICT (wallet) DO NOTHING`,
      [wallet],
    );

    await query("BEGIN");
    try {
      await query(
        `INSERT INTO payments (signature, wallet, kind, amount_sol, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          signature,
          wallet,
          `buy_ship:${level}`,
          amountSol,
          JSON.stringify({ level: Number(level), intentId, solUsd: Number(row.sol_usd), priceUsd: Number(row.price_usd) }),
        ],
      );

      await query(`DELETE FROM payment_intents WHERE id=$1`, [intentId]);

      await query(
        `UPDATE users SET ship_level = GREATEST(COALESCE(ship_level, 1), $1) WHERE wallet = $2`,
        [Number(level), wallet],
      );

      await query("COMMIT");
    } catch (e) {
      await query("ROLLBACK");
      throw e;
    }

    res.json({ ok: true, level: Number(level), signature });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ Zeruva API running on ${PORT}`));
  })
  .catch((err) => {
    console.error("❌ Failed to initialize DB", err);
    process.exit(1);
  });
