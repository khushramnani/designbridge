import type { CaptureWarning } from "@designbridge/schema";

export type RenderKind = "capture" | "html" | "url";
export type RenderStatus =
  | "queued"
  | "translating"
  | "delivering"
  | "delivered"
  | "done"
  | "failed";

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  userId: string | null; // null for anonymous beta/dev keys (no user row)
  keyHash: string;
  keyPrefix: string;
  name?: string | null;
  rateLimitPerMin: number;
  dailyRenderLimit: number;
  revokedAt?: string | null;
  createdAt: string;
}

/** A render count bucketed by UTC day (dashboard usage chart, §9.3). */
export interface DailyCount {
  day: string; // YYYY-MM-DD (UTC)
  count: number;
}

export interface Channel {
  id: string;
  pluginTokenHash?: string | null;
  label?: string | null;
  lastConnectedAt?: string | null;
  createdAt: string;
}

export interface Pairing {
  code: string;
  channelId: string;
  expiresAt: string;
  claimedByKey?: string | null;
  claimedAt?: string | null;
}

export interface RenderError {
  code: string;
  message: string;
}

/** Build summary reported by the plugin on `render.done` (surfaced to MCP callers, FR-5.1). */
export interface RenderSummary {
  layers?: number;
  rasterRegions?: number;
  fontsSubstituted?: number;
}

export interface Render {
  id: string;
  apiKeyId: string;
  channelId: string;
  kind: RenderKind;
  status: RenderStatus;
  schemaVersion?: string | null;
  payloadBytes?: number | null;
  name?: string | null;
  warnings: CaptureWarning[];
  error?: RenderError | null;
  summary?: RenderSummary | null;
  timing: Record<string, number>;
  /** opaque token authorizing a one-shot payload fetch (dev Storage stand-in). */
  payloadToken?: string | null;
  createdAt: string;
  doneAt?: string | null;
}

export interface ChannelBinding {
  channel: Channel;
  isDefault: boolean;
}

export interface AssetRecord {
  hash: string; // "sha256:<hex>"
  mime: string;
  bytes: number;
  storagePath: string;
  createdAt: string;
  lastUsedAt: string;
}

/**
 * Persistence boundary for the relay. The in-memory implementation backs local dev + CI; a
 * Postgres implementation (same interface) is the production target — see docs/DECISIONS.md D1.
 */
export interface Store {
  // --- users (web app: Supabase Auth identities; §9.3) ---
  getUserByEmail(email: string): Promise<User | null>;
  createUser(init: { id?: string; email: string }): Promise<User>;

  // --- api keys ---
  getApiKeyByHash(hash: string): Promise<ApiKey | null>;
  getApiKeyById(id: string): Promise<ApiKey | null>;
  getApiKeysForUser(userId: string): Promise<ApiKey[]>;
  insertApiKey(key: ApiKey): Promise<void>;
  revokeApiKey(id: string, atIso: string): Promise<void>;

  // --- channels ---
  createChannel(init: { label?: string | null }): Promise<Channel>;
  getChannel(id: string): Promise<Channel | null>;
  getChannelByTokenHash(hash: string): Promise<Channel | null>;
  setChannelToken(channelId: string, tokenHash: string): Promise<void>;
  touchChannel(channelId: string, atIso: string): Promise<void>;

  // --- pairings ---
  createPairing(pairing: Pairing): Promise<void>;
  getPairing(code: string): Promise<Pairing | null>;
  claimPairing(code: string, apiKeyId: string, atIso: string): Promise<void>;
  deletePairingsForChannel(channelId: string): Promise<void>;

  // --- key <-> channel links ---
  linkKeyChannel(apiKeyId: string, channelId: string, isDefault: boolean): Promise<void>;
  isKeyLinkedToChannel(apiKeyId: string, channelId: string): Promise<boolean>;
  getChannelsForKey(apiKeyId: string): Promise<ChannelBinding[]>;
  getDefaultChannelForKey(apiKeyId: string): Promise<Channel | null>;

  // --- renders ---
  createRender(render: Render): Promise<void>;
  getRender(id: string): Promise<Render | null>;
  updateRender(id: string, patch: Partial<Render>): Promise<Render | null>;
  /** Renders for a channel not yet in a terminal state, oldest first (offline queue, FR-3.5). */
  getDeliverableRenders(channelId: string): Promise<Render[]>;
  /** Count renders created by a key at/after the given instant (daily quota). */
  countRendersForKeySince(apiKeyId: string, sinceIso: string): Promise<number>;
  /** Render counts per UTC day for a set of keys at/after `sinceIso` (dashboard usage chart). */
  getDailyRenderCounts(apiKeyIds: string[], sinceIso: string): Promise<DailyCount[]>;

  // --- payload blobs (dev Storage stand-in; prod uses Supabase Storage) ---
  putPayload(renderId: string, bytes: Buffer): Promise<void>;
  getPayload(renderId: string): Promise<Buffer | null>;

  // --- assets (content-addressed; dedup + GC, TECHNICAL-SPEC §4/§5) ---
  upsertAsset(asset: {
    hash: string;
    mime: string;
    bytes: number;
    storagePath: string;
  }): Promise<void>;
  getAsset(hash: string): Promise<AssetRecord | null>;
  linkRenderAsset(renderId: string, assetHash: string): Promise<void>;
  /** Delete asset rows older than the cutoff with no live render reference; returns deleted hashes. */
  gcUnreferencedAssets(cutoffIso: string): Promise<string[]>;
}
