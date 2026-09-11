# NetPulse REST API reference

> Generated from `client/src/config/apiDocsCatalog.js` (same catalog as the in-app **/api-docs** explorer).

Interactive explorer: log into the portal and open **/api-docs**.

Related: [docs/EXTERNAL-AGENT-API.md](docs/EXTERNAL-AGENT-API.md) · [docs/PORTAL-LLM-FLOWS.md](docs/PORTAL-LLM-FLOWS.md) · [server-mcp/README.md](server-mcp/README.md)

---

## Base URL

Use the same origin as this portal (shown above). All paths are under /api/… except /health. In production, nginx proxies /api to the Node server on port 5000.

## Authentication

Header: Authorization: Bearer <jwt>



• Session JWT — from POST /api/auth/login (browser, ~7 days)

• API JWT — from POST /api/auth/api-tokens when admin enabled Allow API access (30d–365d, revocable)

• Agent key — header X-Netpulse-Agent-Key (server env; service user permissions)



Your JWT only accesses pages in allowedPages (same as the portal UI).

## Getting data quickly

For automation, prefer:

1. GET /api/store-monitor/full — all live store monitor data in one call

2. POST /api/agent/query — direct answers + full context, no UI

3. GET /api/store-monitor/overview — stores + summary only (lighter)

4. POST /api/ai/chat with mode:details — full hostname report

5. GET /api/logs/search — raw firewall/Cisco logs

## Query parameters

GET endpoints support query strings — use the Query parameters section on each endpoint in this explorer. Values are editable before Send request.

## Rate limits & timeouts

