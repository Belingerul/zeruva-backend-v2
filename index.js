require("dotenv").config();
const express = require("express");
const cors = require("cors");
const body = require("body-parser");
const path = require("path");
const crypto = require("crypto");
const { nanoid } = require("nanoid");
const { PublicKey } = require("@solana/web3.js");
const { buildTransferTx } = require("./src/sol");

const app = express();
app.use(cors());
app.use(body.json({ limit: "1mb" }));

// serve alien images
app.use("/static", express.static(path.join(__dirname, "public")));

const ADMIN_WALLET = process.env.ADMIN_WALLET;
const ALIEN_COUNT = parseInt(process.env.ALIEN_COUNT || "60", 10);
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

// In-memory list of aliens we display (PNG files in /public/aliens)
const ALIENS = Array.from({ length: ALIEN_COUNT }, (_, i) => ({
  id: i + 1,
  image: `/static/aliens/${i + 1}.png`
}));

// Base rarity weights and egg modifiers
const BASE_WEIGHTS = { Common: 60, Rare: 25, Epic: 10, Legendary: 5 };
const EGG_MOD = {
  basic: { Epic: 0,  Legendary: 0 },
  rare:  { Epic: 10, Legendary: 5 },
  ultra: { Epic: 25, Legendary: 10 }
};
const ROI = { Common: 0.02, Rare: 0.05, Epic: 0.08, Legendary: 0.10 };

function weightedPick(weights) {
  const total = Object.values(weights).reduce((a,b)=>a+b,0);
  let r = Math.random() * total;
  for (const [tier, w] of Object.entries(weights)) {
    if (r < w) return tier;
    r -= w;
  }
  return "Common";
}

// Health
app.get("/api/health", (_, res) => {
  res.json({ ok: true, admin: ADMIN_WALLET, aliens: ALIEN_COUNT, rpc: RPC_URL });
});

// Fresh thumbnails for roulette (random every time)
app.get("/api/get-random-aliens", (req, res) => {
  const count = Math.min(parseInt(req.query.count || "16", 10), ALIEN_COUNT);
  const exclude = new Set(
    (req.query.exclude || "").split(",").map(s => parseInt(s,10)).filter(Boolean)
  );
  const pool = ALIENS.filter(a => !exclude.has(a.id));
  // shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  res.json(pool.slice(0, count));
});

// Authoritative spin
app.post("/api/spin", (req, res) => {
  const { wallet, eggType = "basic" } = req.body || {};
  const mod = EGG_MOD[eggType] || EGG_MOD.basic;
  const weights = {
    Common: BASE_WEIGHTS.Common,
    Rare: BASE_WEIGHTS.Rare,
    Epic: BASE_WEIGHTS.Epic + (mod.Epic || 0),
    Legendary: BASE_WEIGHTS.Legendary + (mod.Legendary || 0),
  };
  const tier = weightedPick(weights);
  const alien = ALIENS[Math.floor(Math.random() * ALIENS.length)];

  const payload = {
    spinId: nanoid(),
    wallet,
    tier,
    roi: ROI[tier],
    alien,             // { id, image }
    timestamp: Date.now()
  };
  const serverSignature = crypto
    .createHmac("sha256", process.env.SERVER_HMAC_SECRET || "dev")
    .update(JSON.stringify(payload))
    .digest("hex");

  res.json({ ...payload, serverSignature });
});

/**
 * Prepare a SOL transfer for spaceship purchase (user signs & sends)
 * Request: { wallet: <user pubkey>, level: 1|2|3 }
 * Pricing: lv1=$30 (0.3 SOL), lv2=$60 (0.6 SOL), lv3=$120 (1.2 SOL)  <-- adjust rates as needed
 */
app.post("/api/buy-spaceship", async (req, res) => {
  try {
    const { wallet, level } = req.body || {};
    if (!wallet || !level) return res.status(400).json({ error: "missing fields" });

    // Convert USD→SOL: simple static example (1 SOL = $100) – change for your needs
    const priceUSD = level === 1 ? 30 : level === 2 ? 60 : level === 3 ? 120 : null;
    if (!priceUSD) return res.status(400).json({ error: "invalid level" });
    const usdPerSol = 100; // set your own peg or fetch a live price server-side
    const amountSol = priceUSD / usdPerSol;

    const admin = new PublicKey(ADMIN_WALLET);
    const tx = await buildTransferTx({
      rpcUrl: RPC_URL, fromPubkey: wallet, toPubkey: admin, amountSol
    });

    // encode to base64 so frontend can reconstruct & sign
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    res.json({ serialized, amountSol, admin: admin.toBase58(), level });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// (Optional) Mint prep – stub for now. Replace with Metaplex mint generation later.
app.post("/api/prepare-mint", async (req, res) => {
  const { wallet, alienId } = req.body || {};
  if (!wallet || !alienId) return res.status(400).json({ error: "missing fields" });
  res.json({ note: "Minting stub: integrate Metaplex SDK here later.", alienId });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Zeruva API running on", PORT));
