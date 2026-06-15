/**
 * MCP server definition: tools, resources, prompts.
 *
 * Static surface:
 *   • netpulse_meta     – instance + user identity
 *   • netpulse_modules  – discoverable module catalog (also drives dynamic tools)
 *   • netpulse_context  – cross-module structured snapshot
 *   • netpulse_query    – natural-language question against any modules
 *
 * Dynamic surface (one tool per AI_CONTEXT_MODULE the user can see):
 *   • netpulse_<moduleId>  – fetch THAT dashboard only
 *
 * The dynamic tools auto-update: a background reconcile loop polls
 * /api/agent/modules every NETPULSE_MCP_REFRESH_MS (default 60_000) and
 * adds/removes tools to match. The MCP SDK fires
 * `notifications/tools/list_changed` on each add/remove, so connected
 * clients (Claude Desktop, Cursor, n8n) see new dashboards without
 * reconnecting.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const historyWindowSchema = {
  historyFrom: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Unix seconds (UTC) start of Zabbix CPU/RAM history window. Pair with historyTo.'),
  historyTo: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Unix seconds (UTC) end of Zabbix CPU/RAM history window. Pair with historyFrom.'),
}

const SERVER_INFO = {
  name: 'netpulse-mcp',
  version: '0.2.0',
}

const SERVER_INSTRUCTIONS = `NetPulse MCP server.

Each NetPulse dashboard is exposed as its own tool named \`netpulse_<moduleId>\`.
Call \`netpulse_modules\` to list what's currently available to you. Use the
per-module tools for direct dashboard fetches, or \`netpulse_query\` to ask a
natural-language question that may span multiple modules.`

const DEFAULT_REFRESH_MS = 60_000
const TOOL_NAME_PREFIX = 'netpulse_'

/**
 * Build a fresh MCP server bound to one client session.
 * `netpulse` already carries the per-session JWT.
 *
 * Returns { server, attachDynamicModules, dispose } so the entrypoint can:
 *   await server.connect(transport)
 *   await attachDynamicModules()       // initial registration + start polling
 *   // ... session runs ...
 *   dispose()                          // stop polling on session close
 */
