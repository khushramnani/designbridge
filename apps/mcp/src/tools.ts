import type {
  ContextScope,
  DesignBridgeClient,
  GetRenderResponse,
  RenderSummary,
  RenderWarning,
} from "@designbridge/client";
import { z } from "zod";

/** Result shape MCP tool handlers return (a subset of the SDK's CallToolResult). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /** Index signature for structural compatibility with the SDK's CallToolResult. */
  [key: string]: unknown;
}

const text = (s: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: s }],
  ...(isError ? { isError: true } : {}),
});

// --- input schemas (shared by the SDK registration and the typed handlers) ----

export const sendToFigmaShape = {
  html: z
    .string()
    .min(1)
    .describe(
      "Complete standalone HTML document. Use inline CSS or a <style> block; do not reference " +
        "external frameworks that need a build step (Tailwind CDN / Google Fonts links are fine).",
    ),
  name: z.string().max(200).optional().describe("Name for the resulting frame in Figma."),
  viewport: z
    .object({
      width: z.number().int().positive().max(8000).default(1440),
      height: z.number().int().positive().max(8000).default(900),
    })
    .partial()
    .optional()
    .describe("Render viewport (defaults to 1440×900)."),
} as const;

export const getFigmaContextShape = {
  scope: z
    .enum(["selection", "page"])
    .default("selection")
    .describe("Read the current Figma selection, or the whole page."),
} as const;

type SendToFigmaInput = z.infer<z.ZodObject<typeof sendToFigmaShape>>;
type GetFigmaContextInput = z.infer<z.ZodObject<typeof getFigmaContextShape>>;

export interface PollOptions {
  /** Give up after this long; the design may still arrive — we just stop waiting (default 60s, §8). */
  timeoutMs?: number;
  /** Delay between status polls (default 750ms). */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const TERMINAL: ReadonlySet<GetRenderResponse["status"]> = new Set(["done", "failed"]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pull the relay's `{ error: { code, message } }` body off a thrown client error, if present. */
function relayError(err: unknown): { code: string; message: string } | null {
  const body = (err as { body?: { error?: { code?: unknown; message?: unknown } } } | undefined)
    ?.body?.error;
  if (body && typeof body.code === "string") {
    return {
      code: body.code,
      message: typeof body.message === "string" ? body.message : body.code,
    };
  }
  return null;
}

/** Map relay error codes to guidance the calling AI can relay to the user (NFR-2: never silent). */
function friendlyRelayError(err: unknown, fallback: string): string {
  const re = relayError(err);
  if (!re) return `${fallback}: ${err instanceof Error ? err.message : String(err)}`;
  switch (re.code) {
    case "channel_not_paired":
      return "No Figma file is paired with this API key. Open the DesignBridge plugin in Figma, copy the pairing code, and pair it (extension popup or dashboard) before sending designs.";
    case "channel_offline":
      return "The DesignBridge Figma plugin is not connected. Open the plugin in your Figma file and try again.";
    case "context_timeout":
      return "The Figma plugin did not respond in time. Make sure the DesignBridge plugin is open and the file is focused, then try again.";
    case "invalid_api_key":
    case "revoked_api_key":
      return "The DesignBridge API key is missing, invalid, or revoked. Set a valid key in your MCP client config.";
    case "rate_limited":
      return "Rate limit reached for this API key. Wait a moment and try again.";
    case "quota_exceeded":
      return "Daily render quota reached for this API key.";
    case "payload_too_large":
      return `The design is too large to send: ${re.message}`;
    case "invalid_payload":
      return `The relay rejected the request: ${re.message}`;
    default:
      return `${fallback} (${re.code}): ${re.message}`;
  }
}

function renderSummary(s: GetRenderResponse): string {
  const parts: string[] = [`Status: ${s.status}.`];
  if (s.summary) parts.push(formatSummary(s.summary));
  parts.push(formatWarnings(s.warnings));
  if (s.error) parts.push(`Error: [${s.error.code}] ${s.error.message}`);
  return parts.join("\n");
}

function formatSummary(summary: RenderSummary): string {
  const bits: string[] = [];
  if (summary.layers != null) bits.push(`${summary.layers} layers`);
  if (summary.rasterRegions != null) bits.push(`${summary.rasterRegions} rasterized regions`);
  if (summary.fontsSubstituted != null) bits.push(`${summary.fontsSubstituted} fonts substituted`);
  return bits.length ? `Figma import: ${bits.join(", ")}.` : "Figma import complete.";
}

/** Warnings are surfaced verbatim so the AI can pass every fidelity compromise to the user (NFR-2). */
function formatWarnings(warnings: RenderWarning[]): string {
  if (!warnings.length) return "Warnings: none.";
  const lines = warnings.map((w) => {
    const where = w.nodeId ? ` (node ${w.nodeId})` : "";
    return `  - [${w.code}]${where}${w.detail ? ` ${w.detail}` : ""}`;
  });
  return `Warnings (${warnings.length}):\n${lines.join("\n")}`;
}

/**
 * `send_to_figma`: submit standalone HTML, then poll the relay until the render reaches a terminal
 * state (the worker translates → relay delivers → plugin builds → `done`). Returns status, the
 * full warning list, and the Figma build summary.
 */
export async function runSendToFigma(
  client: DesignBridgeClient,
  input: SendToFigmaInput,
  opts: PollOptions = {},
): Promise<ToolResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000; // big pages take a while to build on the canvas
  const pollIntervalMs = opts.pollIntervalMs ?? 750;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());

