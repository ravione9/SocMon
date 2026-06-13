# netpulse-mcp

Model Context Protocol (MCP) server for NetPulse. Exposes NetPulse data to any
MCP-compatible client (Claude Desktop, Cursor, Continue, n8n, custom agents,
or another MCP server doing tool-chaining).

It is a **thin proxy** over the existing `/api/agent/*` endpoints in
`server/src/routes/agentPortal.js`, so all permission/auth logic stays on
the main NetPulse server. No direct DB access from this container.

## Tool surface

**4 static core tools (always present):**

| Tool | Purpose |
|---|---|
| `netpulse_meta` | Instance identity, current user, allowed pages |
| `netpulse_modules` | List every dashboard the user can see, with the matching `mcpTool` name |
| `netpulse_context` | Pull a cross-module JSON snapshot (one or many modules at once) |
| `netpulse_query` | Ask a natural-language question; returns fast-path answer + context |

**Auto-grown per-dashboard tools** (one per entry in `AI_CONTEXT_MODULES` the
user has access to). Today's defaults:

| Tool | Dashboard |
|---|---|
| `netpulse_storeMonitor` | Store Monitor (live InfluxDB) |
| `netpulse_storeProblems` | Store problem tracker (Mongo lifecycle) |
| `netpulse_storeZabbix` | Store Zabbix (ping, interfaces, CPU/RAM) |
| `netpulse_soc` | SOC / firewall (Elasticsearch, last hour) |
| `netpulse_sentinelXdr` | SentinelOne XDR (Singularity Data Lake) |
| `netpulse_zabbixInfra` | Infra Zabbix (host availability, ping, traffic) |
| `netpulse_orian` | SolarWinds Orion NPM (SWIS nodes, alerts, interfaces) |

**Resources:** `netpulse://meta`, `netpulse://modules`
**Prompts:** `noc_status_summary`

## Adding a new dashboard — zero code changes here

Just add an entry to `AI_CONTEXT_MODULES` in
`server/src/services/ai/portalContextBuilder.js`:

```js
export const AI_CONTEXT_MODULES = [
  // ... existing entries ...
  {
    id: 'newDashboard',
    label: 'New Dashboard',
    pageKey: 'newDashboard',
    freshness: 'live',
    description: 'Short note about where the data comes from',
  },
]
```

Within `NETPULSE_MCP_REFRESH_MS` (default 60 s) every connected MCP client
automatically gets a new tool called `netpulse_newDashboard`, with no
restart, reconnect, or config change. The MCP SDK fires
`notifications/tools/list_changed` on each add/remove and Claude Desktop /
Cursor / n8n redraw their tool palettes.

The same loop also **removes** tools when a module disappears (e.g. you
drop a module's `pageKey` from a user's role) so the palette stays
truthful for that session's user.

---

## Authentication — same JWT as the REST API

MCP clients authenticate **exactly the same way they authenticate to
`http://localhost:3000/api/...`**:

```
Authorization: Bearer <NetPulse JWT>
```

Two flavours of JWT both work, because that's already what NetPulse's
`authenticateUserOrAgent` middleware accepts:

| Token type | How to get it | Lifetime | Best for |
|---|---|---|---|
| **Session JWT** | Sign in to NetPulse, copy from `Authorization` header (DevTools → Network) or local storage | 7 days (default) | Quick experiments, local Cursor / Claude Desktop |
| **API token** (`typ=api`) | NetPulse → Profile → API Tokens → Create | 90 days, revocable | Long-lived agents, n8n, CI, hosted MCP clients |

The MCP server **never validates the JWT locally**. It forwards the bearer
to `GET /api/agent/meta` on the very first request — NetPulse decides whether
the JWT is valid, who it belongs to, and which pages they can see. That same
JWT is reused for every subsequent tool call in the session, so:

- Revoking an API token in NetPulse kills the MCP session on the next call.
- Disabling a user account kills the MCP session on the next call.
- No `JWT_SECRET` is ever shared with the MCP container.

---

## Architecture

```
MCP client (Claude / Cursor / agent / n8n)
         │   Streamable HTTP (JSON-RPC + SSE) on :5050
         │   Authorization: Bearer <NetPulse JWT>
         ▼
   netpulse-mcp  (this service)
         │   Authorization: Bearer <same JWT, forwarded>
         ▼
   netpulse-server  /api/agent/*    (authenticateUserOrAgent → resolveUserFromBearerToken)
         │
         ▼
   Mongo / Redis / Elasticsearch / Zabbix / Sentinel ...
```

---

## Configuration

| Var | Required | Default | Purpose |
|---|---|---|---|
| `NETPULSE_API_BASE` | yes | `http://server:5000` | Base URL of the main NetPulse API. Inside compose use the service name; behind nginx use the public URL. |
| `MCP_TRANSPORT` | no | auto | `http` or `stdio`. Auto-detected: stdio when stdin is piped, otherwise http. |
| `PORT` | no (http only) | `5050` | HTTP listen port. |
| `NETPULSE_USER_JWT` | yes (stdio only) | – | The NetPulse JWT to use for all calls. Only consulted in stdio mode (HTTP mode uses the per-session `Authorization` header instead). |
| `NETPULSE_MCP_REFRESH_MS` | no | `60000` | How often to re-poll `AI_CONTEXT_MODULES` and add/remove per-dashboard tools. `0` disables (one-shot at session-init). 5 s floor enforced. |

