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

// ======= Game configuration =======
const BASE_WEIGHTS = { Common: 60, Rare: 25, Epic: 10, Legendary: 5 };
const EGG_MOD = {
  basic: { Epic: 0, Legendary: 0 },
  rare: { Epic: 10, Legendary: 5 },
  ultra: { Epic: 25, Legendary: 10 }
};
const ROI = { Common: 0.02, Rare: 0.05, Epic: 0.08, Legendary: 0.10 };

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

// ======= Routes =======
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
    const user = await query(`SELECT ship_level FROM users WHERE wallet = $1`, [wallet]);
    const slots = await query(
      `SELECT s.slot_index, a.*
       FROM ship_slots s
       LEFT JOIN aliens a ON a.id = s.alien_fk
       WHERE s.wallet = $1
       ORDER BY slot_index`,
      [wallet]
    );

    res.json({
      level: user.rows[0]?.ship_level || 1,
      slots: slots.rows,
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

  const mod = EGG_MOD[eggType] || EGG_MOD.basic;
  const weights = {
    Common: BASE_WEIGHTS.Common,
    Rare: BASE_WEIGHTS.Rare,
    Epic: BASE_WEIGHTS.Epic + (mod.Epic || 0),
    Legendary: BASE_WEIGHTS.Legendary + (mod.Legendary || 0),
  };

  const tier = weightedPick(weights);
  const randId = 1 + Math.floor(Math.random() * ALIEN_COUNT);
  const alien = { id: randId, image: imgUrl(randId) };
  const roi = ROI[tier];

  const payload = {
    spinId: nanoid(),
    wallet,
    tier,
    roi,
    alien,
    timestamp: Date.now(),
  };

  const signature = crypto.createHmac("sha256", process.env.SERVER_HMAC_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex");

  // Save alien in DB
  const result = await query(
    `INSERT INTO aliens (wallet, alien_id, image, tier, roi)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [wallet, randId, alien.image, tier, roi]
  );

  res.json({
    ...payload,
    db_id: result.rows[0].id, // important for assigning to ship slots
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
