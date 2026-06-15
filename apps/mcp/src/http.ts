import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DesignBridgeClient } from "@designbridge/client";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ApiKeyAuth, type AuthStrategy } from "./auth.js";
import { createMcpServer } from "./server.js";
import { MCP_NAME, MCP_VERSION } from "./server.js";
import type { PollOptions } from "./tools.js";

export interface McpHttpOptions {
  /** Base URL of the relay this MCP server proxies to (internal compose URL in prod). */
  relayUrl: string;
  /** MCP endpoint path (default `/mcp`). */
  mcpPath?: string;
  auth?: AuthStrategy;
  poll?: PollOptions;
  fetchImpl?: typeof fetch;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-session-id, mcp-protocol-version",
  "access-control-expose-headers": "mcp-session-id",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
  res.end(payload);
}

/** JSON-RPC framed error so MCP clients surface it cleanly (id null = pre-dispatch failure). */
function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Stateless Streamable HTTP MCP server (TECHNICAL-SPEC §8). Each POST gets a fresh McpServer +
 * transport bound to the caller's API key — no session state, so it scales horizontally and a
 * restart loses nothing. GET/DELETE (SSE streams / session teardown) are not supported in stateless
 * mode and return 405.
 */
export function createMcpHttpServer(options: McpHttpOptions): Server {
  const mcpPath = options.mcpPath ?? "/mcp";
  const auth = options.auth ?? new ApiKeyAuth();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) rpcError(res, 500, -32603, `internal error: ${String(err)}`);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (url.pathname === "/health" || url.pathname === "/v1/health") {
      sendJson(res, 200, { ok: true, name: MCP_NAME, version: MCP_VERSION });
      return;
    }

    if (url.pathname !== mcpPath) {
      rpcError(res, 404, -32601, "not found");
      return;
    }

    // Stateless: no server-initiated streams (GET) or session teardown (DELETE).
    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405, { allow: "POST", ...CORS_HEADERS });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "method not allowed (stateless server)" },
          id: null,
        }),
      );
      return;
    }

    if (req.method !== "POST") {
      rpcError(res, 405, -32000, "method not allowed");
      return;
    }

    const ctx = await auth.authenticate(req);
    if (!ctx) {
      res.setHeader("www-authenticate", auth.challenge());
      rpcError(res, 401, -32001, "missing or invalid Authorization bearer token");
      return;
    }

    const client = new DesignBridgeClient({
      baseUrl: options.relayUrl,
      apiKey: ctx.apiKey,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const server = createMcpServer(client, options.poll ?? {});
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}
