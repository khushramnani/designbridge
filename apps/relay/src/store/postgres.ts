import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { uuid } from "../lib/ids.js";
import type {
  ApiKey,
  AssetRecord,
  Channel,
  ChannelBinding,
  DailyCount,
  Pairing,
  Render,
  Store,
  User,
} from "./types.js";

/** Minimal query surface — satisfied by `pg.Pool`/`pg.Client` and by pg-mem's adapter in tests. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const MIGRATION_FILE = "0001_init.sql";
// "already exists" classes we ignore so migrations are idempotent (TECHNICAL-SPEC T1.1 AC).
const DUPLICATE_CODES = new Set(["42P07", "42710", "42P06", "42701", "23505"]);

/**
 * Durable Store backed by Postgres (Supabase). Same interface as InMemoryStore — see
 * docs/DECISIONS.md D1. Ids are generated in code (not relying on DB defaults) so the same code
 * path works across drivers; jsonb columns are round-tripped via the driver's native parsing.
 */
export class PostgresStore implements Store {
  constructor(private readonly db: Queryable) {}

  // --- users ---
  async getUserByEmail(email: string): Promise<User | null> {
    const { rows } = await this.db.query(`select * from users where lower(email) = lower($1)`, [
      email,
    ]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async createUser(init: { id?: string; email: string }): Promise<User> {
    const id = init.id ?? uuid();
    const createdAt = new Date().toISOString();
    const { rows } = await this.db.query(
      `insert into users (id, email, created_at) values ($1,$2,$3) returning *`,
      [id, init.email, createdAt],
    );
    return rowToUser(rows[0]!);
  }

  // --- api keys ---
  async getApiKeyByHash(hash: string): Promise<ApiKey | null> {
    const { rows } = await this.db.query(`select * from api_keys where key_hash = $1`, [hash]);
    return rows[0] ? rowToApiKey(rows[0]) : null;
  }

  async getApiKeyById(id: string): Promise<ApiKey | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.db.query(`select * from api_keys where id = $1`, [id]);
    return rows[0] ? rowToApiKey(rows[0]) : null;
  }

  async getApiKeysForUser(userId: string): Promise<ApiKey[]> {
    const { rows } = await this.db.query(
      `select * from api_keys where user_id = $1 order by created_at desc`,
      [userId],
    );
    return rows.map(rowToApiKey);
  }

  async revokeApiKey(id: string, atIso: string): Promise<void> {
    await this.db.query(`update api_keys set revoked_at = $2 where id = $1`, [id, atIso]);
  }

  async insertApiKey(key: ApiKey): Promise<void> {
    await this.db.query(
      `insert into api_keys
         (id, user_id, key_hash, key_prefix, name, rate_limit_per_min, daily_render_limit, revoked_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        key.id,
        key.userId ?? null,
        key.keyHash,
        key.keyPrefix,
        key.name ?? null,
        key.rateLimitPerMin,
        key.dailyRenderLimit,
        key.revokedAt ?? null,
        key.createdAt,
      ],
    );
  }

  // --- channels ---
  async createChannel(init: { label?: string | null }): Promise<Channel> {
    const id = uuid();
    const createdAt = new Date().toISOString();
    const { rows } = await this.db.query(
      `insert into channels (id, label, created_at) values ($1,$2,$3) returning *`,
      [id, init.label ?? null, createdAt],
    );
    return rowToChannel(rows[0]!);
  }

  async getChannel(id: string): Promise<Channel | null> {
    const { rows } = await this.db.query(`select * from channels where id = $1`, [id]);
    return rows[0] ? rowToChannel(rows[0]) : null;
  }

  async getChannelByTokenHash(hash: string): Promise<Channel | null> {
    const { rows } = await this.db.query(`select * from channels where plugin_token_hash = $1`, [
      hash,
    ]);
    return rows[0] ? rowToChannel(rows[0]) : null;
  }

  async setChannelToken(channelId: string, tokenHash: string): Promise<void> {
    await this.db.query(`update channels set plugin_token_hash = $2 where id = $1`, [
      channelId,
      tokenHash,
    ]);
  }

  async touchChannel(channelId: string, atIso: string): Promise<void> {
    await this.db.query(`update channels set last_connected_at = $2 where id = $1`, [
      channelId,
      atIso,
    ]);
  }

  // --- pairings ---
  async createPairing(pairing: Pairing): Promise<void> {
    await this.db.query(`insert into pairings (code, channel_id, expires_at) values ($1,$2,$3)`, [
      pairing.code,
      pairing.channelId,
      pairing.expiresAt,
    ]);
  }

  async getPairing(code: string): Promise<Pairing | null> {
    const { rows } = await this.db.query(`select * from pairings where code = $1`, [code]);
    return rows[0] ? rowToPairing(rows[0]) : null;
  }

  async claimPairing(code: string, apiKeyId: string, atIso: string): Promise<void> {
    await this.db.query(
      `update pairings set claimed_by_key = $2, claimed_at = $3 where code = $1`,
      [code, apiKeyId, atIso],
    );
  }

  async deletePairingsForChannel(channelId: string): Promise<void> {
    await this.db.query(`delete from pairings where channel_id = $1`, [channelId]);
  }

  // --- key <-> channel links ---
  async linkKeyChannel(apiKeyId: string, channelId: string, isDefault: boolean): Promise<void> {
    if (isDefault) {
      await this.db.query(`update key_channels set is_default = false where api_key_id = $1`, [
        apiKeyId,
      ]);
    }
    await this.db.query(
      `insert into key_channels (api_key_id, channel_id, is_default, created_at)
         values ($1,$2,$3,$4)
       on conflict (api_key_id, channel_id) do update set is_default = excluded.is_default`,
      [apiKeyId, channelId, isDefault, new Date().toISOString()],
    );
  }

  async isKeyLinkedToChannel(apiKeyId: string, channelId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `select 1 from key_channels where api_key_id = $1 and channel_id = $2`,
      [apiKeyId, channelId],
    );
    return rows.length > 0;
  }

  async getChannelsForKey(apiKeyId: string): Promise<ChannelBinding[]> {
    const { rows } = await this.db.query(
      `select c.*, kc.is_default
         from key_channels kc join channels c on c.id = kc.channel_id
        where kc.api_key_id = $1`,
      [apiKeyId],
    );
    return rows.map((r) => ({ channel: rowToChannel(r), isDefault: Boolean(r.is_default) }));
  }

  async getDefaultChannelForKey(apiKeyId: string): Promise<Channel | null> {
    const { rows } = await this.db.query(
      `select c.* from key_channels kc join channels c on c.id = kc.channel_id
        where kc.api_key_id = $1 order by kc.is_default desc limit 1`,
      [apiKeyId],
    );
    return rows[0] ? rowToChannel(rows[0]) : null;
  }

  // --- renders ---
  async createRender(render: Render): Promise<void> {
    await this.db.query(
      `insert into renders
         (id, api_key_id, channel_id, kind, status, schema_version, payload_bytes, name,
          warnings, error, summary, timing, payload_token, created_at, done_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        render.id,
        render.apiKeyId,
        render.channelId,
        render.kind,
        render.status,
        render.schemaVersion ?? null,
        render.payloadBytes ?? null,
        render.name ?? null,
        JSON.stringify(render.warnings ?? []),
        render.error ? JSON.stringify(render.error) : null,
        render.summary ? JSON.stringify(render.summary) : null,
        JSON.stringify(render.timing ?? {}),
        render.payloadToken ?? null,
        render.createdAt,
        render.doneAt ?? null,
      ],
    );
  }

  async getRender(id: string): Promise<Render | null> {
    if (!isUuid(id)) return null; // path param may be garbage; a bad uuid is simply "not found"
    const { rows } = await this.db.query(`select * from renders where id = $1`, [id]);
    return rows[0] ? rowToRender(rows[0]) : null;
  }

  async updateRender(id: string, patch: Partial<Render>): Promise<Render | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.schemaVersion !== undefined) add("schema_version", patch.schemaVersion);
    if (patch.payloadBytes !== undefined) add("payload_bytes", patch.payloadBytes);
    if (patch.name !== undefined) add("name", patch.name);
    if (patch.warnings !== undefined) add("warnings", JSON.stringify(patch.warnings));
    if (patch.error !== undefined) add("error", patch.error ? JSON.stringify(patch.error) : null);
    if (patch.summary !== undefined)
      add("summary", patch.summary ? JSON.stringify(patch.summary) : null);
    if (patch.timing !== undefined) add("timing", JSON.stringify(patch.timing));
    if (patch.payloadToken !== undefined) add("payload_token", patch.payloadToken);
    if (patch.doneAt !== undefined) add("done_at", patch.doneAt);
    if (sets.length === 0) return this.getRender(id);

