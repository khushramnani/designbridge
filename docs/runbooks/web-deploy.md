# Runbook — Deploy `apps/web` (designbridge.io) to Vercel

The website + dashboard + account API run on Vercel (serverless). The **relay** and **worker** do
NOT run here — they need a persistent server (the VPS); see PRODUCTION-PLAN §5. The web app and the
relay share the **same Supabase Postgres** (docs/DECISIONS.md D6), which is how a key minted in the
dashboard is immediately valid at the relay.

## 1. Vercel project settings

- **Root Directory:** `apps/web` (Settings → General → Root Directory). This is the only setting that
  must be done in the dashboard; everything else is in `apps/web/vercel.json`.
- **Framework:** Next.js (auto-detected).
- **Install / Build commands:** come from `apps/web/vercel.json`:
  - install: `cd ../.. && pnpm install --frozen-lockfile` (installs the whole pnpm workspace).
  - build: `cd ../.. && pnpm --filter @designbridge/app-web... build` — the trailing `...` builds web
    **and its workspace deps in topo order** (`schema` → `relay` → `web`). Required because web
    imports the relay's compiled `dist`.
- **Node:** 22 (pinned via `apps/web/package.json` `engines.node`).
- Output (`apps/web/.next`) is found automatically because Root Directory is `apps/web`.

## 2. Environment variables (Vercel → Settings → Environment Variables)

| Var | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | public |
| `WEB_STORE` | `postgres` | in-memory won't persist on serverless |
| `DATABASE_URL` | Supabase **pooled** string | see pooling note below |
| `NEXT_PUBLIC_RELAY_URL` | `https://relay.designbridge.io` | shown in dashboard pairing helper + docs |
| `NEXT_PUBLIC_SITE_URL` | `https://designbridge.io` | magic-link redirect base |

### Pooling note (important)
Serverless functions open many short-lived connections. Use Supabase's **transaction pooler**
endpoint for `DATABASE_URL` (host `...pooler.supabase.com`, port **6543**), not the direct `5432`
string — otherwise you exhaust Postgres connections under load. The relay (on the VPS, a long-lived
process) can keep using the direct connection.

## 3. Supabase Auth configuration (magic-link will silently fail without this)

In Supabase → Authentication → URL Configuration:
- **Site URL:** `https://designbridge.io`
- **Redirect URLs (allow list):** add `https://designbridge.io/auth/callback` (and your Vercel
  preview domain + `http://localhost:3000/auth/callback` for local dev).

The sign-in form sends the user a link back to `${origin}/auth/callback`, which exchanges the code
for a session. If the redirect URL isn't allow-listed, the link bounces to `/signin?error=link`.

## 4. First deploy checklist

1. Set Root Directory = `apps/web`; push to `main` (or import the repo) → Vercel builds via vercel.json.
2. Add all env vars above; redeploy so they take effect.
3. Configure Supabase Auth URLs (§3).
4. Smoke test: visit `/`, `/docs`, sign in at `/signin` (check inbox → lands on `/dashboard`),
   create + revoke a key, confirm the usage panel renders.
5. Pair: run the Figma plugin → enter its code + a key in the dashboard pairing helper → expect a
   "Paired" message (requires the relay to be live on the VPS).

## 5. Local dev

```
cp apps/web/.env.example apps/web/.env.local   # fill in Supabase + (optional) DATABASE_URL
pnpm --filter @designbridge/app-relay build     # web imports relay's dist
pnpm --filter @designbridge/app-web dev         # http://localhost:3000
```
Without Supabase env the app still renders and shows "auth not configured"; without `DATABASE_URL`
it uses an ephemeral in-memory store.
