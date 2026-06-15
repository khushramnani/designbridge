// Verify the web app can reach the configured Postgres (e.g. Supabase pooler) and that the schema
// is present. Mirrors apps/web/src/lib/store.ts connection logic. Read-only — never prints the URL.
//
// Run (from apps/web, so `pg` resolves):
//   cd apps/web && node --env-file=.env.local ../../scripts/verify-db.mjs
// where .env.local contains DATABASE_URL=postgresql://...pooler.supabase.com:6543/postgres

import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL is not set (put it in apps/web/.env.local).");
  process.exit(1);
}

const EXPECTED = [
  "users",
  "api_keys",
  "channels",
  "pairings",
  "key_channels",
  "renders",
  "assets",
  "render_assets",
  "render_payloads",
];

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])/.test(url);
const pool = new pg.Pool({
  connectionString: url,
  ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  connectionTimeoutMillis: 10000,
});

try {
  const { rows } = await pool.query(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  const have = new Set(rows.map((r) => r.table_name));
  const present = EXPECTED.filter((t) => have.has(t));
  const missing = EXPECTED.filter((t) => !have.has(t));

  console.log(`✓ Connected (TLS=${!isLocal}).`);
  console.log(`  Tables present: ${present.length}/${EXPECTED.length}`);
  if (missing.length) {
    console.error(`✗ Missing tables: ${missing.join(", ")}`);
    process.exit(2);
  }
  console.log("✓ All expected tables present. The web app can use this database.");
} catch (err) {
  console.error(`✗ Connection/query failed: ${err.message}`);
  console.error("  Check: correct pooled string (port 6543), password, and that WEB_STORE=postgres.");
  process.exit(1);
} finally {
  await pool.end();
}
