#!/usr/bin/env node
/**
 * One-time fix: updates on-chain metadata URI for aliens minted with wrong arweave.net URIs.
 * Run with:  node nft/fix-metadata-uri.js
 *
 * Pass alien db IDs as args, e.g.:  node nft/fix-metadata-uri.js 10
 * Or pass "all" to fix every alien with an arweave.net URI:  node nft/fix-metadata-uri.js all
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { Keypair, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58").default;
const { getMetaplex } = require("./metaplex");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const {
  toMetaplexFile,
} = require("@metaplex-foundation/js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === "disable" ? false : undefined });

function loadKeypair() {
  const secretKeyStr = process.env.DEV_WALLET_SECRET_KEY;
  let bytes;
  try {
    const trimmed = secretKeyStr.trim();
    if (trimmed.startsWith("[")) bytes = Uint8Array.from(JSON.parse(trimmed));
    else bytes = bs58.decode(trimmed);
  } catch {
    bytes = Uint8Array.from(Buffer.from(secretKeyStr.trim(), "base64"));
  }
  return Keypair.fromSecretKey(bytes);
}

function fixUri(uri) {
  return uri.replace("https://arweave.net/", "https://devnet.irys.xyz/");
}

const TIER_DESCRIPTIONS = {
  Common:    "A Common alien from the Zeruva universe. Assigned to your colony for daily passive income.",
  Rare:      "A Rare alien with heightened abilities. Sends stronger signals from distant planets.",
  Epic:      "An Epic alien. Few exist in the universe — this one brings serious earnings.",
  Legendary: "A Legendary alien. The rarest of the rare. Maximum daily ROI, maximum prestige.",
};
const DAILY_REWARD = { Nothing: 0, Common: 2, Rare: 5, Epic: 8, Legendary: 10 };

async function fixAlien(mx, keypair, row) {
  const { id, alien_id, tier, nft_mint } = row;
  console.log(`\n[fix] db#${id} alien#${alien_id} (${tier}) mint=${nft_mint}`);

  // Upload image
  console.log(`  Uploading image #${alien_id}...`);
  const imagePath = path.join(__dirname, "../public", `${alien_id}.png`);
  const imageBuffer = fs.readFileSync(imagePath);
  const imageFile = toMetaplexFile(imageBuffer, `${alien_id}.png`, { contentType: "image/png" });
  const rawImageUri = await mx.storage().upload(imageFile);
  const imageUri = fixUri(rawImageUri);
  console.log(`  Image URI: ${imageUri}`);

  // Build + upload metadata
  const metadata = {
    name: `Zeruva Alien #${alien_id}`,
    symbol: "ZRV",
    description: TIER_DESCRIPTIONS[tier] || "A Zeruva alien.",
    image: imageUri,
    external_url: "https://aeruva.io",
    attributes: [
      { trait_type: "Alien ID", value: String(alien_id) },
      { trait_type: "Tier",     value: tier },
      { trait_type: "Daily ROI", value: `$${DAILY_REWARD[tier] ?? 0}` },
    ],
    properties: {
      files: [{ uri: imageUri, type: "image/png" }],
      category: "image",
    },
  };
  console.log(`  Uploading metadata...`);
  const { uri: rawUri } = await mx.nfts().uploadMetadata(metadata);
  const uri = fixUri(rawUri);
  console.log(`  Metadata URI: ${uri}`);

  // Update on-chain
  console.log(`  Updating on-chain URI...`);
  const nft = await mx.nfts().findByMint({ mintAddress: new PublicKey(nft_mint) });
  await mx.nfts().update({ nftOrSft: nft, uri });
  console.log(`  ✅ Done — db#${id} updated`);
}

async function main() {
  const keypair = loadKeypair();
  const mx = getMetaplex(keypair);
  console.log("Admin wallet:", keypair.publicKey.toBase58());

  let rows;
  const args = process.argv.slice(2);
  if (args[0] === "all") {
    const res = await pool.query(
      `SELECT id, alien_id, tier, nft_mint FROM aliens WHERE nft_mint IS NOT NULL ORDER BY id`
    );
    rows = res.rows;
  } else if (args.length > 0) {
    const ids = args.map(Number).filter(Boolean);
    const res = await pool.query(
      `SELECT id, alien_id, tier, nft_mint FROM aliens WHERE id = ANY($1) AND nft_mint IS NOT NULL`,
      [ids]
    );
    rows = res.rows;
  } else {
    console.error("Usage: node nft/fix-metadata-uri.js <db_id> [db_id...]\n       node nft/fix-metadata-uri.js all");
    process.exit(1);
  }

  if (!rows.length) { console.log("No aliens found."); process.exit(0); }
  console.log(`Fixing ${rows.length} alien(s)...`);

  for (const row of rows) {
    try {
      await fixAlien(mx, keypair, row);
    } catch (e) {
      console.error(`  ❌ Failed db#${row.id}:`, e.message);
    }
  }

  await pool.end();
  console.log("\nAll done.");
}

main().catch(e => { console.error(e); process.exit(1); });