    const { rows } = await this.db.query(
      `update renders set ${sets.join(", ")} where id = $1 returning *`,
      params,
    );
    return rows[0] ? rowToRender(rows[0]) : null;
  }

  async getDeliverableRenders(channelId: string): Promise<Render[]> {
    const { rows } = await this.db.query(
      `select * from renders
        where channel_id = $1 and status not in ('done','failed')
        order by created_at asc`,
      [channelId],
    );
    return rows.map(rowToRender);
  }

  async countRendersForKeySince(apiKeyId: string, sinceIso: string): Promise<number> {
    const { rows } = await this.db.query(
      `select count(*)::int as n from renders where api_key_id = $1 and created_at >= $2`,
      [apiKeyId, sinceIso],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getDailyRenderCounts(apiKeyIds: string[], sinceIso: string): Promise<DailyCount[]> {
    const ids = apiKeyIds.filter(isUuid);
    if (ids.length === 0) return [];
    // Bucket UTC days in code: portable (no `AT TIME ZONE`, which pg-mem lacks) and UTC-correct
    // regardless of the DB session timezone. Per-user windows are small (≤ a few thousand rows).
    const { rows } = await this.db.query(
      `select created_at from renders where api_key_id = any($1) and created_at >= $2`,
      [ids, sinceIso],
    );
    const byDay = new Map<string, number>();
    for (const r of rows) {
      const iso = toIso(r.created_at);
      if (!iso) continue;
      const day = iso.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    return [...byDay.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  // --- payload blobs (Phase 1: in Postgres as text; Phase 2: Supabase Storage) ---
  async putPayload(renderId: string, bytes: Buffer): Promise<void> {
    await this.db.query(
      `insert into render_payloads (render_id, body) values ($1,$2)
       on conflict (render_id) do update set body = excluded.body`,
      [renderId, bytes.toString("utf8")],
    );
  }

  async getPayload(renderId: string): Promise<Buffer | null> {
    if (!isUuid(renderId)) return null;
    const { rows } = await this.db.query(`select body from render_payloads where render_id = $1`, [
      renderId,
    ]);
    return rows[0] ? Buffer.from(String(rows[0].body), "utf8") : null;
  }

  // --- assets ---
  async upsertAsset(asset: {
    hash: string;
    mime: string;
    bytes: number;
    storagePath: string;
  }): Promise<void> {
    const at = new Date().toISOString();
    await this.db.query(
      `insert into assets (hash, mime, bytes, storage_path, created_at, last_used_at)
         values ($1,$2,$3,$4,$5,$5)
       on conflict (hash) do update set last_used_at = excluded.last_used_at`,
      [asset.hash, asset.mime, asset.bytes, asset.storagePath, at],
    );
  }

  async getAsset(hash: string): Promise<AssetRecord | null> {
    const { rows } = await this.db.query(`select * from assets where hash = $1`, [hash]);
    return rows[0] ? rowToAsset(rows[0]) : null;
  }

  async linkRenderAsset(renderId: string, assetHash: string): Promise<void> {
    await this.db.query(
      `insert into render_assets (render_id, asset_hash) values ($1,$2)
       on conflict (render_id, asset_hash) do nothing`,
      [renderId, assetHash],
    );
    await this.db.query(`update assets set last_used_at = $2 where hash = $1`, [
      assetHash,
      new Date().toISOString(),
    ]);
  }

  async gcUnreferencedAssets(cutoffIso: string): Promise<string[]> {
    const { rows } = await this.db.query(
      `delete from assets a
        where a.last_used_at < $1
          and not exists (select 1 from render_assets ra where ra.asset_hash = a.hash)
        returning a.hash`,
      [cutoffIso],
    );
    return rows.map((r) => String(r.hash));
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// --- migrations -------------------------------------------------------------

export function loadMigrationSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/store/postgres.js → ../../migrations ; src/store/postgres.ts → ../../migrations
  return readFileSync(resolve(here, "..", "..", "migrations", MIGRATION_FILE), "utf8");
}

/** Run the schema migration, ignoring "already exists" errors so re-runs are idempotent. */
export async function runMigrations(db: Queryable, sql = loadMigrationSql()): Promise<void> {
  for (const statement of splitSql(sql)) {
    try {
      await db.query(statement);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && DUPLICATE_CODES.has(code)) continue;
      throw err;
    }
  }
}

/** Split a migration file into individual statements (no functions/dollar-quotes in our DDL). */
function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter((s) => s.length > 0);
}

// --- row mappers ------------------------------------------------------------

function rowToUser(r: Record<string, unknown>): User {
  return {
    id: String(r.id),
    email: String(r.email),
    createdAt: toIso(r.created_at) ?? new Date().toISOString(),
  };
}

function rowToApiKey(r: Record<string, unknown>): ApiKey {
  return {
    id: String(r.id),
    userId: r.user_id ? String(r.user_id) : null,
    keyHash: String(r.key_hash),
    keyPrefix: String(r.key_prefix),
    name: (r.name as string | null) ?? null,
    rateLimitPerMin: Number(r.rate_limit_per_min),
    dailyRenderLimit: Number(r.daily_render_limit),
    revokedAt: toIso(r.revoked_at),
    createdAt: toIso(r.created_at) ?? new Date().toISOString(),
  };
}

function rowToChannel(r: Record<string, unknown>): Channel {
  return {
    id: String(r.id),
    pluginTokenHash: (r.plugin_token_hash as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    lastConnectedAt: toIso(r.last_connected_at),
    createdAt: toIso(r.created_at) ?? new Date().toISOString(),
  };
}

function rowToPairing(r: Record<string, unknown>): Pairing {
  return {
    code: String(r.code),
    channelId: String(r.channel_id),
    expiresAt: toIso(r.expires_at) ?? new Date().toISOString(),
    claimedByKey: r.claimed_by_key ? String(r.claimed_by_key) : null,
    claimedAt: toIso(r.claimed_at),
  };
}

function rowToRender(r: Record<string, unknown>): Render {
  return {
    id: String(r.id),
    apiKeyId: String(r.api_key_id),
    channelId: String(r.channel_id),
    kind: r.kind as Render["kind"],
    status: r.status as Render["status"],
    schemaVersion: (r.schema_version as string | null) ?? null,
    payloadBytes: r.payload_bytes == null ? null : Number(r.payload_bytes),
    name: (r.name as string | null) ?? null,
    warnings: asJson(r.warnings, []) as Render["warnings"],
    error: asJson(r.error, null) as Render["error"],
    summary: asJson(r.summary, null) as Render["summary"],
    timing: asJson(r.timing, {}) as Record<string, number>,
    payloadToken: (r.payload_token as string | null) ?? null,
    createdAt: toIso(r.created_at) ?? new Date().toISOString(),
    doneAt: toIso(r.done_at),
  };
}

function rowToAsset(r: Record<string, unknown>): AssetRecord {
  return {
    hash: String(r.hash),
    mime: String(r.mime),
    bytes: Number(r.bytes),
    storagePath: String(r.storage_path),
    createdAt: toIso(r.created_at) ?? new Date().toISOString(),
    lastUsedAt: toIso(r.last_used_at) ?? new Date().toISOString(),
  };
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** jsonb columns may arrive parsed (object) or as text depending on the driver. */
function asJson(value: unknown, fallback: unknown): unknown {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}