5000 requests / 15 min per IP on /api/*. Store monitor overview and AI chat can take 30s–6min — use a long client timeout. CSV exports stream; do not expect JSON.

## Page access map

storeMonitor → /api/store-monitor/*, /api/store-alerts/*

soc → /api/stats/soc, /api/logs/*

noc → /api/stats/noc

sentinel → /api/sentinel/*, /api/sentinel-one/*

infra → /api/zabbix/*

storeZabbix → /api/store-zabbix/*

ai → /api/ai/*

admin → /api/users, /api/devices, /api/sites (admin page)

---

# Endpoints

## Authentication & tokens

### POST `/api/auth/login`

**Login (portal session)** · *no auth*

Returns a short-lived session JWT (typ: session) and user profile with allowedPages / pageAccess. Use this for browser login — not for long-lived automation.

**Sample body**

```json
{
  "email": "user@example.com",
  "password": "your-password"
}
```

**Example response**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs…",
  "user": {
    "id": "…",
    "email": "user@example.com",
    "role": "analyst",
    "allowedPages": [
      "soc",
      "storeMonitor"
    ]
  }
}
```

**Notes**

- Session tokens cannot create or revoke API tokens.

### GET `/api/auth/me`

**Current user profile**

Returns id, name, email, role, allowedPages, pageAccess, customRoleId, apiAccessEnabled, theme. Works with session JWT or API JWT.

**Example response**

```json
{
  "id": "…",
  "email": "user@example.com",
  "role": "analyst",
  "allowedPages": [
    "soc",
    "storeMonitor",
    "ai"
  ],
  "pageAccess": {
    "soc": "full",
    "storeMonitor": "full",
    "ai": "read"
  },
  "apiAccessEnabled": true
}
```

### GET `/api/auth/api-tokens`

**List API tokens** · *session JWT only*

Lists active API tokens (id, label, expiresAt, lastUsedAt). Does not return JWT secrets.

**Example response**

```json
{
  "apiAccessEnabled": true,
  "tokens": [
    {
      "id": "…",
      "label": "n8n",
      "expiresAt": "2026-09-01T00:00:00.000Z",
      "lastUsedAt": null
    }
  ]
}
```

### POST `/api/auth/api-tokens`

**Create API JWT** · *session JWT only*

Creates a revocable long-lived JWT (typ: api). Requires apiAccessEnabled on your user (Admin → Users). Max 10 active tokens per user.

**Sample body**

```json
{
  "label": "automation-script",
  "expiresIn": "90d"
}
```

**Example response**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs…",
  "id": "…",
  "label": "automation-script",
  "expiresAt": "2026-09-01T00:00:00.000Z",
  "message": "Copy this token now. It will not be shown again."
}
```

**Notes**

- expiresIn: 30d | 90d | 180d | 365d (or env JWT_API_EXPIRES_IN default).

### DELETE `/api/auth/api-tokens/{tokenId}`

**Revoke API token** · *session JWT only*

Immediately invalidates the token. Scripts using it will receive 401.


| Path param | Description | Example |
|---|---|---|
| `tokenId` | From GET /api/auth/api-tokens | mongo-object-id |

**Example response**

```json
{
  "ok": true
}
```

## External agent API

### GET `/api/agent/meta`

**Agent API metadata**

Version, authMethod (jwt | agent_key | api_jwt), service user, allowedPages, configured forward URLs, endpoint map.

**Example response**

```json
{
  "version": "1",
  "authMethod": "jwt",
  "allowedPages": [
    "storeMonitor",
    "soc",
    "sentinel"
  ],
  "endpoints": {
    "query": "POST /api/agent/query",
    "context": "POST /api/agent/context"
  }
}
```

**Notes**

- Also accepts X-Netpulse-Agent-Key when NETPULSE_AGENT_API_KEY is set on server.

### GET `/api/agent/modules`

**Context modules**

Module ids you may pass to /context or /query: storeMonitor, storeProblems, soc, etc.

**Example response**

```json
{
  "modules": [
    {
      "id": "storeMonitor",
      "label": "Store Monitor",
      "freshness": "live"
    }
  ]
}
```

### POST `/api/agent/context`

**Export portal context (no LLM)**

Fetches live/periodic portal JSON for external agents. format: json | prompt | both — includes a text block suitable for LLM system context.

**Sample body**

```json
{
  "question": "store monitor summary",
  "modules": [
    "storeMonitor",
    "storeProblems"
  ],
  "autoModules": true,
  "format": "both"
}
```

**Example response**

```json
{
  "portalContext": {
    "portal": "netpulse",
    "modules": {}
  },
  "contextPreview": {
    "storeMonitor": {
      "total": 1200,
      "offline": 5
    }
  },
  "modulesUsed": [
    "storeMonitor"
  ],
  "prompt": "=== NETPULSE PORTAL CONTEXT ==="
}
```

**Notes**

- modules: optional string[] — omit with autoModules:true to pick from question keywords.
- Does not call Claude/OpenAI/Ollama.

### POST `/api/agent/query`

**Query + direct answers**

Best endpoint for automation. Runs fast paths (stores, XDR, Zabbix, SOC, hostname) when the question matches; returns directAnswer.content when available.

**Sample body**

```json
{
  "question": "How many stores are offline?",
  "includeContext": true,
  "autoModules": true
}
```

**Example response**

```json
{
  "source": "netpulse",
  "question": "How many stores are offline?",
  "directAnswer": {
    "content": "Store Monitor (LIVE)…",
    "mode": "direct-store",
    "fastPath": true
  },
  "portalContext": {},
  "modulesUsed": [
    "storeMonitor",
    "storeProblems"
  ]
}
```

### POST `/api/agent/forward`

**Forward custom payload**

POST your own JSON to downstream webhook URL(s). Optional NETPULSE_AGENT_FORWARD_SECRET header on target.

**Sample body**

```json
{
  "url": "https://your-agent.example/hooks/netpulse",
  "payload": {
    "custom": "data"
  }
}
```

**Example response**

```json
{
  "ok": true,
  "delivered": [
    {
      "url": "https://…",
      "ok": true,
      "status": 200
    }
  ]
}
```

### POST `/api/agent/deliver`

**Query + forward (one call)**

Runs /query then POSTs the full envelope to url or env NETPULSE_AGENT_FORWARD_URL(S).

**Sample body**

```json
{
  "question": "Sentinel failed login last 1 hour",
  "url": "https://your-agent.example/hooks/netpulse",
  "includeContext": true
}
```

## SocMon AI (`pageKey: ai`)

### GET `/api/ai/modules`

**AI context modules** · requires page `ai`

Same module list as agent API, filtered by your allowedPages.

**Example response**

```json
{
  "modules": [
    {
      "id": "storeMonitor",
      "label": "Store Monitor",
      "freshness": "live"
    }
  ]
}
```

### GET `/api/ai/provider`

**AI provider status** · requires page `ai`

Active LLM (claude | openai | ollama), model name, configuration rows, hints.

**Example response**

```json
{
  "provider": "ollama",
  "model": "llama3.1:8b",
  "active": "ollama",
  "rows": [
    {
      "key": "ollama",
      "label": "Ollama (OLLAMA_HOST)",
      "value": "http://192.168.1.50:11434",
      "ok": true
    }
  ]
}
```

### POST `/api/ai/chat`

**AI chat (multi-turn)** · requires page `ai`

Primary AI endpoint. mode: monitor | details | rca. Fast paths return fastPath:true without calling LLM. Timeout up to ~6 min.

**Sample body**

```json
{
  "messages": [
    {
      "role": "user",
      "content": "How many stores are offline?"
    }
  ],
  "modules": [
    "storeMonitor",
    "storeProblems"
  ],
  "autoModules": true,
  "mode": "monitor"
}
```

**Example response**

```json
{
  "content": "Store Monitor (LIVE)…",
  "fastPath": true,
  "modulesUsed": [
    "storeMonitor"
  ],
  "metrics": {
    "mode": "direct",
    "totalMs": 420,
    "llmMs": 0
  }
}
```

**Notes**

- details mode — full hostname bundle (Store Monitor + Sentinel + SOC + NOC).
- rca mode — correlated root-cause analysis.

### POST `/api/ai/search`

**Natural language log search** · requires page `ai`

Converts a question to Elasticsearch DSL and runs it on firewall-* / cisco-* indices.

**Sample body**

```json
{
  "question": "failed login from 10.0.0.5 in last 24 hours"
}
```

**Example response**

```json
{
  "total": 42,
  "hits": [
    {
      "@timestamp": "…",
      "srcip": "10.0.0.5"
    }
  ]
}
```

### POST `/api/ai/triage`

**Alert triage** · requires page `ai`

LLM triage for a single alert object (severity, summary, recommended actions).

**Sample body**

```json
{
  "alert": {
    "title": "Store offline",
    "severity": "high",
    "hostname": "RP4531-E521BCXS"
  }
}
```

### GET `/api/ai/anomalies`

**Anomaly detection** · requires page `ai`

LLM summary of anomalies in last 1 hour. Optional site filter.


| Query param | Description | Example |
|---|---|---|
| `site` | Optional site filter | store-tag or hostname |

## Store monitor (live) (`pageKey: storeMonitor`)

### GET `/api/store-monitor/full`

**Full bundle (all store monitor data)** · requires page `storeMonitor`

Primary wide API — one call returns live summary, every store row, flattened problems, crash aggregates, settings, and store alert rules/events. Use this instead of calling overview + problems + crashes + alerts separately.


| Query param | Description | Example |
|---|---|---|
| `staleMinutes` | Stale threshold minutes (2–60) | 10 |
| `range` | Store metrics window | -24h |
| `crashRange` | Crash window (defaults to range) | -24h |
| `q` | Filter hostname / storeTag / serial / IP | RP4531 |
| `connState` | online | offline | unknown | offline |
| `issuesOnly` | Only stores with issues | true |
| `includeCrashes` | Include crashes block (default true) | true |
| `includeAlerts` | Include alert rules + recent events (default true) | true |
| `includeSettings` | Include monitor settings (default true) | true |
| `includeProblemHistory` | Mongo problem snapshots (heavier) | false |
| `alertEventsLimit` | Max recent alert events | 50 |
| `problemHistoryLimit` | Max problem history snapshots | 20 |

**Example response**

```json
{
  "summary": {
    "total": 1200,
    "online": 1190,
    "offline": 5,
    "withIssues": 12
  },
  "stores": [
    {
      "hostname": "RP4531-E521BCXS",
      "storeTag": "RP4531",
      "connState": "offline",
      "issues": []
    }
  ],
  "problems": [],
  "crashes": {
    "totalEvents": 42,
    "byApp": [],
    "byType": []
  },
  "alerts": {
    "rules": [],
    "recentEvents": []
  },
  "settings": {
    "manualRopSdwanCodeList": []
  }
}
```

**Notes**

- Recommended for integrations and dashboards.
- For one store time-series use GET /api/store-monitor/stores/{storeTag}/history.
- Set includeProblemHistory=true only when you need Mongo snapshot trends.

### GET `/api/store-monitor/meta`

**Store monitor meta** · requires page `storeMonitor`

Influx URL/bucket status, feature flags, stale defaults.

**Example response**

```json
{
  "configured": true,
  "bucket": "stores",
  "org": "lenskart"
}
```

### GET `/api/store-monitor/overview`

**Overview + all stores (live)** · requires page `storeMonitor`

Primary data API for store health. Returns summary counts plus full store array with connState, metrics, issues.


| Query param | Description | Example |
|---|---|---|
| `staleMinutes` | Mark stale if no ping (2–60) | 10 |
| `range` | Metric window: -1h|-3h|-6h|-12h|-24h|-2d|-7d | -24h |
| `q` | Search hostname, serial, storeTag, gatewayIp | RP4531 |
| `connState` | Filter: online | offline | unknown | offline |
| `issuesOnly` | 1 | true | yes | true |
| `from` | Custom range start (unix sec) | 1704067200 |
| `to` | Custom range end (unix sec) | 1704153600 |

**Example response**

```json
{
  "summary": {
    "total": 1200,
    "online": 1190,
    "offline": 5,
    "withIssues": 12
  },
  "stores": [
    {
      "hostname": "RP4531-E521BCXS",
      "storeTag": "RP4531",
      "connState": "offline",
      "issueCount": 2
    }
  ],
  "fetchedAt": "2026-06-03T12:00:00.000Z"
}
```

### GET `/api/store-monitor/stores`

**Store list (filtered)** · requires page `storeMonitor`

Lighter than overview — stores array only with q / connState / issuesOnly filters.


| Query param | Description | Example |
|---|---|---|
| `staleMinutes` |  | 10 |
| `q` | Search filter | RP |
| `connState` | online | offline | unknown | offline |
| `issuesOnly` |  | true |

**Example response**

```json
{
  "stores": [],
  "total": 0,
  "fetchedAt": "2026-06-03T12:00:00.000Z"
}
```

### GET `/api/store-monitor/stores/{storeTag}/history`

**Store metric history** · requires page `storeMonitor`

Time series for one store (packet loss, latency, etc.) from Influx.


| Path param | Description | Example |
|---|---|---|
| `storeTag` | Store tag (URL-encoded if needed) | RP4531 |


| Query param | Description | Example |
|---|---|---|
| `rangeSec` | Fallback window seconds (300–2592000) | 86400 |
| `from` | Unix start (sec) | 1704067200 |
| `to` | Unix end (sec) | 1704153600 |

### GET `/api/store-monitor/problems`

**Active problems (live)** · requires page `storeMonitor`

Derived problem list from current store snapshot (not the Mongo periodic snapshot).


| Query param | Description | Example |
|---|---|---|
| `staleMinutes` |  | 10 |
| `range` |  | -24h |

### GET `/api/store-monitor/problem-history`

**Problem history (Mongo)** · requires page `storeMonitor`

Periodic snapshot history (~2 min). Use for trends and RCA timelines.


| Query param | Description | Example |
|---|---|---|
| `limit` | Max snapshots | 20 |
| `hostname` | Filter one host | RP4531-E521BCXS |

### GET `/api/store-monitor/crashes`

**Application crashes summary** · requires page `storeMonitor`

Aggregated crash counts by store/app from Influx event log.


| Query param | Description | Example |
|---|---|---|
| `range` |  | -24h |
| `app` | App name filter | pos |
| `hostname` |  | RP4531-E521BCXS |

**Example response**

```json
{
  "totalEvents": 120,
  "affectedStores": 8,
  "affectedStoreList": [
    {
      "storeTag": "RP4531",
      "totalCrashes": 15
    }
  ]
}
```

### GET `/api/store-monitor/crashes/raw`

**Crash events (raw)** · requires page `storeMonitor`

Individual crash event rows for export or deep dive.


| Query param | Description | Example |
|---|---|---|
| `range` |  | -6h |
| `hostname` |  | RP4531-E521BCXS |
| `limit` |  | 100 |

### GET `/api/store-monitor/reports/{type}`

**Store reports** · requires page `storeMonitor`

type: inventory | uptime | issues | connectivity | speedtest


| Path param | Description | Example |
|---|---|---|
| `type` | inventory|uptime|issues|connectivity|speedtest | uptime |


| Query param | Description | Example |
|---|---|---|
| `range` |  | -7d |

### GET `/api/store-monitor/settings`

**Get monitor settings** · requires page `storeMonitor`

Read store monitor thresholds and alert-related settings.

### PUT `/api/store-monitor/settings`

**Update monitor settings** · requires page `storeMonitor`

Requires full storeMonitor page access (write).

**Sample body**

```json
{
  "staleMinutes": 10
}
```

**Notes**

- Write access required.

## Store alerts (`pageKey: storeMonitor`)

### GET `/api/store-alerts`

**List alert rules** · requires page `storeMonitor`

Influx-based store alert rules (Slack/webhook channels).

### GET `/api/store-alerts/events`

**Alert events** · requires page `storeMonitor`

Fired store alert events with optional filters.


| Query param | Description | Example |
|---|---|---|
| `limit` |  | 50 |
| `ruleId` |  | mongo-id |

### GET `/api/store-alerts/status`

**Alert engine status** · requires page `storeMonitor`

Whether the store alert engine is running and last evaluation time.

## SOC — firewall & logs (`pageKey: soc`)

### GET `/api/stats/soc`

**SOC dashboard stats** · requires page `soc`

Firewall KPIs, denies, top threats — Elasticsearch firewall-* (cached).


| Query param | Description | Example |
|---|---|---|
| `range` | ES time range | 12h |
| `from` | Custom from (with to) | ISO date |
| `to` | Custom to | ISO date |

**Example response**

```json
{
  "denies": 1200,
  "allowed": 50000,
  "topSrcIps": []
}
```

### GET `/api/stats/report`

**SOC/NOC combined report** · requires page `soc`

Combined stats report for dashboards.


| Query param | Description | Example |
|---|---|---|
| `range` |  | 24h |

### GET `/api/logs/search`

**Search firewall / Cisco logs** · requires page `soc`

Elasticsearch search with query string and time range.


| Query param | Description | Example |
|---|---|---|
| `q` | Lucene query | action:deny |
| `range` |  | 24h |
| `size` |  | 50 |
| `index` | firewall-* | cisco-* | firewall-* |

### GET `/api/logs/denied`

**Denied sessions** · requires page `soc`

Top denied firewall sessions for SOC view.


| Query param | Description | Example |
|---|---|---|
| `range` |  | 1h |

### GET `/api/logs/events/recent`

**Recent events** · requires page `soc`

Latest firewall/cisco events stream.


| Query param | Description | Example |
|---|---|---|
| `limit` |  | 30 |

### GET `/api/logs/export`

**Export logs (CSV)** · requires page `soc`

Streaming CSV export. Same query params as /search. Long-running — increase timeout.


| Query param | Description | Example |
|---|---|---|
| `q` |  | action:deny |
| `range` |  | 24h |

**Notes**

- Response is text/csv stream, not JSON.

## NOC — network stats (`pageKey: noc`)

### GET `/api/stats/noc`

**NOC dashboard stats** · requires page `noc`

Interface / network KPIs from Elasticsearch cisco-* indices.


| Query param | Description | Example |
|---|---|---|
| `range` |  | 12h |
| `from` |  | ISO |
| `to` |  | ISO |

## Sentinel (Elasticsearch) (`pageKey: sentinel`)

### GET `/api/sentinel/stats`

**Sentinel stats** · requires page `sentinel`

Dashboard KPIs from sentinel-* Elasticsearch index.


| Query param | Description | Example |
|---|---|---|
| `range` |  | 24h |

### GET `/api/sentinel/dashboard`

**Sentinel dashboard bundle** · requires page `sentinel`

Aggregated dashboard payload (threats, connectivity, etc.).


| Query param | Description | Example |
|---|---|---|
| `range` |  | 24h |

### GET `/api/sentinel/events`

**Sentinel events list** · requires page `sentinel`

Paginated XDR-style events from Elasticsearch.


| Query param | Description | Example |
|---|---|---|
| `q` |  | search text |
| `range` |  | 24h |
| `page` |  | 1 |
| `pageSize` |  | 50 |

### GET `/api/sentinel/hostname-search`

**Search by hostname** · requires page `sentinel`

Find Sentinel events for a store hostname or pattern.


| Query param | Description | Example |
|---|---|---|
| `hostname` | Required | RP4531 |
| `range` |  | 6h |

### GET `/api/sentinel/usb-device-search`

**USB device events** · requires page `sentinel`

USB connect/disconnect events in time range.


| Query param | Description | Example |
|---|---|---|
| `range` |  | 1h |
| `hostname` |  | RP4531-E521BCXS |

## SentinelOne console & XDR (`pageKey: sentinel`)

### GET `/api/sentinel-one/configured`

**SentinelOne configured?** · requires page `sentinel`

Whether SENTINEL_ONE_BASE_URL and API token are set on server.

**Example response**

```json
{
  "configured": true
}
```

### GET `/api/sentinel-one/threats`

**List threats** · requires page `sentinel`

Management API threats list with filters.


| Query param | Description | Example |
|---|---|---|
| `limit` |  | 10 |
| `resolved` |  | false |

### POST `/api/sentinel-one/xdr/powerQuery`

**XDR PowerQuery** · requires page `sentinel`

Run Singularity XDR PowerQuery (Log Read Access token). Used by AI direct-xdr path.

**Sample body**

```json
{
  "query": "dataset = xdr_data | filter event.type = \"Login\" | limit 100",
  "from": "1h"
}
```

**Notes**

- Requires SENTINEL_ONE_XDR_BASE_URL + SENTINEL_ONE_XDR_API_TOKEN on server.

## Infra Zabbix (`pageKey: infra`)

### GET `/api/zabbix/overview`

**Zabbix overview** · requires page `infra`

Host counts by availability, problem summary — infra Zabbix instance.

**Example response**

```json
{
  "hosts": {
    "total": 500,
    "up": 480,
    "down": 20
  },
  "problems": {
    "high": 3
  }
}
```

### GET `/api/zabbix/hosts`

**Zabbix hosts** · requires page `infra`

List monitored hosts with status, groups, interfaces.


| Query param | Description | Example |
|---|---|---|
| `search` | Name/host search | switch-name |
| `group` | Host group filter | Network |
| `limit` |  | 100 |

### GET `/api/zabbix/problems`

**Zabbix problems** · requires page `infra`

Active problems (triggers) from infra Zabbix.


| Query param | Description | Example |
|---|---|---|
| `severity` | Min severity 0–5 | 4 |
| `host` |  | hostname |

### GET `/api/zabbix/hosts/{hostId}/items/latest`

**Host latest items** · requires page `infra`

Latest values for key items on one host.


| Path param | Description | Example |
|---|---|---|
| `hostId` | Zabbix hostid | 12345 |

## Store Zabbix (`pageKey: storeZabbix`)

### GET `/api/store-zabbix/overview`

**Store Zabbix overview** · requires page `storeZabbix`

Same shape as infra overview but STORE_ZABBIX_* env instance.

### GET `/api/store-zabbix/hosts`

**Store Zabbix hosts** · requires page `storeZabbix`


| Query param | Description | Example |
|---|---|---|
| `search` |  | RP |
| `limit` |  | 100 |

## Admin — users & devices (`pageKey: admin`)

### GET `/api/users`

**List users** · requires page `admin`

All portal users with roles, allowedPages, apiAccessEnabled. Admin console.

**Example response**

```json
[
  {
    "email": "user@example.com",
    "role": "analyst",
    "apiAccessEnabled": false
  }
]
```

**Notes**

- Typically used from Admin UI; protect network access to /api/users in production.

### POST `/api/users`

**Create user** · requires page `admin`

**Sample body**

```json
{
  "name": "API User",
  "email": "api@example.com",
  "password": "minimum-8-chars",
  "role": "viewer",
  "apiAccessEnabled": true,
  "allowedPages": [
    "storeMonitor",
    "ai"
  ]
}
```

### PUT `/api/users/{userId}`

**Update user** · requires page `admin`

Update role, allowedPages, active, apiAccessEnabled. Disabling apiAccess revokes all API tokens.


| Path param | Description | Example |
|---|---|---|
| `userId` |  | mongo-object-id |

**Sample body**

```json
{
  "apiAccessEnabled": true,
  "allowedPages": [
    "storeMonitor",
    "soc",
    "ai"
  ]
}
```

### GET `/api/devices`

**List devices** · requires page `admin`

Firewalls, switches — IP, site, mgmt credentials flag.

### GET `/api/devices/{deviceId}`

**Get device** · requires page `admin`


| Path param | Description | Example |
|---|---|---|
| `deviceId` |  | mongo-object-id |

### GET `/api/sites`

**List sites** · requires page `admin`

Sites/locations with IP ranges for device assignment.

## System

### GET `/health`

**Health check** · *no auth*

Liveness probe. No authentication. Use before calling authenticated routes.

**Example response**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "ai": "ollama"
}
```

---

## Other mounted prefixes

These are available on the server but not fully listed in the interactive catalog:

| Prefix | Notes |
|---|---|
| `/api/solarwinds` | SolarWinds Orion (JWT + `solarwinds` page) |
| `/api/idcs` | Oracle IDCS users |
| `/api/ad` | Active Directory |
| `/api/nexs` | Nexs auth service |
| `/api/email-sim` | Email simulation (JWT + `emailSim`) |
| `/api/email-sim/pub` | Public email-sim endpoints |
| `/api/tickets` | Tickets |
| `/api/custom-roles` | Custom role templates |
| `/api/web-mgmt` | Device web management |
| `/api/rdp` / `/api/ssh-sessions` | Remote access |
| `/api/ssl` | SSL helpers |
| `/api/auth/saml` | SAML SSO |
| `/mcp` | MCP Streamable HTTP (not a browser page; needs JWT + session) — see `server-mcp/README.md` |
