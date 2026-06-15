/**
 * Portal data export and query resolution for external / downstream agents.
 */
import { computeUserPageAccess } from '../../utils/computeUserPageAccess.js'
import {
  AI_CONTEXT_MODULES,
  buildPortalContext,
  buildContextPreview,
  formatContextForPrompt,
  suggestContextModules,
  tryDirectStoreAnswer,
  tryDirectCrashAnswer,
} from './portalContextBuilder.js'
import { tryDirectZabbixAnswer } from './zabbixDirectAnswer.js'
import { tryDirectSOCAnswer } from './socDirectAnswer.js'
import { tryDirectHostnameAnswer } from './hostnameDirectAnswer.js'
import { tryDirectXdrAnswer } from './xdrDirectAnswer.js'
import { resolveQueryContext } from './queryContext.js'

const AGENT_PAYLOAD_VERSION = '1'

/**
 * @param {import('../../models/User.js').default} user
 * @param {string} question
 * @param {ReturnType<typeof resolveQueryContext>} ctx
 * @param {string[]} allowedPages
 */
export async function tryDirectAgentAnswer(user, question, ctx, allowedPages) {
  const q = String(question || '').trim()
  if (!q) return null

  const attempts = [
    () => tryDirectXdrAnswer(q, allowedPages, ctx),
    () => tryDirectZabbixAnswer(q, allowedPages, ctx),
    () => tryDirectSOCAnswer(q, allowedPages, ctx),
    () => tryDirectHostnameAnswer(q, allowedPages, ctx),
    () => tryDirectCrashAnswer(q, allowedPages, ctx),
  ]

  for (const run of attempts) {
    const hit = await run()
    if (hit?.content) {
      return {
        content: hit.content,
        mode: hit.mode || 'direct',
        modulesUsed: hit.modulesUsed || [],
        contextMeta: hit.contextMeta || [],
        contextPreview: hit.contextPreview || {},
        chartSeries: hit.chartSeries,
        queryContext: hit.queryContext,
        fastPath: true,
      }
    }
  }

  let moduleIds = suggestContextModules(q, allowedPages, ctx)
  const storeOnly =
    ctx.directHandler === 'store'
    || (/\b(store|stores|offline|online|down|monitor|hostname)\b/i.test(q)
      && !/\b(firewall|fortigate|deny|soc|crash|crashed|crashes)\b/i.test(q)
      && ctx.priorTopic !== 'crash')
  if (storeOnly) moduleIds = moduleIds.filter(id => id !== 'soc')

  if (!moduleIds.length) return null

  const portalContext = await buildPortalContext(user, moduleIds, { userMessage: q })
  const text = tryDirectStoreAnswer(q, portalContext, ctx)
  if (!text) return null

  return {
    content: text,
    mode: 'direct-store',
    modulesUsed: moduleIds,
    contextMeta: portalContext.meta,
    contextPreview: buildContextPreview(portalContext),
    queryContext: {
      topic: ctx.topic || 'store',
      appName: ctx.appName,
      isFollowUp: ctx.isFollowUp,
    },
    fastPath: true,
  }
}

/**
 * @param {import('../../models/User.js').default} user
 * @param {{ modules?: string[], question?: string, autoModules?: boolean, historyFrom?: number, historyTo?: number }} opts
 */
export async function exportPortalContextForAgent(user, opts = {}) {
  const question = String(opts.question || '').trim()
  const { allowedPages } = await computeUserPageAccess(user)

  let moduleIds = Array.isArray(opts.modules)
    ? opts.modules.filter(id => typeof id === 'string')
    : []

  if (opts.autoModules !== false && question) {
    const ctx = resolveQueryContext([{ role: 'user', content: question }])
    const suggested = suggestContextModules(question, allowedPages, ctx)
    moduleIds = [...new Set([...moduleIds, ...suggested])]
  }

  const availableModules = AI_CONTEXT_MODULES.filter(m => allowedPages.includes(m.pageKey)).map(m => ({
    id: m.id,
    label: m.label,
    freshness: m.freshness,
    description: m.description,
  }))

  if (!moduleIds.length) {
    return {
      portalContext: {
        portal: 'netpulse',
        user: { email: user.email, role: user.role },
        modules: {},
        meta: [],
      },
      contextPreview: {},
      prompt: '',
      modulesUsed: [],
      availableModules,
    }
  }

  const portalContext = await buildPortalContext(user, moduleIds, {
    userMessage: question,
    historyFrom: opts.historyFrom,
    historyTo: opts.historyTo,
  })
  const contextPreview = buildContextPreview(portalContext)

  return {
    portalContext,
    contextPreview,
    prompt: formatContextForPrompt(portalContext),
    modulesUsed: moduleIds,
    availableModules,
  }
}

/**
 * @param {import('../../models/User.js').default} user
 * @param {{ question: string, modules?: string[], autoModules?: boolean, includeContext?: boolean }} opts
 */
