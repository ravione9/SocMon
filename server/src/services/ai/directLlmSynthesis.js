import { chat, getAIProvider, getAIProviderConfigStatus } from './aiRouter.js'

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/

const NO_LLM_FOOTERS = [
  '(Direct answer from live Zabbix API — no LLM wait.)',
  '(Direct answer from live Elasticsearch firewall-* — no LLM wait.)',
  '(Direct answer from SocMon live data — no LLM wait.)',
]

/** User wants narrative analysis, not just raw direct-handler output. */
export function wantsLlmSynthesis(question, chatMode = 'monitor') {
  if (chatMode === 'agent') return false
  const q = String(question || '').trim()
  if (!q) return false

  if (/\b(use llm|with llm|llm analysis)\b/i.test(q)) return true

  // analys*, analyse, analyze, analysis, common typo analysys
  if (/\banalys\w*\b/i.test(q)) return true
  if (/\b(interpret|explain|recommend|investigate|troubleshoot|assessment|assess|deep dive|root cause|what'?s wrong|why is)\b/i.test(q)) {
    return true
  }
  if (/\b(summarize|summarise|insights?|action items?|what should we)\b/i.test(q)) return true

  if (/\b(detail|detailed|deep|thorough|comprehensive)\b/i.test(q)) {
    if (/\b(report|review|overview|health|status|check|summary|breakdown|picture|investigation)\b/i.test(q)) {
      return true
    }
  }

  if (/\b(complete|full|comprehensive)\b/i.test(q) && /\b(report|summary|overview)\b/i.test(q)) return true

  // IP/hostname scoped health or investigation without saying "analysis"
  if (IPV4_RE.test(q) && /\b(detail|detailed|health|investigate|issue|problem|breakdown|overview|report|status)\b/i.test(q)) {
    return true
  }

  return false
}

/** Fetch richer Zabbix metrics (ping, interfaces) before LLM synthesis. */
export function wantsDeepInfraFetch(question, chatMode = 'monitor') {
  if (chatMode === 'agent') return false
  if (!wantsLlmSynthesis(question, chatMode)) return false
  const q = String(question || '')
  return IPV4_RE.test(q)
    || /\b(for|of|about|on)\s+[a-z0-9][\w.-]*\b/i.test(q)
}

function stripNoLlmFooters(content) {
  let out = String(content || '')
  for (const footer of NO_LLM_FOOTERS) {
    out = out.replace(`\n\n${footer}`, '').replace(`\n${footer}`, '').replace(footer, '')
  }
  return out.trimEnd()
}

/**
 * Append LLM analysis to a direct-handler result using only the live payload as source.
 * @param {string} question
 * @param {{ content: string, contextMeta?: unknown[], contextPreview?: object, queryContext?: object }} directPayload
 * @param {string} chatMode
 */
export async function appendLlmAnalysis(question, directPayload, chatMode = 'monitor') {
  if (!directPayload?.content || !wantsLlmSynthesis(question, chatMode)) {
    return { payload: directPayload, llmMs: 0 }
  }

  const activeReady = getAIProviderConfigStatus().rows?.find(r => r.key === 'active')?.ok
  if (!activeReady) return { payload: directPayload, llmMs: 0 }

  const system = [
    'You are SocMon AI for Lenskart network and security operations.',
    'The user asked for analysis. LIVE portal data is provided below.',
    'CRITICAL: Use ONLY the live data — never invent hostnames, IPs, event counts, or metrics.',
    'If data is missing or a host is down, say so explicitly.',
    'For FortiGate/firewall hosts: relate VPN tunnel and interface problems to business impact.',
    'Format:',
    '1. Executive summary (2–4 sentences)',
    '2. Key findings (bullets with evidence from the data)',
    '3. Risks / impact',
    '4. Recommended actions (numbered, ops-focused)',
  ].join('\n')

  const liveData = stripNoLlmFooters(directPayload.content)
  const llmStart = Date.now()
  try {
    const analysis = await chat(
      [{ role: 'user', content: String(question || '').trim() }],
      {
        system: `${system}\n\n=== LIVE DATA (authoritative) ===\n${liveData}`,
        maxTokens: 1536,
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
  } catch {
    return {
      payload: {
        ...directPayload,
        content: `${liveData}\n\n(AI analysis unavailable — LLM error. Raw live data above is still authoritative.)`,
      },
      llmMs: Date.now() - llmStart,
    }
  }
}
