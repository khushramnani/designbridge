import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  isCompatible,
  toBuilderData,
  validateCapture,
  wrapCapture,
  type NativeCapture,
} from "./index.js";

const node = {
  tag: "body",
  x: 0,
  y: 0,
  w: 1440,
  h: 900,
  style: {},
  text: null,
  children: [
    {
      tag: "div",
      x: 24,
      y: 24,
      w: 200,
      h: 80,
      style: { bg: { r: 1, g: 1, b: 1, a: 1 } },
      text: "Hello",
      children: [],
    },
  ],
};

describe("capture schema", () => {
  it("validates a v1 capture envelope with the existing node tree shape", () => {
    const result = validateCapture({
      schemaVersion: SCHEMA_VERSION,
      source: { kind: "extension", tool: "claude-design", url: "https://example.com" },
      capturedAt: new Date("2026-06-12T00:00:00.000Z").toISOString(),
      viewport: { width: 1440, height: 900, dpr: 2 },
      root: node,
      assets: [],
      fonts: [{ family: "Inter", weights: [400, 700], matched: "Inter" }],
      warnings: [{ code: "font-substituted", nodeId: "n1", detail: "Used Inter" }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects inline asset ids that are not content hashes", () => {
    const result = validateCapture({
      schemaVersion: SCHEMA_VERSION,
      source: { kind: "direct" },
      capturedAt: new Date("2026-06-12T00:00:00.000Z").toISOString(),
      viewport: { width: 1440, height: 900, dpr: 2 },
      root: { ...node, assetId: "image-1" },
      assets: [],
      fonts: [],
      warnings: [],
    });

    expect(result.success).toBe(false);
  });

  it("accepts same-major producer and consumer versions", () => {
    expect(isCompatible("1.2.0", "1.0.0")).toBe(true);
    expect(isCompatible("2.0.0", "1.0.0")).toBe(false);
    expect(isCompatible("not-semver", "1.0.0")).toBe(false);
  });
});

describe("native <-> envelope adapter", () => {
  const native: NativeCapture = {
    _designbridge: true,
    version: "0.6.0",
    capturedAt: "2026-06-13T00:00:00.000Z",
    sourceUrl: "https://claude.ai/artifact",
    viewport: { w: 1280, h: 720 },
    warnings: ["Rasterized a gradient", { code: "font-substituted", detail: "Used Inter" }],
    tree: node,
  };

  it("wraps a native capture into a valid v1 envelope", () => {
    const envelope = wrapCapture(native, { dpr: 2 });
    expect(validateCapture(envelope).success).toBe(true);
    expect(envelope.schemaVersion).toBe(SCHEMA_VERSION);
    expect(envelope.source).toMatchObject({ kind: "extension", url: "https://claude.ai/artifact" });
    expect(envelope.viewport).toEqual({ width: 1280, height: 720, dpr: 2 });
    expect(envelope.root).toBe(node);
    // string warnings normalized to {code, detail}
    expect(envelope.warnings[0]).toEqual({ code: "capture", detail: "Rasterized a gradient" });
  });

  it("round-trips envelope -> builder data preserving the tree and warning text", () => {
    const envelope = wrapCapture(native);
    const builderData = toBuilderData(envelope);
    expect(builderData._designbridge).toBe(true);
    expect(builderData.tree).toBe(node);
    expect(builderData.viewport).toEqual({ w: 1280, h: 720 });
    expect(builderData.warnings).toEqual(["Rasterized a gradient", "Used Inter"]);
    expect(builderData.sourceUrl).toBe("https://claude.ai/artifact");
  });

  it("supplies safe defaults when optional native fields are missing", () => {
    const envelope = wrapCapture({ tree: node });
    expect(validateCapture(envelope).success).toBe(true);
    expect(envelope.viewport.width).toBeGreaterThan(0);
    expect(envelope.viewport.height).toBeGreaterThan(0);
  });
});