export async function runAgentPortalQuery(user, opts = {}) {
  const question = String(opts.question || '').trim()
  if (!question) {
    throw Object.assign(new Error('question is required'), { status: 400 })
  }

  const { allowedPages } = await computeUserPageAccess(user)
  const messages = [{ role: 'user', content: question }]
  const ctx = resolveQueryContext(messages)

  const directAnswer = await tryDirectAgentAnswer(user, question, ctx, allowedPages)

  let portalContext = null
  let contextPreview = {}
  let prompt = ''
  let modulesUsed = directAnswer?.modulesUsed || []

  const wantContext = opts.includeContext !== false
  if (wantContext) {
    const exported = await exportPortalContextForAgent(user, {
      modules: opts.modules,
      question,
      autoModules: opts.autoModules,
    })
    portalContext = exported.portalContext
    contextPreview = exported.contextPreview
    prompt = exported.prompt
    modulesUsed = [...new Set([...modulesUsed, ...exported.modulesUsed])]
  }

  return {
    question,
    queryContext: ctx,
    directAnswer,
    portalContext,
    contextPreview,
    prompt,
    modulesUsed,
    hasDirectAnswer: Boolean(directAnswer?.content),
  }
}

/**
 * Standard envelope for Cursor, n8n, custom bots, or a second LLM agent.
 */
export function buildAgentPayload({
  question = null,
  portalContext = null,
  contextPreview = {},
  prompt = '',
  directAnswer = null,
  modulesUsed = [],
  authMethod = 'jwt',
}) {
  const fetchedAt = new Date().toISOString()
  return {
    source: 'netpulse',
    version: AGENT_PAYLOAD_VERSION,
    fetchedAt,
    authMethod,
    question,
    modulesUsed,
    contextPreview,
    portalContext,
    prompt: prompt || (portalContext ? formatContextForPrompt(portalContext) : ''),
    directAnswer: directAnswer
      ? {
          content: directAnswer.content,
          mode: directAnswer.mode,
          fastPath: directAnswer.fastPath,
          queryContext: directAnswer.queryContext,
        }
      : null,
    instructions: [
      'Use only portalContext and directAnswer fields; do not invent hostnames, IPs, or counts.',
      'Respect freshness in portalContext.meta (live vs periodic).',
    ],
  }
}

function resolveForwardUrls(bodyUrl) {
  const fromBody = bodyUrl == null
    ? []
    : Array.isArray(bodyUrl)
      ? bodyUrl
      : [bodyUrl]
  const trimmed = fromBody.map(u => String(u || '').trim()).filter(Boolean)

  if (trimmed.length) return trimmed

  const envMulti = String(process.env.NETPULSE_AGENT_FORWARD_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (envMulti.length) return envMulti

  const single = String(process.env.NETPULSE_AGENT_FORWARD_URL || '').trim()
  return single ? [single] : []
}

/**
 * POST portal payload to one or more downstream agent webhooks.
 * @param {object} payload from buildAgentPayload
 * @param {{ url?: string | string[], headers?: Record<string,string> }} opts
 */
export async function forwardPayloadToAgents(payload, opts = {}) {
  const urls = resolveForwardUrls(opts.url)
  if (!urls.length) {
    throw Object.assign(
      new Error('No forward URL. Pass url in the body or set NETPULSE_AGENT_FORWARD_URL / NETPULSE_AGENT_FORWARD_URLS.'),
      { status: 400, code: 'FORWARD_URL_REQUIRED' },
    )
  }

  const timeoutMs = Math.min(
    Math.max(parseInt(String(process.env.NETPULSE_AGENT_FORWARD_TIMEOUT_MS || '30000'), 10) || 30000, 5000),
    120000,
  )

  const baseHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'NetPulse-Agent-Forward/1.0',
    ...(opts.headers && typeof opts.headers === 'object' ? opts.headers : {}),
  }

  const forwardSecret = String(process.env.NETPULSE_AGENT_FORWARD_SECRET || '').trim()
  if (forwardSecret) baseHeaders['X-Netpulse-Forward-Secret'] = forwardSecret

  const results = await Promise.all(
    urls.map(async (url) => {
      const started = Date.now()
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        })
        let body = null
        const ct = res.headers.get('content-type') || ''
        if (ct.includes('json')) {
          try {
            body = await res.json()
          } catch {
            body = null
          }
        } else {
          const text = await res.text()
          body = text ? { text: text.slice(0, 2000) } : null
        }
        return {
          url,
          ok: res.ok,
          status: res.status,
          durationMs: Date.now() - started,
          response: body,
        }
      } catch (err) {
        return {
          url,
          ok: false,
          status: 0,
          durationMs: Date.now() - started,
          error: err.message || String(err),
        }
      }
    }),
  )

  const allOk = results.every(r => r.ok)
  return { allOk, results }
}
