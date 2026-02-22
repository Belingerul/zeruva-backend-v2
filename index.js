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

// Targeted rate limits for sensitive routes
const authNonceLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const authVerifyLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const expeditionStartLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const upgradeWithItemsLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const geEnterLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

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
// Allow frontend to load images through Next.js /api rewrite (tunnel-friendly)
app.use("/api/static", express.static(path.join(__dirname, "public")));

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

// short-lived nonce store.
// IMPORTANT: Railway can run multiple instances; in-memory nonces will randomly fail.
// We keep an in-memory cache, but the source of truth is the DB table `auth_nonces`.
const nonces = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000;

async function createNonce(wallet) {
  const nonce = nanoid(32);
  const expAt = new Date(Date.now() + NONCE_TTL_MS);

  // cache (best-effort)
  nonces.set(wallet, { nonce, exp: expAt.getTime() });

  // persist (authoritative)
  await query(
    `INSERT INTO auth_nonces (wallet, nonce, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (wallet)
     DO UPDATE SET nonce = EXCLUDED.nonce, expires_at = EXCLUDED.expires_at`,
    [wallet, nonce, expAt]
  );

  return nonce;
}

async function getNonce(wallet) {
  const cached = nonces.get(wallet);
  if (cached) {
    if (Date.now() <= cached.exp) return cached.nonce;
    nonces.delete(wallet);
  }

  const r = await query(
    `SELECT nonce, expires_at
     FROM auth_nonces
     WHERE wallet=$1`,
    [wallet]
  );

  if (r.rowCount === 0) return null;

  const { nonce, expires_at } = r.rows[0];
  if (!expires_at || Date.now() > new Date(expires_at).getTime()) {
    await query(`DELETE FROM auth_nonces WHERE wallet=$1`, [wallet]);
    return null;
  }

  // refresh cache
  nonces.set(wallet, { nonce, exp: new Date(expires_at).getTime() });
  return nonce;
}

