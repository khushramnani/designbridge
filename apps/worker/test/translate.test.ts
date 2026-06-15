import { wrapCapture, type CaptureEnvelope } from "@designbridge/schema";
import { describe, expect, it } from "vitest";
import { externalizeAssets, type WorkerStorage, type WorkerStore } from "../src/translate.js";

class FakeStorage implements WorkerStorage {
  readonly blobs = new Map<string, Buffer>();
  async put(hash: string, _mime: string, bytes: Buffer) {
    this.blobs.set(hash, bytes);
  }
  async exists(hash: string) {
    return this.blobs.has(hash);
  }
}

class FakeStore implements WorkerStore {
  readonly assets: string[] = [];
  readonly links: Array<[string, string]> = [];
  async updateRender() {
    return null;
  }
  async putPayload() {}
  async upsertAsset(a: { hash: string }) {
    this.assets.push(a.hash);
  }
  async linkRenderAsset(renderId: string, hash: string) {
    this.links.push([renderId, hash]);
  }
}

// a 1x1 transparent PNG
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function envelopeWithRaster(): CaptureEnvelope {
  return wrapCapture({
    tree: {
      tag: "div",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      children: [
        { tag: "div", x: 0, y: 0, w: 50, h: 50, raster: true, imgData: PNG_DATA_URL, children: [] },
        {
          tag: "div",
          x: 50,
          y: 0,
          w: 50,
          h: 50,
          raster: true,
          imgData: PNG_DATA_URL,
          children: [],
        },
      ],
    },
  });
}

describe("externalizeAssets", () => {
  it("replaces inline imgData with content-addressed asset ids and dedupes identical bytes", async () => {
    const envelope = envelopeWithRaster();
    const storage = new FakeStorage();
    const store = new FakeStore();

    await externalizeAssets(envelope, "render-1", store, storage);

    // both children had identical PNG bytes → one stored blob, one asset entry
    expect(storage.blobs.size).toBe(1);
    expect(envelope.assets).toHaveLength(1);
    const assetId = envelope.assets[0]!.id;
    expect(assetId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(envelope.assets[0]!.mime).toBe("image/png");

    const children = (envelope.root as { children: Array<Record<string, unknown>> }).children;
    for (const child of children) {
      expect(child.imgData).toBeUndefined(); // inline data removed
      expect(child.assetId).toBe(assetId); // reference added
    }

    // both nodes link the render to the asset (GC bookkeeping)
    expect(store.links).toHaveLength(2);
    expect(store.assets.length).toBeGreaterThan(0);
  });

  it("leaves an asset-free envelope untouched", async () => {
    const envelope = wrapCapture({
      tree: { tag: "div", x: 0, y: 0, w: 10, h: 10, children: [] },
    });
    await externalizeAssets(envelope, "render-2", new FakeStore(), new FakeStorage());
    expect(envelope.assets).toHaveLength(0);
  });
});
