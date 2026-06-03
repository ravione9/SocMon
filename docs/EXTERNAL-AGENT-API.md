# NetPulse external agent API

Send live portal data to **external agents** (Cursor, Claude API, OpenAI Assistants, n8n, LangGraph, a second LLM service, etc.) without scraping the UI.

**Base URL:** `http://<netpulse-host>:5000` (or your public API URL)  
**Prefix:** `/api/agent`

---

## Authentication

Use **one** of:

| Method | Headers |
|--------|---------|
| NetPulse user JWT | `Authorization: Bearer <jwt>` from `POST /api/auth/login` (short-lived session) |
| User API JWT | `Authorization: Bearer <jwt>` from `POST /api/auth/api-tokens` after an admin enables **Allow API access** on the user (long-lived; revocable) |
| Agent API key | `X-Netpulse-Agent-Key: <secret>` **or** `Authorization: Bearer <secret>` (non-JWT key) |

### Server configuration (`.env`)

```env
NETPULSE_AGENT_API_KEY=your-long-random-secret
NETPULSE_AGENT_USER_EMAIL=agent-service@yourcompany.com
# Optional: push to another agent by default
NETPULSE_AGENT_FORWARD_URL=https://hooks.example.com/netpulse
NETPULSE_AGENT_FORWARD_SECRET=optional-shared-secret
```

The service user must be an **active** Mongo user with the pages you want exported (`storeMonitor`, `soc`, `sentinel`, `infra`, etc.). Agent key auth uses that user’s `allowedPages`.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/agent/meta` | Capabilities, auth method, allowed pages |
| GET | `/api/agent/modules` | Context modules this user may request |
| POST | `/api/agent/context` | Export portal JSON (+ optional prompt text) |
| POST | `/api/agent/query` | Direct answers + context (no NetPulse LLM) |
| POST | `/api/agent/forward` | POST payload to downstream agent URL(s) |
| POST | `/api/agent/deliver` | `query` + `forward` in one call |

---

## 1. Export context only

```bash
curl -s -X POST "$BASE/api/agent/context" \
  -H "X-Netpulse-Agent-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "store monitor summary",
    "autoModules": true,
    "format": "both"
  }'
```

**Body:**

| Field | Type | Description |
|-------|------|-------------|
| `modules` | `string[]` | Optional: `storeMonitor`, `storeProblems`, `soc` |
| `question` | `string` | Used for auto module selection + detail level |
| `autoModules` | `boolean` | Default `true` — keyword-based module pick |
| `format` | `json` \| `prompt` \| `both` | Include `formatContextForPrompt` block |

**Response:** `portalContext`, `contextPreview`, `modulesUsed`, `fetchedAt`.

Pass `portalContext` or `prompt` into your external LLM as system/context.

---

## 2. Query (direct answers + context)

```bash
curl -s -X POST "$BASE/api/agent/query" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "How many stores are offline?",
    "includeContext": true
  }'
```

Runs the same **fast paths** as the AI Assistant (XDR, Zabbix, SOC, hostname, crashes, store counts) when the question matches. Returns a standard envelope:

```json
{
  "source": "netpulse",
  "version": "1",
  "fetchedAt": "2026-06-03T12:00:00.000Z",
  "question": "How many stores are offline?",
  "modulesUsed": ["storeMonitor", "storeProblems"],
  "contextPreview": { "storeMonitor": { "total": 1200, "offline": 5 } },
  "portalContext": { "portal": "netpulse", "modules": { } },
  "prompt": "=== NETPULSE PORTAL CONTEXT ...",
  "directAnswer": {
    "content": "Store Monitor (LIVE ...)\nTotal stores: 1200\n...",
    "mode": "direct-store",
    "fastPath": true
  },
  "instructions": ["Use only portalContext and directAnswer..."]
}
```

If `directAnswer` is present, your downstream agent can answer from it without calling NetPulse’s LLM.

---

## 3. Forward to another agent

POST the envelope to **your** webhook (OpenAI proxy, internal orchestrator, etc.):

```bash
curl -s -X POST "$BASE/api/agent/deliver" \
  -H "X-Netpulse-Agent-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Sentinel failed login last 1 hour",
    "url": "https://your-second-agent.example/v1/ingest"
  }'
