# MCP setup — connect any AI to your Figma canvas

The DesignBridge MCP server is a remote **Streamable HTTP** server. It exposes two
tools to any MCP-capable AI client:

| Tool                | What it does                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `send_to_figma`     | Render standalone HTML onto your paired Figma file as editable layers. Returns status, a layer summary, and every fidelity warning. |
| `get_figma_context` | Read your current Figma selection or page as structured JSON, so the AI can see the canvas before designing.                        |

- **Endpoint (beta):** `https://mcp.designbridge.io/mcp`
- **Auth (beta):** `Authorization: Bearer db_live_...` — get a key at <https://designbridge.io>.
- **Local dev:** point clients at `http://localhost:8081/mcp` (see [local-dev.md](./local-dev.md)).

> **Prerequisite — pair a Figma file.** `send_to_figma` delivers to the file paired
> with your key. Open the DesignBridge plugin in Figma to get a 6-char code, then
> enter it once in the extension popup or the dashboard. Until you pair, calls
> return _"No Figma file is paired with this API key."_

---

## Claude Code

**Easiest — the plugin** (wraps everything; see `apps/mcp/plugin/`):

```bash
/plugin marketplace add designbridge/designbridge
/plugin install designbridge
export DESIGNBRIDGE_API_KEY="db_live_..."
```

**Manual — one command:**

```bash
claude mcp add --transport http designbridge https://mcp.designbridge.io/mcp \
  --header "Authorization: Bearer db_live_..."
```

**Manual — project `.mcp.json`** (checked into a repo; key via env):

```jsonc
{
  "mcpServers": {
    "designbridge": {
      "type": "http",
      "url": "https://mcp.designbridge.io/mcp",
      "headers": { "Authorization": "Bearer ${DESIGNBRIDGE_API_KEY}" },
    },
  },
}
```

## Claude Cowork / claude.ai (custom connector)

Add a custom connector → **Streamable HTTP** → URL `https://mcp.designbridge.io/mcp`,
header `Authorization: Bearer db_live_...`.
(The Claude connectors **directory** listing is Phase 5 — it needs OAuth 2.1, which
this server's auth layer is designed to swap in without tool changes.)

## Codex / other MCP clients

Any client that speaks Streamable HTTP works. Example (Codex `~/.codex/config.toml`):

```toml
[mcp_servers.designbridge]
url = "https://mcp.designbridge.io/mcp"
http_headers = { "Authorization" = "Bearer db_live_..." }
```

## Smoke test with curl

```bash
# list tools
curl -s https://mcp.designbridge.io/mcp \
  -H "Authorization: Bearer db_live_..." \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# health (no auth)
curl -s https://mcp.designbridge.io/health
```

---

## How it works

```
AI client ──MCP/Streamable HTTP──▶ mcp (apps/mcp) ──REST──▶ relay ──WS──▶ Figma plugin
   send_to_figma  →  POST /v1/renders (kind:html) → translation worker → deliver → build
   get_figma_context → POST /v1/context → relay round-trips the plugin (15s timeout)
```

The MCP server is **stateless**: every request creates a fresh session bound to the
caller's API key and forwards to the relay as that key. No session state, so it
scales horizontally and a restart loses nothing.

## Troubleshooting

| Tool result says…                         | Fix                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| _No Figma file is paired…_                | Open the plugin in Figma, pair the 6-char code.                          |
| _plugin is not connected_                 | Open the DesignBridge plugin in your Figma file.                         |
| _did not respond in time_                 | Keep the Figma tab focused; retry.                                       |
| _API key is missing, invalid, or revoked_ | Set a valid `db_live_...` key in your client config.                     |
| _still processing after 60s_              | Large/slow design; it may still land on the canvas. Check the dashboard. |
