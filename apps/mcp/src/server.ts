import type { DesignBridgeClient } from "@designbridge/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getFigmaContextShape,
  runGetFigmaContext,
  runSendToFigma,
  sendToFigmaShape,
  type PollOptions,
} from "./tools.js";

export const MCP_NAME = "designbridge-mcp";
export const MCP_VERSION = "0.1.0";

/**
 * Build a stateless MCP server bound to one caller's relay client. A fresh instance is created per
 * request in the Streamable HTTP transport so each call acts as the requesting API key (§8).
 */
export function createMcpServer(client: DesignBridgeClient, opts: PollOptions = {}): McpServer {
  const server = new McpServer(
    { name: MCP_NAME, version: MCP_VERSION },
    {
      instructions:
        "DesignBridge turns AI-generated UIs into editable Figma layers. Use send_to_figma to " +
        "render standalone HTML onto the user's paired Figma canvas, and get_figma_context to read " +
        "what is currently on the canvas before designing. Always relay the warnings from " +
        "send_to_figma to the user — they describe every fidelity compromise.",
    },
  );

  server.registerTool(
    "send_to_figma",
    {
      title: "Send design to Figma",
      description:
        "Render a design onto the user's Figma canvas as editable layers. Provide complete " +
        "standalone HTML (inline CSS or <style>; no external framework imports that need a build " +
        "step). Returns the import status, a layer summary, and any fidelity warnings.",
      inputSchema: sendToFigmaShape,
    },
    async (args) => runSendToFigma(client, args, opts),
  );

  server.registerTool(
    "get_figma_context",
    {
      title: "Read Figma canvas",
      description:
        "Read the user's current Figma selection or page as structured JSON, so you can see what " +
        "is on the canvas before designing. Requires the DesignBridge plugin to be open in Figma.",
      inputSchema: getFigmaContextShape,
    },
    async (args) => runGetFigmaContext(client, args),
  );

  return server;
}
