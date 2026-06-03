import StoreProblemHistory from '../../models/StoreProblemHistory.js'
import {
  isInfluxStoreConfigured,
  fetchStoreSnapshot,
  fetchStoreHistory,
  fetchCrashSummary,
} from '../influxStore.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'
import {
  extractStoreHostname,
  formatRangeLabelFromInflux,
  parseQuestionTimeRange,
} from './queryContext.js'
import { fetchHostnameEnvironments } from './environmentDataFetcher.js'
import {
  buildTimelineFromEvidence,
  rankHypotheses,
  recommendedActions,
} from './correlationEngine.js'
import { complete } from './aiRouter.js'

const RCA_MARKERS = /\b(rca|root cause|why is|why are|why was|why did|what caused|what happened|investigate|investigation|troubleshoot|diagnose|reason for|reason why|explain why|what went wrong|impact analysis|correlat|analyze|analysis)\b/i

function rangeToSeconds(range) {
  const m = /^-(\d+)([smhd])$/i.exec(String(range || ''))
  if (!m) return 6 * 3600
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()] || 3600
  return Number(m[1]) * mult
}

function hostnameMatchesStore(store, hostname) {
  const h = String(hostname || '').toLowerCase()
  const sh = String(store?.hostname || '').toLowerCase()
  const tag = String(store?.storeTag || '').toLowerCase()
  return sh === h || sh.includes(h) || tag.includes(h) || tag.startsWith(`${h}_`)
}

function summarizeHistory(history) {
  const stats = []
  for (const series of history?.series || []) {
    const vals = series.points.map(p => p.value).filter(v => Number.isFinite(v))
    if (!vals.length) continue
    stats.push({
      name: series.name,
      min: Math.min(...vals),
      max: Math.max(...vals),
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
    })
  }
  return stats
}

export function isRcaQuery(question, ctx = null) {
  const q = String(question || '')
  if (ctx?.chatMode === 'rca') {
    if (/\b(how many|count|total|list all|show all)\b/i.test(q) && !RCA_MARKERS.test(q) && !extractStoreHostname(q)) return false
    if (RCA_MARKERS.test(q) || extractStoreHostname(q) || ctx?.hostname) return true
    if (ctx?.isFollowUp && ctx?.priorTopic === 'rca') return true
    return false
  }
  if (RCA_MARKERS.test(q)) {
    if (/\b(how many|count|total)\b/i.test(q) && !/\b(why|cause|rca|investigate|analyze)\b/i.test(q)) return false
    return true
  }
  if (ctx?.isFollowUp && ctx?.priorTopic === 'rca') return true
  return false
}

function resolveAnchor(question, ctx, stores = []) {
  const hostname = extractStoreHostname(question)
    || ctx?.hostname
    || (ctx?.isFollowUp ? extractStoreHostname(ctx?.threadText || '') : null)

  if (hostname) {
    const store = stores.find(s => hostnameMatchesStore(s, hostname))
    return { type: 'hostname', hostname, store: store || null, storeTag: store?.storeTag || hostname }
  }

  const storeTagMatch = String(question || '').match(/\b(RP\d{4})\b/i)
  if (storeTagMatch) {
    const tag = storeTagMatch[1].toUpperCase()
    const store = stores.find(s => String(s.storeTag || '').toUpperCase().startsWith(tag))
    return {
      type: 'storeTag',
      hostname: store?.hostname || tag,
      store: store || null,
      storeTag: store?.storeTag || tag,
    }
  }

  if (/\b(stores offline|store offline|offline stores|stores down)\b/i.test(question)) {
    const offline = stores.filter(s => s.online === false).slice(0, 5)
    if (offline.length === 1) {
      return {
        type: 'auto',
        hostname: offline[0].hostname || offline[0].storeTag,
        store: offline[0],
        storeTag: offline[0].storeTag,
      }
    }
    return { type: 'regional', offlineStores: offline, count: stores.filter(s => !s.online).length }
  }

  return null
}

