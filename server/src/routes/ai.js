import { Router } from 'express'
import { authenticate, authorize } from '../middleware/auth.js'
import { requireAppPage } from '../middleware/requireAppPage.js'
import { computeUserPageAccess } from '../utils/computeUserPageAccess.js'
import {
  chat,
  getAIProvider,
  getAIProviderConfigStatus,
  formatLlmErrorForClient,
  providerModelName,
} from '../services/ai/aiRouter.js'
import { triageAlert } from '../services/ai/triage.js'
import { naturalLanguageSearch } from '../services/ai/nlSearch.js'
import { detectAnomalies } from '../services/ai/anomaly.js'
import {
  AI_CONTEXT_MODULES,
  buildPortalContext,
  buildContextPreview,
  formatContextForPrompt,
  inferContextDetail,
  suggestContextModules,
  tryDirectStoreAnswer,
  tryDirectStoreConnectivityAnswer,
  tryDirectStoreIssuesAnswer,
  tryDirectCrashAnswer,
  extractStoreGroupFilter,
} from '../services/ai/portalContextBuilder.js'
import { tryDirectZabbixAnswer } from '../services/ai/zabbixDirectAnswer.js'
import { tryDirectSOCAnswer, isSocReportQuery } from '../services/ai/socDirectAnswer.js'
import { tryDirectNocAnswer } from '../services/ai/nocDirectAnswer.js'
import { tryDirectRcaAnswer } from '../services/ai/rcaAnalysis.js'
import { tryDirectHostnameAnswer } from '../services/ai/hostnameDirectAnswer.js'
import { tryDirectXdrAnswer } from '../services/ai/xdrDirectAnswer.js'
import { resolveQueryContext, isHostnameDataRequest, isStoreHostnamePortalQuery, extractStoreHostname } from '../services/ai/queryContext.js'
import { isXdrQuestion } from '../services/ai/xdrDirectAnswer.js'
import { isStoreMonitorConnectivityQuery, isStoreMonitorIssuesQuery } from '../services/ai/geoConnectionQuery.js'
import { runAgentChat } from '../services/ai/agentChat.js'
import { needsLiveAgentFallback } from '../services/ai/queryLiveDataFallback.js'
import { appendLlmAnalysis } from '../services/ai/directLlmSynthesis.js'

const router = Router()

const VALID_PROVIDERS = ['claude', 'openai', 'gemini', 'ollama']

const CHAT_SYSTEM_BASE = `You are SocMon AI, an assistant for network and security operations at Lenskart.
Help analysts with firewall logs, store connectivity, SentinelOne, Zabbix, and SOC/NOC workflows.
Be concise, structured, and actionable. Use bullet points and tables when listing hostnames or stores.
For advanced monitoring questions: correlate store offline status with firewall denies, Sentinel threats, USB events, and NOC interface logs when context provides them.
For Zabbix bandwidth/utilization questions: analyze zabbixInfra.hosts[].ports — list all interfaces, highlight highest traffic, note down ports, and give actionable ops guidance.
For RCA-style questions without a direct answer: state hypotheses ranked by evidence, cite counts from context, and list recommended verification steps — never guess hostnames or event counts.
CRITICAL: NEVER invent hostnames, store tags, IP addresses, event counts, or SentinelOne XDR rows.
When portal context or a direct query result is provided below, use ONLY that data for facts.
Use the full conversation to resolve follow-ups ("same device", "that VPN", "what next") — do not ignore prior user or assistant messages.
If live data is missing, say clearly that you cannot access it and tell the user which SocMon module to open.`

