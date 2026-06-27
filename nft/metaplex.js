"use strict";

const {
  Metaplex,
  keypairIdentity,
  irysStorage,
  toMetaplexFile,
  PublicKey: MetaplexPublicKey,
} = require("@metaplex-foundation/js");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const { buildAlienMetadata } = require("./metadata");

let _mx = null;

function getMetaplex(keypair) {
  if (_mx) return _mx;

  const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  _mx = Metaplex.make(connection)
    .use(keypairIdentity(keypair))
    .use(
      irysStorage({
        address: "https://devnet.irys.xyz",
        providerUrl: rpcUrl,
        timeout: 60000,
      })
    );

  return _mx;
}

/**
 * Upload metadata JSON to Bundlr (Arweave on devnet).
 * Returns the Arweave URI string.
 */
async function uploadMetadata(mx, metadataJson) {
  const { uri } = await mx.nfts().uploadMetadata(metadataJson);
  return uri;
}

/**
 * Create the Zeruva Aliens collection NFT.
 * Run once via setup-collection.js — saves the mint address to .env.
 *
 * Returns the collection mint PublicKey.
 */
async function createCollection(keypair) {
  const mx = getMetaplex(keypair);
  const imageBaseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3002";

  console.log("Uploading collection metadata to Bundlr...");
  const collectionMetadata = {
    name: "Zeruva Aliens",
    symbol: "ZRV",
    description: "198 unique aliens from the Zeruva universe. Hatch, assign, and earn passive SOL.",
    image: `${imageBaseUrl}/static/1.png`,
    external_url: imageBaseUrl,
    properties: {
      files: [{ uri: `${imageBaseUrl}/static/1.png`, type: "image/png" }],
      category: "image",
    },
  };

  const collectionUri = await uploadMetadata(mx, collectionMetadata);
  console.log("Collection metadata URI:", collectionUri);

  console.log("Minting collection NFT...");
  const { nft: collectionNft } = await mx.nfts().create({
    name: "Zeruva Aliens",
    symbol: "ZRV",
    uri: collectionUri,
    sellerFeeBasisPoints: 500, // 5% royalty
    isCollection: true,
    collectionIsSized: true,
  });

  console.log("Collection NFT minted:", collectionNft.address.toBase58());
  return collectionNft.address;
}

/**
 * Mint a single alien NFT to a player's wallet.
 *
 * @param {Keypair} keypair - Admin/payer keypair
 * @param {number}  alienId - 1–198
 * @param {string}  tier    - Common / Rare / Epic / Legendary
 * @param {string}  toWallet - player's base58 wallet address
 * @returns {Promise<string>} mint address of the new NFT
 */
// Metaplex SDK always returns arweave.net URIs even for Irys devnet uploads.
// Devnet data lives on devnet.irys.xyz, not arweave.net — rewrite so wallets can fetch it.
function fixIrysUri(uri) {
  const irysAddress = process.env.IRYS_ADDRESS || "https://devnet.irys.xyz";
  if (irysAddress.includes("devnet.irys.xyz")) {
    return uri.replace("https://arweave.net/", "https://devnet.irys.xyz/");
  }
  return uri;
}

async function mintAlienNft(keypair, alienId, tier, toWallet) {
  const mx = getMetaplex(keypair);
  const collectionMintStr = process.env.COLLECTION_MINT;

  // Upload image to Irys and fix the URI so wallets can actually reach it.
  console.log(`[NFT] Uploading image for alien #${alienId}...`);
  const imagePath = path.join(__dirname, "../public", `${alienId}.png`);
  const imageBuffer = fs.readFileSync(imagePath);
  const imageFile = toMetaplexFile(imageBuffer, `${alienId}.png`, { contentType: "image/png" });
  const imageUri = fixIrysUri(await mx.storage().upload(imageFile));
  console.log(`[NFT] Image URI: ${imageUri}`);

  // Build metadata with the corrected image URI and upload it too.
  const { buildAlienMetadata } = require("./metadata");
  const metadata = buildAlienMetadata(alienId, tier, "");
  metadata.image = imageUri;
  metadata.external_url = "https://aeruva.io";
  metadata.properties.files = [{ uri: imageUri, type: "image/png" }];

  console.log(`[NFT] Uploading metadata for alien #${alienId}...`);
  const uri = fixIrysUri(await uploadMetadata(mx, metadata));
  console.log(`[NFT] Metadata URI: ${uri}`);

  const mintParams = {
    name: `Zeruva Alien #${alienId}`,
    symbol: "ZRV",
    uri,
    sellerFeeBasisPoints: 500,
    tokenOwner: new MetaplexPublicKey(toWallet),
  };

  if (collectionMintStr) {
    mintParams.collection = new MetaplexPublicKey(collectionMintStr);
  }

  console.log(`[NFT] Minting to ${toWallet}...`);
  const { nft } = await mx.nfts().create(mintParams);

  // Verify collection membership if collection exists
  if (collectionMintStr) {
    try {
      await mx.nfts().verifyCollection({
        mintAddress: nft.address,
        collectionMintAddress: new MetaplexPublicKey(collectionMintStr),
      });
      console.log(`[NFT] Collection verified for mint ${nft.address.toBase58()}`);
    } catch (e) {
      console.warn("[NFT] Collection verification failed (non-fatal):", e.message);
    }
  }

  console.log(`[NFT] Minted alien #${alienId} → ${nft.address.toBase58()}`);
  return nft.address.toBase58();
}

module.exports = { createCollection, mintAlienNft, getMetaplex };