async function gatherEvidence(anchor, range, allowedPages) {
  const rangeSec = rangeToSeconds(range)
  const hostname = anchor.hostname || anchor.storeTag

  const [stores, crashRows, env] = await Promise.all([
    isInfluxStoreConfigured() ? fetchStoreSnapshot(10, range) : Promise.resolve([]),
    fetchCrashSummary(range).catch(() => []),
    fetchHostnameEnvironments(hostname, range, allowedPages),
  ])

  const store = anchor.store || stores.find(s => hostnameMatchesStore(s, hostname)) || null
  const storeTag = store?.storeTag || anchor.storeTag || hostname

  const [history, problems] = await Promise.all([
    store ? fetchStoreHistory(storeTag, rangeSec).catch(() => ({ series: [] })) : Promise.resolve({ series: [] }),
    StoreProblemHistory.find({
      $or: [
        { hostname: new RegExp(`^${String(hostname).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        { storeTag: new RegExp(String(storeTag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      ],
    }).sort({ lastSeenAt: -1 }).limit(10).lean().catch(() => []),
  ])

  const historyStats = summarizeHistory(history)
  const crashes = crashRows.filter(r => hostnameMatchesStore(r, hostname))
  const timeline = buildTimelineFromEvidence({ store, historyStats, env, crashes, problems })
  const hypotheses = rankHypotheses(timeline, store)
  const actions = recommendedActions(hypotheses, store)

  return {
    store,
    env,
    crashes,
    problems,
    historyStats,
    timeline,
    hypotheses,
    actions,
    anchor,
  }
}

function formatTimelineLine(e, fmtTs) {
  const ts = e.ts ? fmtTs(e.ts) : '—'
  const sev = e.severity !== 'medium' ? ` [${e.severity}]` : ''
  return `    • ${ts} · ${e.source}${sev} · ${e.summary}`
}

function formatRcaReport(evidence, rangeLabel, fetchedAt, { llmNarrative = null } = {}) {
  const fmtTs = (v) => formatPortalTimestamp(v)
  const { anchor, store, timeline, hypotheses, actions, env, crashes, problems } = evidence
  const hostLabel = anchor.hostname || anchor.storeTag || 'unknown'

  const lines = [
    `Root Cause Analysis (LIVE — fetched ${fmtTs(fetchedAt)})`,
    `Anchor: ${hostLabel}${store?.storeTag ? ` · tag ${store.storeTag}` : ''}`,
    `Window: ${rangeLabel}`,
    '',
    '── Summary ──',
  ]

  if (hypotheses.length) {
    const top = hypotheses[0]
    lines.push(`Likely cause: ${top.title}`)
    lines.push(`Confidence: ${top.confidence}`)
    lines.push(top.reasoning)
  }

  if (store) {
    lines.push('')
    lines.push('── Store Monitor snapshot ──')
    lines.push(`  Online: ${store.online ? 'yes' : 'no'} · Connection: ${store.connState || 'unknown'}`)
    if (!store.online) {
      lines.push('  Status: store currently OFFLINE in Store Monitor.')
    } else if (/\b(offline|down|why is)\b/i.test(hostLabel)) {
      lines.push('  Note: store is ONLINE now — issue may have cleared; review timeline for earlier signals.')
    }
    if (store.avgPingMs != null || store.packetLossPct != null) {
      lines.push(`  Ping: ${store.avgPingMs ?? '—'} ms · Packet loss: ${store.packetLossPct ?? '—'}%`)
    }
    if (store.gatewayVendor || store.gatewayIp) {
      lines.push(`  Gateway: ${store.gatewayVendor || '—'} ${store.gatewayIp || ''}`.trim())
    }
  } else if (anchor.type === 'regional') {
    lines.push('')
    lines.push('── Regional view ──')
    lines.push(`  ${anchor.count ?? anchor.offlineStores?.length ?? 0} stores offline in current snapshot`)
    for (const s of (anchor.offlineStores || []).slice(0, 8)) {
      lines.push(`    • ${s.hostname || s.storeTag} · ${s.connState || 'offline'}`)
    }
  }

  lines.push('')
  lines.push('── Ranked hypotheses ──')
  for (const h of hypotheses) {
    lines.push(`  ${h.rank}. [${h.confidence}] ${h.title}`)
    lines.push(`     ${h.reasoning}`)
  }

  lines.push('')
  lines.push('── Correlated timeline ──')
  if (!timeline.length) {
    lines.push('  No correlated events in this window.')
  } else {
    for (const e of timeline.slice(0, 25)) {
      lines.push(formatTimelineLine(e, fmtTs))
    }
    if (timeline.length > 25) lines.push(`    … ${timeline.length - 25} more events`)
  }

  lines.push('')
  lines.push('── Signal counts ──')
  lines.push(`  Timeline events: ${timeline.length}`)
  lines.push(`  Crashes: ${crashes.reduce((n, c) => n + (c.totalCrashes || 0), 0)} · Problems: ${problems.length}`)
  if (env.sentinel?.configured) {
    lines.push(`  Sentinel USB ↓${env.sentinel.usbDisconnected ?? 0} · threats ${env.sentinel.threatsDetected ?? 0} · agent disc ${env.sentinel.agentDisconnected ?? 0}`)
  }
  if (env.soc?.configured) lines.push(`  Firewall events: ${env.soc.total ?? 0} · denies ${env.soc.denies ?? 0}`)
  if (env.noc?.configured) lines.push(`  NOC events: ${env.noc.total ?? 0} · UPDOWN ${env.noc.updown ?? 0}`)

  lines.push('')
  lines.push('── Recommended actions ──')
  for (let i = 0; i < actions.length; i++) lines.push(`  ${i + 1}. ${actions[i]}`)

  if (llmNarrative) {
    lines.push('')
    lines.push('── Analyst narrative (LLM synthesis) ──')
    lines.push(llmNarrative.trim())
  }

  lines.push('')
  lines.push('(RCA from correlated live NetPulse data — evidence-backed; verify before change windows.)')

  return lines.join('\n')
}

async function maybeSynthesizeWithLlm(question, evidence, rangeLabel) {
  if (process.env.AI_RCA_LLM === '0') return null
  try {
    const summary = {
      question,
      window: rangeLabel,
      store: evidence.store ? {
        online: evidence.store.online,
        connState: evidence.store.connState,
        packetLossPct: evidence.store.packetLossPct,
      } : null,
      hypotheses: evidence.hypotheses.slice(0, 4).map(h => ({ title: h.title, confidence: h.confidence, reasoning: h.reasoning })),
      timelineSample: evidence.timeline.slice(0, 12).map(e => ({ ts: e.ts, source: e.source, summary: e.summary })),
    }
    const system = `You are a NetPulse NOC/SOC analyst. Given JSON evidence from live monitoring systems, write 3-5 sentences of root cause narrative.
Rules: Use ONLY the provided evidence. Do not invent hostnames, counts, or events. If evidence is weak, say so. Be actionable.`
    const raw = await Promise.race([
      complete(JSON.stringify(summary), { system, maxTokens: 400 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), 25000)),
    ])
    return String(raw || '').trim()
  } catch {
    return null
  }
}

/**
 * Correlated RCA from Store Monitor + Sentinel + SOC + NOC + crashes + problems.
 */
export async function tryDirectRcaAnswer(question, allowedPages, ctx = null) {
  if (!isRcaQuery(question, ctx)) return null

  const fetchedAt = new Date().toISOString()
  const range = ctx?.range || parseQuestionTimeRange(question)
  const rangeLabel = formatRangeLabelFromInflux(range)
  const canStore = allowedPages.includes('storeMonitor')
  const canEnv = allowedPages.some(p => ['sentinel', 'soc', 'noc'].includes(p))

  if (!canStore && !canEnv) {
    return {
      content: 'RCA requires Store Monitor and/or Sentinel/SOC/NOC access in NetPulse.',
      contextMeta: [{ id: 'rca', label: 'RCA', freshness: 'live', fetchedAt, configured: false }],
      contextPreview: {},
      queryContext: { topic: 'rca', chatMode: ctx?.chatMode },
    }
  }

  const stores = canStore && isInfluxStoreConfigured() ? await fetchStoreSnapshot(10, range) : []
  const anchor = resolveAnchor(question, ctx, stores)

  if (!anchor) {
    return {
      content: [
        'Root Cause Analysis needs an anchor — specify a store hostname (e.g. RP4531-E521BCXS), store tag (RP4531), or ask "why are stores offline".',
        '',
        'Examples:',
        '  • Why is RP4531-E521BCXS offline?',
        '  • Root cause for RP4430 connectivity last 6 hours',
        '  • Investigate USB disconnections on RP4139',
      ].join('\n'),
      contextMeta: [{ id: 'rca', label: 'RCA', freshness: 'live', fetchedAt, configured: true }],
      contextPreview: { rca: { needsAnchor: true } },
      queryContext: { topic: 'rca', chatMode: ctx?.chatMode },
    }
  }

  if (anchor.type === 'regional' && !anchor.offlineStores?.length) {
    return {
      content: 'No offline stores in the current Store Monitor snapshot — nothing to investigate at regional level.',
      contextMeta: [{ id: 'rca', label: 'RCA / Regional', freshness: 'live', fetchedAt, configured: true }],
      contextPreview: { rca: { regional: true, offlineCount: 0 } },
      queryContext: { topic: 'rca', chatMode: ctx?.chatMode },
    }
  }

  const evidence = await gatherEvidence(anchor, range, allowedPages)
  const useLlm = ctx?.chatMode === 'rca' || RCA_MARKERS.test(String(question || ''))
  const llmNarrative = useLlm ? await maybeSynthesizeWithLlm(question, evidence, rangeLabel) : null
  const content = formatRcaReport(evidence, rangeLabel, fetchedAt, { llmNarrative })

  return {
    content,
    contextMeta: [{
      id: 'rca',
      label: 'Root Cause Analysis',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: `${rangeLabel} · ${evidence.timeline.length} events · top: ${evidence.hypotheses[0]?.title || '—'}`,
    }],
    contextPreview: {
      rca: {
        window: rangeLabel,
        anchor: anchor.hostname || anchor.storeTag,
        timelineEvents: evidence.timeline.length,
        hypotheses: evidence.hypotheses.length,
        topHypothesis: evidence.hypotheses[0]?.title,
        topConfidence: evidence.hypotheses[0]?.confidence,
        storeOnline: evidence.store?.online,
        llmSynthesis: Boolean(llmNarrative),
      },
    },
    queryContext: {
      topic: 'rca',
      hostname: anchor.hostname,
      chatMode: ctx?.chatMode,
      isFollowUp: ctx?.isFollowUp,
    },
  }
}
