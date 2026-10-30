# Kagi Translate MCP Server

An MCP server that exposes Kagi Translate as tools for any MCP-compatible assistant. It is BYOK: set your own `KAGI_API_KEY` and the server calls Kagi’s Translate API over stdio.

## Tools

- `translate_text` - translate plain text or batch text inputs
- `translate_url` - translate content fetched from a URL
- `proofread` - proofread and correct text

## Requirements

- Node.js 20 or newer
- A Kagi API key in `KAGI_API_KEY`

Kagi’s translate service is currently in a free test period. If you need a key, email support@kagi.com.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set your real API key:

```bash
KAGI_API_KEY=your_real_key_here
```

## Browser-session authentication (local extension)

Alternatively, set `KAGI_TRANSLATE_AUTHORIZATION` to the value of your own
`kagi_session` cookie / `X-Kagi-Authorization` header. This mode supports
`translate_text` (including batches) and `proofread`; `translate_url` is not
supported in session mode. Session credentials take precedence over an API key.

To keep secrets in OpenCode's existing private service configuration, set only
`KAGI_CREDENTIALS_FILE=/home/USER/.config/opencode/service.json` in the MCP's
environment. The server reads the `env` object in that JSON file for
`KAGI_TRANSLATE_AUTHORIZATION`, optional `KAGI_TRANSLATE_SESSION_TOKEN`, and
`KAGI_API_KEY`. Environment variables take precedence over file values.
It does not load unrelated credentials into its environment or modify the file.

The client obtains a fresh Translate token from the authenticated homepage and
refreshes it every 20 minutes. Responses from the web endpoints are decoded as
UTF-8 SSE streams. If the underlying Kagi login is revoked or expires, renew
`KAGI_TRANSLATE_AUTHORIZATION` locally and reconnect the MCP. Never commit or
share session cookies; keep the credentials file private (mode `600`). This is
an unofficial web-interface integration and may change independently of the API.

Run the session-client tests after building:

```bash
node --test tests/session-client.test.mjs
```

## Build

```bash
npm run build
```

This compiles TypeScript into `dist/`.

## Run

```bash
npm start
```

For local development with rebuilds:

```bash
npm run dev
```

This command builds once, watches `src/` for changes, and restarts the server automatically.

## Claude Desktop Configuration

Add the server to `claude_desktop_config.json` and point it at the built entry point:

```json
{
  "mcpServers": {
    "kagi-translate": {
      "command": "node",
      "args": ["/absolute/path/to/kagi-translate-mcp/dist/index.js"],
      "env": {
        "KAGI_API_KEY": "your_real_key_here"
      }
    }
  }
}
```

If you prefer to keep secrets out of the config file, start Claude Desktop with `KAGI_API_KEY` already present in the environment and omit the `env` block.

## Assumptions

The public Kagi docs page is authenticated, so this implementation assumes the confirmed quick-start request shape for translation and conservative optional fields for advanced controls. The code currently sends these payloads:

- `POST /api/translate` with `text` or `texts`, `source_lang`, `target_lang`, and optional `formality`, `gender`, and `context`
- `POST /api/translate-url` with `url`, `source_lang`, `target_lang`, and optional `formality`, `gender`
- `POST /api/proofread` with `text` and optional `language` or `target_lang`

If Kagi’s authenticated docs differ on field names or response shapes, update `src/kagi/types.ts` and the tool request mapping in `src/tools/`.

## Implementation Notes

- All outbound Kagi requests go through `src/kagi/client.ts`.
- Tool inputs are validated with Zod and inferred from the schemas.
- Logging uses `console.error` only; stdout is reserved for MCP protocol traffic.
- Each tool lives in its own file under `src/tools/` and is registered from `src/tools/index.ts`.