  let renderId: string;
  try {
    const created = await client.createRender({
      channel: "default",
      ...(input.name ? { name: input.name } : {}),
      payload: {
        kind: "html",
        html: input.html,
        ...(input.viewport
          ? {
              viewport: {
                width: input.viewport.width ?? 1440,
                height: input.viewport.height ?? 900,
              },
            }
          : {}),
      },
    });
    renderId = created.renderId;
  } catch (err) {
    return text(friendlyRelayError(err, "Failed to submit the design"), true);
  }

  const deadline = now() + timeoutMs;
  let last: GetRenderResponse | null = null;
  // Once the plugin has received the render (delivered/building) we KNOW it's on the canvas path —
  // a later timeout then means "slow build", not "disconnected".
  let reachedFigma = false;
  while (now() < deadline) {
    await sleep(pollIntervalMs);
    try {
      last = await client.getRender(renderId);
    } catch (err) {
      return text(friendlyRelayError(err, "Failed to check render status"), true);
    }
    if (last.status === "delivered" || last.status === "delivering" || last.progress) {
      reachedFigma = true;
    }
    if (TERMINAL.has(last.status)) {
      return text(renderSummary(last), last.status === "failed");
    }
  }

  // Timed out waiting. Be honest about what we know rather than implying a disconnect.
  const secs = Math.round(timeoutMs / 1000);
  const built = last?.progress?.count;
  const total = last?.progress?.total;
  const progressNote =
    built != null ? ` (~${built}${total ? `/${total}` : ""} layers built so far)` : "";
  if (reachedFigma) {
    return text(
      `The design reached Figma and is still building${progressNote} after ${secs}s — this is a large/heavy design, not a disconnect. It should finish on the canvas shortly; check Figma. ` +
        `If it's consistently this big, consider splitting it into sections (e.g. hero / features / footer) for faster, more reliable imports.`,
      true,
    );
  }
  return text(
    `The design is still rendering after ${secs}s (last status: ${last?.status ?? "unknown"}, render ${renderId}). ` +
      `It may still appear in Figma shortly. If this persists, the design may be too large or the HTML too slow to render.`,
    true,
  );
}

/**
 * `get_figma_context`: round-trip the live Figma canvas through the relay to the paired plugin and
 * return the simplified node JSON so the AI can see what's on the canvas before designing.
 */
export async function runGetFigmaContext(
  client: DesignBridgeClient,
  input: GetFigmaContextInput,
): Promise<ToolResult> {
  const scope: ContextScope = input.scope ?? "selection";
  try {
    const { context } = await client.requestContext(scope);
    const nodeCount = Array.isArray(context.nodes) ? context.nodes.length : 0;
    return text(
      `Figma ${scope} (${nodeCount} node${nodeCount === 1 ? "" : "s"}):\n${JSON.stringify(
        context,
        null,
        2,
      )}`,
    );
  } catch (err) {
    return text(friendlyRelayError(err, "Failed to read Figma context"), true);
  }
}
