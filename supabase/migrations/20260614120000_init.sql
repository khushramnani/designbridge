-- DesignBridge relay — initial schema (TECHNICAL-SPEC §4).
-- Applied via the relay's migration runner (src/store/postgres.ts) or the Supabase CLI.
-- Statements are plain DDL; the runner makes re-application idempotent by ignoring
-- "already exists" errors, so this also runs cleanly on pg-mem (fresh DB) for tests.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  key_hash text not null unique,            -- sha256(raw key)
  key_prefix text not null,                 -- "db_live_a1b2" for display
  name text,
  rate_limit_per_min int not null default 10,
  daily_render_limit int not null default 100,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  plugin_token_hash text unique,            -- long-lived token, hashed
  label text,                               -- e.g. Figma file/user hint
  last_connected_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists pairings (
  code text primary key,                    -- 6 chars, A-Z2-9 (no 0/O/1/I)
  channel_id uuid not null references channels(id),
  expires_at timestamptz not null,          -- now() + 10 min
  claimed_by_key uuid references api_keys(id),
  claimed_at timestamptz
);

create table if not exists key_channels (   -- which keys may send to which channels
  api_key_id uuid not null references api_keys(id),
  channel_id uuid not null references channels(id),
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (api_key_id, channel_id)
);

create type render_kind as enum ('capture','html','url');
create type render_status as enum
  ('queued','translating','delivering','delivered','done','failed');

create table if not exists renders (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid not null references api_keys(id),
  channel_id uuid not null references channels(id),
  kind render_kind not null,
  status render_status not null default 'queued',
  schema_version text,
  payload_path text,                        -- Storage path of capture JSON (Phase 2)
  payload_bytes int,
  name text,
  warnings jsonb not null default '[]',
  error jsonb,                              -- { code, message }
  summary jsonb,                            -- { layers, rasterRegions, fontsSubstituted } (plugin render.done)
  timing jsonb not null default '{}',       -- { translateMs, deliverMs, buildMs }
  payload_token text,                       -- one-shot token authorizing the payload fetch
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists renders_key_created_idx on renders (api_key_id, created_at desc);
create index if not exists renders_channel_status_idx on renders (channel_id, status);

create table if not exists assets (
  hash text primary key,                    -- "sha256:<hex>"
  mime text not null,
  bytes int not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create table if not exists render_assets (
  render_id uuid not null references renders(id),
  asset_hash text not null references assets(hash),
  primary key (render_id, asset_hash)
);

-- Phase-1 payload store. Capture JSON is held here (as text) until Phase 2 moves blobs to
-- Supabase Storage and populates renders.payload_path instead. See docs/DECISIONS.md D3.
create table if not exists render_payloads (
  render_id uuid primary key references renders(id),
  body text not null
);
