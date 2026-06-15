import type { DesignBridgeClient, GetRenderResponse } from "@designbridge/client";
import { describe, expect, it } from "vitest";
import { runGetFigmaContext, runSendToFigma } from "../src/tools.js";

/** Build a fake relay client; only the methods a test exercises need to be supplied. */
function fakeClient(overrides: Partial<DesignBridgeClient>): DesignBridgeClient {
  return overrides as unknown as DesignBridgeClient;
}

function relayThrow(code: string, message = "boom"): Error {
  return Object.assign(new Error(message), { body: { error: { code, message } } });
}

const doneRender = (over: Partial<GetRenderResponse> = {}): GetRenderResponse => ({
  renderId: "r1",
  status: "done",
  warnings: [],
  error: null,
  summary: null,
  progress: null,
  timing: {},
  createdAt: "2026-06-14T00:00:00.000Z",
  doneAt: "2026-06-14T00:00:01.000Z",
  ...over,
});

describe("send_to_figma", () => {
  it("submits HTML, polls to done, and reports summary + warnings verbatim", async () => {
    const client = fakeClient({
      createRender: async () => ({ renderId: "r1", status: "translating", statusUrl: "/x" }),
      getRender: async () =>
        doneRender({
          summary: { layers: 12, rasterRegions: 1, fontsSubstituted: 2 },
          warnings: [{ code: "raster-region", nodeId: "n9", detail: "decorative gradient" }],
        }),
    });

    const res = await runSendToFigma(
      client,
      { html: "<h1>Hi</h1>" },
      { sleep: async () => {}, pollIntervalMs: 1 },
    );

    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain("Status: done");
    expect(text).toContain("12 layers");
    expect(text).toContain("1 rasterized regions");
    expect(text).toContain("2 fonts substituted");
    expect(text).toContain("[raster-region]");
    expect(text).toContain("decorative gradient");
  });

  it("forwards the chosen viewport to the relay", async () => {
    let seen: unknown;
    const client = fakeClient({
      createRender: async (body) => {
        seen = body.payload;
        return { renderId: "r1", status: "translating", statusUrl: "/x" };
      },
      getRender: async () => doneRender(),
    });
    await runSendToFigma(
      client,
      { html: "<h1>Hi</h1>", name: "Hero", viewport: { width: 375, height: 812 } },
      { sleep: async () => {}, pollIntervalMs: 1 },
    );
    expect(seen).toMatchObject({ kind: "html", viewport: { width: 375, height: 812 } });
  });

  it("reports a failed render as an error result with the relay error", async () => {
    const client = fakeClient({
      createRender: async () => ({ renderId: "r1", status: "translating", statusUrl: "/x" }),
      getRender: async () =>
        doneRender({ status: "failed", error: { code: "nav_blocked", message: "SSRF blocked" } }),
    });
    const res = await runSendToFigma(
      client,
      { html: "x" },
      { sleep: async () => {}, pollIntervalMs: 1 },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Status: failed");
    expect(res.content[0]!.text).toContain("nav_blocked");
  });

  it("maps channel_not_paired to actionable guidance", async () => {
    const client = fakeClient({
      createRender: async () => {
        throw relayThrow("channel_not_paired");
      },
    });
    const res = await runSendToFigma(client, { html: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("No Figma file is paired");
  });

  it("stops waiting after the timeout without crashing", async () => {
    let clock = 0;
    const client = fakeClient({
      createRender: async () => ({ renderId: "r1", status: "translating", statusUrl: "/x" }),
      getRender: async () => doneRender({ status: "translating" }),
    });
    const res = await runSendToFigma(
      client,
      { html: "x" },
      {
        now: () => clock,
        sleep: async (ms) => void (clock += ms),
        pollIntervalMs: 1000,
        timeoutMs: 5000,
      },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("still rendering");
  });

  it("on timeout after delivery, says it's still building (not disconnected)", async () => {
    let clock = 0;
    const client = fakeClient({
      createRender: async () => ({ renderId: "r1", status: "translating", statusUrl: "/x" }),
      // plugin received it (delivered) + reports build progress, but never reaches done
      getRender: async () =>
        doneRender({
          status: "delivered",
          progress: { count: 80, total: 150, stage: "building", at: "t" },
        }),
    });
    const res = await runSendToFigma(
      client,
      { html: "x" },
      {
        now: () => clock,
        sleep: async (ms) => void (clock += ms),
        pollIntervalMs: 1000,
        timeoutMs: 5000,
      },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("still building");
    expect(res.content[0]!.text).toContain("80/150");
    expect(res.content[0]!.text).toContain("not a disconnect");
  });
});

describe("get_figma_context", () => {
  it("returns the live canvas context with a node count", async () => {
    const client = fakeClient({
      requestContext: async (scope) => {
        expect(scope).toBe("page");
        return { context: { nodes: [{ name: "Frame 1" }, { name: "Button" }] } };
      },
    });
    const res = await runGetFigmaContext(client, { scope: "page" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("Figma page (2 nodes)");
    expect(res.content[0]!.text).toContain("Frame 1");
  });

  it("maps an offline plugin to a clear message", async () => {
    const client = fakeClient({
      requestContext: async () => {
        throw relayThrow("channel_offline");
      },
    });
    const res = await runGetFigmaContext(client, { scope: "selection" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("plugin is not connected");
  });

  it("maps a context timeout to a clear message", async () => {
    const client = fakeClient({
      requestContext: async () => {
        throw relayThrow("context_timeout");
      },
    });
    const res = await runGetFigmaContext(client, { scope: "selection" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("did not respond in time");
  });
});
