const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js");

/**
 * Build a SOL transfer tx for the user to sign.
 * amountSol: number (e.g. 0.3)
 */
async function buildTransferTx({ rpcUrl, fromPubkey, toPubkey, amountSol }) {
  const connection = new Connection(rpcUrl, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash();

  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: new PublicKey(fromPubkey) });
  tx.add(SystemProgram.transfer({
    fromPubkey: new PublicKey(fromPubkey),
    toPubkey: new PublicKey(toPubkey),
    lamports: Math.round(amountSol * 1e9),
  }));

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
