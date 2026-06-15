import { z } from "zod";

/** Subprotocol advertised on the WS handshake (TECHNICAL-SPEC §6). */
export const WS_SUBPROTOCOL = "designbridge.v1";

/** Inbound frames (plugin → relay). Each is zod-validated before handling (§12: never crash). */
export const helloFrame = z.object({
  type: z.literal("hello"),
  pluginVersion: z.string().optional(),
  schemaVersion: z.string().optional(),
  token: z.string().optional(),
});

export const renderAckFrame = z.object({
  type: z.literal("render.ack"),
  renderId: z.string(),
});

export const renderProgressFrame = z.object({
  type: z.literal("render.progress"),
  renderId: z.string(),
  pct: z.number().optional(),
  count: z.number().optional(),
  total: z.number().optional(),
  stage: z.enum(["fetching", "building"]).optional(),
});

export const renderDoneFrame = z.object({
  type: z.literal("render.done"),
  renderId: z.string(),
  rootNodeId: z.string().optional(),
  summary: z
    .object({
      layers: z.number().optional(),
      rasterRegions: z.number().optional(),
      fontsSubstituted: z.number().optional(),
    })
    .partial()
    .optional(),
});

export const renderFailedFrame = z.object({
  type: z.literal("render.failed"),
  renderId: z.string(),
  error: z.object({ code: z.string(), message: z.string() }),
});

export const contextResponseFrame = z.object({
  type: z.literal("context.response"),
  requestId: z.string(),
  context: z.object({ nodes: z.array(z.unknown()) }).passthrough(),
});

export const pongFrame = z.object({ type: z.literal("pong") });

export const inboundFrame = z.discriminatedUnion("type", [
  helloFrame,
  renderAckFrame,
  renderProgressFrame,
  renderDoneFrame,
  renderFailedFrame,
  contextResponseFrame,
  pongFrame,
]);

export type InboundFrame = z.infer<typeof inboundFrame>;

/** Outbound frames (relay → plugin). */
export type OutboundFrame =
  | { type: "hello.ok"; channelId: string; paired: boolean; serverSchemaVersion: string }
  | { type: "pair.code"; code: string; expiresAt: string }
  | { type: "paired"; keyPrefix: string; channelToken: string }
  | {
      type: "render.new";
      renderId: string;
      name: string | null;
      payloadUrl: string;
      assetBase: string;
      schemaVersion: string | null;
      bytes: number;
    }
  | {
      type: "context.request";
      requestId: string;
      scope: "selection" | "page";
      maxDepth: number;
      maxNodes: number;
    }
  | { type: "ping" }
  | { type: "error"; code: string; message: string; fatal: boolean };