No `JWT_SECRET`, no `MCP_PUBLIC_KEYS`, no static agent key — auth is
end-to-end JWT pass-through.

---

## Run with Docker (recommended)

The compose file at the repo root already wires this up:

```bash
docker compose up -d mcp
docker compose logs -f mcp
```

Health check (no auth required for /health):

```bash
curl http://localhost:5050/health
# { "status": "ok", "api": "http://server:5000", "auth": "netpulse-jwt" }
```

End-to-end smoke test using the **same JWT** you use for the API:

```bash
# Get a JWT — same one you'd send to /api/...
JWT=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"..."}' | jq -r .token)

# 1. initialize → server responds with Mcp-Session-Id header
curl -i -X POST http://localhost:5050/mcp \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "0" }
    }
  }'

# 2. reuse the Mcp-Session-Id from the response headers
SID="<paste from response>"

# (no need to resend Authorization on subsequent calls — the bearer is bound
#  to the session at init time. Sending it again is fine and ignored.)
curl -X POST http://localhost:5050/mcp \
  -H "Authorization: Bearer $JWT" \
  -H "Mcp-Session-Id: $SID" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }'

curl -X POST http://localhost:5050/mcp \
  -H "Authorization: Bearer $JWT" \
  -H "Mcp-Session-Id: $SID" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "netpulse_query",
      "arguments": { "question": "How many devices are offline right now?" }
    }
  }'
```

---

## Run as stdio (Claude Desktop / Cursor on a laptop)

For analysts who want NetPulse tools inside Claude Desktop / Cursor on their
own machine, run the same code as a stdio child process. Stdio has no headers
so the JWT is read from `NETPULSE_USER_JWT`:

```bash
cd server-mcp
npm install
NETPULSE_API_BASE=https://your-netpulse.example.com \
NETPULSE_USER_JWT=<your-api-token-from-netpulse-profile> \
MCP_TRANSPORT=stdio \
node src/index.js
```

### Claude Desktop config

`%APPDATA%/Claude/claude_desktop_config.json` (Windows) /
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "netpulse": {
      "command": "node",
      "args": ["C:/Users/Ravi Verma/Desktop/Cur/netpulse/server-mcp/src/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "NETPULSE_API_BASE": "https://your-netpulse.example.com",
        "NETPULSE_USER_JWT": "<api token from NetPulse → Profile → API Tokens>"
      }
    }
  }
}
```

### Cursor MCP config

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "netpulse": {
      "command": "node",
      "args": ["C:/Users/Ravi Verma/Desktop/Cur/netpulse/server-mcp/src/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "NETPULSE_API_BASE": "https://your-netpulse.example.com",
        "NETPULSE_USER_JWT": "<api token>"
      }
    }
  }
}
```

For **remote** MCP (Cursor → hosted netpulse-mcp container), point Cursor at
the URL with the JWT in the header — no separate MCP key needed. In prod the
sidecar is reachable on the same hostname as the UI, at `/mcp`, proxied by
nginx (see `docker/nginx/default.conf`):

```json
{
  "mcpServers": {
    "netpulse": {
      "url": "https://your-netpulse.example.com/mcp",
      "headers": { "Authorization": "Bearer <NetPulse JWT>" }
    }
  }
}
```

---

## n8n integration

n8n's MCP Client node accepts a Streamable-HTTP URL and headers:

- URL: `http://netpulse-mcp:5050/mcp` (inside docker) or the public URL
- Headers: `Authorization: Bearer <NetPulse API token>`

Use an API token (`typ=api`) so the workflow doesn't break every 7 days when
a session JWT expires.

---

## Token lifecycle

- The bearer is captured at session-init and reused for the whole session.
- If NetPulse later returns 401 (token expired/revoked, account disabled),
  the next tool call surfaces the error to the MCP client. The client should
  re-initialize with a fresh JWT.
- Closing the MCP session (DELETE /mcp) clears the captured bearer.

---

## Extending the tool set

There are two extension paths, in order of preference:

### 1. Add a new dashboard (no code in this repo)

Add an entry to `AI_CONTEXT_MODULES` in
`server/src/services/ai/portalContextBuilder.js` and implement its data
loader the same way the existing modules do. Within one refresh tick the
new module shows up as `netpulse_<id>` for every connected client.

### 2. Add a custom tool that doesn't fit the module shape

For one-off tools that don't map to a dashboard (e.g. raw `/api/devices`,
ad-hoc Zabbix metric pulls, control actions):

1. If the target route is JWT-only (`authenticate`), it already accepts
   user JWTs as-is — nothing to change. If it's agent-only, switch it to
   `authenticateUserOrAgent` so the MCP JWT pass-through works.
2. Add a method on `NetPulseClient` in `src/netpulseClient.js`.
3. Register a static tool inside `createNetPulseMcpServer` in
   `src/server.js` with a tight Zod schema.

Keep the rule "MCP server never touches Mongo directly" — that's what makes
audit, page-access enforcement, and rate limiting on the API side keep working.
