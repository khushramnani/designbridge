import { createMcpHttpServer } from "./http.js";
import { MCP_NAME, MCP_VERSION } from "./server.js";

export const mcpAppName = MCP_NAME;
export { createMcpHttpServer } from "./http.js";
export { createMcpServer } from "./server.js";
export { ApiKeyAuth } from "./auth.js";
export { runSendToFigma, runGetFigmaContext } from "./tools.js";

function main(): void {
  const port = Number(process.env.PORT ?? 8081);
  const host = process.env.HOST ?? "0.0.0.0";
  // Internal compose URL in prod (mcp → relay over the docker network); falls back to localhost.
  const relayUrl =
    process.env.RELAY_INTERNAL_URL ?? process.env.RELAY_PUBLIC_URL ?? "http://localhost:8080";
  const mcpPath = process.env.MCP_PATH ?? "/mcp";

  const server = createMcpHttpServer({ relayUrl, mcpPath });
  server.listen(port, host, () => {
    const publicUrl = process.env.MCP_PUBLIC_URL ?? `http://localhost:${port}`;
    console.log(
      `${MCP_NAME} v${MCP_VERSION} listening on ${publicUrl}${mcpPath} → relay ${relayUrl}`,
    );
  });
}

const invokedDirectly = process.argv[1]?.endsWith("index.js");
if (invokedDirectly) main();
