import fastifyWebsocket from "@fastify/websocket";
import { validateCapture } from "@designbridge/schema";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, rawBearer } from "./auth.js";
import { errorBody, RelayError } from "./lib/errors.js";
import { sha256Bytes, shortToken, uuid } from "./lib/ids.js";
import { FailureCounter, TokenBucketLimiter, type RateLimiter } from "./lib/rate-limit.js";
import { InMemoryQueue, type Queue, type TranslateJob } from "./queue/types.js";
import { InMemoryStorage, type Storage } from "./storage/types.js";
import type { DeliverJob } from "./queue/types.js";
import type { Render, Store } from "./store/types.js";
import { Hub } from "./ws/hub.js";

export interface BuildAppDeps {
  store: Store;
  storage?: Storage;
  queue?: Queue;
  hub?: Hub;
  publicUrl?: string;
  rateLimiter?: RateLimiter;
  pairFailures?: FailureCounter;
  /** Inline-base64 cap before forcing asset externalization (§5: 100 KB once presign exists). */
  maxInlineBytes?: number;
  bodyLimit?: number;
  now?: () => number;
  logger?: boolean;
}

const RENDER_BODY_LIMIT = 2 * 1024 * 1024; // 2 MB (§5)
const HTML_LIMIT = 1024 * 1024; // 1 MB (§5)
const MAX_ASSET_BYTES = 20 * 1024 * 1024; // §5: ≤ 20 MB per asset
const HASH_RE = /^sha256:[a-f0-9]{64}$/;

const renderRequestSchema = z.object({
  channel: z.string().min(1).default("default"),
  name: z.string().max(200).optional(),
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("capture"), capture: z.unknown() }),
    z.object({
      kind: z.literal("html"),
      html: z.string(),
      viewport: z.object({ width: z.number(), height: z.number() }).optional(),
    }),
    z.object({ kind: z.literal("url"), url: z.string().url() }),
  ]),
});

