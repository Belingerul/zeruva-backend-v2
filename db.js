const { Pool } = require("pg")

// Uses the DATABASE_URL you referenced in Railway
// In dev, if DATABASE_URL is not set, we fall back to an in-memory Postgres (pg-mem)
// so the app can run locally without installing PostgreSQL.
let pool;

if (!process.env.DATABASE_URL && (process.env.NODE_ENV || "development") !== "production") {
  const { newDb } = require("pg-mem");
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const pg = mem.adapters.createPg();
  pool = new pg.Pool();
  console.warn("⚠️  DATABASE_URL not set. Using in-memory Postgres (pg-mem) for local dev.");
} else {
  // SECURITY NOTE:
  // - `rejectUnauthorized: false` disables TLS cert validation (MITM risk).
  // - Some platforms (e.g. Railway) may require relaxed validation; make it configurable.
  const ssl = (() => {
    if (process.env.PGSSLMODE === "disable") return false;

    // Default to secure verification.
    const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false";

    // Optional custom CA (PEM string)
    const ca = process.env.DB_SSL_CA;

    return {
      rejectUnauthorized,
      ...(ca ? { ca } : {}),
    };
  })();

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
  });
}

async function query(text, params) {
  return pool.query(text, params)
}

// This will be used to create tables on startup
async function initDb() {
  // 1) users table
await query(`
  CREATE TABLE IF NOT EXISTS users (
    wallet TEXT PRIMARY KEY,
    ship_level INTEGER DEFAULT 1,
    expedition_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  );
`);

// 1a) ensure last_claim_at column exists
await query(`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'last_claim_at'
    ) THEN
      ALTER TABLE users
      ADD COLUMN last_claim_at TIMESTAMP DEFAULT NOW();
    END IF;
  END$$;
`);

// 1b) ensure total_claimed_points column exists (NUMERIC for high precision)
await query(`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'total_claimed_points'
    ) THEN
      ALTER TABLE users
      ADD COLUMN total_claimed_points NUMERIC(30, 10) DEFAULT 0;
    END IF;
  END$$;
`);

// 1c) ensure pending_earnings column exists (NUMERIC for high precision)
await query(`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'pending_earnings'
    ) THEN
      ALTER TABLE users
      ADD COLUMN pending_earnings NUMERIC(30, 10) DEFAULT 0;
    END IF;
  END$$;
`);

// 1d) migrate pending_points to pending_earnings if pending_points exists
await query(`
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'pending_points'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'pending_earnings'
    ) THEN
      UPDATE users
      SET pending_earnings = COALESCE(pending_earnings, 0) + COALESCE(pending_points, 0)
      WHERE pending_points IS NOT NULL AND pending_points > 0;
      ALTER TABLE users DROP COLUMN IF EXISTS pending_points;
    END IF;
  END$$;
`);
  // 2) aliens owned by users
  await query(`
    CREATE TABLE IF NOT EXISTS aliens (
      id SERIAL PRIMARY KEY,
      wallet TEXT REFERENCES users(wallet),
      alien_id INTEGER NOT NULL,
      image TEXT NOT NULL,
      tier TEXT NOT NULL,
      roi DOUBLE PRECISION NOT NULL,
      obtained_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 3) which alien is placed in which ship slot
  await query(`
    CREATE TABLE IF NOT EXISTS ship_slots (
      id SERIAL PRIMARY KEY,
      wallet TEXT REFERENCES users(wallet),
      slot_index INTEGER NOT NULL,
      alien_fk INTEGER REFERENCES aliens(id)
    );
  `);

  // 3a) ensure UNIQUE(wallet, slot_index) for ON CONFLICT (wallet, slot_index)
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ship_slots_wallet_slot_unique'
      ) THEN
        ALTER TABLE ship_slots
        ADD CONSTRAINT ship_slots_wallet_slot_unique
        UNIQUE (wallet, slot_index);
      END IF;
    END$$;
  `);

  // 3b) optional but recommended: each alien only once per wallet
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ship_slots_wallet_alien_unique'
      ) THEN
        ALTER TABLE ship_slots
        ADD CONSTRAINT ship_slots_wallet_alien_unique
        UNIQUE (wallet, alien_fk);
      END IF;
    END$$;
  `);

  console.log("✅ Database tables ensured/created");
}

module.exports = {
  query,
  initDb,
}
