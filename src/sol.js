const { Connection, PublicKey, SystemProgram, Transaction } = require("@solana/web3.js");

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

module.exports = { buildTransferTx };