const pairRequestSchema = z.object({ code: z.string().min(4).max(12) });
const contextRequestSchema = z.object({
  channel: z.string().min(1).default("default"),
  scope: z.enum(["selection", "page"]).default("selection"),
});
const presignSchema = z.object({
  assets: z
    .array(
      z.object({
        hash: z.string(),
        mime: z.string().min(1),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(50), // §5: ≤ 50 per call
});

export function buildApp(deps: BuildAppDeps): FastifyInstance {
  const store = deps.store;
  const now = deps.now ?? (() => Date.now());
  const publicUrl = deps.publicUrl ?? "http://localhost:8080";
  const storage = deps.storage ?? new InMemoryStorage();
  const queue = deps.queue ?? new InMemoryQueue();
  const hub = deps.hub ?? new Hub({ store, publicUrl, now });
  const limiter = deps.rateLimiter ?? new TokenBucketLimiter(now);
  const pairFailures = deps.pairFailures ?? new FailureCounter(60 * 60_000, now);
  const maxInlineBytes = deps.maxInlineBytes ?? RENDER_BODY_LIMIT;

  // The relay consumes `deliver` jobs (enqueued by the worker after translation) and pushes the
  // render to the plugin — only the relay process holds the live WS connections (§7).
  queue.subscribe("deliver", async (data) => {
    const { renderId } = data as DeliverJob;
    const render = await store.getRender(renderId);
    if (render) await hub.deliver(render);
  });

  const app = Fastify({
    bodyLimit: deps.bodyLimit ?? RENDER_BODY_LIMIT,
    logger: deps.logger ?? false,
    genReqId: () => uuid(),
  });

  // Binary asset uploads arrive as application/octet-stream (mime carried in ?mime=).
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof RelayError) {
      void reply.code(err.status).send(errorBody(err, req.id));
      return;
    }
    const fastifyCode = (err as { code?: string }).code;
    if (fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
      const re = new RelayError("payload_too_large", "request body exceeds limit");
      void reply.code(re.status).send(errorBody(re, req.id));
      return;
    }
    // Other content-type-parser failures (missing/unsupported content-type, empty/invalid JSON
    // body) are client errors — return a clean 422, not a 500.
    if (typeof fastifyCode === "string" && fastifyCode.startsWith("FST_ERR_CTP_")) {
      const re = new RelayError(
        "invalid_payload",
        "request body must be JSON with content-type: application/json",
      );
      void reply.code(re.status).send(errorBody(re, req.id));
      return;
    }
    req.log.error({ err }, "unhandled error");
    const re = new RelayError("internal", "internal server error");
    void reply.code(500).send(errorBody(re, req.id));
  });

  // --- POST /v1/renders ------------------------------------------------------
  app.post("/v1/renders", async (req, reply) => {
    const apiKey = await authenticate(store, req.headers.authorization);

    if (!limiter.take(`render:${apiKey.id}`, apiKey.rateLimitPerMin, 5)) {
      throw new RelayError("rate_limited", "too many requests; slow down");
    }

    const parsed = renderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new RelayError("invalid_payload", "invalid request body", parsed.error.issues);
    }
    const body = parsed.data;

    // html / url → translation worker (Playwright). Persist the render as `translating` and enqueue.
    if (body.payload.kind === "html" || body.payload.kind === "url") {
      const channel = await resolveChannel(store, apiKey.id, body.channel);
      await enforceQuota(store, apiKey, now);
      if (body.payload.kind === "html" && Buffer.byteLength(body.payload.html) > HTML_LIMIT) {
        throw new RelayError("payload_too_large", "html exceeds 1 MB limit");
      }
      const render = newRender(
        apiKey.id,
        channel.id,
        body.payload.kind,
        "translating",
        body.name,
        [],
        now,
      );
      await store.createRender(render);
      const job: TranslateJob = {
        renderId: render.id,
        kind: body.payload.kind,
        ...(body.payload.kind === "html" ? { html: body.payload.html } : { url: body.payload.url }),
        ...(body.payload.kind === "html" && body.payload.viewport
          ? { viewport: body.payload.viewport }
          : {}),
      };
      await queue.publish("translate", job);
      return reply.code(202).send({
        renderId: render.id,
        status: "translating",
        statusUrl: `/v1/renders/${render.id}`,
      });
    }

    const captureResult = validateCapture(body.payload.capture);
    if (!captureResult.success) {
      throw new RelayError(
        "invalid_payload",
        "capture envelope failed validation",
        captureResult.error.issues,
      );
    }
    const capture = captureResult.data;

    const inlineBytes = inlineBase64Bytes(capture.root);
    if (inlineBytes > maxInlineBytes) {
      throw new RelayError(
        "payload_too_large",
        "inline asset data too large; upload assets via /v1/assets/presign",
      );
    }

    const channel = await resolveChannel(store, apiKey.id, body.channel);
    await enforceQuota(store, apiKey, now);

    const serialized = Buffer.from(JSON.stringify(capture));
    const render: Render = {
      ...newRender(
        apiKey.id,
        channel.id,
        "capture",
        "queued",
        body.name,
        capture.warnings ?? [],
        now,
      ),
      schemaVersion: capture.schemaVersion,
      payloadBytes: serialized.byteLength,
    };
    await store.createRender(render);
    await store.putPayload(render.id, serialized);
    await hub.deliver(render);

    return reply.code(202).send({
      renderId: render.id,
      status: "queued",
      statusUrl: `/v1/renders/${render.id}`,
    });
  });

  // --- GET /v1/renders/:id ---------------------------------------------------
  app.get("/v1/renders/:id", async (req, reply) => {
    const apiKey = await authenticate(store, req.headers.authorization);
    const { id } = req.params as { id: string };
    const render = await store.getRender(id);
    if (!render || render.apiKeyId !== apiKey.id) {
      throw new RelayError("render_not_found", "render not found");
    }
    return reply.send({
      renderId: render.id,
      status: render.status,
      warnings: render.warnings,
      error: render.error ?? null,
      summary: render.summary ?? null,
      progress: hub.getProgress(render.id),
      timing: render.timing,
      createdAt: render.createdAt,
      doneAt: render.doneAt ?? null,
    });
  });

  // --- GET /v1/renders/:id/payload (signed-URL stand-in; no bearer) ----------
  app.get("/v1/renders/:id/payload", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { t } = req.query as { t?: string };
    const render = await store.getRender(id);
    if (!render || !render.payloadToken || render.payloadToken !== t) {
      throw new RelayError("render_not_found", "payload not found");
    }
    const bytes = await store.getPayload(id);
    if (!bytes) throw new RelayError("render_not_found", "payload not found");
    // Token-protected blob; the Figma plugin UI fetches it cross-origin (origin "null"), so a
    // permissive ACAO is safe here — possession of the unguessable token is the gate.
    return reply
      .header("content-type", "application/json")
      .header("access-control-allow-origin", "*")
      .send(bytes);
  });

  // --- POST /v1/pair ---------------------------------------------------------
  app.post("/v1/pair", async (req, reply) => {
    const apiKey = await authenticate(store, req.headers.authorization);
    const raw = rawBearer(req.headers.authorization)!;
    const ip = req.ip;

    if (pairFailures.count(`ip:${ip}`) >= 20) {
      throw new RelayError("pairing_locked", "too many failed pairing attempts; try again later");
    }
    if (!limiter.take(`pair:${apiKey.id}`, 5, 5) || !limiter.take(`pair:ip:${ip}`, 5, 5)) {
      throw new RelayError("rate_limited", "too many pairing attempts; slow down");
    }

    const parsed = pairRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new RelayError("invalid_payload", "invalid request body", parsed.error.issues);
    }
    const code = parsed.data.code.toUpperCase();

    const pairing = await store.getPairing(code);
    if (!pairing || pairing.claimedAt) {
      pairFailures.record(`ip:${ip}`);
      throw new RelayError("pairing_code_invalid", "pairing code not found");
    }
    if (Date.parse(pairing.expiresAt) <= now()) {
      pairFailures.record(`ip:${ip}`);
      throw new RelayError("pairing_code_expired", "pairing code expired");
    }

    await store.claimPairing(code, apiKey.id, new Date(now()).toISOString());
    await store.linkKeyChannel(apiKey.id, pairing.channelId, true);
    await hub.completePairing(pairing.channelId, raw);

    const channel = await store.getChannel(pairing.channelId);
    return reply.send({ channelId: pairing.channelId, label: channel?.label ?? null });
  });

  // --- GET /v1/channels ------------------------------------------------------
  app.get("/v1/channels", async (req, reply) => {
    const apiKey = await authenticate(store, req.headers.authorization);
    const bindings = await store.getChannelsForKey(apiKey.id);
    return reply.send({
      channels: bindings.map((b) => ({
        id: b.channel.id,
        label: b.channel.label ?? null,
        isDefault: b.isDefault,
        online: hub.isOnline(b.channel.id),
        lastConnectedAt: b.channel.lastConnectedAt ?? null,
      })),
    });
  });

  // --- POST /v1/context ------------------------------------------------------
  app.post("/v1/context", async (req, reply) => {
    const apiKey = await authenticate(store, req.headers.authorization);
    const parsed = contextRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new RelayError("invalid_payload", "invalid request body", parsed.error.issues);
    }
    const channel = await resolveChannel(store, apiKey.id, parsed.data.channel);
    if (!hub.isOnline(channel.id)) {
      throw new RelayError("channel_offline", "Figma plugin is not connected");
    }
    const context = await hub.requestContext(channel.id, parsed.data.scope);
    return reply.send({ context });
  });

  // --- POST /v1/assets/presign (FR-3, §5) ------------------------------------
  app.post("/v1/assets/presign", async (req, reply) => {
    await authenticate(store, req.headers.authorization);
    const parsed = presignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new RelayError("invalid_payload", "invalid request body", parsed.error.issues);
    }
    const uploads = [];
    for (const asset of parsed.data.assets) {
      if (!HASH_RE.test(asset.hash)) {
        throw new RelayError("invalid_payload", `bad asset hash: ${asset.hash}`);
      }
      if (asset.bytes > MAX_ASSET_BYTES) {
        throw new RelayError("payload_too_large", `asset ${asset.hash} exceeds 20 MB`);
      }
      const exists = (await storage.exists(asset.hash)) || !!(await store.getAsset(asset.hash));
      uploads.push({
        hash: asset.hash,
        exists,
        uploadUrl: exists
          ? null
          : `${publicUrl}/v1/assets/${asset.hash}?mime=${encodeURIComponent(asset.mime)}`,
      });
    }
    return reply.send({ uploads });
  });

  // --- PUT /v1/assets/:hash (content-addressed upload) -----------------------
  app.put("/v1/assets/:hash", async (req, reply) => {
    await authenticate(store, req.headers.authorization);
    const { hash } = req.params as { hash: string };
    const { mime } = req.query as { mime?: string };
    if (!HASH_RE.test(hash)) throw new RelayError("invalid_payload", "bad asset hash");
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes)) {
      throw new RelayError("invalid_payload", "upload body must be application/octet-stream");
    }
    if (bytes.byteLength > MAX_ASSET_BYTES)
      throw new RelayError("payload_too_large", "asset exceeds 20 MB");
    // content-addressing integrity: stored bytes must hash to the claimed id
    if (`sha256:${sha256Bytes(bytes)}` !== hash) {
      throw new RelayError("invalid_payload", "content hash does not match asset id");
    }
    await storage.put(hash, mime ?? "application/octet-stream", bytes);
    await store.upsertAsset({
      hash,
      mime: mime ?? "application/octet-stream",
      bytes: bytes.byteLength,
      storagePath: hash,
    });
    return reply.code(201).send({ hash, bytes: bytes.byteLength });
  });

  // --- GET /v1/assets/:hash (no auth; content-addressed, plugin fetches) -----
  app.get("/v1/assets/:hash", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const blob = await storage.get(hash);
    if (!blob) throw new RelayError("render_not_found", "asset not found");
    return reply
      .header("content-type", blob.mime)
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(blob.bytes);
  });

  // --- GET /v1/health (no auth) ----------------------------------------------
  app.get("/v1/health", async (_req, reply) => {
    return reply.send({
      ok: true,
      version: process.env.npm_package_version ?? "0.1.0",
      ws: { connections: hub.connectionCount() },
      queue: { translate: 0, deliver: 0 },
    });
  });

  // --- WS /v1/ws -------------------------------------------------------------
  app.register(async (instance) => {
    await instance.register(fastifyWebsocket);
    instance.get("/v1/ws", { websocket: true }, (socket) => {
      const sock = socket as unknown as {
        send: (d: string) => void;
        close: (c?: number, r?: string) => void;
        readyState: number;
        on: (ev: string, cb: (...args: unknown[]) => void) => void;
      };
      const handler = hub.handleConnection(sock);
      sock.on("message", (data: unknown) => {
        void handler.onMessage(String(data));
      });
      sock.on("pong", () => handler.onPong());
      sock.on("close", () => handler.onClose());
    });
  });

  app.decorate("hub", hub);
  app.decorate("queue", queue);
  app.decorate("storage", storage);
  return app;
}

