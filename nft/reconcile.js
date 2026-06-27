// One-off reconcile: make the DB match on-chain NFT ownership (devnet).
// The 429-throttled public RPC let DB ownership drift from the chain (e.g. a
// "sold" alien whose NFT release failed). Dry-run by default; --apply to write.
//
//   node nft/reconcile.js            # report only
//   node nft/reconcile.js --apply    # apply DB fixes (no on-chain sends)
require("dotenv").config();
const { Pool } = require("pg");
const { getNftOwner } = require("./escrow");

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const ADMIN_WALLET = process.env.ADMIN_WALLET || "";
const APPLY = process.argv.includes("--apply");
const short = (s) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-4)}` : "—");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (t, p) => pool.query(t, p);

  const aliens = (await q(
    `SELECT id, alien_id, wallet, nft_mint FROM aliens WHERE nft_mint IS NOT NULL ORDER BY id`
  )).rows;

  console.log(`RPC=${RPC_URL.replace(/api-key=.*/, "api-key=***")}`);
  console.log(`ADMIN(escrow)=${short(ADMIN_WALLET)}  minted-aliens=${aliens.length}  mode=${APPLY ? "APPLY" : "dry-run"}\n`);

  const fixes = [];
  for (const a of aliens) {
    let owner = null;
    try {
      owner = await getNftOwner({ rpcUrl: RPC_URL, mint: a.nft_mint });
    } catch (e) {
      console.log(`#${a.id} alien ${a.alien_id} mint ${short(a.nft_mint)}  RPC ERROR: ${e.message}`);
      continue;
    }

    const listing = (await q(
      `SELECT id, status FROM marketplace_listings
       WHERE alien_db_id=$1 AND status IN ('active','pending_escrow')
       ORDER BY listed_at DESC LIMIT 1`, [a.id]
    )).rows[0];

    const inEscrow = !!ADMIN_WALLET && owner === ADMIN_WALLET;
    const matches = owner === a.wallet;
    let verdict = "ok";

    if (!owner) {
      verdict = "no on-chain holder (burned/unminted?) — left as-is";
    } else if (!inEscrow && !matches) {
      // Desync: DB owner doesn't actually hold it and it isn't escrowed → chain wins.
      verdict = `FIX owner ${short(a.wallet)} -> ${short(owner)}` + (listing ? ` + cancel list#${listing.id}` : "");
      fixes.push(async () => {
        await q(`UPDATE aliens SET wallet=$1 WHERE id=$2`, [owner, a.id]);
        if (listing) await q(`UPDATE marketplace_listings SET status='cancelled' WHERE id=$1`, [listing.id]);
      });
    } else if (listing && !inEscrow) {
      // Listing claims escrow but the NFT never left the seller → bogus listing.
      verdict = `CANCEL list#${listing.id} (${listing.status}; NFT not in escrow)`;
      fixes.push(async () => q(`UPDATE marketplace_listings SET status='cancelled' WHERE id=$1`, [listing.id]));
    } else if (inEscrow && listing && listing.status === "pending_escrow") {
      // The deposit actually landed → the listing is really live.
      verdict = `ACTIVATE list#${listing.id} (escrow confirmed on-chain)`;
      fixes.push(async () => q(`UPDATE marketplace_listings SET status='active' WHERE id=$1`, [listing.id]));
    } else if (inEscrow && !listing) {
      verdict = `ORPHAN in escrow (db owner ${short(a.wallet)}) — needs manual return`;
    }

    console.log(
      `#${a.id} alien ${a.alien_id}  mint ${short(a.nft_mint)}  db=${short(a.wallet)}  chain=${short(owner)}${inEscrow ? "(ESCROW)" : ""}  ${listing ? `list#${listing.id}/${listing.status}` : "no-listing"}  => ${verdict}`
    );
  }

  if (fixes.length && APPLY) {
    console.log(`\nApplying ${fixes.length} DB fix(es)…`);
    for (const f of fixes) await f();
    console.log("done.");
  } else if (fixes.length) {
    console.log(`\n${fixes.length} fix(es) pending — re-run with --apply to write them.`);
  } else {
    console.log("\nNothing to fix. ✅");
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
