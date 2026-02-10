const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js");

/**
 * Build a SOL transfer tx for the user to sign.
 * Prefer passing an integer lamports amount to avoid rounding issues.
 */
async function buildTransferTx({ rpcUrl, fromPubkey, toPubkey, lamports, amountSol }) {
  const connection = new Connection(rpcUrl, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash();

  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: new PublicKey(fromPubkey),
  });

  const resolvedLamports = (() => {
    if (Number.isFinite(lamports) && lamports > 0) return Math.floor(lamports);
    if (Number.isFinite(amountSol) && amountSol > 0) return Math.ceil(amountSol * 1e9);
    throw new Error("Missing transfer amount (lamports or amountSol)");
  })();

  tx.add(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(fromPubkey),
      toPubkey: new PublicKey(toPubkey),
      lamports: resolvedLamports,
    })
  );

  return tx; // caller will serialize to base64 as needed
}

async function verifySolPayment({
  rpcUrl,
  signature,
  expectedFrom,
  expectedTo,
  minLamports,
}) {
  const connection = new Connection(rpcUrl, "confirmed");

  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    return { ok: false, reason: "Transaction not found" };
  }

  if (tx.meta?.err) {
    return { ok: false, reason: "Transaction failed" };
  }

  const from = expectedFrom ? new PublicKey(expectedFrom).toBase58() : null;
  const to = expectedTo ? new PublicKey(expectedTo).toBase58() : null;

  // Look for a SystemProgram transfer instruction
  const instructions = tx.transaction.message.instructions || [];
  let matchedLamports = 0;

  for (const ix of instructions) {
    if (ix.program !== "system") continue;
    // parsed transfer looks like: { type: "transfer", info: { source, destination, lamports } }
    const parsed = ix.parsed;
    if (!parsed || parsed.type !== "transfer") continue;

    const info = parsed.info || {};
    const src = info.source;
    const dst = info.destination;
    const lamports = Number(info.lamports || 0);

    if (from && src !== from) continue;
    if (to && dst !== to) continue;

    matchedLamports += lamports;
  }

  if (matchedLamports < minLamports) {
    return {
      ok: false,
      reason: `Insufficient payment (${matchedLamports} < ${minLamports})`,
      matchedLamports,
    };
  }

  return { ok: true, matchedLamports, slot: tx.slot, blockTime: tx.blockTime };
}

module.exports = { buildTransferTx, verifySolPayment };
