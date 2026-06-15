import { buildApp } from "../src/app.js";
import { generateApiKey, keyPrefix, sha256, uuid } from "../src/lib/ids.js";
import { InMemoryQueue } from "../src/queue/types.js";
import { InMemoryStorage } from "../src/storage/types.js";
import { InMemoryStore } from "../src/store/memory.js";
import { Hub } from "../src/ws/hub.js";

export interface TestRig {
  app: ReturnType<typeof buildApp>;
  store: InMemoryStore;
  storage: InMemoryStorage;
  queue: InMemoryQueue;
  hub: Hub;
  rawKey: string;
  apiKeyId: string;
  auth: { authorization: string };
}

export async function makeRig(
  opts: { dailyRenderLimit?: number; rateLimitPerMin?: number; publicUrl?: string } = {},
): Promise<TestRig> {
  const store = new InMemoryStore();
  const storage = new InMemoryStorage();
  const queue = new InMemoryQueue();
  const publicUrl = opts.publicUrl ?? "http://localhost:8080";
  const hub = new Hub({ store, publicUrl });
  const app = buildApp({ store, storage, queue, hub, publicUrl });

  const rawKey = generateApiKey();
  const apiKeyId = uuid();
  await store.insertApiKey({
    id: apiKeyId,
    userId: uuid(),
    keyHash: sha256(rawKey),
    keyPrefix: keyPrefix(rawKey),
    name: "test",
    rateLimitPerMin: opts.rateLimitPerMin ?? 60,
    dailyRenderLimit: opts.dailyRenderLimit ?? 100,
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });

  return {
    app,
    store,
    storage,
    queue,
    hub,
    rawKey,
    apiKeyId,
    auth: { authorization: `Bearer ${rawKey}` },
  };
}

export function sampleCapture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0.0",
    source: { kind: "extension", tool: "claude-design", url: "https://claude.ai/x" },
    capturedAt: new Date().toISOString(),
    viewport: { width: 1440, height: 900, dpr: 2 },
    root: { tag: "div", x: 0, y: 0, w: 1440, h: 900, children: [] },
    assets: [],
    fonts: [],
    warnings: [{ code: "raster-region", nodeId: "n1", detail: "decorative gradient" }],
    ...overrides,
  };
}

/** Pair a channel to the rig's key by minting a channel + pairing code directly in the store. */
export async function pairChannel(rig: TestRig): Promise<string> {
  const channel = await rig.store.createChannel({ label: "Test File" });
  await rig.store.linkKeyChannel(rig.apiKeyId, channel.id, true);
  return channel.id;
}
