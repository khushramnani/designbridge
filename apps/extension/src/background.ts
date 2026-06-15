// DesignBridge background service worker.
// Receives native captures from the content script, lifts them into the v1 transfer envelope, and
// submits to the relay via the typed client. Holds no secrets at build time — the API key lives in
// chrome.storage.local, entered by the user in the popup.
import { DesignBridgeClient } from "@designbridge/client";
import { wrapCapture, type NativeCapture } from "@designbridge/schema";

const DEFAULT_BASE_URL = "http://localhost:8080";

interface Config {
  baseUrl: string;
  apiKey: string | null;
  channel: string;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "db_submit") {
    submit(msg.native as NativeCapture)
      .then(sendResponse)
      .catch((err: unknown) => sendResponse({ ok: false, message: messageOf(err) }));
    return true; // keep the channel open for the async response
  }
  return false;
});

async function getConfig(): Promise<Config> {
  const stored = await chrome.storage.local.get(["baseUrl", "apiKey", "channel"]);
  return {
    baseUrl: (stored.baseUrl as string) || DEFAULT_BASE_URL,
    apiKey: (stored.apiKey as string) || null,
    channel: (stored.channel as string) || "default",
  };
}

async function submit(native: NativeCapture) {
  const cfg = await getConfig();
  if (!cfg.apiKey) return { ok: false, reason: "not_configured" };

  const client = new DesignBridgeClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const capture = wrapCapture(native, { sourceKind: "extension", dpr: 2 });
  try {
    const res = await client.createRender({
      channel: cfg.channel,
      name: deriveName(native),
      payload: { kind: "capture", capture },
    });
    return { ok: true, renderId: res.renderId, status: res.status };
  } catch (err) {
    return { ok: false, message: relayMessage(err) };
  }
}

function deriveName(native: NativeCapture): string {
  if (native.sourceUrl) {
    try {
      return `Design from ${new URL(native.sourceUrl).hostname}`;
    } catch {
      // fall through
    }
  }
  return "Claude design";
}

function relayMessage(err: unknown): string {
  const body = (err as { body?: { error?: { code?: string; message?: string } } }).body;
  if (body?.error) return body.error.code ?? body.error.message ?? "relay error";
  return messageOf(err);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
