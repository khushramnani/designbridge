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

const TERMINAL: ReadonlySet<Render["status"]> = new Set(["done", "failed"]);

/**
 * Non-durable in-memory Store (docs/DECISIONS.md D1). A restart drops queued renders — fine for
 * dev/CI, never for prod. Maps are keyed by primary id; secondary lookups scan (corpus is small).
 */
export class InMemoryStore implements Store {
  private readonly users = new Map<string, User>();
  private readonly apiKeys = new Map<string, ApiKey>();
  private readonly channels = new Map<string, Channel>();
  private readonly pairings = new Map<string, Pairing>();
  private readonly keyChannels: Array<{ apiKeyId: string; channelId: string; isDefault: boolean }> =
    [];
  private readonly renders = new Map<string, Render>();
  private readonly payloads = new Map<string, Buffer>();
  private readonly assets = new Map<string, AssetRecord>();
  private readonly renderAssets: Array<{ renderId: string; assetHash: string }> = [];

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async getUserByEmail(email: string): Promise<User | null> {
    const target = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === target) return { ...u };
    }
    return null;
  }

  async createUser(init: { id?: string; email: string }): Promise<User> {
    const user: User = { id: init.id ?? uuid(), email: init.email, createdAt: this.now() };
    this.users.set(user.id, user);
    return { ...user };
  }

  async getApiKeyByHash(hash: string): Promise<ApiKey | null> {
    for (const key of this.apiKeys.values()) {
      if (key.keyHash === hash) return { ...key };
    }
    return null;
  }

  async getApiKeyById(id: string): Promise<ApiKey | null> {
    const k = this.apiKeys.get(id);
    return k ? { ...k } : null;
  }

  async getApiKeysForUser(userId: string): Promise<ApiKey[]> {
    return [...this.apiKeys.values()]
      .filter((k) => k.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((k) => ({ ...k }));
  }

  async insertApiKey(key: ApiKey): Promise<void> {
    this.apiKeys.set(key.id, { ...key });
  }

  async revokeApiKey(id: string, atIso: string): Promise<void> {
    const k = this.apiKeys.get(id);
    if (k) k.revokedAt = atIso;
  }

  async createChannel(init: { label?: string | null }): Promise<Channel> {
    const channel: Channel = {
      id: uuid(),
      pluginTokenHash: null,
      label: init.label ?? null,
      lastConnectedAt: null,
      createdAt: this.now(),
    };
    this.channels.set(channel.id, channel);
    return { ...channel };
  }

  async getChannel(id: string): Promise<Channel | null> {
    const c = this.channels.get(id);
    return c ? { ...c } : null;
  }

  async getChannelByTokenHash(hash: string): Promise<Channel | null> {
    for (const c of this.channels.values()) {
      if (c.pluginTokenHash && c.pluginTokenHash === hash) return { ...c };
    }
    return null;
  }

  async setChannelToken(channelId: string, tokenHash: string): Promise<void> {
    const c = this.channels.get(channelId);
    if (c) c.pluginTokenHash = tokenHash;
  }

  async touchChannel(channelId: string, atIso: string): Promise<void> {
    const c = this.channels.get(channelId);
    if (c) c.lastConnectedAt = atIso;
  }

  async createPairing(pairing: Pairing): Promise<void> {
    // normalize unclaimed fields to null so behavior matches PostgresStore (contract parity)
    this.pairings.set(pairing.code, { claimedByKey: null, claimedAt: null, ...pairing });
  }

  async getPairing(code: string): Promise<Pairing | null> {
    const p = this.pairings.get(code);
    return p ? { ...p } : null;
  }

  async claimPairing(code: string, apiKeyId: string, atIso: string): Promise<void> {
    const p = this.pairings.get(code);
    if (p) {
      p.claimedByKey = apiKeyId;
      p.claimedAt = atIso;
    }
  }

  async deletePairingsForChannel(channelId: string): Promise<void> {
    for (const [code, p] of this.pairings) {
      if (p.channelId === channelId) this.pairings.delete(code);
    }
  }

  async linkKeyChannel(apiKeyId: string, channelId: string, isDefault: boolean): Promise<void> {
    const existing = this.keyChannels.find(
      (k) => k.apiKeyId === apiKeyId && k.channelId === channelId,
    );
    if (existing) {
      existing.isDefault = isDefault;
      return;
    }
    if (isDefault) {
      for (const k of this.keyChannels) if (k.apiKeyId === apiKeyId) k.isDefault = false;
    }
    this.keyChannels.push({ apiKeyId, channelId, isDefault });
  }

  async isKeyLinkedToChannel(apiKeyId: string, channelId: string): Promise<boolean> {
    return this.keyChannels.some((k) => k.apiKeyId === apiKeyId && k.channelId === channelId);
  }

  async getChannelsForKey(apiKeyId: string): Promise<ChannelBinding[]> {
    const out: ChannelBinding[] = [];
    for (const k of this.keyChannels) {
      if (k.apiKeyId !== apiKeyId) continue;
      const channel = this.channels.get(k.channelId);
      if (channel) out.push({ channel: { ...channel }, isDefault: k.isDefault });
    }
    return out;
  }

  async getDefaultChannelForKey(apiKeyId: string): Promise<Channel | null> {
    const link =
      this.keyChannels.find((k) => k.apiKeyId === apiKeyId && k.isDefault) ??
      this.keyChannels.find((k) => k.apiKeyId === apiKeyId);
    if (!link) return null;
    const c = this.channels.get(link.channelId);
    return c ? { ...c } : null;
  }

  async createRender(render: Render): Promise<void> {
    this.renders.set(render.id, { ...render });
  }

  async getRender(id: string): Promise<Render | null> {
    const r = this.renders.get(id);
    return r ? { ...r } : null;
  }

  async updateRender(id: string, patch: Partial<Render>): Promise<Render | null> {
    const r = this.renders.get(id);
    if (!r) return null;
    Object.assign(r, patch);
    return { ...r };
  }

  async getDeliverableRenders(channelId: string): Promise<Render[]> {
    return [...this.renders.values()]
      .filter((r) => r.channelId === channelId && !TERMINAL.has(r.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({ ...r }));
  }

  async countRendersForKeySince(apiKeyId: string, sinceIso: string): Promise<number> {
    let count = 0;
    for (const r of this.renders.values()) {
      if (r.apiKeyId === apiKeyId && r.createdAt >= sinceIso) count++;
    }
    return count;
  }

  async getDailyRenderCounts(apiKeyIds: string[], sinceIso: string): Promise<DailyCount[]> {
    const keys = new Set(apiKeyIds);
    const byDay = new Map<string, number>();
    for (const r of this.renders.values()) {
      if (!keys.has(r.apiKeyId) || r.createdAt < sinceIso) continue;
      const day = r.createdAt.slice(0, 10); // YYYY-MM-DD (createdAt is a UTC ISO string)
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    return [...byDay.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  async putPayload(renderId: string, bytes: Buffer): Promise<void> {
    this.payloads.set(renderId, bytes);
  }

  async getPayload(renderId: string): Promise<Buffer | null> {
    return this.payloads.get(renderId) ?? null;
  }

  async upsertAsset(asset: {
    hash: string;
    mime: string;
    bytes: number;
    storagePath: string;
  }): Promise<void> {
    const at = this.now();
    const existing = this.assets.get(asset.hash);
    if (existing) {
      existing.lastUsedAt = at;
      return;
    }
    this.assets.set(asset.hash, { ...asset, createdAt: at, lastUsedAt: at });
  }

  async getAsset(hash: string): Promise<AssetRecord | null> {
    const a = this.assets.get(hash);
    return a ? { ...a } : null;
  }

  async linkRenderAsset(renderId: string, assetHash: string): Promise<void> {
    if (!this.renderAssets.some((r) => r.renderId === renderId && r.assetHash === assetHash)) {
      this.renderAssets.push({ renderId, assetHash });
    }
    const a = this.assets.get(assetHash);
    if (a) a.lastUsedAt = this.now();
  }

  async gcUnreferencedAssets(cutoffIso: string): Promise<string[]> {
    const referenced = new Set(this.renderAssets.map((r) => r.assetHash));
    const deleted: string[] = [];
    for (const [hash, a] of this.assets) {
      if (a.lastUsedAt < cutoffIso && !referenced.has(hash)) {
        this.assets.delete(hash);
        deleted.push(hash);
      }
    }
    return deleted;
  }
}
