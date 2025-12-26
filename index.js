require("dotenv").config();
const express = require("express");
const cors = require("cors");
const body = require("body-parser");
const path = require("path");
const crypto = require("crypto");
const { nanoid } = require("nanoid");
const { PublicKey } = require("@solana/web3.js");
const { buildTransferTx } = require("./src/sol");
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
// ======= Validate Solana address (basic check) =======
function isProbableSolanaAddress(address) {
  return (
    typeof address === "string" &&
    address.length >= 32 &&
    address.length <= 44
  );
}

// ======= Routes =======
const BASE_POINTS_PER_DAY = 1; // you can tweak this later

app.get("/api/rewards/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;

    if (!wallet) {
      return res.status(400).json({ error: "Wallet is required" });
    }

    const result = await query(
      `
      SELECT wallet, last_claim_at, total_claimed_points
      FROM users
      WHERE wallet = $1
      `,
      [wallet]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];

    // You already have this logic somewhere — reuse it
    const totalRoiPerDay = await getUserTotalRoi(wallet);

    return res.json({
      wallet: user.wallet,
      total_claimed_points: Number(user.total_claimed_points || 0),
      last_claim_at: user.last_claim_at,
      total_roi_per_day: totalRoiPerDay,
      base_points_per_day: BASE_POINTS_PER_DAY
    });
  } catch (err) {
    console.error("GET /api/rewards error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


app.post("/api/claim-rewards", async (req, res) => {
  try {
    const { wallet, calculatedValue } = req.body || {};

    if (!wallet || typeof calculatedValue !== "number") {
      return res.status(400).json({ error: "Invalid request body" });
    }

    const result = await query(
      `
      SELECT wallet, last_claim_at, total_claimed_points
      FROM users
      WHERE wallet = $1
      `,
      [wallet]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];

    const nowMs = Date.now();
    const lastMs = new Date(user.last_claim_at).getTime();

    if (isNaN(lastMs) || nowMs <= lastMs) {
      return res.status(400).json({ error: "Invalid claim timing" });
    }

    const elapsedSeconds = (nowMs - lastMs) / 1000;

    const totalRoiPerDay = await getUserTotalRoi(wallet);
    const earningsPerSecond = totalRoiPerDay / 86400;

    const newlyEarned = elapsedSeconds * earningsPerSecond;
    const expectedTotal =
      Number(user.total_claimed_points) + newlyEarned;

    // --- Anti-cheat validation ---
    const tolerance = 0.01; // allows tiny float drift

    if (Math.abs(calculatedValue - expectedTotal) > tolerance) {
      return res.status(403).json({
        success: false,
        message: "Validation failed"
      });
    }

    // --- Atomic update ---
    await query(
      `
      UPDATE users
      SET total_claimed_points = $1,
          last_claim_at = $2
      WHERE wallet = $3
      `,
      [expectedTotal, new Date(nowMs), wallet]
    );

    return res.json({
      success: true,
      claimedAmount: newlyEarned,
      totalClaimedPoints: expectedTotal,
      lastClaimTimestamp: new Date(nowMs).toISOString()
    });
  } catch (err) {
    console.error("POST /api/claim-rewards error:", err);
    return res.status(500).json({ error: "Internal server error" });
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
    await query(
      `INSERT INTO ship_slots (wallet, slot_index, alien_fk)
       VALUES ($1, $2, $3)
       ON CONFLICT (wallet, slot_index)
       DO UPDATE SET alien_fk = $3`,
      [wallet, slotIndex, alienDbId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/unassign-slot", async (req, res) => {
  const { wallet, alienDbId } = req.body;

  if (!wallet || !alienDbId)
    return res.status(400).json({ error: "Missing fields" });

  try {
    const result = await query(
      `DELETE FROM ship_slots
       WHERE wallet = $1 AND alien_fk = $2
       RETURNING id`,
      [wallet, alienDbId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "No such slot assignment" });
    }

    res.json({ ok: true });
  } catch (e) {
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



app.post("/api/buy-spaceship", async (req, res) => {
  try {
    const { wallet, level } = req.body || {};
    if (!wallet || !level) return res.status(400).json({ error: "missing fields" });

    const priceUSD = level === 1 ? 30 : level === 2 ? 60 : level === 3 ? 120 : null;
    if (!priceUSD) return res.status(400).json({ error: "invalid level" });

    const usdPerSol = 100;
    const amountSol = priceUSD / usdPerSol;

    const admin = new PublicKey(ADMIN_WALLET);
    const tx = await buildTransferTx({
      rpcUrl: RPC_URL,
      fromPubkey: wallet,
      toPubkey: admin,
      amountSol
    });

    const serialized = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    ).toString("base64");

    res.json({ serialized, amountSol, admin: admin.toBase58(), level });
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
