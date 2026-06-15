import {
  generateApiKey,
  keyPrefix,
  sha256,
  uuid,
  type ApiKey,
  type DailyCount,
  type Store,
  type User,
} from "@designbridge/app-relay";

/**
 * Beta limits for self-served keys (PRD §8 / TECHNICAL-SPEC §5: "generous"). The relay enforces
 * these per-key (token bucket + daily quota); the dashboard just stamps them at creation time.
 */
export const BETA_RATE_LIMIT_PER_MIN = 30;
export const BETA_DAILY_RENDER_LIMIT = 100;
export const MAX_KEYS_PER_USER = 10;

/** A key as shown in the dashboard — never includes the hash or the raw secret. */
export interface KeyView {
  id: string;
  name: string | null;
  keyPrefix: string;
  rateLimitPerMin: number;
  dailyRenderLimit: number;
  revoked: boolean;
  revokedAt: string | null;
  createdAt: string;
}

/** Returned exactly once at creation — the only time the raw secret is ever available. */
export interface IssuedKey extends KeyView {
  /** Full `db_live_...` secret. Show once, then it is unrecoverable (only the sha256 is stored). */
  rawKey: string;
}

export interface UsageReport {
  /** Renders today (UTC) across all of the user's keys. */
  today: number;
  /** Renders over the requested window across all keys. */
  total: number;
  windowDays: number;
  /** Per-UTC-day counts over the window, ascending, zero-filled. */
  daily: DailyCount[];
}

export class AccountError extends Error {
  constructor(
    readonly code: "key_limit_reached" | "key_not_found" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

function toView(k: ApiKey): KeyView {
  return {
    id: k.id,
    name: k.name ?? null,
    keyPrefix: k.keyPrefix,
    rateLimitPerMin: k.rateLimitPerMin,
    dailyRenderLimit: k.dailyRenderLimit,
    revoked: !!k.revokedAt,
    revokedAt: k.revokedAt ?? null,
    createdAt: k.createdAt,
  };
}

/**
 * Account operations for designbridge.io (§9.3). Built on the relay's `Store` so keys written here
 * are exactly the rows the relay validates — no schema or key-format drift. Framework-free and
 * hermetically testable; the Next.js route handlers are a thin shell over this.
 */
export class AccountService {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Find or create the user row for an authenticated email (Supabase Auth identity). */
  async ensureUser(email: string, id?: string): Promise<User> {
    const existing = await this.store.getUserByEmail(email);
    if (existing) return existing;
    return this.store.createUser({ ...(id ? { id } : {}), email });
  }

  /** Mint a new API key. The raw secret is returned ONCE; only its sha256 + prefix are stored. */
  async issueKey(userId: string, name?: string): Promise<IssuedKey> {
    const active = (await this.store.getApiKeysForUser(userId)).filter((k) => !k.revokedAt);
    if (active.length >= MAX_KEYS_PER_USER) {
      throw new AccountError(
        "key_limit_reached",
        `key limit reached (${MAX_KEYS_PER_USER}); revoke an unused key first`,
      );
    }
    const rawKey = generateApiKey();
    const key: ApiKey = {
      id: uuid(),
      userId,
      keyHash: sha256(rawKey),
      keyPrefix: keyPrefix(rawKey),
      name: name?.trim() || null,
      rateLimitPerMin: BETA_RATE_LIMIT_PER_MIN,
      dailyRenderLimit: BETA_DAILY_RENDER_LIMIT,
      revokedAt: null,
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.store.insertApiKey(key);
    return { ...toView(key), rawKey };
  }

  async listKeys(userId: string): Promise<KeyView[]> {
    return (await this.store.getApiKeysForUser(userId)).map(toView);
  }

  /** Revoke a key the user owns. Ownership is checked so one user can't revoke another's key. */
  async revokeKey(userId: string, keyId: string): Promise<void> {
    const key = await this.store.getApiKeyById(keyId);
    if (!key) throw new AccountError("key_not_found", "API key not found");
    if (key.userId !== userId) throw new AccountError("forbidden", "not your API key");
    if (key.revokedAt) return; // idempotent
    await this.store.revokeApiKey(keyId, new Date(this.now()).toISOString());
  }

  /** Aggregate render usage across all the user's keys for the dashboard chart. */
  async usage(userId: string, windowDays = 30): Promise<UsageReport> {
    const keyIds = (await this.store.getApiKeysForUser(userId)).map((k) => k.id);
    if (keyIds.length === 0) {
      return { today: 0, total: 0, windowDays, daily: zeroFilled([], windowDays, this.now()) };
    }
    const since = startOfUtcDayMinus(windowDays - 1, this.now());
    const raw = await this.store.getDailyRenderCounts(keyIds, since);
    const daily = zeroFilled(raw, windowDays, this.now());
    const total = daily.reduce((sum, d) => sum + d.count, 0);
    const todayKey = utcDayString(this.now());
    const today = daily.find((d) => d.day === todayKey)?.count ?? 0;
    return { today, total, windowDays, daily };
  }
}

// --- date helpers (UTC days; createdAt is always a UTC ISO string) -----------

function utcDayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function startOfUtcDayMinus(days: number, nowMs: number): string {
  const d = new Date(nowMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - days * 86_400_000;
  return new Date(start).toISOString();
}

/** Produce a contiguous ascending series of `windowDays` UTC days, filling missing days with 0. */
function zeroFilled(raw: DailyCount[], windowDays: number, nowMs: number): DailyCount[] {
  const counts = new Map(raw.map((d) => [d.day, d.count]));
  const out: DailyCount[] = [];
  const todayUtc = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = new Date(todayUtc - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, count: counts.get(day) ?? 0 });
  }
  return out;
}