async function enforceQuota(
  store: Store,
  apiKey: { id: string; dailyRenderLimit: number },
  now: () => number,
) {
  const sinceIso = startOfUtcDay(now());
  const todayCount = await store.countRendersForKeySince(apiKey.id, sinceIso);
  if (todayCount >= apiKey.dailyRenderLimit) {
    throw new RelayError("quota_exceeded", "daily render limit reached");
  }
}

function newRender(
  apiKeyId: string,
  channelId: string,
  kind: Render["kind"],
  status: Render["status"],
  name: string | undefined,
  warnings: Render["warnings"],
  now: () => number,
): Render {
  return {
    id: uuid(),
    apiKeyId,
    channelId,
    kind,
    status,
    schemaVersion: null,
    payloadBytes: null,
    name: name ?? null,
    warnings,
    error: null,
    timing: {},
    payloadToken: shortToken(),
    createdAt: new Date(now()).toISOString(),
    doneAt: null,
  };
}

async function resolveChannel(store: Store, apiKeyId: string, channelRef: string) {
  if (channelRef === "default") {
    const channel = await store.getDefaultChannelForKey(apiKeyId);
    if (!channel)
      throw new RelayError("channel_not_paired", "no paired channel; pair a Figma plugin first");
    return channel;
  }
  const linked = await store.isKeyLinkedToChannel(apiKeyId, channelRef);
  if (!linked) throw new RelayError("channel_not_paired", "channel not paired to this key");
  const channel = await store.getChannel(channelRef);
  if (!channel) throw new RelayError("channel_not_paired", "channel not found");
  return channel;
}

/** Sum of inline base64-ish payload across the node tree (forces externalization, §5). */
function inlineBase64Bytes(node: unknown): number {
  let total = 0;
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const rec = n as Record<string, unknown>;
    if (typeof rec.imgData === "string") total += rec.imgData.length;
    if (typeof rec.dataUrl === "string") total += rec.dataUrl.length;
    if (typeof rec.src === "string" && rec.src.startsWith("data:")) total += rec.src.length;
    if (Array.isArray(rec.children)) for (const c of rec.children) visit(c);
  };
  visit(node);
  return total;
}

function startOfUtcDay(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

declare module "fastify" {
  interface FastifyInstance {
    hub: Hub;
    queue: Queue;
    storage: Storage;
  }
}
