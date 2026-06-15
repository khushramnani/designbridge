import { SCHEMA_VERSION } from "@designbridge/schema";
import { RelayError } from "../lib/errors.js";
import {
  generateChannelToken,
  generatePairingCode,
  keyPrefix as toKeyPrefix,
  sha256,
  uuid,
} from "../lib/ids.js";
import type { Render, Store } from "../store/types.js";
import { inboundFrame, WS_SUBPROTOCOL, type OutboundFrame } from "./protocol.js";

/** Minimal socket surface the hub depends on — satisfied by `ws` and by test doubles. */
export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface HubOptions {
  store: Store;
  publicUrl: string;
  storageBase?: string;
  pairingTtlMs?: number;
  contextTimeoutMs?: number;
  redeliveryIntervalMs?: number;
  maxDeliveryAttempts?: number;
  heartbeatIntervalMs?: number;
  now?: () => number;
  /** Schedules a callback; injectable so tests run without real timers. Returns a cancel fn. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

interface Connection {
  id: string;
  socket: HubSocket;
  channelId: string | null;
  schemaVersion?: string;
  pluginVersion?: string;
  missedPongs: number;
  cancelHeartbeat?: () => void;
}

interface PendingContext {
  resolve: (ctx: unknown) => void;
  reject: (err: Error) => void;
  cancelTimer: () => void;
}

interface PendingDelivery {
  attempts: number;
  cancelTimer: () => void;
}

export interface RenderProgress {
  pct?: number;
  count?: number;
  total?: number;
  stage?: "fetching" | "building";
  at: string;
}

const OPEN = 1;

export { WS_SUBPROTOCOL };

/**
 * In-process WS hub (TECHNICAL-SPEC §6). Owns the live plugin connections, the pairing handshake,
 * at-least-once render delivery with redelivery, and the context round-trip. Transport-agnostic:
 * it operates on `HubSocket`, so it is unit-testable with fake sockets.
 */
export class Hub {
  private readonly store: Store;
  private readonly opts: Required<Omit<HubOptions, "store" | "log" | "storageBase">> & {
    storageBase?: string;
  };
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  private readonly byChannel = new Map<string, Connection>();
  private readonly pendingContext = new Map<string, PendingContext>();
  private readonly pendingDelivery = new Map<string, PendingDelivery>();
  /** Live build progress per render (in-memory; surfaced via GET render, cleared on terminal). */
  private readonly progressByRender = new Map<string, RenderProgress>();

  constructor(options: HubOptions) {
    this.store = options.store;
    this.log = options.log ?? (() => {});
    this.opts = {
      publicUrl: options.publicUrl,
      storageBase: options.storageBase,
      pairingTtlMs: options.pairingTtlMs ?? 10 * 60_000,
      contextTimeoutMs: options.contextTimeoutMs ?? 15_000,
      redeliveryIntervalMs: options.redeliveryIntervalMs ?? 60_000,
      maxDeliveryAttempts: options.maxDeliveryAttempts ?? 10,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
      now: options.now ?? (() => Date.now()),
      setTimer:
        options.setTimer ??
        ((fn, ms) => {
          const t = setTimeout(fn, ms);
          if (typeof t.unref === "function") t.unref();
          return () => clearTimeout(t);
        }),
    };
  }

  isOnline(channelId: string): boolean {
    const conn = this.byChannel.get(channelId);
    return !!conn && conn.socket.readyState === OPEN;
  }

  connectionCount(): number {
    return this.byChannel.size;
  }

  /** Latest in-memory build progress for a render, if any (cleared when it reaches a terminal state). */
  getProgress(renderId: string): RenderProgress | null {
    return this.progressByRender.get(renderId) ?? null;
  }

  // --- connection lifecycle --------------------------------------------------

  /** Register a freshly-opened socket. Returns a handle the transport drives on message/close. */
  handleConnection(socket: HubSocket): {
    onMessage: (raw: string) => Promise<void>;
    onPong: () => void;
    onClose: () => void;
  } {
    const conn: Connection = {
      id: uuid(),
      socket,
      channelId: null,
      missedPongs: 0,
    };
    this.startHeartbeat(conn);
    return {
      onMessage: (raw: string) => this.onMessage(conn, raw),
      onPong: () => {
        conn.missedPongs = 0;
      },
      onClose: () => this.onClose(conn),
    };
  }

  private startHeartbeat(conn: Connection): void {
    const tick = () => {
      if (conn.socket.readyState !== OPEN) return;
      if (conn.missedPongs >= 2) {
        this.log("ws heartbeat timeout", { conn: conn.id });
        conn.socket.close(4000, "heartbeat timeout");
        return;
      }
      conn.missedPongs++;
      this.send(conn.socket, { type: "ping" });
      conn.cancelHeartbeat = this.opts.setTimer(tick, this.opts.heartbeatIntervalMs);
    };
    conn.cancelHeartbeat = this.opts.setTimer(tick, this.opts.heartbeatIntervalMs);
  }

  private onClose(conn: Connection): void {
    conn.cancelHeartbeat?.();
    if (conn.channelId && this.byChannel.get(conn.channelId) === conn) {
      this.byChannel.delete(conn.channelId);
    }
  }

  private async onMessage(conn: Connection, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(conn.socket, {
        type: "error",
        code: "bad_frame",
        message: "invalid JSON",
        fatal: true,
      });
      conn.socket.close(1003, "invalid JSON");
      return;
    }
    const result = inboundFrame.safeParse(parsed);
    if (!result.success) {
      this.send(conn.socket, {
        type: "error",
        code: "bad_frame",
        message: "unrecognized frame",
        fatal: false,
      });
      return;
    }
    const frame = result.data;
    switch (frame.type) {
      case "hello":
        await this.onHello(conn, frame);
        return;
      case "render.ack":
        await this.onAck(frame.renderId);
        return;
      case "render.progress":
        // Kept in memory (not persisted) and surfaced via GET /v1/renders/:id so callers can see a
        // long build is alive rather than assuming a stall.
        this.progressByRender.set(frame.renderId, {
          pct: frame.pct,
          count: frame.count,
          total: frame.total,
          stage: frame.stage,
          at: new Date(this.opts.now()).toISOString(),
        });
        return;
      case "render.done":
        await this.onDone(frame);
        return;
      case "render.failed":
        await this.onFailed(frame);
        return;
      case "context.response":
        this.onContextResponse(frame.requestId, frame.context);
        return;
      case "pong":
        conn.missedPongs = 0;
        return;
    }
  }

  private async onHello(
    conn: Connection,
    frame: { token?: string; schemaVersion?: string; pluginVersion?: string },
  ): Promise<void> {
    conn.schemaVersion = frame.schemaVersion;
    conn.pluginVersion = frame.pluginVersion;

    let channel = frame.token ? await this.store.getChannelByTokenHash(sha256(frame.token)) : null;
    const paired = !!channel;

    if (!channel) {
      channel = await this.store.createChannel({ label: null });
    }
    this.bindChannel(conn, channel.id);
    await this.store.touchChannel(channel.id, new Date(this.opts.now()).toISOString());

    this.send(conn.socket, {
      type: "hello.ok",
      channelId: channel.id,
      paired,
      serverSchemaVersion: SCHEMA_VERSION,
    });

    if (!paired) {
      await this.issuePairingCode(conn, channel.id);
    } else {
      await this.flushDeliverable(channel.id);
    }
  }

  private bindChannel(conn: Connection, channelId: string): void {
    const prev = this.byChannel.get(channelId);
    if (prev && prev !== conn) {
      prev.cancelHeartbeat?.();
      prev.socket.close(4001, "replaced by new connection");
    }
    conn.channelId = channelId;
    this.byChannel.set(channelId, conn);
  }

  private async issuePairingCode(conn: Connection, channelId: string): Promise<void> {
    await this.store.deletePairingsForChannel(channelId);
    const code = generatePairingCode();
    const expiresAt = new Date(this.opts.now() + this.opts.pairingTtlMs).toISOString();
    await this.store.createPairing({ code, channelId, expiresAt });
    this.send(conn.socket, { type: "pair.code", code, expiresAt });
  }

  // --- pairing completion (called by POST /v1/pair) --------------------------

  /**
   * Issue a long-lived channel token (hashed at rest) and push `paired` to the live plugin.
   * Returns whether a connected plugin received it — if offline, the token can't be delivered
   * (Phase 1: the user re-pairs; see docs/DECISIONS.md).
   */
  async completePairing(channelId: string, rawKey: string): Promise<{ delivered: boolean }> {
    const token = generateChannelToken();
    await this.store.setChannelToken(channelId, sha256(token));
    await this.store.deletePairingsForChannel(channelId);
    const conn = this.byChannel.get(channelId);
    if (!conn || conn.socket.readyState !== OPEN) return { delivered: false };
    this.send(conn.socket, {
      type: "paired",
      keyPrefix: toKeyPrefix(rawKey),
      channelToken: token,
    });
    return { delivered: true };
  }

  // --- render delivery (at-least-once, FR-3.5) -------------------------------

  /** Push a queued render to its channel if online; otherwise it waits in the offline queue. */
  async deliver(render: Render): Promise<void> {
    if (!this.isOnline(render.channelId)) return;
    await this.sendRenderNew(render);
  }

  private async flushDeliverable(channelId: string): Promise<void> {
    const renders = await this.store.getDeliverableRenders(channelId);
    for (const render of renders) {
      await this.sendRenderNew(render);
    }
  }

  private async sendRenderNew(render: Render): Promise<void> {
    const conn = this.byChannel.get(render.channelId);
    if (!conn || conn.socket.readyState !== OPEN) return;

    await this.store.updateRender(render.id, { status: "delivering" });
    const payloadUrl = `${this.opts.publicUrl}/v1/renders/${render.id}/payload?t=${render.payloadToken ?? ""}`;
    const assetBase = this.opts.storageBase ?? `${this.opts.publicUrl}/v1/assets`;
    this.send(conn.socket, {
      type: "render.new",
      renderId: render.id,
      name: render.name ?? null,
      payloadUrl,
      assetBase,
      schemaVersion: render.schemaVersion ?? null,
      bytes: render.payloadBytes ?? 0,
    });
    this.scheduleRedelivery(render.id);
  }

  private scheduleRedelivery(renderId: string): void {
    this.pendingDelivery.get(renderId)?.cancelTimer();
    const existing = this.pendingDelivery.get(renderId);
    const attempts = (existing?.attempts ?? 0) + 1;
    const cancelTimer = this.opts.setTimer(() => {
      void this.onRedeliveryTick(renderId);
    }, this.opts.redeliveryIntervalMs);
    this.pendingDelivery.set(renderId, { attempts, cancelTimer });
  }

  private async onRedeliveryTick(renderId: string): Promise<void> {
    const pending = this.pendingDelivery.get(renderId);
    const render = await this.store.getRender(renderId);
    if (!render || render.status !== "delivering") {
      this.clearDelivery(renderId);
      return;
    }
    if ((pending?.attempts ?? 0) >= this.opts.maxDeliveryAttempts) {
      this.clearDelivery(renderId);
      await this.store.updateRender(renderId, {
        status: "failed",
        error: { code: "delivery_timeout", message: "plugin did not ack render" },
        doneAt: new Date(this.opts.now()).toISOString(),
      });
      return;
    }
    await this.sendRenderNew(render);
  }

  private clearDelivery(renderId: string): void {
    this.pendingDelivery.get(renderId)?.cancelTimer();
    this.pendingDelivery.delete(renderId);
  }

  private async onAck(renderId: string): Promise<void> {
    this.clearDelivery(renderId);
    await this.store.updateRender(renderId, { status: "delivered" });
  }

  private async onDone(frame: {
    renderId: string;
    summary?: { layers?: number; rasterRegions?: number; fontsSubstituted?: number };
  }): Promise<void> {
    this.clearDelivery(frame.renderId);
    this.progressByRender.delete(frame.renderId);
    const render = await this.store.getRender(frame.renderId);
    await this.store.updateRender(frame.renderId, {
      status: "done",
      summary: frame.summary ?? null,
      timing: { ...(render?.timing ?? {}) },
      doneAt: new Date(this.opts.now()).toISOString(),
    });
  }

  private async onFailed(frame: {
    renderId: string;
    error: { code: string; message: string };
  }): Promise<void> {
    this.clearDelivery(frame.renderId);
    this.progressByRender.delete(frame.renderId);
    await this.store.updateRender(frame.renderId, {
      status: "failed",
      error: frame.error,
      doneAt: new Date(this.opts.now()).toISOString(),
    });
  }

  // --- context round-trip (FR-3.7) -------------------------------------------

  async requestContext(channelId: string, scope: "selection" | "page"): Promise<unknown> {
    const conn = this.byChannel.get(channelId);
    if (!conn || conn.socket.readyState !== OPEN) {
      throw new RelayError("channel_offline", "Figma plugin is not connected");
    }
    const requestId = uuid();
    return new Promise<unknown>((resolve, reject) => {
      const cancelTimer = this.opts.setTimer(() => {
        this.pendingContext.delete(requestId);
        reject(new RelayError("context_timeout", "plugin did not respond in time"));
      }, this.opts.contextTimeoutMs);
      this.pendingContext.set(requestId, { resolve, reject, cancelTimer });
      this.send(conn.socket, {
        type: "context.request",
        requestId,
        scope,
        maxDepth: 6,
        maxNodes: 500,
      });
    });
  }

  private onContextResponse(requestId: string, context: unknown): void {
    const pending = this.pendingContext.get(requestId);
    if (!pending) return;
    pending.cancelTimer();
    this.pendingContext.delete(requestId);
    pending.resolve(context);
  }

  // --- helpers ---------------------------------------------------------------

  private send(socket: HubSocket, frame: OutboundFrame): void {
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (err) {
      this.log("ws send failed", { err: String(err) });
    }
  }
}
