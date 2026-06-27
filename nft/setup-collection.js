#!/usr/bin/env node
/**
 * One-time script: creates the Zeruva Aliens collection NFT on devnet.
 * Run with:  node nft/setup-collection.js
 *
 * After it completes, copy the printed COLLECTION_MINT address into .env.
 * The backend will then attach all hatched alien NFTs to this collection.
 *
 * Requirements:
 *   - DEV_WALLET_SECRET_KEY set in .env (admin keypair)
 *   - Admin wallet funded with devnet SOL  (get from https://faucet.solana.com)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58").default;
const { createCollection } = require("./metaplex");
const fs = require("fs");
const path = require("path");

async function main() {
  const secretKeyStr = process.env.DEV_WALLET_SECRET_KEY;
  if (!secretKeyStr) {
    console.error("DEV_WALLET_SECRET_KEY not set in .env");
    process.exit(1);
  }

  let bytes;
  try {
    const trimmed = secretKeyStr.trim();
    if (trimmed.startsWith("[")) {
      bytes = Uint8Array.from(JSON.parse(trimmed));
    } else {
      bytes = bs58.decode(trimmed);
    }
  } catch (e) {
    // base64 fallback (the current .env format)
    bytes = Uint8Array.from(Buffer.from(secretKeyStr.trim(), "base64"));
  }

  const keypair = Keypair.fromSecretKey(bytes);
  console.log("Admin wallet:", keypair.publicKey.toBase58());

  console.log("\nCreating Zeruva Aliens collection NFT on devnet...");
  console.log("(This needs devnet SOL — get some at https://faucet.solana.com)\n");

  const collectionMint = await createCollection(keypair);

  console.log("\n✅ Collection created!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Add this to zeruva-backend-v2/.env:");
  console.log(`COLLECTION_MINT=${collectionMint.toBase58()}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Auto-append to .env if COLLECTION_MINT not already there
  const envPath = path.join(__dirname, "../.env");
  const envContent = fs.readFileSync(envPath, "utf8");
  if (!envContent.split("\n").some(l => l.match(/^COLLECTION_MINT=/))) {
    fs.appendFileSync(envPath, `\nCOLLECTION_MINT=${collectionMint.toBase58()}\n`);
    console.log("✅ COLLECTION_MINT auto-appended to .env");
  }
}

main().catch((e) => {
  console.error("Setup failed:", e);
  process.exit(1);
});
