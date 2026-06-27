// Marketplace NFT escrow (devnet).
// Listing: seller signs a transfer of the NFT to the admin (escrow) wallet.
// Sale:    server sends the NFT from escrow to the buyer.
// Unlist:  server sends the NFT from escrow back to the seller.

const { Connection, PublicKey, Transaction } = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} = require("@solana/spl-token");

// The public devnet RPC rate-limits aggressively; retry once after a pause
// before giving up so a single 429 doesn't fail the whole flow.
async function withRpcRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!String(e?.message || "").includes("429")) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    return fn();
  }
}

// Unsigned tx: seller -> escrow (seller pays fees + ATA rent, signs client-side)
async function buildEscrowDepositTx({ rpcUrl, mint, sellerPubkey, escrowPubkey }) {
  const connection = new Connection(rpcUrl, "confirmed");
  const mintPk = new PublicKey(mint);
  const seller = new PublicKey(sellerPubkey);
  const escrow = new PublicKey(escrowPubkey);

  const fromAta = await getAssociatedTokenAddress(mintPk, seller);
  const toAta = await getAssociatedTokenAddress(mintPk, escrow);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(seller, toAta, escrow, mintPk),
    createTransferInstruction(fromAta, toAta, seller, 1),
  );
  tx.feePayer = seller;
  const { blockhash } = await withRpcRetry(() => connection.getLatestBlockhash("confirmed"));
  tx.recentBlockhash = blockhash;
  return tx;
}

// Server-signed: escrow -> recipient (admin keypair pays fees)
async function sendNftFromEscrow({ rpcUrl, mint, escrowKeypair, toPubkey }) {
  const connection = new Connection(rpcUrl, "confirmed");
  const mintPk = new PublicKey(mint);
  const to = new PublicKey(toPubkey);

  const fromAta = await getAssociatedTokenAddress(mintPk, escrowKeypair.publicKey);
  const toAta = await getAssociatedTokenAddress(mintPk, to);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(escrowKeypair.publicKey, toAta, to, mintPk),
    createTransferInstruction(fromAta, toAta, escrowKeypair.publicKey, 1),
  );
  const sig = await connection.sendTransaction(tx, [escrowKeypair]);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// Who currently holds the NFT (owner of the token account with balance 1)?
async function getNftOwner({ rpcUrl, mint }) {
  const connection = new Connection(rpcUrl, "confirmed");
  const largest = await withRpcRetry(() => connection.getTokenLargestAccounts(new PublicKey(mint)));
  const holder = largest.value.find((a) => Number(a.amount) > 0);
  if (!holder) return null;
  const info = await withRpcRetry(() => connection.getParsedAccountInfo(holder.address));
  return info.value?.data?.parsed?.info?.owner || null;
}

module.exports = { buildEscrowDepositTx, sendNftFromEscrow, getNftOwner };
