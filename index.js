require("dotenv").config();
const express = require("express");
const cors = require("cors");
const body = require("body-parser");
const path = require("path");
const crypto = require("crypto");
const { nanoid } = require("nanoid");
const { PublicKey } = require("@solana/web3.js");
const { buildTransferTx, verifySolPayment } = require("./src/sol");
const { initDb, query } = require("./db");

const app = express();
app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:3001",
    "https://your-frontend.vercel.app",
    "https://*.v0.app",
    "https://*.vusercontent.net"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use(body.json({ limit: "1mb" }));
app.use("/static", express.static(path.join(__dirname, "public")));

const ADMIN_WALLET = process.env.ADMIN_WALLET;
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/+$/,'') || 'http://localhost:3000';
const ALIEN_COUNT = parseInt(process.env.ALIEN_COUNT || "60", 10);

// ======= Helper to build absolute image URLs =======
const imgUrl = (id) => `${PUBLIC_BASE_URL}/static/${id}.png`;
const ALIENS = Array.from({ length: ALIEN_COUNT }, (_, i) => ({
  id: i + 1,
  image: imgUrl(i + 1)
}));

const NOTHING_IMAGE = `${PUBLIC_BASE_URL}/static/nothing.png`;

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
const USD_PER_SOL = Number(process.env.USD_PER_SOL || 100);
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

function usdToSol(usd) {
  return usd / USD_PER_SOL;
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
  const activeResult = await query(
    `SELECT a.roi
     FROM ship_slots s
     JOIN aliens a ON a.id = s.alien_fk
     WHERE s.wallet = $1`,
    [wallet]
  );
  let totalRoiPerDay = 0;
  for (const row of activeResult.rows) {
    totalRoiPerDay += Number(row.roi);
  }
  return totalRoiPerDay;
}