export function createNetPulseMcpServer({ netpulse, refreshMs = DEFAULT_REFRESH_MS }) {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS })

  // ---------- Static core tools ----------

  server.registerTool(
    'netpulse_meta',
    {
      title: 'NetPulse: server identity',
      description:
        'Return the connected NetPulse instance metadata (auth method, current user, allowed pages, configured forward URLs).',
      inputSchema: {},
    },
    async () => jsonResult(await netpulse.meta()),
  )

  server.registerTool(
    'netpulse_modules',
    {
      title: 'NetPulse: list available dashboards',
      description:
        'List every NetPulse dashboard / context module currently visible to the authenticated user. Each entry includes the matching tool name (e.g. `netpulse_storeMonitor`), data freshness, and a description.',
      inputSchema: {},
    },
    async () => {
      const data = await netpulse.modules()
      const enriched = {
        ...data,
        modules: (data?.modules || []).map((m) => ({
          ...m,
          mcpTool: TOOL_NAME_PREFIX + sanitizeToolName(m.id),
        })),
      }
      return jsonResult(enriched)
    },
  )

  server.registerTool(
    'netpulse_context',
    {
      title: 'NetPulse: fetch structured context across modules',
      description:
        'Fetch a cross-module structured JSON snapshot. Use the per-module tools for a single dashboard; use this when you want several at once or to hint module selection from a natural-language question.',
      inputSchema: {
        modules: z
          .array(z.string())
          .optional()
          .describe('Module ids to include. Omit with autoModules=true to let NetPulse pick.'),
        question: z
          .string()
          .optional()
          .describe('Optional natural-language hint that drives auto module selection.'),
        autoModules: z
          .boolean()
          .optional()
          .describe('When true (default), NetPulse picks modules based on the question.'),
        ...historyWindowSchema,
      },
    },
    async (args) =>
      jsonResult(
        await netpulse.context({
          modules: args.modules,
          question: args.question,
          autoModules: args.autoModules ?? true,
          format: 'json',
          historyFrom: args.historyFrom,
          historyTo: args.historyTo,
        }),
      ),
  )

  server.registerTool(
    'netpulse_query',
    {
      title: 'NetPulse: answer question with context',
      description:
        'Run a natural-language question through NetPulse. Returns any fast-path direct answer plus the structured context the answer was derived from. Examples: "Which Mumbai stores are offline?", "List critical alerts in the last hour", "What tickets are open for site BLR-01?"',
      inputSchema: {
        question: z.string().min(1).describe('User question, in plain English.'),
        modules: z
          .array(z.string())
          .optional()
          .describe('Restrict context to these module ids. Omit to let NetPulse decide.'),
        includeContext: z
          .boolean()
          .optional()
          .describe('Include the resolved context payload in the response (default true).'),
      },
    },
    async (args) =>
      jsonResult(
        await netpulse.query({
          question: args.question,
          modules: args.modules,
          autoModules: !args.modules || args.modules.length === 0,
          includeContext: args.includeContext ?? true,
        }),
      ),
  )

  // ---------- Static resources ----------

  server.registerResource(
    'netpulse-meta',
    'netpulse://meta',
    {
      title: 'NetPulse instance metadata',
      description: 'Identity, auth method, allowed pages, configured forward URLs.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await netpulse.meta()),
  )

  server.registerResource(
    'netpulse-modules',
    'netpulse://modules',
    {
      title: 'Available NetPulse dashboards',
      description: 'Modules visible to the authenticated NetPulse user.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await netpulse.modules()),
  )

  // ---------- Static prompts ----------

  server.registerPrompt(
    'noc_status_summary',
    {
      title: 'NOC status summary',
      description: 'Pull NetPulse NOC context and ask the LLM for an executive summary.',
      argsSchema: {
        focus: z
          .string()
          .optional()
          .describe('Optional focus area, e.g. "Bangalore stores" or "core routers".'),
      },
    },
    ({ focus }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Use the `netpulse_query` tool to answer:',
              focus
                ? `Provide a concise NOC status summary focused on ${focus}. Highlight outages, alerts, and any open tickets.`
                : 'Provide a concise NOC status summary across the whole estate. Highlight outages, top alerts, and any open tickets.',
              'Quote numeric counts where available and call out the worst-affected sites first.',
            ].join(' '),
          },
        },
      ],
    }),
  )

  // ---------- Dynamic per-module tools ----------
  // Track the registered tool handles so we can remove ones that disappear
  // server-side (e.g. if a module is gated off a user, or removed from
  // AI_CONTEXT_MODULES). The McpServer's tool handle exposes .remove() and
  // .update() which auto-fire notifications/tools/list_changed.
  const moduleToolHandles = new Map() // moduleId -> { handle, signature }
  let refreshTimer = null
  let stopped = false

  function buildModuleTool(moduleMeta) {
    const toolName = TOOL_NAME_PREFIX + sanitizeToolName(moduleMeta.id)
    const freshnessNote = moduleMeta.freshness === 'live'
      ? 'Data is queried live from the source on every call.'
      : moduleMeta.freshness === 'periodic'
        ? 'Data comes from a periodic snapshot maintained by NetPulse.'
        : ''
    const description = [
      `Fetch the "${moduleMeta.label}" dashboard data from NetPulse.`,
      moduleMeta.description ? `Source: ${moduleMeta.description}.` : '',
      freshnessNote,
      'Use the optional `question` argument to refine module-specific filtering.',
    ].filter(Boolean).join(' ')

    const handle = server.registerTool(
      toolName,
      {
        title: `NetPulse: ${moduleMeta.label}`,
        description,
        inputSchema: {
          question: z
            .string()
            .optional()
            .describe(`Optional natural-language refinement for the ${moduleMeta.label} dashboard.`),
          ...historyWindowSchema,
        },
      },
      async (args) =>
        jsonResult(
          await netpulse.context({
            modules: [moduleMeta.id],
            question: args?.question,
            autoModules: false,
            format: 'json',
            historyFrom: args?.historyFrom,
            historyTo: args?.historyTo,
          }),
        ),
    )

    return { handle, signature: signatureFor(moduleMeta) }
  }

  async function reconcileModuleTools() {
    if (stopped) return
    let modules
    try {
      const resp = await netpulse.modules()
      modules = Array.isArray(resp?.modules) ? resp.modules : []
    } catch (err) {
      // Don't tear down existing tools on a transient failure (network blip,
      // NetPulse restart). Just log and try again on the next tick.
      process.stderr.write(
        `[netpulse-mcp] module reconcile failed: ${err.message}\n`,
      )
      return
    }

    const seen = new Set()
    for (const m of modules) {
      if (!m?.id) continue
      seen.add(m.id)
      const existing = moduleToolHandles.get(m.id)
      const sig = signatureFor(m)
      if (!existing) {
        moduleToolHandles.set(m.id, buildModuleTool(m))
      } else if (existing.signature !== sig) {
        // Description / label changed — refresh in-place. update() fires list_changed.
        const freshnessNote = m.freshness === 'live'
          ? 'Data is queried live from the source on every call.'
          : m.freshness === 'periodic'
            ? 'Data comes from a periodic snapshot maintained by NetPulse.'
            : ''
        existing.handle.update({
          title: `NetPulse: ${m.label}`,
          description: [
            `Fetch the "${m.label}" dashboard data from NetPulse.`,
            m.description ? `Source: ${m.description}.` : '',
            freshnessNote,
          ].filter(Boolean).join(' '),
        })
        existing.signature = sig
      }
    }

    // Remove tools whose modules have vanished from the user's view.
    for (const [id, { handle }] of moduleToolHandles) {
      if (!seen.has(id)) {
        try { handle.remove() } catch { /* already removed */ }
        moduleToolHandles.delete(id)
      }
    }
  }

  async function attachDynamicModules() {
    await reconcileModuleTools()
    if (refreshMs > 0) {
      refreshTimer = setInterval(() => {
        reconcileModuleTools().catch((err) => {
          process.stderr.write(
            `[netpulse-mcp] reconcile tick error: ${err.message}\n`,
          )
        })
      }, refreshMs)
      // Don't keep the event loop alive just for the poll.
      refreshTimer.unref?.()
    }
  }

  function dispose() {
    stopped = true
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  return { server, attachDynamicModules, dispose }
}

function sanitizeToolName(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_')
}

function signatureFor(m) {
  return `${m.label || ''}|${m.description || ''}|${m.freshness || ''}|${m.pageKey || ''}`
}

function jsonResult(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  }
}

function jsonResource(uri, data) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      },
    ],
  }
}
