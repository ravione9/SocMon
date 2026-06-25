#!/usr/bin/env node
/**
 * NetPulse MCP server entrypoint.
 *
 * Authentication model — same as the NetPulse REST API:
 *   • The MCP client presents a NetPulse JWT in `Authorization: Bearer <jwt>`.
 *   • Both session JWTs (browser login, 7d) and API JWTs (typ=api, 90d,
 *     revocable from /api/auth/api-tokens) are accepted.
 *   • The MCP server NEVER validates the JWT locally — it forwards the bearer
 *     to NetPulse on the very first request (`/api/agent/meta`). NetPulse's
 *     existing middleware decides if it's valid, which user it belongs to,
 *     and what pages they can see. That same JWT is reused for every tool
 *     call in the session.
 *
 * Tool surface — auto-grown from AI_CONTEXT_MODULES on the server:
 *   • 4 static tools (netpulse_meta, netpulse_modules, netpulse_context, netpulse_query)
 *   • One dynamic tool per dashboard the user can see
 *     (e.g. netpulse_storeMonitor, netpulse_soc, netpulse_sentinelXdr, …)
 *   A reconcile loop polls every NETPULSE_MCP_REFRESH_MS (default 60s) and
 *   adds/removes tools when NetPulse adds/removes modules. The MCP SDK
 *   auto-emits `notifications/tools/list_changed` so connected clients
 *   (Claude Desktop, Cursor, n8n) see new dashboards without reconnecting.
 *
 * Transport selection:
 *   • MCP_TRANSPORT=stdio → spawn-as-child (Claude Desktop / Cursor).
 *     JWT comes from env `NETPULSE_USER_JWT`.
 *   • MCP_TRANSPORT=http  → Streamable HTTP on $PORT (default 5050).
 *     JWT comes from `Authorization: Bearer <jwt>` per session.
 *   • Auto: stdio when stdin is piped without a TTY and no $PORT, else http.
 */
import express from 'express'
import { randomUUID } from 'node:crypto'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { NetPulseClient, resolveMcpTimeoutMs, verifyJwtAgainstNetPulse } from './netpulseClient.js'
import { createNetPulseMcpServer, isMinimalMcpToolMode } from './server.js'

const NETPULSE_API_BASE = process.env.NETPULSE_API_BASE || 'http://server:5000'
const MCP_TIMEOUT_MS = resolveMcpTimeoutMs()
const REFRESH_MS = (() => {
  const raw = Number(process.env.NETPULSE_MCP_REFRESH_MS)
  if (!Number.isFinite(raw) || raw < 0) return 60_000
  // 5 s floor to avoid hammering the API; 0 disables the loop entirely.
  return raw === 0 ? 0 : Math.max(5_000, raw)
})()

function pickTransportMode() {
  const explicit = String(process.env.MCP_TRANSPORT || '').toLowerCase()
  if (explicit === 'stdio' || explicit === 'http') return explicit
  return process.stdin.isTTY === false && !process.env.PORT ? 'stdio' : 'http'
}

function extractBearer(req) {
  const raw = String(req.headers['authorization'] || '').trim()
  if (!raw) return null
  return raw.replace(/^Bearer\s+/i, '').trim() || null
}

