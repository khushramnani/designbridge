/**
 * Centralised env access. Everything here must tolerate *missing* values so `next build` (which
 * evaluates modules without production secrets) never throws — features degrade to a clear
 * "not configured" state at runtime instead. Real values are injected on Vercel / the VPS.
 */

// Supabase Auth (magic-link). The publishable key (sb_publishable_…) is the modern, browser-safe
// key; we still accept the legacy anon key as a fallback so older projects keep working.
const rawSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const rawSupabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
  "";

/** True only when both Supabase values are present — the UI gates sign-in on this. */
export function supabaseConfigured(): boolean {
  return rawSupabaseUrl.length > 0 && rawSupabasePublishableKey.length > 0;
}

// supabase-js throws on an empty URL/key, so fall back to inert placeholders when unconfigured.
// The client is only ever *used* behind a supabaseConfigured() guard, so these never hit the wire.
export const SUPABASE_URL = rawSupabaseUrl || "https://placeholder.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = rawSupabasePublishableKey || "placeholder-publishable-key";

/** Postgres connection string shared with the relay (docs/DECISIONS.md D6). */
export const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? "";

/** Which Store impl to use; `postgres` requires DATABASE_URL. Defaults to in-memory for dev. */
export const WEB_STORE = (process.env.WEB_STORE ?? process.env.RELAY_STORE ?? "memory").trim();

/** Public relay base URL, surfaced in the dashboard pairing helper + docs snippets. */
export const RELAY_PUBLIC_URL =
  process.env.NEXT_PUBLIC_RELAY_URL?.trim() ||
  process.env.RELAY_PUBLIC_URL?.trim() ||
  "http://localhost:8080";

/** Public site origin, used to build the magic-link redirect target. */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000";