app.get("/api/rewards/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    if (!wallet) {
      return res.status(400).json({ error: "Missing wallet" });
    }
    if (!isProbableSolanaAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address" });
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

    return res.json({
      unclaimed_earnings: Number(unclaimedEarnings),
      pending_earnings: Number(user.pending_earnings || 0),
      total_claimed_points: Number(user.total_claimed_points || 0),
      last_claim_at: user.last_claim_at,
      total_roi_per_day: totalRoiPerDay,
      base_points_per_day: BASE_POINTS_PER_DAY,
    });
  } catch (e) {
    console.error("GET /api/rewards error", e);
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/claim-rewards", async (req, res) => {
  try {
    const { wallet, expected_earnings } = req.body || {};
    if (!wallet) {
      return res.status(400).json({ error: "Missing wallet" });
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

      const totalRoiPerDay = await calculateCurrentROI(wallet);

      const newEarnings = calculateUnclaimedEarnings(
        user.last_claim_at,
        totalRoiPerDay,
        now
      );

      const pendingEarnings = Number(user.pending_earnings || 0);
      const totalToClaim = pendingEarnings + newEarnings;

      if (expected_earnings !== undefined && expected_earnings !== null) {
        const expectedNum = Number(expected_earnings);
        const diff = Math.abs(totalToClaim - expectedNum);
        if (diff > 0.01) {
          await query("ROLLBACK");
          return res.status(400).json({
            error: "Earnings mismatch",
            server_calculated: totalToClaim,
            client_expected: expectedNum,
            tolerance: 0.01,
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


app.get("/api/health", (_, res) => {
  res.json({ ok: true, admin: ADMIN_WALLET, aliens: ALIEN_COUNT });
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
  const pool = [...ALIENS];
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
    res.json(result.rows);
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
            image:    found.image,
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

app.post("/api/upgrade-ship", async (req, res) => {
  const { wallet, newLevel } = req.body;

  if (!wallet || !newLevel)
    return res.status(400).json({ error: "Missing fields" });

  try {
    await query(
      `UPDATE users
       SET ship_level = $1
       WHERE wallet = $2`,
      [newLevel, wallet]
    );

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/assign-slot", async (req, res) => {
  const { wallet, slotIndex, alienDbId } = req.body;

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
app.post("/api/unassign-slot", async (req, res) => {
  const { wallet, alienDbId } = req.body;

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

app.post("/api/register", async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });

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

app.post("/api/spin", limitSpin, async (req, res) => {
  const { wallet, eggType = "basic" } = req.body || {};

  if (!wallet) return res.status(400).json({ error: "Missing wallet" });

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
    const alien = { id: null, image: NOTHING_IMAGE };

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
  const alien = { id: randId, image: imgUrl(randId) };

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
app.post("/api/buy-egg", async (req, res) => {
  try {
    const { wallet, eggType = "basic" } = req.body || {};
    if (!wallet) return res.status(400).json({ error: "missing wallet" });

    const priceUsd = EGG_PRICE_USD[eggType];
    if (!priceUsd) return res.status(400).json({ error: "invalid eggType" });

    const amountSol = usdToSol(priceUsd);

    const admin = new PublicKey(ADMIN_WALLET);
    const tx = await buildTransferTx({
      rpcUrl: RPC_URL,
      fromPubkey: wallet,
      toPubkey: admin,
      amountSol,
    });

    const serialized = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ).toString("base64");

    res.json({ serialized, amountSol, admin: admin.toBase58(), eggType });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Confirm a signed payment and credit the egg
app.post("/api/confirm-buy-egg", async (req, res) => {
  try {
    const { wallet, eggType = "basic", signature } = req.body || {};
    if (!wallet || !signature)
      return res.status(400).json({ error: "missing fields" });

    const priceUsd = EGG_PRICE_USD[eggType];
    if (!priceUsd) return res.status(400).json({ error: "invalid eggType" });

    const amountSol = usdToSol(priceUsd);
    const minLamports = Math.round(amountSol * 1e9);

    // Prevent replay
    const already = await query(`SELECT signature FROM payments WHERE signature=$1`, [
      signature,
    ]);
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
          JSON.stringify({ eggType }),
        ],
      );

      await query(
        `UPDATE users SET ${col} = COALESCE(${col}, 0) + 1 WHERE wallet = $1`,
        [wallet],
      );

      await query("COMMIT");
    } catch (e) {
      await query("ROLLBACK");
      throw e;
    }

    res.json({ ok: true, eggType, credited: 1, signature });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Prepare a SOL transfer tx for a ship purchase
app.post("/api/buy-spaceship", async (req, res) => {
  try {
    const { wallet, level } = req.body || {};
    if (!wallet || !level)
      return res.status(400).json({ error: "missing fields" });

    const priceUsd = SHIP_PRICE_USD[String(level)];
    if (!priceUsd) return res.status(400).json({ error: "invalid level" });

    const amountSol = usdToSol(priceUsd);

    const admin = new PublicKey(ADMIN_WALLET);
    const tx = await buildTransferTx({
      rpcUrl: RPC_URL,
      fromPubkey: wallet,
      toPubkey: admin,
      amountSol,
    });

    const serialized = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ).toString("base64");

    res.json({ serialized, amountSol, admin: admin.toBase58(), level });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Confirm ship payment and set ship_level
app.post("/api/confirm-buy-spaceship", async (req, res) => {
  try {
    const { wallet, level, signature } = req.body || {};
    if (!wallet || !level || !signature)
      return res.status(400).json({ error: "missing fields" });

    const priceUsd = SHIP_PRICE_USD[String(level)];
    if (!priceUsd) return res.status(400).json({ error: "invalid level" });

    const amountSol = usdToSol(priceUsd);
    const minLamports = Math.round(amountSol * 1e9);

    const already = await query(`SELECT signature FROM payments WHERE signature=$1`, [
      signature,
    ]);
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
          JSON.stringify({ level: Number(level) }),
        ],
      );

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
