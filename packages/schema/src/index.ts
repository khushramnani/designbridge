import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export const captureNodeSchema: z.ZodType<CaptureNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      tag: z.string(),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      style: z.record(z.string(), z.unknown()).optional(),
      text: z.string().nullable().optional(),
      children: z.array(captureNodeSchema).default([]),
      raster: z.boolean().optional(),
      imgData: z.string().optional(),
      assetId: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
      src: z.string().nullable().optional(),
      svg: z.string().optional(),
    })
    .passthrough(),
);

export const sourceSchema = z
  .object({
    kind: z.enum(["extension", "server-render", "direct"]),
    tool: z.string().optional(),
    url: z.string().url().optional(),
  })
  .passthrough();

export const viewportSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  dpr: z.number().positive(),
});

export const assetSchema = z.object({
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  kind: z.enum(["raster", "image", "font"]),
  mime: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  storagePath: z.string().min(1),
});

export const fontSchema = z.object({
  family: z.string().min(1),
  weights: z.array(z.number().int()).default([]),
  matched: z.string().optional(),
});

export const warningSchema = z
  .object({
    code: z.string().min(1),
    nodeId: z.string().optional(),
    detail: z.string().min(1),
  })
  .passthrough();

export const captureEnvelopeSchema = z.object({
  schemaVersion: semverSchema,
  source: sourceSchema,
  capturedAt: z.string().datetime(),
  viewport: viewportSchema,
  root: captureNodeSchema,
  assets: z.array(assetSchema).default([]),
  fonts: z.array(fontSchema).default([]),
  warnings: z.array(warningSchema).default([]),
});

export type CaptureNode = {
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  style?: Record<string, unknown>;
  text?: string | null;
  children: CaptureNode[];
  raster?: boolean;
  imgData?: string;
  assetId?: string;
  src?: string | null;
  svg?: string;
  [key: string]: unknown;
};

export type CaptureEnvelope = z.infer<typeof captureEnvelopeSchema>;
export type CaptureAsset = z.infer<typeof assetSchema>;
export type CaptureWarning = z.infer<typeof warningSchema>;

export function validateCapture(input: unknown) {
  return captureEnvelopeSchema.safeParse(input);
}

export function assertCapture(input: unknown): CaptureEnvelope {
  return captureEnvelopeSchema.parse(input);
}

/**
 * Native capture object produced by `capture-core` (format v0.6.0). Becomes the `root` tree of the
 * v1 envelope unchanged (TECHNICAL-SPEC §3). Kept loose on purpose — the engine is the source of
 * truth for the node shape; the envelope only re-frames it.
 */
export interface NativeCapture {
  _designbridge?: boolean;
  version?: string;
  capturedAt?: string;
  sourceUrl?: string;
  viewport?: { w: number; h: number };
  warnings?: Array<string | CaptureWarning>;
  tree: unknown;
}

/** Shape the `figma-builder` engine consumes via the `import` plugin message. */
export interface BuilderData {
  _designbridge: true;
  version: string;
  capturedAt?: string;
  sourceUrl?: string;
  viewport: { w: number; h: number };
  warnings: string[];
  tree: unknown;
}

export interface WrapOptions {
  sourceKind?: "extension" | "server-render" | "direct";
  tool?: string;
  dpr?: number;
}

/**
 * Lift a native capture (capture-core) into the v1 transfer envelope. Used by every *sender*
 * (extension now; worker in Phase 2). Construction only — the relay validates on receipt, so a
 * malformed capture surfaces as a 422 there rather than throwing in the sender's hot path.
 */
export function wrapCapture(native: NativeCapture, opts: WrapOptions = {}): CaptureEnvelope {
  const url = native.sourceUrl;
  return {
    schemaVersion: SCHEMA_VERSION,
    source: {
      kind: opts.sourceKind ?? "extension",
      tool: opts.tool ?? "claude-design",
      ...(url ? { url } : {}),
    },
    capturedAt: native.capturedAt ?? new Date().toISOString(),
    viewport: {
      width: Math.max(1, native.viewport?.w ?? 1440),
      height: Math.max(1, native.viewport?.h ?? 900),
      dpr: opts.dpr ?? 2,
    },
    root: native.tree as CaptureEnvelope["root"],
    assets: [],
    fonts: [],
    warnings: (native.warnings ?? []).map(toWarning),
  };
}

/** Lower a v1 envelope back to the native shape the `figma-builder` engine expects (receiver). */
export function toBuilderData(envelope: CaptureEnvelope): BuilderData {
  return {
    _designbridge: true,
    version: "0.6.0",
    capturedAt: envelope.capturedAt,
    sourceUrl: envelope.source?.url,
    viewport: { w: envelope.viewport.width, h: envelope.viewport.height },
    warnings: (envelope.warnings ?? []).map((w) => (typeof w === "string" ? w : w.detail)),
    tree: envelope.root,
  };
}

function toWarning(w: string | CaptureWarning): CaptureWarning {
  return typeof w === "string" ? { code: "capture", detail: w } : w;
}

export function isCompatible(producer: string, consumer = SCHEMA_VERSION): boolean {
  const parsedProducer = parseSemver(producer);
  const parsedConsumer = parseSemver(consumer);
  if (!parsedProducer || !parsedConsumer) return false;
  return parsedProducer.major === parsedConsumer.major;
}

function parseSemver(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]!),
    minor: Number(match[2]!),
    patch: Number(match[3]!),
  };
}
