#!/usr/bin/env node
// Quoting-proof pairing helper (avoids PowerShell curl/Invoke-RestMethod escaping pitfalls).
//
//   node scripts/pair.mjs <CODE> [API_KEY]
//
// API key resolves from: arg 2  →  $env:DEV_API_KEY  →  error.
// Relay URL from $env:RELAY_URL (default http://localhost:8080).

const code = process.argv[2];
const key = process.argv[3] ?? process.env.DEV_API_KEY;
const relay = process.env.RELAY_URL ?? "http://localhost:8080";

if (!code || !key) {
  console.error("usage: node scripts/pair.mjs <CODE> [API_KEY]");
  console.error("  (API_KEY may instead come from $env:DEV_API_KEY)");
  process.exit(2);
}

const res = await fetch(`${relay}/v1/pair`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ code: code.toUpperCase() }),
});
const text = await res.text();
if (res.ok) {
  console.log(`✓ paired (${res.status}): ${text}`);
  console.log("  The plugin should now show 'Paired ✓'. Leave it open.");
} else {
  console.error(`✗ pair failed (${res.status}): ${text}`);
  process.exit(1);
}