async function runStdio() {
  const bearer = String(process.env.NETPULSE_USER_JWT || '').trim()
  if (!bearer) {
    process.stderr.write(
      '[netpulse-mcp] ERROR: NETPULSE_USER_JWT is required in stdio mode. ' +
        'Generate an API token in NetPulse (Profile → API Tokens) and pass it via env.\n',
    )
    process.exit(1)
  }

  const verify = await verifyJwtAgainstNetPulse({
    baseUrl: NETPULSE_API_BASE,
    bearer,
  })
  if (!verify.ok) {
    process.stderr.write(
      `[netpulse-mcp] ERROR: NetPulse rejected the JWT (HTTP ${verify.status}): ${verify.error}\n`,
    )
    process.exit(1)
  }

  const netpulse = new NetPulseClient({
    baseUrl: NETPULSE_API_BASE,
    bearer,
    timeoutMs: MCP_TIMEOUT_MS,
  })
  const minimalTools = isMinimalMcpToolMode()
  const { server, attachDynamicModules, dispose } = createNetPulseMcpServer({
    netpulse,
    refreshMs: REFRESH_MS,
    minimalTools,
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await attachDynamicModules()

  const stop = () => { try { dispose() } catch { /* ignore */ } process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  process.stderr.write(
    `[netpulse-mcp] stdio transport ready (api=${NETPULSE_API_BASE}, ` +
    `user=${verify.meta?.serviceUser?.email || 'unknown'}, refresh=${REFRESH_MS}ms, ` +
    `minimalTools=${minimalTools}, timeout=${MCP_TIMEOUT_MS}ms)\n`,
  )
}

async function runHttp() {
  const port = Number(process.env.PORT || 5050)
  const app = express()
  app.use(express.json({ limit: '4mb' }))

  app.get('/health', (_req, res) =>
    res.json({
      status: 'ok',
      api: NETPULSE_API_BASE,
      auth: 'netpulse-jwt',
      moduleRefreshMs: REFRESH_MS,
      minimalTools: isMinimalMcpToolMode(),
      readOnlyTools: true,
      note: 'Claude Desktop Allow prompts are client-side; set NETPULSE_MCP_MINIMAL_TOOLS=1 to expose only 3 tools, or use autoapprove in claude_desktop_config.json (see README).',
    }),
  )

  // One transport+server pair per session, keyed on Mcp-Session-Id.
  const sessions = new Map() // sessionId -> { transport, server, bearer, dispose }

  function send401(res, id, message) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message },
      id: id ?? null,
    })
  }

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id']
    let entry = sessionId ? sessions.get(sessionId) : null

    if (!entry && isInitializeRequest(req.body)) {
      const bearer = extractBearer(req)
      if (!bearer) {
        return send401(
          res,
          req.body?.id,
          'Missing Authorization: Bearer <NetPulse JWT>. Use the same token you would send to /api/...',
        )
      }
      const verify = await verifyJwtAgainstNetPulse({
        baseUrl: NETPULSE_API_BASE,
        bearer,
      })
      if (!verify.ok) {
        return send401(
          res,
          req.body?.id,
          `NetPulse rejected the JWT (HTTP ${verify.status}): ${verify.error}`,
        )
      }

      const netpulse = new NetPulseClient({
        baseUrl: NETPULSE_API_BASE,
        bearer,
        timeoutMs: MCP_TIMEOUT_MS,
      })
      const { server, attachDynamicModules, dispose } = createNetPulseMcpServer({
        netpulse,
        refreshMs: REFRESH_MS,
        minimalTools: isMinimalMcpToolMode(),
      })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, bearer, dispose })
          process.stderr.write(
            `[netpulse-mcp] session opened: ${id} user=${verify.meta?.serviceUser?.email || 'unknown'}\n`,
          )
        },
      })
      transport.onclose = () => {
        const id = transport.sessionId
        if (id && sessions.has(id)) {
          const { dispose: disp } = sessions.get(id) || {}
          try { disp?.() } catch { /* ignore */ }
          sessions.delete(id)
          process.stderr.write(`[netpulse-mcp] session closed: ${id}\n`)
        }
      }
      await server.connect(transport)
      // IMPORTANT: attach dynamic module tools before handling initialize.
      // Some MCP clients (including Claude Desktop builds) cache the first
      // tool list and may not reliably process later list_changed events for
      // newly added tools. Awaiting here ensures tools like
      // netpulse_storeZabbix are present from the first tools/list call.
      try {
        await attachDynamicModules()
      } catch (err) {
        process.stderr.write(
          `[netpulse-mcp] initial dashboard attach failed: ${err.message}\n`,
        )
      }
      entry = { transport, server, bearer, dispose }
    }

    if (!entry) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message:
            'No active MCP session. Send an initialize request with Authorization: Bearer <NetPulse JWT>.',
        },
        id: req.body?.id ?? null,
      })
      return
    }

    await entry.transport.handleRequest(req, res, req.body)
  })

  const sessionPassthrough = async (req, res) => {
    const sessionId = req.headers['mcp-session-id']
    const entry = sessionId ? sessions.get(sessionId) : null
    if (!entry) {
      res.status(400).send('Invalid or missing Mcp-Session-Id header')
      return
    }
    await entry.transport.handleRequest(req, res)
  }
  app.get('/mcp', sessionPassthrough)
  app.delete('/mcp', sessionPassthrough)

  const httpServer = app.listen(port, () => {
    process.stderr.write(
      `[netpulse-mcp] http transport listening on :${port} ` +
      `(api=${NETPULSE_API_BASE}, auth=netpulse-jwt, refresh=${REFRESH_MS}ms)\n`,
    )
  })

  const shutdown = () => {
    for (const [, entry] of sessions) {
      try { entry.dispose?.() } catch { /* ignore */ }
    }
    sessions.clear()
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const mode = pickTransportMode()
if (mode === 'stdio') {
  runStdio().catch((err) => {
    process.stderr.write(`[netpulse-mcp] stdio error: ${err.stack || err.message}\n`)
    process.exit(1)
  })
} else {
  runHttp().catch((err) => {
    process.stderr.write(`[netpulse-mcp] http error: ${err.stack || err.message}\n`)
    process.exit(1)
  })
}
