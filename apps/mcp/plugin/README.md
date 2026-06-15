# DesignBridge — Claude Code / Cowork plugin

One-command install of the DesignBridge remote MCP server (`send_to_figma`,
`get_figma_context`). This wraps the hosted Streamable HTTP server at
`https://mcp.designbridge.io/mcp` — there is nothing to run locally.

## Install (Claude Code)

```bash
# 1. Add the marketplace (or install from a local checkout of this directory)
/plugin marketplace add designbridge/designbridge
/plugin install designbridge

# 2. Provide your API key (get one at https://designbridge.io)
export DESIGNBRIDGE_API_KEY="db_live_..."
```

`.mcp.json` interpolates `${DESIGNBRIDGE_API_KEY}` from your environment, so the
key never lives in the repo.

## Pair a Figma file first

`send_to_figma` delivers to the Figma file paired with your API key:

1. Open the **DesignBridge** plugin in Figma → it shows a 6-character pairing code.
2. Enter that code once in the extension popup or the dashboard
   (`https://designbridge.io/dashboard`) — this binds your key to that file.

After that, "design a pricing page on my Figma" renders straight onto the canvas.

See [`docs/runbooks/mcp-setup.md`](../../../docs/runbooks/mcp-setup.md) for manual
config snippets (Claude Code without the plugin, Cowork, Codex, generic clients).