router.get('/modules', authenticate, requireAppPage('ai'), async (req, res) => {
  try {
    const { allowedPages } = await computeUserPageAccess(req.user)
    const modules = AI_CONTEXT_MODULES.filter(m => allowedPages.includes(m.pageKey)).map(m => ({
      id: m.id,
      label: m.label,
      freshness: m.freshness,
      description: m.description,
    }))
    res.json({ modules })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/provider', authenticate, (req, res) => {
  try {
    const provider = getAIProvider()
    const status = getAIProviderConfigStatus()
    res.json({
      provider: provider.name,
      model: providerModelName(provider.name),
      ...status,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/provider', authenticate, authorize('admin'), (req, res) => {
  const { provider } = req.body || {}
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `Invalid provider. Use: ${VALID_PROVIDERS.join(', ')}` })
  }
  process.env.AI_PROVIDER = provider
  const status = getAIProviderConfigStatus()
  res.json({ provider: status.active, model: providerModelName(status.active), ...status })
})

router.use(authenticate, requireAppPage('ai'))

router.post('/chat', async (req, res) => {
  try {
    const requestStart = Date.now()
    let contextMs = 0
    let llmMs = 0
    const { messages, modules: requestedModules, autoModules = true, mode: chatMode = 'monitor' } = req.body || {}
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' })
    }
    const sanitized = messages
      .filter(m => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role))
      .map(m => ({ role: m.role, content: m.content.trim() }))
      .filter(m => m.content)
    if (!sanitized.length) return res.status(400).json({ error: 'No valid messages' })

    const lastUser = [...sanitized].reverse().find(m => m.role === 'user')?.content || ''
    const { allowedPages } = await computeUserPageAccess(req.user)
    const ctx = resolveQueryContext(sanitized, { chatMode })

    // Agent mode — LLM picks tools, fetches live data, then synthesizes answer.
    if (chatMode === 'agent') {
      const agentStart = Date.now()
      const providerName = getAIProvider().name
      const defaultTimeoutMs = providerName === 'ollama' ? 300000 : 180000
      const agentTimeoutMs = Number.parseInt(process.env.AI_AGENT_TIMEOUT_MS || String(defaultTimeoutMs), 10)

      try {
        const agentResult = await withTimeout(
          runAgentChat(sanitized, { user: req.user, allowedPages, ctx }),
          agentTimeoutMs,
          `Agent timeout after ${Math.round(agentTimeoutMs / 1000)}s`,
        )
        return res.json({
          content: agentResult.content,
          provider: agentResult.provider || providerName,
          contextMeta: agentResult.contextMeta || [],
          contextPreview: agentResult.contextPreview || {},
          queryContext: {
            topic: 'agent',
            chatMode: 'agent',
            toolsUsed: agentResult.toolsUsed,
            isFollowUp: ctx.isFollowUp,
          },
          modulesUsed: agentResult.modulesUsed || [],
          fastPath: false,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs: agentResult.toolMs || 0,
            llmMs: agentResult.llmMs || 0,
            mode: 'agent',
          },
        })
      } catch (err) {
        const hint = formatLlmErrorForClient(err)
        return res.status(err.message?.includes('timeout') ? 504 : 502).json({
          error: hint.error || err.message,
          errorTable: hint.errorTable,
          queryContext: { topic: 'agent', chatMode: 'agent' },
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs: Date.now() - agentStart,
            llmMs: 0,
            mode: 'agent-error',
          },
        })
      }
    }

    if (isStoreMonitorIssuesQuery(lastUser) && allowedPages.includes('storeMonitor')) {
      const storeIssuesStart = Date.now()
      const storeIssuesDirect = await tryDirectStoreIssuesAnswer(lastUser, allowedPages, ctx)
      if (storeIssuesDirect) {
        if (storeIssuesDirect.skipLlmAnalysis) {
          return res.json({
            content: storeIssuesDirect.content,
            provider: getAIProvider().name,
            contextMeta: storeIssuesDirect.contextMeta,
            contextPreview: storeIssuesDirect.contextPreview,
            queryContext: storeIssuesDirect.queryContext || { topic: 'store', isFollowUp: ctx.isFollowUp },
            modulesUsed: ['storeMonitor', 'storeProblems'],
            fastPath: true,
            metrics: {
              totalMs: Date.now() - requestStart,
              contextMs: Date.now() - storeIssuesStart,
              llmMs: 0,
              mode: 'direct-store-issues',
            },
          })
        }
        const { payload, llmMs: storeLlmMs } = await appendLlmAnalysis(lastUser, storeIssuesDirect, chatMode, sanitized, ctx)
        return res.json({
          content: payload.content,
          provider: getAIProvider().name,
          contextMeta: payload.contextMeta,
          contextPreview: payload.contextPreview,
          queryContext: payload.queryContext || { topic: 'store', isFollowUp: ctx.isFollowUp },
          modulesUsed: ['storeMonitor', 'storeProblems'],
          fastPath: !payload.llmSynthesized,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs: Date.now() - storeIssuesStart,
            llmMs: storeLlmMs,
            mode: payload.llmSynthesized ? 'direct-store-issues-llm' : 'direct-store-issues',
          },
        })
      }
    }

    if (isStoreMonitorConnectivityQuery(lastUser, ctx) && allowedPages.includes('storeMonitor')) {
      const storeConnStart = Date.now()
      const storeConnDirect = await tryDirectStoreConnectivityAnswer(lastUser, allowedPages, ctx)
      if (storeConnDirect) {
        const { payload, llmMs: storeLlmMs } = await appendLlmAnalysis(lastUser, storeConnDirect, chatMode, sanitized, ctx)
        return res.json({
          content: payload.content,
          provider: getAIProvider().name,
          contextMeta: payload.contextMeta,
          contextPreview: payload.contextPreview,
          queryContext: payload.queryContext || {
            topic: 'store',
            isFollowUp: ctx.isFollowUp,
            storeGroup: extractStoreGroupFilter(lastUser, [ctx.priorUser, ctx.priorAssistant].filter(Boolean).join(' ')) || undefined,
            range: ctx.range,
          },
          modulesUsed: ['storeMonitor'],
          fastPath: !payload.llmSynthesized,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs: Date.now() - storeConnStart,
            llmMs: storeLlmMs,
            mode: payload.llmSynthesized ? 'direct-store-conn-llm' : 'direct-store-conn',
          },
        })
      }
    }

    if (allowedPages.includes('storeMonitor') && /\b(crash|crashed|crashes|crahed|app crash|app hang)\b/i.test(lastUser)) {
      const crashEarlyStart = Date.now()
      const crashEarly = await tryDirectCrashAnswer(lastUser, allowedPages, ctx)
      if (crashEarly) {
        const { payload: crPayload, llmMs: crLlmMs } = await appendLlmAnalysis(lastUser, crashEarly, chatMode, sanitized, ctx)
        return res.json({
          content: crPayload.content,
          provider: getAIProvider().name,
          contextMeta: crPayload.contextMeta,
          contextPreview: crPayload.contextPreview,
          queryContext: crPayload.queryContext || { topic: 'crash', appName: ctx.appName, isFollowUp: ctx.isFollowUp },
          modulesUsed: ['storeCrashes'],
          fastPath: !crPayload.llmSynthesized,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs: Date.now() - crashEarlyStart,
            llmMs: crLlmMs,
            mode: crPayload.llmSynthesized ? 'direct-crash-llm' : 'direct-crash',
          },
        })
      }
    }

    const xdrStart = Date.now()
    const xdrDirect = await tryDirectXdrAnswer(lastUser, allowedPages, ctx)
    if (xdrDirect) {
      const { payload: xdrPayload, llmMs: xdrLlmMs } = await appendLlmAnalysis(lastUser, xdrDirect, chatMode, sanitized, ctx)
      return res.json({
        content: xdrPayload.content,
        provider: getAIProvider().name,
        contextMeta: xdrPayload.contextMeta,
        contextPreview: xdrPayload.contextPreview,
        queryContext: xdrPayload.queryContext || { topic: ctx.topic, appName: ctx.appName, isFollowUp: ctx.isFollowUp },
        modulesUsed: ['sentinelXdr'],
        fastPath: !xdrPayload.llmSynthesized,
        metrics: { totalMs: Date.now() - requestStart, contextMs: Date.now() - xdrStart, llmMs: xdrLlmMs, mode: xdrPayload.llmSynthesized ? 'direct-xdr-llm' : 'direct-xdr' },
      })
    }

    const hostnameEarlyStart = Date.now()
    if (
      !isXdrQuestion(lastUser)
      && (isStoreHostnamePortalQuery(lastUser) || (extractStoreHostname(lastUser) && isHostnameDataRequest(lastUser)))
    ) {
      const hostnameEarly = await tryDirectHostnameAnswer(lastUser, allowedPages, ctx)
      if (hostnameEarly) {
        const { payload: hnPayload, llmMs: hnLlmMs } = await appendLlmAnalysis(lastUser, hostnameEarly, chatMode, sanitized, ctx)
        return res.json({
          content: hnPayload.content,
          provider: getAIProvider().name,
          contextMeta: hnPayload.contextMeta,
          contextPreview: hnPayload.contextPreview,
          chartSeries: hostnameEarly.chartSeries,
          queryContext: hnPayload.queryContext || { topic: 'hostname', hostname: ctx.hostname || extractStoreHostname(lastUser), isFollowUp: ctx.isFollowUp },
          modulesUsed: ['storeMonitor', 'storeProblems', 'storeCrashes', 'sentinelXdr', 'soc', 'noc'].filter(id => {
            if (id === 'storeMonitor' || id === 'storeProblems' || id === 'storeCrashes') return allowedPages.includes('storeMonitor')
            if (id === 'sentinelXdr') return allowedPages.includes('sentinel')
            if (id === 'soc') return allowedPages.includes('soc')
            if (id === 'noc') return allowedPages.includes('noc')
            return false
          }),
          fastPath: !hnPayload.llmSynthesized,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs: Date.now() - hostnameEarlyStart,
            llmMs: hnLlmMs,
            mode: hnPayload.llmSynthesized ? 'direct-hostname-llm' : 'direct-hostname',
          },
        })
      }
    }

    const zabbixStart = Date.now()
    if (isSocReportQuery(lastUser)) {
      const socEarly = await tryDirectSOCAnswer(lastUser, allowedPages, ctx)
      if (socEarly) {
        const synthStart = Date.now()
        const { payload, llmMs } = await appendLlmAnalysis(lastUser, socEarly, chatMode, sanitized, ctx)
        return res.json({
          content: payload.content,
          provider: getAIProvider().name,
          contextMeta: payload.contextMeta,
          contextPreview: payload.contextPreview,
          queryContext: payload.queryContext || { topic: 'soc', isFollowUp: ctx.isFollowUp },
          modulesUsed: ['soc'],
          fastPath: !payload.llmSynthesized,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs: Date.now() - zabbixStart,
            llmMs,
            mode: payload.llmSynthesized ? 'direct-soc-llm' : 'direct-soc',
          },
        })
      }
    }

    const zabbixDirect = await tryDirectZabbixAnswer(lastUser, allowedPages, ctx)
    if (zabbixDirect) {
      const { payload, llmMs } = await appendLlmAnalysis(lastUser, zabbixDirect, chatMode, sanitized, ctx)
      return res.json({
        content: payload.content,
        provider: getAIProvider().name,
        contextMeta: payload.contextMeta,
        contextPreview: payload.contextPreview,
        queryContext: payload.queryContext || {
          topic: 'zabbix',
          isFollowUp: ctx.isFollowUp,
        },
        modulesUsed: ['zabbix', 'storeZabbix'].filter(id =>
          id === 'zabbix' ? allowedPages.includes('infra') : allowedPages.includes('storeZabbix'),
        ),
        fastPath: !payload.llmSynthesized,
        metrics: {
          totalMs: Date.now() - requestStart,
          contextMs: Date.now() - zabbixStart,
          llmMs,
          mode: payload.llmSynthesized ? 'direct-zabbix-llm' : 'direct-zabbix',
        },
      })
    }

    const socStart = Date.now()
    const socDirect = await tryDirectSOCAnswer(lastUser, allowedPages, ctx)
    if (socDirect) {
      const { payload, llmMs } = await appendLlmAnalysis(lastUser, socDirect, chatMode, sanitized, ctx)
      return res.json({
        content: payload.content,
        provider: getAIProvider().name,
        contextMeta: payload.contextMeta,
        contextPreview: payload.contextPreview,
        queryContext: payload.queryContext || { topic: 'soc', isFollowUp: ctx.isFollowUp },
        modulesUsed: ['soc'],
        fastPath: !payload.llmSynthesized,
        metrics: {
          totalMs: Date.now() - requestStart,
          contextMs: Date.now() - socStart,
          llmMs,
          mode: payload.llmSynthesized ? 'direct-soc-llm' : 'direct-soc',
        },
      })
    }

    const nocStart = Date.now()
    const nocDirect = await tryDirectNocAnswer(lastUser, allowedPages, ctx)
    if (nocDirect) {
      const { payload: nocPayload, llmMs: nocLlmMs } = await appendLlmAnalysis(lastUser, nocDirect, chatMode, sanitized, ctx)
      return res.json({
        content: nocPayload.content,
        provider: getAIProvider().name,
        contextMeta: nocPayload.contextMeta,
        contextPreview: nocPayload.contextPreview,
        queryContext: nocPayload.queryContext || { topic: 'noc', isFollowUp: ctx.isFollowUp },
        modulesUsed: ['noc', 'sentinel'].filter(id => allowedPages.includes(id)),
        fastPath: !nocPayload.llmSynthesized,
        metrics: { totalMs: Date.now() - requestStart, contextMs: Date.now() - nocStart, llmMs: nocLlmMs, mode: nocPayload.llmSynthesized ? 'direct-noc-llm' : 'direct-noc' },
      })
    }

    const rcaStart = Date.now()
    const rcaDirect = await tryDirectRcaAnswer(lastUser, allowedPages, ctx)
    if (rcaDirect) {
      return res.json({
        content: rcaDirect.content,
        provider: getAIProvider().name,
        contextMeta: rcaDirect.contextMeta,
        contextPreview: rcaDirect.contextPreview,
        queryContext: rcaDirect.queryContext || { topic: 'rca', chatMode: ctx.chatMode, isFollowUp: ctx.isFollowUp },
        modulesUsed: ['storeMonitor', 'storeProblems', 'sentinel', 'soc', 'noc'].filter(id => {
          if (id === 'storeMonitor' || id === 'storeProblems') return allowedPages.includes('storeMonitor')
          return allowedPages.includes(id)
        }),
        fastPath: true,
        metrics: {
          totalMs: Date.now() - requestStart,
          contextMs: Date.now() - rcaStart,
          llmMs: 0,
          mode: 'direct-rca',
        },
      })
    }

    const hostnameStart = Date.now()
    const hostnameDirect = await tryDirectHostnameAnswer(lastUser, allowedPages, ctx)
    if (hostnameDirect) {
      const { payload: hnPayload, llmMs: hnLlmMs } = await appendLlmAnalysis(lastUser, hostnameDirect, chatMode, sanitized, ctx)
      return res.json({
        content: hnPayload.content,
        provider: getAIProvider().name,
        contextMeta: hnPayload.contextMeta,
        contextPreview: hnPayload.contextPreview,
        chartSeries: hostnameDirect.chartSeries,
        queryContext: hnPayload.queryContext || { topic: 'hostname', hostname: ctx.hostname, isFollowUp: ctx.isFollowUp },
        modulesUsed: ['storeMonitor', 'storeProblems', 'storeCrashes', 'sentinelXdr', 'soc', 'noc'].filter(id => {
          if (id === 'storeMonitor' || id === 'storeProblems' || id === 'storeCrashes') return true
          if (id === 'sentinelXdr') return allowedPages.includes('sentinel')
          if (id === 'soc') return allowedPages.includes('soc')
          if (id === 'noc') return allowedPages.includes('noc')
          return false
        }),
        fastPath: !hnPayload.llmSynthesized,
        metrics: { totalMs: Date.now() - requestStart, contextMs: Date.now() - hostnameStart, llmMs: hnLlmMs, mode: hnPayload.llmSynthesized ? 'direct-hostname-llm' : 'direct-hostname' },
      })
    }

    let moduleIds = Array.isArray(requestedModules)
      ? requestedModules.filter(id => typeof id === 'string')
      : []

    // Hostname data queries — never wait on slow LLM.
    if ((ctx.directHandler === 'hostname' || ctx.hostname) && ctx.directHandler !== 'zabbix') {
      const hostnameRetry = await tryDirectHostnameAnswer(lastUser, allowedPages, ctx)
      if (hostnameRetry) {
        return res.json({
          content: hostnameRetry.content,
          provider: getAIProvider().name,
          contextMeta: hostnameRetry.contextMeta,
          contextPreview: hostnameRetry.contextPreview,
          chartSeries: hostnameRetry.chartSeries,
          queryContext: hostnameRetry.queryContext || { topic: 'hostname', hostname: ctx.hostname, isFollowUp: ctx.isFollowUp },
          modulesUsed: ['storeMonitor', 'storeProblems', 'storeCrashes', 'sentinelXdr', 'soc', 'noc'],
          fastPath: true,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs: 0,
            llmMs: 0,
            mode: 'direct-hostname',
          },
        })
      }
    }

    // NOC / USB follow-ups — never wait on slow LLM.
    if (ctx.directHandler === 'noc' || (ctx.isFollowUp && ctx.priorTopic === 'noc')) {
      const nocRetry = await tryDirectNocAnswer(lastUser, allowedPages, ctx)
      if (nocRetry) {
        return res.json({
          content: nocRetry.content,
          provider: getAIProvider().name,
          contextMeta: nocRetry.contextMeta,
          contextPreview: nocRetry.contextPreview,
          queryContext: nocRetry.queryContext || { topic: 'noc', isFollowUp: ctx.isFollowUp },
          modulesUsed: ['noc', 'sentinel'].filter(id => allowedPages.includes(id)),
          fastPath: true,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs: 0,
            llmMs: 0,
            mode: 'direct-noc',
          },
        })
      }
    }

    // RCA follow-ups — never wait on slow generic LLM.
    if (
      (ctx.directHandler === 'rca' || (ctx.isFollowUp && ctx.priorTopic === 'rca') || ctx.chatMode === 'rca')
      && !isStoreMonitorIssuesQuery(lastUser)
      && !isStoreMonitorConnectivityQuery(lastUser, ctx)
    ) {
      const rcaRetry = await tryDirectRcaAnswer(lastUser, allowedPages, ctx)
      if (rcaRetry) {
        return res.json({
          content: rcaRetry.content,
          provider: getAIProvider().name,
          contextMeta: rcaRetry.contextMeta,
          contextPreview: rcaRetry.contextPreview,
          queryContext: rcaRetry.queryContext || { topic: 'rca', chatMode: ctx.chatMode, isFollowUp: ctx.isFollowUp },
          modulesUsed: ['storeMonitor', 'sentinel', 'soc', 'noc'].filter(id => allowedPages.includes(id)),
          fastPath: true,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs: 0,
            llmMs: 0,
            mode: 'direct-rca',
          },
        })
      }
    }

    // Monitor: no direct handler matched — Agent + live tools (users can phrase questions many ways).
    if (needsLiveAgentFallback(lastUser, chatMode)) {
      const providerStatus = getAIProviderConfigStatus()
      const activeReady = providerStatus.rows?.find(r => r.key === 'active')?.ok
      if (activeReady) {
        const providerName = getAIProvider().name
        const defaultTimeoutMs = providerName === 'ollama' ? 300000 : 180000
        const agentTimeoutMs = Number.parseInt(process.env.AI_AGENT_TIMEOUT_MS || String(defaultTimeoutMs), 10)
        try {
          const agentResult = await withTimeout(
            runAgentChat(sanitized, { user: req.user, allowedPages, ctx }),
            agentTimeoutMs,
            `Agent timeout after ${Math.round(agentTimeoutMs / 1000)}s`,
          )
          return res.json({
            content: agentResult.content,
            provider: agentResult.provider || providerName,
            contextMeta: agentResult.contextMeta || [],
            contextPreview: agentResult.contextPreview || {},
            queryContext: {
              topic: 'monitor-agent',
              chatMode: 'monitor',
              toolsUsed: agentResult.toolsUsed,
              isFollowUp: ctx.isFollowUp,
            },
            modulesUsed: agentResult.modulesUsed || [],
            fastPath: false,
            metrics: {
              totalMs: Date.now() - requestStart,
              contextMs: agentResult.toolMs || 0,
              llmMs: agentResult.llmMs || 0,
              mode: 'monitor-agent',
            },
          })
        } catch {
          /* fall through to portal context + LLM */
        }
      }
    }

    if (autoModules !== false) {
      const suggested = suggestContextModules(lastUser, allowedPages, ctx)
      moduleIds = [...new Set([...moduleIds, ...suggested])]
    }

    // Hostname details — fetch live data, then always run through LLM.
    if (isHostnameDataRequest(lastUser) && extractStoreHostname(lastUser)) {
      const hostnamePreLlm = await tryDirectHostnameAnswer(lastUser, allowedPages, ctx)
      if (hostnamePreLlm) {
        const { payload: hnPre, llmMs: hnPreLlmMs } = await appendLlmAnalysis(lastUser, hostnamePreLlm, chatMode, sanitized, ctx)
        return res.json({
          content: hnPre.content,
          provider: getAIProvider().name,
          contextMeta: hnPre.contextMeta,
          contextPreview: hnPre.contextPreview,
          chartSeries: hostnamePreLlm.chartSeries,
          queryContext: hnPre.queryContext || { topic: 'hostname', hostname: ctx.hostname || extractStoreHostname(lastUser), isFollowUp: ctx.isFollowUp },
          modulesUsed: ['storeMonitor', 'storeProblems', 'storeCrashes', 'sentinelXdr', 'soc', 'noc'].filter(id => {
            if (id === 'storeMonitor' || id === 'storeProblems' || id === 'storeCrashes') return true
            if (id === 'sentinelXdr') return allowedPages.includes('sentinel')
            if (id === 'soc') return allowedPages.includes('soc')
            if (id === 'noc') return allowedPages.includes('noc')
            return false
          }),
          fastPath: !hnPre.llmSynthesized,
          metrics: { totalMs: Date.now() - requestStart, contextMs: 0, llmMs: hnPreLlmMs, mode: hnPre.llmSynthesized ? 'direct-hostname-llm' : 'direct-hostname' },
        })
      }
    }

    const storeOnly = ctx.directHandler === 'store'
      || isStoreMonitorIssuesQuery(lastUser)
      || isStoreMonitorConnectivityQuery(lastUser, ctx)
      || (/\b(store|stores|offline|online|down|monitor|hostname)\b/i.test(lastUser)
        && !/\b(firewall|fortigate|deny|soc|crash|crashed|crashes)\b/i.test(lastUser)
        && ctx.priorTopic !== 'crash'
        && ctx.priorTopic !== 'noc'
        && ctx.directHandler !== 'noc')
    if (storeOnly) {
      moduleIds = moduleIds.filter(id => id !== 'soc')
    }

    const contextStart = Date.now()
    const portalContext = moduleIds.length
      ? await buildPortalContext(req.user, moduleIds, { userMessage: lastUser })
      : { portal: 'netpulse', user: { email: req.user.email, role: req.user.role }, modules: {}, meta: [] }
    contextMs = Date.now() - contextStart
    const contextPreview = buildContextPreview(portalContext)

    const direct = tryDirectStoreAnswer(lastUser, portalContext, ctx)
    if (direct) {
      const storePayload = {
        content: direct,
        contextMeta: portalContext.meta,
        contextPreview: buildContextPreview(portalContext),
        queryContext: {
          topic: ctx.topic || 'store',
          appName: ctx.appName,
          isFollowUp: ctx.isFollowUp,
          storeGroup: extractStoreGroupFilter(lastUser) || undefined,
        },
      }
      const { payload, llmMs: storeLlmMs } = await appendLlmAnalysis(lastUser, storePayload, chatMode, sanitized, ctx)
      return res.json({
        content: payload.content,
        provider: getAIProvider().name,
        contextMeta: payload.contextMeta,
        contextPreview: payload.contextPreview,
        queryContext: payload.queryContext,
        modulesUsed: moduleIds,
        fastPath: !payload.llmSynthesized,
        metrics: {
          totalMs: Date.now() - requestStart,
          contextMs,
          llmMs: storeLlmMs,
          mode: payload.llmSynthesized ? 'direct-store-llm' : 'direct-store',
        },
      })
    }

    const contextBlock = formatContextForPrompt(portalContext)
    const system = contextBlock
      ? `${CHAT_SYSTEM_BASE}\n\n${contextBlock}`
      : `${CHAT_SYSTEM_BASE}\n\nNo portal modules were loaded for this message. Do not claim to have live store or firewall data. Tell the user which SocMon page to open, or ask them to enable data sources in the SocMon AI panel.`

    const detail = inferContextDetail(lastUser)
    const maxTokens = detail === 'summary' ? 512 : detail === 'standard' ? 1024 : 1536
    const recentMessages = sanitized
      .filter(m => !(m.role === 'assistant' && /^SocMon AI — four chat modes/i.test(m.content)))
      .slice(-12)
    // Default 300s for Ollama (local LLM can be slow); cloud providers stay at 120s unless overridden.
    const providerName = getAIProvider().name
    const defaultTimeoutMs = providerName === 'ollama' ? 300000 : 120000
    const llmTimeoutMs = Number.parseInt(process.env.AI_LLM_TIMEOUT_MS || String(defaultTimeoutMs), 10)

    let content = ''
    const llmStart = Date.now()
    try {
      content = await withTimeout(
        chat(recentMessages, { system, maxTokens }),
        llmTimeoutMs,
        `LLM timeout after ${Math.round(llmTimeoutMs / 1000)}s`,
      )
      llmMs = Date.now() - llmStart
    } catch (err) {
      llmMs = Date.now() - llmStart
      const socFallback = await tryDirectSOCAnswer(lastUser, allowedPages, ctx)
      if (socFallback) {
        return res.json({
          content: `${socFallback.content}\n\n(LLM fallback: ${err.message})`,
          provider: getAIProvider().name,
          contextMeta: socFallback.contextMeta,
          contextPreview: socFallback.contextPreview,
          queryContext: socFallback.queryContext || { topic: 'soc', isFollowUp: ctx.isFollowUp },
          modulesUsed: moduleIds,
          fastPath: true,
          fallback: true,
          metrics: { totalMs: Date.now() - requestStart, contextMs, llmMs, mode: 'fallback-soc' },
        })
      }
      const zabbixFallback = await tryDirectZabbixAnswer(lastUser, allowedPages, ctx)
      if (zabbixFallback) {
        return res.json({
          content: `${zabbixFallback.content}\n\n(LLM fallback: ${err.message})`,
          provider: getAIProvider().name,
          contextMeta: zabbixFallback.contextMeta,
          contextPreview: zabbixFallback.contextPreview,
          queryContext: zabbixFallback.queryContext || { topic: 'zabbix', isFollowUp: ctx.isFollowUp },
          modulesUsed: moduleIds,
          fastPath: true,
          fallback: true,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs,
            llmMs,
            mode: 'fallback-zabbix',
          },
        })
      }
      const hostnameFallback = await tryDirectHostnameAnswer(lastUser, allowedPages, ctx)
      if (hostnameFallback) {
        return res.json({
          content: `${hostnameFallback.content}\n\n(LLM fallback: ${err.message})`,
          provider: getAIProvider().name,
          contextMeta: hostnameFallback.contextMeta,
          contextPreview: hostnameFallback.contextPreview,
          chartSeries: hostnameFallback.chartSeries,
          queryContext: hostnameFallback.queryContext || { topic: 'hostname', hostname: ctx.hostname, isFollowUp: ctx.isFollowUp },
          modulesUsed: moduleIds,
          fastPath: true,
          fallback: true,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs,
            llmMs,
            mode: 'fallback-hostname',
          },
        })
      }
      const fallback = tryDirectStoreAnswer(lastUser, portalContext, ctx)
      if (fallback) {
        return res.json({
          content: `${fallback}\n\n(LLM fallback: ${err.message})`,
          provider: getAIProvider().name,
          contextMeta: portalContext.meta,
          contextPreview,
          queryContext: {
            topic: ctx.topic || 'store',
            appName: ctx.appName,
            isFollowUp: ctx.isFollowUp,
          },
          modulesUsed: moduleIds,
          fastPath: true,
          fallback: true,
          metrics: {
            totalMs: Date.now() - requestStart,
            contextMs,
            llmMs,
            mode: 'fallback',
          },
        })
      }
      throw err
    }

    res.json({
      content,
      provider: getAIProvider().name,
      contextMeta: portalContext.meta,
      contextPreview,
      queryContext: {
        topic: ctx.topic,
        appName: ctx.appName,
        isFollowUp: ctx.isFollowUp,
      },
      modulesUsed: moduleIds,
      metrics: {
        totalMs: Date.now() - requestStart,
        contextMs,
        llmMs,
        mode: 'llm',
      },
    })
  } catch (err) {
    const payload = formatLlmErrorForClient(err)
    const status = payload.code === 'LLM_AUTH_FAILED' ? 503 : 502
    res.status(status).json(payload)
  }
})

