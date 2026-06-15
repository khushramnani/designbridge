// DesignBridge Figma plugin — UI iframe.
// The Figma plugin sandbox can't open sockets, so the WebSocket client lives here in the UI and
// talks to the main thread (code.ts) via postMessage. Responsibilities: pairing handshake, render
// delivery (fetch payload → hand to the builder → report done), the context round-trip, heartbeat,
// and the paste-JSON fallback for offline/unpaired use.
import { toBuilderData, type CaptureEnvelope } from "@designbridge/schema";

const DEFAULT_RELAY_URL = "http://localhost:8080";
const PLUGIN_VERSION = "0.1.0";

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const statusEl = $("status");
const codeBox = $("codeBox");
const codeEl = $("code");
const relayInput = $("relay") as HTMLInputElement;

let ws: WebSocket | null = null;
let relayHttpUrl = DEFAULT_RELAY_URL;
let channelToken: string | null = null;
let pendingRenderId: string | null = null;
let reconnectAttempt = 0;
let reconnectTimer: number | undefined;

// --- main-thread bridge ---------------------------------------------------------------------

function toCode(msg: Record<string, unknown>): void {
  parent.postMessage({ pluginMessage: msg }, "*");
}

window.onmessage = (event: MessageEvent) => {
  const m = event.data?.pluginMessage;
  if (!m) return;
  switch (m.type) {
    case "db_config":
      relayHttpUrl = m.relayUrl || DEFAULT_RELAY_URL;
      channelToken = m.channelToken || null;
      relayInput.value = relayHttpUrl;
      connect();
      return;
    case "db_context_result":
      send({ type: "context.response", requestId: m.requestId, context: m.context });
      return;
    case "progress":
      // Build progress from the builder (code.ts) → relay, so a long import reports liveness
      // instead of looking like a stalled/dropped connection.
      if (pendingRenderId) {
        const total = typeof m.total === "number" && m.total > 0 ? m.total : undefined;
        send({
          type: "render.progress",
          renderId: pendingRenderId,
          stage: "building",
          ...(typeof m.count === "number" ? { count: m.count } : {}),
          ...(total ? { total } : {}),
          ...(total && typeof m.count === "number"
            ? { pct: Math.min(99, Math.round((m.count / total) * 100)) }
            : {}),
        });
      }
      return;
    case "done":
      onBuildDone(m);
      return;
    case "error":
      onBuildError(m.message ?? "build failed");
      return;
  }
};

// --- websocket ------------------------------------------------------------------------------

function wsUrl(): string {
  return `${relayHttpUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/ws`;
}

function connect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  // Tear down any existing socket WITHOUT letting its onclose trigger another reconnect — otherwise
  // a manual reconnect (Connect button) and the old socket's close handler race and clobber each
  // other, producing a connect storm and a fresh pairing code every cycle.
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch (err) {
      void err;
    }
    ws = null;
  }

  let socket: WebSocket;
  try {
    socket = new WebSocket(wsUrl(), "designbridge.v1");
  } catch (err) {
    setStatus(`Bad relay URL: ${String(err)}`, "err");
    return;
  }
  ws = socket;
  setStatus("Connecting…");
  socket.onopen = () => {
    reconnectAttempt = 0;
    send({
      type: "hello",
      pluginVersion: PLUGIN_VERSION,
      schemaVersion: "1.0.0",
      ...(channelToken ? { token: channelToken } : {}),
    });
  };
  socket.onmessage = (e) => handleFrame(JSON.parse(String(e.data)));
  // Identity guard: only react if this is still the current socket (a replaced one is inert).
  socket.onclose = () => {
    if (ws === socket) {
      ws = null;
      scheduleReconnect();
    }
  };
  socket.onerror = () => {
    if (ws === socket) setStatus("Relay connection error — retrying…", "err");
  };
}

function scheduleReconnect(): void {
  const delay = Math.min(60000, 1000 * 2 ** reconnectAttempt) + Math.floor(Math.random() * 500);
  reconnectAttempt++;
  setStatus(`Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`, "err");
  reconnectTimer = window.setTimeout(connect, delay);
}