function requireAuth(req, res, next) {
  // Dev convenience: allow "guest" wallets for local testing without Phantom/signatures.
  // Enable explicitly: DEV_GUEST_AUTH=1
  if (process.env.DEV_GUEST_AUTH === "1") {
    const devWallet =
      req.headers["x-dev-wallet"] ||
      req.query.wallet ||
      req.body?.wallet;

    if (typeof devWallet === "string" && devWallet.trim()) {
      req.auth = { wallet: devWallet.trim(), dev: true };
      return next();
    }
  }

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

async function calculateAssignedROI(wallet) {
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

async function settleExpiredExpedition(wallet, now) {
  // If an expedition expired while the user was offline, settle earnings up to ends_at,
  // then turn expedition off. Also grant loot once per expedition.
  const uRes = await query(
    `SELECT expedition_active, expedition_ends_at, expedition_planet, expedition_rewarded_at,
            last_accrual_at, last_claim_at, pending_earnings
     FROM users WHERE wallet=$1`,
    [wallet]
  );
  if (uRes.rowCount === 0) return;
  const u = uRes.rows[0];
  if (!u.expedition_active || !u.expedition_ends_at) return;

  const endsAt = new Date(u.expedition_ends_at);
  if (now.getTime() <= endsAt.getTime()) return;

  const planetKey = u.expedition_planet || "planet-1";

  const roi = await calculateAssignedROI(wallet);
  const accrualBase = u.last_accrual_at || u.last_claim_at;
  const earned = calculateUnclaimedEarnings(accrualBase, roi, endsAt);


  await query(
    `UPDATE users
     SET pending_earnings = COALESCE(pending_earnings, 0) + $1,
         expedition_active = FALSE,
         expedition_ends_at = NULL,
         expedition_started_at = NULL,
         expedition_planet = NULL,
         expedition_rewarded_at = $4,
         last_accrual_at = $2
     WHERE wallet=$3`,
    [earned, endsAt, wallet, endsAt]
  );
}

async function calculateCurrentROI(wallet) {
  // EARNINGS RULE: Only earn while on expedition, and only with assigned aliens.
  const uRes = await query(
    `SELECT expedition_active, expedition_ends_at
     FROM users WHERE wallet=$1`,
    [wallet]
  );
  const u = uRes.rows[0];
  const active = !!u?.expedition_active;
  const endsAt = u?.expedition_ends_at ? new Date(u.expedition_ends_at) : null;

  if (!active) return 0;
  if (endsAt && Date.now() > endsAt.getTime()) return 0;

  const planetKey = u?.expedition_planet || "planet-1";
  const mult = getPlanet(planetKey)?.roiMult || 1.0;
  const base = await calculateAssignedROI(wallet);
  return base * mult;
}

app.get("/api/planets", (_req, res) => {
  res.json({ ok: true, planets: PLANETS });
});



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
      `SELECT wallet, last_claim_at, last_accrual_at, expedition_active, expedition_started_at, expedition_ends_at, expedition_planet, total_claimed_points, pending_earnings
       FROM users
       WHERE wallet = $1`,
      [wallet]
    );

    let user = userResult.rows[0];

    if (!user) {
      const insertResult = await query(
        `INSERT INTO users (wallet, last_claim_at, last_accrual_at, expedition_active, total_claimed_points, pending_earnings)
         VALUES ($1, $2, $2, FALSE, 0, 0)
         RETURNING wallet, last_claim_at, last_accrual_at, expedition_active, expedition_started_at, expedition_ends_at, expedition_planet, total_claimed_points, pending_earnings`,
        [wallet, now]
      );
      user = insertResult.rows[0];
    }

    // Settle expeditions that may have expired while user was offline
    await settleExpiredExpedition(wallet, now);

    // IMPORTANT: settleExpiredExpedition can UPDATE pending_earnings / last_accrual_at / expedition flags.
    // Reload user so the response reflects the latest authoritative state.
    userResult = await query(
      `SELECT wallet, last_claim_at, last_accrual_at, expedition_active, expedition_started_at, expedition_ends_at, expedition_planet, total_claimed_points, pending_earnings
       FROM users
       WHERE wallet = $1`,
      [wallet]
    );
    user = userResult.rows[0] || user;

    const totalRoiPerDay = await calculateCurrentROI(wallet);

    const accrualBase = user.last_accrual_at || user.last_claim_at;

    const unclaimedEarnings = calculateUnclaimedEarnings(
      accrualBase,
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
      last_accrual_at: user.last_accrual_at,
      next_claim_at: nextClaimAt ? nextClaimAt.toISOString() : null,
      expedition_active: !!user.expedition_active,
      expedition_started_at: user.expedition_started_at,
      expedition_ends_at: user.expedition_ends_at,
      expedition_planet: user.expedition_planet,
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
        `SELECT wallet, last_claim_at, last_accrual_at, total_claimed_points, pending_earnings
         FROM users
         WHERE wallet = $1`,
        [wallet]
      );

      let user = userResult.rows[0];

      if (!user) {
        const insertResult = await query(
          `INSERT INTO users (wallet, last_claim_at, last_accrual_at, total_claimed_points, pending_earnings)
           VALUES ($1, $2, $2, 0, 0)
           RETURNING wallet, last_claim_at, last_accrual_at, total_claimed_points, pending_earnings`,
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

      const accrualBase = user.last_accrual_at || user.last_claim_at;
      const newEarnings = calculateUnclaimedEarnings(
        accrualBase,
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
      `SELECT last_claim_at, last_accrual_at, pending_earnings
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
    const accrualBase = user.last_accrual_at || user.last_claim_at;
    const newEarnings = calculateUnclaimedEarnings(accrualBase, totalRoiPerDay, now);
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
             last_claim_at = $2,
             last_accrual_at = $2
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
app.post("/api/auth/nonce", authNonceLimiter, async (req, res) => {
  try {
    const { wallet } = req.body || {};
    if (!wallet || !isProbableSolanaAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet" });
    }
    const nonce = await createNonce(wallet);
    const message = `Zeruva login\nWallet: ${wallet}\nNonce: ${nonce}`;
    return res.json({ wallet, nonce, message, ttl_ms: NONCE_TTL_MS });
  } catch (e) {
    console.error("POST /api/auth/nonce error", e);
    return res.status(500).json({ error: "Failed to create nonce" });
  }
});

// Verify signature and issue JWT
app.post("/api/auth/verify", authVerifyLimiter, async (req, res) => {
  if (!JWT_SECRET) return res.status(500).json({ error: "Server misconfigured (JWT_SECRET missing)" });

  const { wallet, signature, nonce } = req.body || {};
  if (!wallet || !signature || !nonce) {
    return res.status(400).json({ error: "Missing fields" });
  }
  if (!isProbableSolanaAddress(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  const expected = await getNonce(wallet);
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
    await query(`DELETE FROM auth_nonces WHERE wallet=$1`, [wallet]);

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
      `SELECT last_claim_at, last_accrual_at, expedition_active, expedition_ends_at, total_claimed_points, pending_earnings
       FROM users
       WHERE wallet = $1`,
      [wallet]
    );
    
    let user = userResult.rows[0];

    // Lock assignments while on expedition
    if (user?.expedition_active && user?.expedition_ends_at && new Date(user.expedition_ends_at).getTime() > Date.now()) {
      await query("ROLLBACK");
      return res.status(409).json({ error: "Cannot change assignments during expedition" });
    }
    if (!user) {
      await query(
        `INSERT INTO users (wallet, last_claim_at, last_accrual_at, total_claimed_points, pending_earnings)
         VALUES ($1, $2, $2, 0, 0)
         ON CONFLICT (wallet) DO NOTHING
         RETURNING last_claim_at, last_accrual_at, total_claimed_points, pending_earnings`,
        [wallet, now]
      );
      const newUserResult = await query(
        `SELECT last_claim_at, last_accrual_at, total_claimed_points, pending_earnings
         FROM users WHERE wallet = $1`,
        [wallet]
      );
      user = newUserResult.rows[0];
    }

    const oldROI = await calculateCurrentROI(wallet);

    let earnings = 0;
    const accrualBase = user.last_accrual_at || user.last_claim_at;
    if (oldROI > 0 && accrualBase) {
      earnings = calculateUnclaimedEarnings(accrualBase, oldROI, now);
      if (earnings < 0) earnings = 0;
    }

    // IMPORTANT: ROI changes should NOT reset claim cooldown.
    // We advance last_accrual_at (earnings baseline) while keeping last_claim_at intact.
    await query(
      `UPDATE users
       SET pending_earnings = COALESCE(pending_earnings, 0) + $1,
           last_accrual_at = $2
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
      `SELECT last_claim_at, last_accrual_at, expedition_active, expedition_ends_at, total_claimed_points, pending_earnings
       FROM users
       WHERE wallet = $1`,
      [wallet]
    );
    
    let user = userResult.rows[0];
    if (!user) {
      await query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }

    // Lock assignments while on expedition
    if (user?.expedition_active && user?.expedition_ends_at && new Date(user.expedition_ends_at).getTime() > Date.now()) {
      await query("ROLLBACK");
      return res.status(409).json({ error: "Cannot change assignments during expedition" });
    }

    const oldROI = await calculateCurrentROI(wallet);

    let earnings = 0;
    const accrualBase = user.last_accrual_at || user.last_claim_at;
    if (oldROI > 0 && accrualBase) {
      earnings = calculateUnclaimedEarnings(accrualBase, oldROI, now);
      if (earnings < 0) earnings = 0;
    }

    // IMPORTANT: ROI changes should NOT reset claim cooldown.
    // We advance last_accrual_at (earnings baseline) while keeping last_claim_at intact.
    await query(
      `UPDATE users
       SET pending_earnings = COALESCE(pending_earnings, 0) + $1,
           last_accrual_at = $2
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

// ===== Expeditions =====
const EXPEDITION_DURATION_MS = 6 * 60 * 60 * 1000;

const PLANETS = [
  { key: "planet-1", name: "Astra", roiMult: 1.0, loot: { mat_common: 1.0, mat_rare: 0.15, mat_epic: 0.03 } },
  { key: "planet-2", name: "Vulcan", roiMult: 1.25, loot: { mat_common: 1.0, mat_rare: 0.22, mat_epic: 0.05 } },
  { key: "planet-3", name: "Nyx", roiMult: 1.5, loot: { mat_common: 1.0, mat_rare: 0.30, mat_epic: 0.08 } },
];

function getPlanet(planetKey) {
  return PLANETS.find((p) => p.key === planetKey) || PLANETS[0];
}


app.get("/api/expedition/status", requireAuth, async (req, res) => {
  try {
    const wallet = req.auth?.wallet;
    if (!wallet) return res.status(401).json({ error: "Unauthorized" });

    const now = new Date();
    await settleExpiredExpedition(wallet, now);

    const r = await query(
      `SELECT expedition_active, expedition_started_at, expedition_ends_at, expedition_planet
       FROM users WHERE wallet=$1`,
      [wallet]
    );

    const u = r.rows[0] || {};
    return res.json({
      ok: true,
      server_ts: now.toISOString(),
      expedition_active: !!u.expedition_active,
      expedition_started_at: u.expedition_started_at,
      expedition_ends_at: u.expedition_ends_at,
      expedition_planet: u.expedition_planet,
    });
  } catch (e) {
    console.error("GET /api/expedition/status error", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/expedition/start", expeditionStartLimiter, requireAuth, async (req, res) => {
  try {
    const wallet = req.auth?.wallet;
    if (!wallet) return res.status(401).json({ error: "Unauthorized" });

    const requestedPlanet = String(req.body?.planet || "planet-1");
    const planet = getPlanet(requestedPlanet)?.key || "planet-1";
    const now = new Date();

    await query("BEGIN");
    try {
      // Ensure user exists
      await query(
        `INSERT INTO users (wallet)
         VALUES ($1)
         ON CONFLICT (wallet) DO NOTHING`,
        [wallet]
      );

      const uRes = await query(
        `SELECT expedition_active, expedition_ends_at, last_accrual_at, last_claim_at, pending_earnings
         FROM users WHERE wallet=$1`,
        [wallet]
      );
      const u = uRes.rows[0];

      if (u?.expedition_active && u?.expedition_ends_at && new Date(u.expedition_ends_at).getTime() > Date.now()) {
        await query("ROLLBACK");
        return res.status(409).json({
          error: "Expedition already active",
          expedition_ends_at: u.expedition_ends_at,
        });
      }

      // settle any expired expedition first
      await settleExpiredExpedition(wallet, now);

      // Accrue earnings up to now using the OLD rate (likely 0 if not on expedition)
      const oldROI = await calculateCurrentROI(wallet);
      const accrualBase = u?.last_accrual_at || u?.last_claim_at;
      const earned = calculateUnclaimedEarnings(accrualBase, oldROI, now);

      const endsAt = new Date(now.getTime() + EXPEDITION_DURATION_MS);

      await query(
        `UPDATE users
         SET pending_earnings = COALESCE(pending_earnings, 0) + $1,
             expedition_active = TRUE,
             expedition_started_at = $2,
             expedition_ends_at = $3,
             expedition_planet = $4,
             last_accrual_at = $2
         WHERE wallet=$5`,
        [earned, now, endsAt, planet, wallet]
      );

      await query("COMMIT");
      return res.json({ ok: true, server_ts: now.toISOString(), expedition_active: true, expedition_started_at: now.toISOString(), expedition_ends_at: endsAt.toISOString(), expedition_planet: planet });
    } catch (e) {
      await query("ROLLBACK").catch(() => {});
      throw e;
    }
  } catch (e) {
    console.error("POST /api/expedition/start error", e);
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

// ===== Great Expedition (v2) API =====
const GE_SHIPS = 15;
const GE_ADMIN_KEY = process.env.GE_ADMIN_KEY || "";
const GE_TREASURY_WALLET = process.env.GE_TREASURY_WALLET || ADMIN_WALLET;

const GE_GAME_MODES = ["roulette", "elimination", "race"]; // rotate per round
function pickGameMode(nextRoundId) {
  // deterministic rotation (shared across all clients)
  return GE_GAME_MODES[(Number(nextRoundId || 0) - 1) % GE_GAME_MODES.length] || "roulette";
}

function genUniqueAlienIds(n) {
  const poolSize = Math.max(n, Number(process.env.ALIEN_COUNT || 60));
  // Create [1..poolSize] and do a partial Fisher-Yates shuffle for first n.
  const arr = Array.from({ length: poolSize }, (_, i) => i + 1);
  for (let i = 0; i < n; i++) {
    const j = i + crypto.randomInt(0, poolSize - i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, n);
}


// Tokenomics (recommended defaults)
const GE_ENTRY_PRICE_SOL = Number(process.env.GE_ENTRY_PRICE_SOL || 0.1); // min 0.1 SOL per entry
// Payout split (bps)
const GE_WINNER_BPS = Number(process.env.GE_WINNER_BPS || 7000);
const GE_PARTICIPATION_BPS = Number(process.env.GE_PARTICIPATION_BPS || 2500);
const GE_TREASURY_BPS = Number(process.env.GE_TREASURY_BPS || 500);

function requireAdmin(req, res, next) {
  if (!GE_ADMIN_KEY) return res.status(500).json({ error: "Server misconfigured (GE_ADMIN_KEY missing)" });
  const k = req.headers["x-admin-key"];
  if (k !== GE_ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  return next();
}

async function getCurrentRound() {
  // Include 'settled' so the frontend can see the result and animate.
  const r = await query(
    `SELECT * FROM ge_rounds WHERE status IN ('filling','running','settled') ORDER BY id DESC LIMIT 1`
  );
  return r.rows[0] || null;
}

async function getRoundStats(roundId) {
  const totals = await query(
    `SELECT ship_index, COALESCE(SUM(qty),0) AS qty
     FROM ge_entries WHERE round_id=$1
     GROUP BY ship_index
     ORDER BY ship_index`,
    [roundId]
  );
  const perShip = Array.from({ length: GE_SHIPS }).map((_, i) => ({ ship_index: i, qty: 0 }));
  for (const row of totals.rows) {
    const idx = Number(row.ship_index);
    if (idx >= 0 && idx < GE_SHIPS) perShip[idx].qty = Number(row.qty);
  }
  const totalEntries = perShip.reduce((a, b) => a + b.qty, 0);
  return { perShip, totalEntries };
}

app.get("/api/v2/ge/round/current", async (_req, res) => {
  // Ensure a current round exists
  let round = await getCurrentRound();

  // If the last round is settled for a bit, automatically start a new one.
  if (round?.status === "settled") {
    const settledAt = round.settled_at ? new Date(round.settled_at).getTime() : 0;

    // Keep settled rounds longer for animation-heavy modes so mobile can finish.
    const mode = round.game_mode || "roulette";
    const keepMs =
      mode === "elimination" ? 12000 :
      mode === "race" ? 8000 :
      Number(process.env.GE_SHOW_RESULT_MS || 6000);

    if (settledAt && Date.now() - settledAt > keepMs) {
      round = null;
    }
  }

  if (!round) {
    const DURATION_MINUTES = Number(process.env.GE_ROUND_MINUTES || 10);
    const endsAt = new Date(Date.now() + DURATION_MINUTES * 60 * 1000);

    const secret = crypto.randomBytes(32).toString("hex");
    const commit = crypto.createHash("sha256").update(secret).digest("hex");

    const aliens = genUniqueAlienIds(GE_SHIPS);

    const r = await query(
      `INSERT INTO ge_rounds (status, ends_at, ships_count, emissions_total, started_at, seed_commit, seed_reveal, alien_ids, game_mode)
       VALUES ('running', $1, $2, 0, NOW(), $3, $4, $5, NULL)
       RETURNING *`,
      [endsAt, GE_SHIPS, commit, secret, JSON.stringify(aliens)]
    );
    const created = r.rows[0];
    const mode = pickGameMode(created.id);
    await query(`UPDATE ge_rounds SET game_mode=$2 WHERE id=$1`, [created.id, mode]);
    round = { ...created, game_mode: mode };
  }

  // Auto-settle when ended (dev-friendly). This makes the UI announce results
  // without needing an admin call.
  if (round.status === "running" && round.started_at && Date.now() >= new Date(round.ends_at).getTime()) {
    try {
      await settleRound(round);
    } catch (e) {
      // ignore settle errors; client can retry on next poll
      console.warn("[ge] auto-settle failed", e?.message || e);
    }
    // reload round state after settlement attempt
    round = await getCurrentRound();
  }

  const stats = await getRoundStats(round.id);
  return res.json({
    ok: true,
    round: {
      id: round.id,
      status: round.status,
      starts_at: round.starts_at,
      started_at: round.started_at,
      ends_at: round.ends_at,
      ships_count: round.ships_count,
      emissions_total: Number(round.emissions_total || 0),
      winning_ship_index: round.winning_ship_index ?? null,
      seed_commit: round.seed_commit ?? null,
      alien_ids: (() => {
        try { return round.alien_ids ? JSON.parse(round.alien_ids) : null; } catch { return null; }
      })(),
      game_mode: round.game_mode || "roulette",
      // seed is only meaningful after settle; still included for audit
      seed: round.seed ?? null,
    },
    stats,
    config: {
      ships: GE_SHIPS,
      round_minutes: Number(process.env.GE_ROUND_MINUTES || 10),
      entry_price_sol: GE_ENTRY_PRICE_SOL,
      winner_bps: GE_WINNER_BPS,
      participation_bps: GE_PARTICIPATION_BPS,
      treasury_bps: GE_TREASURY_BPS,
    },
  });
});

app.get("/api/v2/ge/me", requireAuth, async (req, res) => {
  const wallet = req.auth?.wallet;
  const round = await getCurrentRound();
  if (!round) return res.json({ ok: true, round: null, my: null });

  const mine = await query(
    `SELECT ship_index, COALESCE(SUM(qty),0) AS qty
     FROM ge_entries
     WHERE round_id=$1 AND wallet=$2
     GROUP BY ship_index
     ORDER BY ship_index`,
    [round.id, wallet]
  );

  return res.json({ ok: true, round_id: round.id, my: mine.rows.map(r => ({ ship_index: Number(r.ship_index), qty: Number(r.qty) })) });
});

// Build a SOL transfer tx for boarding (devnet). Frontend signs & submits.
app.post("/api/v2/ge/buy-entry", geEnterLimiter, requireAuth, async (req, res) => {
  try {
    const wallet = req.auth?.wallet;
    if (!wallet) return res.status(401).json({ error: "Unauthorized" });

    if (!GE_TREASURY_WALLET) {
      return res.status(500).json({ error: "Server misconfigured (GE_TREASURY_WALLET missing)" });
    }

    const round = await getCurrentRound();
    if (!round || round.status !== "running") return res.status(400).json({ error: "No running round" });

    const shipIndex = Number(req.body?.ship_index);
    const qty = Math.max(1, Math.min(100, Number(req.body?.qty || 1)));
    if (!Number.isInteger(shipIndex) || shipIndex < 0 || shipIndex >= GE_SHIPS) {
      return res.status(400).json({ error: "Invalid ship_index" });
    }

    const now = new Date();
    const cutoffMs = Number(process.env.GE_ENTRY_CUTOFF_MS || 15000);
    if (round.started_at && now.getTime() > new Date(round.ends_at).getTime() - cutoffMs) {
      return res.status(400).json({ error: "Round entry closed" });
    }

    const lamports = Math.round(qty * GE_ENTRY_PRICE_SOL * 1_000_000_000);
    if (!Number.isFinite(lamports) || lamports <= 0) return res.status(400).json({ error: "Invalid amount" });

    // Intent binds: round_id + ship_index + qty + lamports.
    const intentId = nanoid(24);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      `INSERT INTO payment_intents (id, wallet, kind, price_usd, sol_usd, lamports, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [intentId, wallet, `ge_entry:${round.id}:${shipIndex}:${qty}`, 0, 0, String(lamports), expiresAt]
    );

    const tx = await buildTransferTx({
      rpcUrl: RPC_URL,
      fromPubkey: wallet,
      toPubkey: GE_TREASURY_WALLET,
      lamports,
    });

    const serialized = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    ).toString("base64");

    return res.json({
      ok: true,
      intentId,
      serialized,
      lamports,
      amountSol: lamportsToSol(lamports),
      to: GE_TREASURY_WALLET,
      round_id: round.id,
      ship_index: shipIndex,
      qty,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e) {
    console.error("POST /api/v2/ge/buy-entry error", e);
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/v2/ge/confirm-entry", geEnterLimiter, requireAuth, async (req, res) => {
  try {
    const wallet = req.auth?.wallet;
    const { signature, intentId } = req.body || {};
    if (!wallet || !signature || !intentId) return res.status(400).json({ error: "missing fields" });

    const intent = await query(
      `SELECT id, wallet, kind, lamports, expires_at
       FROM payment_intents
       WHERE id = $1`,
      [intentId]
    );
    if (intent.rowCount === 0) return res.status(400).json({ error: "invalid intent" });

    const row = intent.rows[0];
    if (row.wallet !== wallet) return res.status(403).json({ error: "intent wallet mismatch" });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "intent expired" });

    const parts = String(row.kind || "").split(":");
    // kind: ge_entry:roundId:shipIndex:qty
    if (parts.length !== 4 || parts[0] !== "ge_entry") return res.status(400).json({ error: "intent kind mismatch" });

    const roundId = Number(parts[1]);
    const shipIndex = Number(parts[2]);
    const qty = Number(parts[3]);
    const minLamports = Number(row.lamports);

    // Prevent replay
    const already = await query(`SELECT signature FROM payments WHERE signature=$1`, [signature]);
    if (already.rowCount > 0) {
      return res.status(409).json({ error: "payment already processed" });
    }

    const verify = await verifySolPayment({
      rpcUrl: RPC_URL,
      signature,
      expectedFrom: wallet,
      expectedTo: GE_TREASURY_WALLET,
      minLamports,
    });

    if (!verify.ok) return res.status(400).json({ error: "invalid payment", detail: verify });

    // Check round is still running
    const round = await query(`SELECT * FROM ge_rounds WHERE id=$1`, [roundId]);
    const r = round.rows[0];
    if (!r || r.status !== "running") return res.status(400).json({ error: "round not running" });

    const cutoffMs = Number(process.env.GE_ENTRY_CUTOFF_MS || 15000);
    if (Date.now() > new Date(r.ends_at).getTime() - cutoffMs) {
      return res.status(400).json({ error: "Round entry closed" });
    }

    await query("BEGIN");
    try {
      await query(
        `INSERT INTO payments (signature, wallet, kind, amount_sol, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          signature,
          wallet,
          `ge_entry:${roundId}`,
          lamportsToSol(minLamports),
          JSON.stringify({ intentId, roundId, shipIndex, qty, lamports: minLamports }),
        ]
      );

      // Intent is single-use
      await query(`DELETE FROM payment_intents WHERE id=$1`, [intentId]);

      await query(
        `INSERT INTO ge_entries (round_id, wallet, ship_index, qty)
         VALUES ($1,$2,$3,$4)`,
        [roundId, wallet, shipIndex, qty]
      );

      await query("COMMIT");
    } catch (e) {
      await query("ROLLBACK");
      throw e;
    }

    const stats = await getRoundStats(roundId);
    return res.json({ ok: true, round_id: roundId, stats });
  } catch (e) {
    console.error("POST /api/v2/ge/confirm-entry error", e);
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/v2/ge/enter", geEnterLimiter, requireAuth, async (req, res) => {
  try {
    const wallet = req.auth?.wallet;
    const round = await getCurrentRound();
    if (!round) return res.status(400).json({ error: "No open round" });

    const now = new Date();
    // If round is running, enforce end time with a small cutoff to avoid last-millisecond sniping.
    const cutoffMs = Number(process.env.GE_ENTRY_CUTOFF_MS || 15000);
    if (round.started_at && now.getTime() > new Date(round.ends_at).getTime() - cutoffMs) {
      return res.status(400).json({ error: "Round entry closed" });
    }

    const shipIndex = Number(req.body?.ship_index);
    const qty = Math.max(1, Math.min(100, Number(req.body?.qty || 1)));
    if (!Number.isInteger(shipIndex) || shipIndex < 0 || shipIndex >= GE_SHIPS) {
      return res.status(400).json({ error: "Invalid ship_index" });
    }

    // MVP: free entries. Later: require buying credits / on-chain.
    await query(
      `INSERT INTO ge_entries (round_id, wallet, ship_index, qty)
       VALUES ($1,$2,$3,$4)`,
      [round.id, wallet, shipIndex, qty]
    );

    const stats = await getRoundStats(round.id);

    // Note: rounds are created as running in dev; no auto-start needed here.

    // Enforce state: once running ends, no more entries.
    // (We keep it strict to prevent last-millisecond sniping.)
    const updated = await getCurrentRound();
    if (updated?.id === round.id && updated.started_at && Date.now() > new Date(updated.ends_at).getTime()) {
      return res.status(400).json({ error: "Round already ended" });
    }

    return res.json({ ok: true, round_id: round.id, stats });
  } catch (e) {
    console.error("POST /api/v2/ge/enter error", e);
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/v2/ge/admin/create-round", requireAdmin, async (req, res) => {
  try {
    const durationMinutes = Math.max(1, Math.min(24 * 60, Number(req.body?.duration_minutes || 1)));
    const endsAt = new Date(Date.now() + durationMinutes * 60 * 1000);

    // Close any existing open round
    await query(`UPDATE ge_rounds SET status='closed' WHERE status IN ('open','running','filling')`);

    const secret = crypto.randomBytes(32).toString("hex");
    const commit = crypto.createHash("sha256").update(secret).digest("hex");

    // Create a new running round immediately (dev-friendly)
    const aliens = genUniqueAlienIds(GE_SHIPS);

    const r = await query(
      `INSERT INTO ge_rounds (status, ends_at, ships_count, emissions_total, started_at, seed_commit, seed_reveal, alien_ids, game_mode)
       VALUES ('running', $1, $2, 0, NOW(), $3, $4, $5, NULL)
       RETURNING *`,
      [endsAt, GE_SHIPS, commit, secret, JSON.stringify(aliens)]
    );

    const created = r.rows[0];
    const mode = pickGameMode(created.id);
    await query(`UPDATE ge_rounds SET game_mode=$2 WHERE id=$1`, [created.id, mode]);

    return res.json({ ok: true, round: { ...created, game_mode: mode } });
  } catch (e) {
    console.error("POST /api/v2/ge/admin/create-round error", e);
    return res.status(500).json({ error: e.message });
  }
});

async function settleRound(round) {
  const now = new Date();

  if (!round.started_at || round.status !== "running") {
    return { ok: false, error: "Round not running" };
  }

  const endsAt = new Date(round.ends_at);
  if (now.getTime() < endsAt.getTime()) {
    return { ok: false, error: "Round not ended yet" };
  }

  const stats = await getRoundStats(round.id);
  // Commit–reveal style seed: round has a secret (seed_reveal) stored server-side.
  // We never expose seed_reveal; clients may see seed_commit for audit.
  const secret = round.seed_reveal || crypto.randomBytes(32).toString("hex");
  const seed = crypto
    .createHash("sha256")
    .update(`${secret}:${round.id}:${endsAt.toISOString()}:${stats.totalEntries}`)
    .digest("hex");

  // Winner selection: weighted by entries (tickets), not by ship.
  // This makes P(win ship i) proportional to entries on that ship.
  let winningShip = 0;
  if (stats.totalEntries > 0) {
    const ticket = parseInt(seed.slice(0, 12), 16) % stats.totalEntries;
    let acc = 0;
    for (let i = 0; i < GE_SHIPS; i++) {
      acc += Number(stats.perShip[i]?.qty || 0);
      if (ticket < acc) {
        winningShip = i;
        break;
      }
    }
  }

  const potSol = Number(stats.totalEntries) * GE_ENTRY_PRICE_SOL;
  const emissionsTotal = potSol;

  const treasuryCut = (potSol * GE_TREASURY_BPS) / 10000;
  const winnerPot = (potSol * GE_WINNER_BPS) / 10000;
  const participationPot = (potSol * GE_PARTICIPATION_BPS) / 10000;

  // Winners are wallets that picked winningShip; split pro-rata by qty on that ship.
  const winners = await query(
    `SELECT wallet, COALESCE(SUM(qty),0) AS qty
     FROM ge_entries
     WHERE round_id=$1 AND ship_index=$2
     GROUP BY wallet`,
    [round.id, winningShip]
  );
  const winTotalQty = winners.rows.reduce((a, r) => a + Number(r.qty), 0);

  // Participation: all wallets split pro-rata by total entries (across all ships).
  const participants = await query(
    `SELECT wallet, COALESCE(SUM(qty),0) AS qty
     FROM ge_entries
     WHERE round_id=$1
     GROUP BY wallet`,
    [round.id]
  );
  const partTotalQty = participants.rows.reduce((a, r) => a + Number(r.qty), 0);

  await query("BEGIN");
  try {
    // Idempotency: only the first settler succeeds.
    const upd = await query(
      `UPDATE ge_rounds
       SET status='settled',
           settled_at=NOW(),
           winning_ship_index=$2,
           emissions_total=$3,
           seed=$4,
           seed_commit=COALESCE(seed_commit, $5),
           seed_reveal=COALESCE(seed_reveal, $6)
       WHERE id=$1 AND status='running'
       RETURNING id`,
      [round.id, winningShip, emissionsTotal, seed, crypto.createHash("sha256").update(secret).digest("hex"), secret]
    );

    if (upd.rowCount === 0) {
      await query("ROLLBACK");
      return { ok: true, already_settled: true, round_id: round.id };
    }

    // Treasury balance
    if (treasuryCut > 0) {
      await query(
        `INSERT INTO ge_balances (wallet, balance) VALUES ('__treasury__', $1)
         ON CONFLICT (wallet) DO UPDATE SET balance = ge_balances.balance + EXCLUDED.balance, updated_at=NOW()`,
        [treasuryCut]
      );
    }

    // Participation payouts
    for (const p of participants.rows) {
      const q = Number(p.qty);
      if (q <= 0 || partTotalQty <= 0) continue;
      const amount = (participationPot * q) / partTotalQty;
      if (amount <= 0) continue;
      await query(`INSERT INTO ge_payouts (round_id, wallet, amount) VALUES ($1,$2,$3)`, [round.id, p.wallet, amount]);
      await query(
        `INSERT INTO ge_balances (wallet, balance) VALUES ($1,$2)
         ON CONFLICT (wallet) DO UPDATE SET balance = ge_balances.balance + EXCLUDED.balance, updated_at=NOW()`,
        [p.wallet, amount]
      );
    }

    // Winner payouts
    for (const w of winners.rows) {
      const q = Number(w.qty);
      if (q <= 0 || winTotalQty <= 0) continue;
      const amount = (winnerPot * q) / winTotalQty;
      if (amount <= 0) continue;
      await query(`INSERT INTO ge_payouts (round_id, wallet, amount) VALUES ($1,$2,$3)`, [round.id, w.wallet, amount]);
      await query(
        `INSERT INTO ge_balances (wallet, balance) VALUES ($1,$2)
         ON CONFLICT (wallet) DO UPDATE SET balance = ge_balances.balance + EXCLUDED.balance, updated_at=NOW()`,
        [w.wallet, amount]
      );
    }

    await query("COMMIT");
  } catch (e) {
    await query("ROLLBACK");
    throw e;
  }

  return {
    ok: true,
    round_id: round.id,
    winning_ship_index: winningShip,
    seed_commit: round.seed_commit || null,
    seed,
    emissions_total: emissionsTotal,
    pot_sol: potSol,
    winner_pot: winnerPot,
    participation_pot: participationPot,
    treasury_cut: treasuryCut,
    ends_at: endsAt.toISOString(),
  };
}

app.post("/api/v2/ge/admin/settle", requireAdmin, async (req, res) => {
  try {
    const round = await getCurrentRound();
    if (!round) return res.status(400).json({ error: "No current round" });
    const out = await settleRound(round);
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  } catch (e) {
    console.error("POST /api/v2/ge/admin/settle error", e);
    return res.status(500).json({ error: e.message });
  }
});

// Auto-settle: if the current round ended, any client poll will finalize it once.
app.post("/api/v2/ge/round/heartbeat", requireAdmin, async (_req, res) => {
  try {
    const round = await getCurrentRound();
    if (!round) return res.json({ ok: true, round: null });
    if (round.status === 'running' && round.started_at && Date.now() >= new Date(round.ends_at).getTime()) {
      const out = await settleRound(round);
      return res.json(out);
    }
    return res.json({ ok: true, round_id: round.id, status: round.status });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/v2/ge/balance", requireAuth, async (req, res) => {
  try {
    const wallet = req.auth?.wallet;
    const r = await query(`SELECT balance FROM ge_balances WHERE wallet=$1`, [wallet]);
    const bal = r.rowCount ? Number(r.rows[0].balance) : 0;
    res.json({ ok: true, wallet, balance: bal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/v2/ge/last", async (_req, res) => {
  try {
    const r = await query(`SELECT id, settled_at, winning_ship_index, emissions_total, seed, alien_ids, game_mode FROM ge_rounds WHERE status='settled' ORDER BY id DESC LIMIT 1`);
    res.json({ ok: true, last: r.rows[0] || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Settled round summary (for winner modal / stats)
app.get("/api/v2/ge/round/summary", async (_req, res) => {
  try {
    const roundIdParam = req.query.round_id ? Number(req.query.round_id) : null;
    const r = roundIdParam
      ? await query(`SELECT * FROM ge_rounds WHERE id=$1 AND status='settled' LIMIT 1`, [roundIdParam])
      : await query(`SELECT * FROM ge_rounds WHERE status='settled' ORDER BY id DESC LIMIT 1`);
    const round = r.rows[0];
    if (!round) return res.json({ ok: true, round: null });

    const stats = await getRoundStats(round.id);
    const potSol = Number(stats.totalEntries) * GE_ENTRY_PRICE_SOL;
    const treasuryCut = (potSol * GE_TREASURY_BPS) / 10000;
    const winnerPot = (potSol * GE_WINNER_BPS) / 10000;
    const participationPot = (potSol * GE_PARTICIPATION_BPS) / 10000;

    const participantsCount = await query(
      `SELECT COUNT(DISTINCT wallet) AS c FROM ge_entries WHERE round_id=$1`,
      [round.id]
    );
    const payoutsSum = await query(
      `SELECT COALESCE(SUM(amount),0) AS s FROM ge_payouts WHERE round_id=$1`,
      [round.id]
    );

    let alienIds = null;
    try { alienIds = round.alien_ids ? JSON.parse(round.alien_ids) : null; } catch {}
    const winIndex = Number(round.winning_ship_index ?? 0);
    const winnerAlien = Array.isArray(alienIds) ? alienIds[winIndex] : null;

    res.json({
      ok: true,
      round: {
        id: round.id,
        game_mode: round.game_mode || "roulette",
        winning_index: winIndex,
        winner_alien: winnerAlien,
        settled_at: round.settled_at,
      },
      pot_sol: potSol,
      winner_pot: winnerPot,
      participation_pot: participationPot,
      treasury_cut: treasuryCut,
      participants: Number(participantsCount.rows[0]?.c || 0),
      distributed_total: Number(payoutsSum.rows[0]?.s || 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/v2/ge/round/payouts", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
    const roundIdParam = req.query.round_id ? Number(req.query.round_id) : null;
    const r = roundIdParam
      ? await query(`SELECT id FROM ge_rounds WHERE id=$1 AND status='settled' LIMIT 1`, [roundIdParam])
      : await query(`SELECT id FROM ge_rounds WHERE status='settled' ORDER BY id DESC LIMIT 1`);
    const round = r.rows[0];
    if (!round) return res.json({ ok: true, round_id: null, payouts: [] });

    const rows = await query(
      `SELECT p.wallet, p.amount,
              COALESCE(e.qty, 0) AS entries
       FROM ge_payouts p
       LEFT JOIN (
         SELECT wallet, COALESCE(SUM(qty),0) AS qty
         FROM ge_entries
         WHERE round_id=$1
         GROUP BY wallet
       ) e ON e.wallet = p.wallet
       WHERE p.round_id=$1
       ORDER BY p.amount DESC
       LIMIT $2`,
      [round.id, limit]
    );

    res.json({
      ok: true,
      round_id: round.id,
      payouts: rows.rows.map((x) => ({
        wallet: x.wallet,
        amount: Number(x.amount),
        entries: Number(x.entries),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function startGreatExpeditionSimulator() {
  if (process.env.GE_SIMULATOR !== "1") return;

  console.log("🤖 GE simulator enabled");

  const simEnabled = !["0","false","off"].includes((process.env.GE_SIM_ENABLED || "").toLowerCase());
  const intervalMs = Number(process.env.GE_SIM_INTERVAL_MS || 2500);
  const maxBots = Number(process.env.GE_SIM_MAX_BOTS || GE_SHIPS);

  // lightweight "live action": bots place small entries on random ships while round is running.
  if (!simEnabled) {
    console.log("🤖 GE simulator disabled (GE_SIM_ENABLED=false)");
  } else {
  setInterval(async () => {
    try {
      const round = await getCurrentRound();
      if (!round || round.status !== "running") return;

      // stop creating entries close to the end
      const cutoffMs = Number(process.env.GE_ENTRY_CUTOFF_MS || 15000);
      if (Date.now() > new Date(round.ends_at).getTime() - cutoffMs) return;

      // decide number of actions this tick
      const actions = 1 + crypto.randomInt(0, 3); // 1-3

      for (let a = 0; a < actions; a++) {
        const botId = crypto.randomInt(0, maxBots);
        const wallet = `bot-${botId}`;
        const shipIndex = crypto.randomInt(0, GE_SHIPS);
        const qty = 1 + crypto.randomInt(0, 2); // 1-2 (smaller bot buys)

        await query(
          `INSERT INTO ge_entries (round_id, wallet, ship_index, qty)
           VALUES ($1,$2,$3,$4)`,
          [round.id, wallet, shipIndex, qty]
        );
      }
    } catch (e) {
      // don't crash the process
      console.warn("[ge] simulator tick failed", e?.message || e);
    }
  }, intervalMs);
  }
}

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ Zeruva API running on ${PORT}`));
    startGreatExpeditionSimulator();
  })
  .catch((err) => {
    console.error("❌ Failed to initialize DB", err);
    process.exit(1);
  });
