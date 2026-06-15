import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { wrapCapture, type CaptureEnvelope, type NativeCapture } from "@designbridge/schema";
import type { Browser } from "playwright";
import { assertSafeUrl, BlockedUrlError, type DnsLookup } from "./ssrf.js";

/** Capability subsets of the relay's Store/Storage/Queue — structural, so no app→app import. */
export interface WorkerStore {
  updateRender(id: string, patch: Record<string, unknown>): Promise<unknown>;
  putPayload(id: string, bytes: Buffer): Promise<void>;
  upsertAsset(a: { hash: string; mime: string; bytes: number; storagePath: string }): Promise<void>;
  linkRenderAsset(renderId: string, hash: string): Promise<void>;
}
export interface WorkerStorage {
  put(hash: string, mime: string, bytes: Buffer): Promise<void>;
  exists(hash: string): Promise<boolean>;
}
export interface WorkerQueue {
  publish(topic: string, data: unknown): Promise<void>;
}

export interface TranslateJob {
  renderId: string;
  kind: "html" | "url";
  html?: string;
  url?: string;
  viewport?: { width: number; height: number };
}

export interface TranslatorOptions {
  browser: Browser;
  store: WorkerStore;
  storage: WorkerStorage;
  queue: WorkerQueue;
  captureBundle?: string;
  lookup?: DnsLookup;
  navTimeoutMs?: number;
  now?: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/** Returns a queue handler that translates one render. Errors are recorded on the render, never thrown. */
export function makeTranslateHandler(opts: TranslatorOptions) {
  return (data: unknown) => translateJob(data as TranslateJob, opts);
}

export async function translateJob(job: TranslateJob, opts: TranslatorOptions): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const navTimeout = opts.navTimeoutMs ?? 15000;
  const bundle = opts.captureBundle ?? loadCaptureBundle();
  const started = now();

  try {
    const native = await renderAndCapture(job, opts, bundle, navTimeout);
    const envelope = wrapCapture(native, { sourceKind: "server-render", tool: "generic", dpr: 2 });
    await externalizeAssets(envelope, job.renderId, opts.store, opts.storage);

    const serialized = Buffer.from(JSON.stringify(envelope));
    await opts.store.putPayload(job.renderId, serialized);
    await opts.store.updateRender(job.renderId, {
      status: "delivering",
      schemaVersion: envelope.schemaVersion,
      payloadBytes: serialized.byteLength,
      warnings: envelope.warnings,
      timing: { translateMs: now() - started },
    });
    await opts.queue.publish("deliver", { renderId: job.renderId });
    log("translated", { renderId: job.renderId, assets: envelope.assets.length });
  } catch (err) {
    const { code, message } = classifyError(err);
    log("translate failed", { renderId: job.renderId, code, message });
    await opts.store.updateRender(job.renderId, {
      status: "failed",
      error: { code, message },
      doneAt: new Date(now()).toISOString(),
    });
  }
}

async function renderAndCapture(
  job: TranslateJob,
  opts: TranslatorOptions,
  bundle: string,
  navTimeout: number,
): Promise<NativeCapture> {
  const viewport = job.viewport ?? DEFAULT_VIEWPORT;
  const context = await opts.browser.newContext({ viewport, deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    if (job.kind === "url") {
      if (!job.url) throw new BlockedUrlError("url kind requires a url", "nav_blocked");
      await assertSafeUrl(job.url, opts.lookup ?? defaultLookup);
      // belt-and-braces: block any sub-request that isn't https (redirects, sub-resources)
      await page.route("**/*", (route) => {
        const proto = new URL(route.request().url()).protocol;
        if (proto !== "https:" && proto !== "data:" && proto !== "blob:") return route.abort();
        return route.continue();
      });
      await page.goto(job.url, { waitUntil: "networkidle", timeout: navTimeout });
    } else {
      await page.setContent(job.html ?? "", { waitUntil: "networkidle", timeout: navTimeout });
    }
    await page.evaluate("document.fonts && document.fonts.ready").catch(() => {});
    await page.addScriptTag({ content: bundle });
    return (await page.evaluate("window.__designbridge_capture()")) as NativeCapture;
  } finally {
    await context.close();
  }
}

/**
 * Replace inline raster data (`imgData` data-URLs) with content-addressed asset references so the
 * payload stays small (NFR-1; WS frames tiny). Bytes are uploaded to Storage and tracked for GC.
 */
export async function externalizeAssets(
  envelope: CaptureEnvelope,
  renderId: string,
  store: WorkerStore,
  storage: WorkerStorage,
): Promise<void> {
  const assets = new Map<
    string,
    { id: string; kind: "raster"; mime: string; bytes: number; storagePath: string }
  >();
  const nodes: Record<string, unknown>[] = [];
  collectNodes(envelope.root as unknown as Record<string, unknown>, nodes);

  for (const node of nodes) {
    const data = node.imgData;
    if (typeof data !== "string" || !data.startsWith("data:")) continue;
    const parsed = parseDataUrl(data);
    if (!parsed) continue;
    const hash = `sha256:${sha256Bytes(parsed.bytes)}`;
    if (!(await storage.exists(hash))) await storage.put(hash, parsed.mime, parsed.bytes);
    await store.upsertAsset({
      hash,
      mime: parsed.mime,
      bytes: parsed.bytes.byteLength,
      storagePath: hash,
    });
    await store.linkRenderAsset(renderId, hash);
    assets.set(hash, {
      id: hash,
      kind: "raster",
      mime: parsed.mime,
      bytes: parsed.bytes.byteLength,
      storagePath: hash,
    });
    node.assetId = hash;
    delete node.imgData;
  }
  envelope.assets = [...assets.values()] as CaptureEnvelope["assets"];
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

function parseDataUrl(data: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(data);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const bytes = m[2]
    ? Buffer.from(m[3]!, "base64")
    : Buffer.from(decodeURIComponent(m[3]!), "utf8");
  return { mime, bytes };
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function classifyError(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof BlockedUrlError) return { code: err.code, message };
  if (err instanceof Error && err.name === "TimeoutError")
    return { code: "render_timeout", message };
  return { code: "capture_error", message };
}

const defaultLookup: DnsLookup = async (host) => {
  const { lookup } = await import("node:dns/promises");
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
};

let cachedBundle: string | null = null;
export function loadCaptureBundle(): string {
  if (cachedBundle) return cachedBundle;
  const require = createRequire(import.meta.url);
  const path = require.resolve("@designbridge/capture-core/dist/content.js");
  cachedBundle = readFileSync(path, "utf8");
  return cachedBundle;
}