router.post('/search', async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim()
    if (!question) return res.status(400).json({ error: 'question is required' })
    const result = await naturalLanguageSearch(question)
    res.json({ ...result, freshness: 'live', fetchedAt: new Date().toISOString() })
  } catch (err) {
    res.status(502).json({ error: err.message || 'Search failed' })
  }
})

router.post('/triage', async (req, res) => {
  try {
    const alert = req.body?.alert
    if (!alert || typeof alert !== 'object') {
      return res.status(400).json({ error: 'alert object is required' })
    }
    const result = await triageAlert(alert)
    res.json(result)
  } catch (err) {
    res.status(502).json({ error: err.message || 'Triage failed' })
  }
})

router.get('/anomalies', async (req, res) => {
  try {
    const site = req.query.site ? String(req.query.site).trim() : null
    const result = await detectAnomalies(site || null)
    res.json({
      ...result,
      freshness: 'live',
      fetchedAt: new Date().toISOString(),
      window: 'last 1 hour',
    })
  } catch (err) {
    res.status(502).json({ error: err.message || 'Anomaly detection failed' })
  }
})

router.post('/report', (_req, res) => {
  res.status(501).json({ error: 'Report generation is not implemented yet' })
})

async function withTimeout(promise, timeoutMs, message = 'Timed out') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export default router
