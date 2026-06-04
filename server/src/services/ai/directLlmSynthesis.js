import { chat, getAIProvider, getAIProviderConfigStatus } from './aiRouter.js'

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/

const NO_LLM_FOOTERS = [
  '(Direct answer from live Zabbix API — no LLM wait.)',
  '(Direct answer from live Elasticsearch firewall-* — no LLM wait.)',
  '(Direct answer from SocMon live data — no LLM wait.)',
  '(Live Store Monitor data — SocMon InfluxDB snapshot.)',
]

const WELCOME_RE = /^SocMon AI — four chat modes/i

/**
 * Every question with live data goes through LLM.
 * The LLM reads the fetched data and answers the user's actual question
 * instead of just dumping a raw template.
 */
export function wantsLlmSynthesis(question, chatMode = 'monitor', _ctx = null) {
  if (chatMode === 'agent') return false
  const q = String(question || '').trim()
  if (!q) return false
  return true
}

/** Fetch richer Zabbix metrics (ping, interfaces, disk) before LLM synthesis. */
export function wantsDeepInfraFetch(question, chatMode = 'monitor', ctx = null) {
  if (chatMode === 'agent') return false
  const q = String(question || '')
  // Always do deep fetch when the user mentions utilization, resource, memory, CPU, disk, etc.
  if (/\b(utiliz|utilisation|resource|cpu|memory|mem|disk|storage|performance|load|throughput|bandwidth)\b/i.test(q)) return true
  if (IPV4_RE.test(q) || ctx?.ip || ctx?.infraHost) return true
  return /\b(for|of|about|on)\s+[a-z0-9][\w.-]*\b/i.test(q) || Boolean(ctx?.zabbixHost) || Boolean(ctx?.infraHost)
}

function stripNoLlmFooters(content) {
  let out = String(content || '')
  for (const footer of NO_LLM_FOOTERS) {
    out = out.replace(`\n\n${footer}`, '').replace(`\n${footer}`, '').replace(footer, '')
  }
  return out.trimEnd()
}

function trimMessageContent(content, maxLen = 4500) {
  const text = String(content || '')
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}\n… [truncated for context window]`
}

function buildLlmMessages(conversationHistory, question, ctx = null) {
  const q = String(question || '').trim()
  if (!ctx?.isFollowUp) {
    return [{ role: 'user', content: q }]
  }

  const history = (conversationHistory || [])
    .filter(m => m?.role === 'user' || m?.role === 'assistant')
    .filter(m => !(m.role === 'assistant' && WELCOME_RE.test(m.content)))
    .map(m => ({ role: m.role, content: trimMessageContent(m.content) }))

  if (!history.length) return [{ role: 'user', content: q }]

  const last = history[history.length - 1]
  const base = history.slice(-9)
  if (last?.role === 'user' && last.content === q) {
    return base
  }
  return [...base, { role: 'user', content: q }]
}

/**
 * Run LLM on every direct-handler result.
 * LLM reads the live data and answers the user's actual question.
 */
export async function appendLlmAnalysis(question, directPayload, chatMode = 'monitor', conversationHistory = [], ctx = null) {
  if (!directPayload?.content) return { payload: directPayload, llmMs: 0 }
  if (directPayload.skipLlmAnalysis) return { payload: directPayload, llmMs: 0 }

  const activeReady = getAIProviderConfigStatus().rows?.find(r => r.key === 'active')?.ok
  if (!activeReady) return { payload: directPayload, llmMs: 0 }

  const system = [
    'You are SocMon AI, an intelligent assistant for network and security operations at Lenskart.',
    'LIVE portal data fetched for this turn is provided below.',
    'Your job: directly answer the user\'s question using ONLY the data below.',
    'Use conversation history only when the user is clearly continuing the same device or topic (e.g. "same device", "that host").',
    'If the user asks about a new hostname or IP, answer only from LIVE DATA for this turn — ignore unrelated prior messages.',
    '',
    'STRICT RULES:',
    '- Facts (counts, hostnames, IPs, metrics, problem names) must come ONLY from the LIVE DATA block — never invent.',
    '- If the data does not contain what the user asked for (e.g. they asked for CPU% but only availability is in the data), say so clearly and tell them how to get it.',
    '- Do not repeat the raw data back verbatim. Interpret and answer.',
    '- Be concise and ops-focused.',
    '',
    'Response format (adapt as needed):',
    '**Executive Summary** — 2–3 sentence direct answer to what was asked.',
    '**Key Findings** — bullet points with evidence from the data.',
    '**Risks / Impact** — if any issues exist.',
    '**Recommended Actions** — numbered, actionable steps for the ops team.',
  ].join('\n')

  const liveData = stripNoLlmFooters(directPayload.content)
  const llmMessages = buildLlmMessages(conversationHistory, question, ctx)
  const llmStart = Date.now()
  try {
    const analysis = await chat(
      llmMessages,
      {
        system: `${system}\n\n=== LIVE DATA (authoritative for this turn) ===\n${liveData}`,
        maxTokens: 2048,
      },
    )
    const llmMs = Date.now() - llmStart
    return {
      payload: {
        ...directPayload,
        content: `${liveData}\n\n── AI Analysis ──\n${analysis}\n\n(Live data + AI analysis.)`,
        llmSynthesized: true,
      },
      llmMs,
      provider: getAIProvider().name,
    }
  } catch (err) {
    return {
      payload: {
        ...directPayload,
        content: `${liveData}\n\n(AI analysis unavailable — ${err?.message || 'LLM error'}. Raw live data above is still accurate.)`,
      },
      llmMs: Date.now() - llmStart,
    }
  }
}