```

| Field | Description |
|-------|-------------|
| `url` | Target URL, or array of URLs. Omit to use `NETPULSE_AGENT_FORWARD_URL(S)` |
| `question` | Required for `/deliver` |
| `includeContext` | Default `true` |
| `modules` / `autoModules` | Same as `/context` |

NetPulse sends `POST` with JSON body = standard envelope. Optional header to your hook: `X-Netpulse-Forward-Secret` if `NETPULSE_AGENT_FORWARD_SECRET` is set.

**Response:**

```json
{
  "ok": true,
  "hasDirectAnswer": true,
  "delivered": [
    { "url": "https://...", "ok": true, "status": 200, "durationMs": 340 }
  ],
  "payload": { }
}
```

### Multiple downstream agents

```env
NETPULSE_AGENT_FORWARD_URLS=https://agent-a/hook,https://agent-b/hook
```

Or per request:

```json
{ "question": "...", "url": ["https://agent-a/hook", "https://agent-b/hook"] }
```

---

## 4. Custom payload forward

Send your own JSON (skip NetPulse query):

```bash
curl -s -X POST "$BASE/api/agent/forward" \
  -H "X-Netpulse-Agent-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hooks.example.com/netpulse",
    "payload": { "custom": "data" }
  }'
```

---

## Downstream agent implementation (example)

Your receiving service should:

1. Read `payload.directAnswer.content` if present (fast, accurate).
2. Else use `payload.prompt` or `JSON.stringify(payload.portalContext)` as LLM context.
3. Never invent hostnames/counts not in the payload.
4. Verify `X-Netpulse-Forward-Secret` if you configured one.

**Python (receive hook):**

```python
from flask import Flask, request
app = Flask(__name__)

@app.post("/hooks/netpulse")
def ingest():
    secret = request.headers.get("X-Netpulse-Forward-Secret")
    # validate secret...
    data = request.json
    ctx = data.get("prompt") or data.get("portalContext")
    answer = data.get("directAnswer", {}).get("content")
    # forward ctx + question to your LLM...
    return {"ok": True}
```

**Cursor / script (pull then ask Claude):**

```bash
ENVELOPE=$(curl -s -X POST "$BASE/api/agent/query" \
  -H "X-Netpulse-Agent-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"question":"How many stores offline?"}')
# Pass $ENVELOPE to your LLM CLI or Agent SDK
```

---

## Module IDs (context export)

| ID | Page access | Freshness |
|----|-------------|-----------|
| `storeMonitor` | `storeMonitor` | live (Influx) |
| `storeProblems` | `storeMonitor` | periodic (~2 min) |
| `soc` | `soc` | live (ES firewall) |

**Direct-query only (via `/query`, not `/context` modules):** XDR, Zabbix, hostname bundle, crashes — same as AI Assistant fast paths.

---

## Errors

| Code / status | Meaning |
|---------------|---------|
| 401 `AGENT_KEY_INVALID` | Wrong API key |
| 503 `AGENT_KEY_NOT_CONFIGURED` | `NETPULSE_AGENT_API_KEY` not set |
| 503 `AGENT_USER_NOT_CONFIGURED` | Key set but no service user email/id |
| 400 `FORWARD_URL_REQUIRED` | Forward/deliver without `url` or env default |
| 502 | One or more forward targets failed |

---

## Related

- [PORTAL-LLM-FLOWS.md](./PORTAL-LLM-FLOWS.md) — full portal + in-app AI flows  
- [OLLAMA-INTEGRATION.md](./OLLAMA-INTEGRATION.md) — local LLM for `/api/ai/chat`  
- `server/src/routes/agentPortal.js` — route definitions  
- `server/src/services/ai/agentPortal.js` — export / forward logic
