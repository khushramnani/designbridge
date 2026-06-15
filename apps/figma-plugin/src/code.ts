// DesignBridge Figma plugin — main thread.
// Imports the figma-builder engine for its side effects (it calls figma.showUI and registers the
// "import" message handler), then *wraps* that handler so we can add channel-token persistence and
// a live-canvas context responder. The builder package itself stays untouched.
import "@designbridge/figma-builder";

type Msg = { type?: string; [key: string]: unknown };

const builderHandler = figma.ui.onmessage as
  | ((pluginMessage: Msg, props: OnMessageProperties) => void)
  | undefined;

figma.ui.onmessage = (msg: Msg, props: OnMessageProperties) => {
  switch (msg?.type) {
    case "db_init":
      void sendConfig();
      return;
    case "db_set_token":
      void figma.clientStorage.setAsync("channelToken", msg.token ?? null);
      return;
    case "db_save_relay":
      void figma.clientStorage.setAsync("relayUrl", msg.relayUrl ?? null);
      return;
    case "db_context":
      figma.ui.postMessage({
        type: "db_context_result",
        requestId: msg.requestId,
        context: serializeContext(msg.scope === "page" ? "page" : "selection"),
      });
      return;
    default:
      // import (and anything else) → the battle-tested builder handler
      builderHandler?.(msg, props);
  }
};

async function sendConfig(): Promise<void> {
  const [channelToken, relayUrl] = await Promise.all([
    figma.clientStorage.getAsync("channelToken"),
    figma.clientStorage.getAsync("relayUrl"),
  ]);
  figma.ui.postMessage({
    type: "db_config",
    channelToken: (channelToken as string | undefined) ?? null,
    relayUrl: (relayUrl as string | undefined) ?? null,
  });
}

// --- context responder (FR-2.6): a simple, lossy view of the canvas for get_figma_context -------

function serializeContext(scope: "selection" | "page") {
  const roots = scope === "page" ? figma.currentPage.children : figma.currentPage.selection;
  return { nodes: roots.slice(0, 500).map((node) => serializeNode(node, 0)) };
}

function serializeNode(node: SceneNode, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { id: node.id, name: node.name, type: node.type };
  if ("width" in node) {
    out.x = Math.round(node.x);
    out.y = Math.round(node.y);
    out.w = Math.round(node.width);
    out.h = Math.round(node.height);
  }
  if (node.type === "TEXT" && typeof node.characters === "string") {
    out.text = node.characters.slice(0, 200);
  }
  if ("fills" in node && Array.isArray(node.fills) && node.fills[0]?.type === "SOLID") {
    const { r, g, b } = node.fills[0].color;
    out.fill = rgbToHex(r, g, b);
  }
  if (depth < 5 && "children" in node && node.children.length) {
    out.children = node.children.slice(0, 50).map((child) => serializeNode(child, depth + 1));
  }
  return out;
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