function send(frame: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function handleFrame(frame: { type: string; [key: string]: unknown }): void {
  switch (frame.type) {
    case "hello.ok":
      if (frame.paired) {
        codeBox.style.display = "none";
        setStatus("Connected & paired ✓ — waiting for designs.", "ok");
      } else {
        setStatus("Connected. Pair this plugin to start receiving designs.");
      }
      return;
    case "pair.code":
      codeEl.textContent = String(frame.code);
      codeBox.style.display = "block";
      setStatus("Enter this code in the DesignBridge extension popup (or dashboard).");
      return;
    case "paired":
      channelToken = String(frame.channelToken);
      toCode({ type: "db_set_token", token: channelToken });
      codeBox.style.display = "none";
      setStatus(`Paired ✓ (key ${String(frame.keyPrefix)}…) — waiting for designs.`, "ok");
      return;
    case "render.new":
      void handleRender(frame as unknown as RenderNew);
      return;
    case "context.request":
      toCode({ type: "db_context", requestId: frame.requestId, scope: frame.scope });
      return;
    case "ping":
      send({ type: "pong" });
      return;
    case "error":
      setStatus(`Relay: ${String(frame.message)}`, "err");
      return;
  }
}

interface RenderNew {
  renderId: string;
  name: string | null;
  payloadUrl: string;
  assetBase: string;
}

async function handleRender(frame: RenderNew): Promise<void> {
  pendingRenderId = frame.renderId;
  setStatus(`Receiving "${frame.name ?? "design"}"…`);
  try {
    const res = await fetch(frame.payloadUrl);
    if (!res.ok) throw new Error(`payload fetch ${res.status}`);
    const envelope = (await res.json()) as CaptureEnvelope;
    send({ type: "render.ack", renderId: frame.renderId });
    setStatus(`Fetching assets for "${frame.name ?? "design"}"…`);
    await resolveAssets(envelope, frame.assetBase);
    setStatus(`Building "${frame.name ?? "design"}" on canvas…`);
    toCode({
      type: "import",
      data: toBuilderData(envelope),
      renderId: frame.renderId, // lets the builder replace a prior import of the same render
      autoLayout: false,
      outline: false,
    });
  } catch (err) {
    pendingRenderId = null;
    send({
      type: "render.failed",
      renderId: frame.renderId,
      error: { code: "delivery_error", message: err instanceof Error ? err.message : String(err) },
    });
    setStatus(`Failed to fetch design: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

/**
 * Re-inline externalized raster assets (worker path): nodes carry `assetId` instead of `imgData`.
 * Fetch each unique asset from the relay and restore `imgData` so the unchanged builder can use it.
 */
async function resolveAssets(envelope: CaptureEnvelope, assetBase: string): Promise<void> {
  const byId = new Map<string, string>();
  const nodes: Record<string, unknown>[] = [];
  collectNodes(envelope.root as unknown as Record<string, unknown>, nodes);
  const withAssets = nodes.filter((n) => typeof n.assetId === "string");
  if (withAssets.length === 0) return;

  for (const node of withAssets) {
    const id = node.assetId as string;
    let dataUrl = byId.get(id);
    if (!dataUrl) {
      const res = await fetch(`${assetBase.replace(/\/+$/, "")}/${id}`);
      if (!res.ok) throw new Error(`asset fetch ${res.status} for ${id}`);
      dataUrl = await blobToDataUrl(await res.blob());
      byId.set(id, dataUrl);
    }
    node.imgData = dataUrl;
    delete node.assetId;
  }
}

function collectNodes(
  node: Record<string, unknown> | null | undefined,
  out: Record<string, unknown>[],
): void {
  if (!node || typeof node !== "object") return;
  out.push(node);
  const children = node.children;
  if (Array.isArray(children))
    for (const c of children) collectNodes(c as Record<string, unknown>, out);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("blob read failed"));
    reader.readAsDataURL(blob);
  });
}

function onBuildDone(m: { count?: number; subs?: string[]; warnings?: string[] }): void {
  const layers = m.count ?? 0;
  if (pendingRenderId) {
    send({
      type: "render.done",
      renderId: pendingRenderId,
      summary: { layers, fontsSubstituted: (m.subs ?? []).length },
    });
    pendingRenderId = null;
  }
  let text = `✓ Imported ${layers} layers.`;
  if (m.subs?.length) text += ` Fonts substituted: ${m.subs.join(", ")}.`;
  if (m.warnings?.length) text += `\n⚠ ${m.warnings.join("\n⚠ ")}`;
  setStatus(text, "ok");
}

function onBuildError(message: string): void {
  if (pendingRenderId) {
    send({
      type: "render.failed",
      renderId: pendingRenderId,
      error: { code: "build_error", message },
    });
    pendingRenderId = null;
  }
  setStatus(`Error: ${message}`, "err");
}

// --- UI controls ----------------------------------------------------------------------------

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

$("saveRelay").addEventListener("click", () => {
  relayHttpUrl = relayInput.value.trim() || DEFAULT_RELAY_URL;
  toCode({ type: "db_save_relay", relayUrl: relayHttpUrl });
  reconnectAttempt = 0;
  connect(); // connect() tears down any existing socket safely (no manual close + reconnect race)
});

// Paste-JSON fallback: the clipboard holds the *native* capture (engine v0.6.0), so it goes
// straight to the builder without the envelope round-trip.
$("import").addEventListener("click", () => {
  const raw = (($("json") as HTMLTextAreaElement).value || "").trim();
  if (!raw) return setStatus("Paste the capture JSON first.");
  let data: { _designbridge?: boolean };
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return setStatus(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
  if (!data._designbridge) return setStatus("This isn't a DesignBridge capture.", "err");
  setStatus("Importing…");
  toCode({
    type: "import",
    data,
    autoLayout: ($("auto") as HTMLInputElement).checked,
    outline: ($("outline") as HTMLInputElement).checked,
  });
});

// Kick off: ask the main thread for stored config (token + relay URL), then connect.
toCode({ type: "db_init" });
