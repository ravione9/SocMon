import { getESClient } from '../../config/elasticsearch.js'
import StoreProblemHistory from '../../models/StoreProblemHistory.js'
import {
  isInfluxStoreConfigured,
  fetchStoreSnapshot,
  buildOverviewSummary,
  fetchCrashSummary,
  fetchCrashEventList,
  crashTypeLabel,
  crashSeverity,
} from '../influxStore.js'
import { getProblemSnapshotStatus } from '../storeProblemSnapshotter.js'
import { computeUserPageAccess } from '../../utils/computeUserPageAccess.js'
import { isXdrQuestion } from './xdrDirectAnswer.js'
import { isNetworkInfraQuery, isZabbixQuestion, extractIpv4, isInfraMonitorQuery, isIpInfraQuery, prefersLlmSynthesis, buildZabbixInfraContext, wantsDiskUsage, extractHostGroupFilter } from './zabbixDirectAnswer.js'
import {
  appNameMatches,
  crashRecordMatches,
  formatRangeLabelFromInflux,
  parseQuestionTimeRange,
  wantsCrashEventLog,
  extractStoreHostname,
} from './queryContext.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'

export { parseQuestionTimeRange } from './queryContext.js'

/** @typedef {'live' | 'periodic'} DataFreshness */

export const AI_CONTEXT_MODULES = [
  {
    id: 'storeMonitor',
    label: 'Store Monitor',
    pageKey: 'storeMonitor',
    freshness: 'live',
    description: 'InfluxDB snapshot queried at send time (agent heartbeats ~5 min)',
  },
  {
    id: 'storeProblems',
    label: 'Problem tracker',
    pageKey: 'storeMonitor',
    freshness: 'periodic',
    description: 'MongoDB lifecycle records; background job every 2 min',
  },
  {
    id: 'soc',
    label: 'SOC / firewall',
    pageKey: 'soc',
    freshness: 'live',
    description: 'Elasticsearch aggregation for the last hour',
  },
  {
    id: 'sentinelXdr',
    label: 'SentinelOne XDR',
    pageKey: 'sentinel',
    freshness: 'live',
    description: 'Singularity Data Lake PowerQuery at send time',
  },
  {
    id: 'zabbixInfra',
    label: 'Infra Zabbix',
    pageKey: 'infra',
    freshness: 'live',
    description: 'Zabbix host availability, ping, and interface traffic at send time',
  },
]

const MODULE_BY_ID = Object.fromEntries(AI_CONTEXT_MODULES.map(m => [m.id, m]))

const STORE_KEYWORDS = /\b(store|stores|hostname|hostnames|offline|online|down|ping|connectivity|isp|hotspot|influx|rop|serial|gateway|latency|packet|speedtest|disk|memory|cpu|outage)\b/i
const CRASH_KEYWORDS = /\b(crash|crashed|crashes|crahed|app crash|app hang|hangs|hung|bsod|wer|dotnet|unexpected shutdown|service crash)\b/i
const SOC_KEYWORDS = /\b(firewall|fortigate|deny|denied|soc|intrusion|utm|ips|traffic spike|blocked)\b/i
const NOC_KEYWORDS = /\b(cisco|switch|interface|noc|vlan|mac flap|updown|config change)\b/i
const OVERVIEW_KEYWORDS = /\b(summary|status|overview|how many|show me|list|top \d+|worst|hostname.wise|hostname-wise)\b/i

/**
 * @param {string} message
 * @param {string[]} allowedPages
 */
export function suggestContextModules(message, allowedPages, ctx = null) {
  const pages = new Set(allowedPages)
  const modules = new Set()
  const text = String(ctx?.threadText || message || '')

  if (ctx?.topic === 'crash' || (ctx?.isFollowUp && ctx?.priorTopic === 'crash')) {
    return []
  }
  if (ctx?.topic === 'xdr' || (ctx?.isFollowUp && ctx?.priorTopic === 'xdr')) {
    return []
  }
  if (ctx?.topic === 'hostname' || ctx?.directHandler === 'hostname') {
    return []
  }
  if (ctx?.topic === 'rca' || ctx?.directHandler === 'rca' || ctx?.chatMode === 'rca') {
    if (pages.has('storeMonitor')) {
      modules.add('storeMonitor')
      modules.add('storeProblems')
    }
    if (pages.has('soc')) modules.add('soc')
    return [...modules]
  }

  if (pages.has('storeMonitor') && (STORE_KEYWORDS.test(text) || OVERVIEW_KEYWORDS.test(text))) {
    const infraDiskQuery = wantsDiskUsage(text) && (extractHostGroupFilter(text) || isZabbixQuestion(text))
    if (!infraDiskQuery) {
      modules.add('storeMonitor')
      if (!CRASH_KEYWORDS.test(text)) modules.add('storeProblems')
    }
  }
  if (pages.has('soc') && SOC_KEYWORDS.test(text)) {
    modules.add('soc')
  }
  if (pages.has('sentinel') && isXdrQuestion(text)) {
    modules.add('sentinelXdr')
    return [...modules]
  }
  if (pages.has('infra') && (
    prefersLlmSynthesis(text, ctx)
    || isZabbixQuestion(text)
    || isNetworkInfraQuery(text)
    || isIpInfraQuery(text)
    || (extractIpv4(text) && /\b(network|device|server|zabbix|infra|monitor)\b/i.test(text))
  )) {
    modules.add('zabbixInfra')
  }
  if (pages.has('noc') && NOC_KEYWORDS.test(text)) {
    modules.add('soc')
  }

  if (!modules.size && pages.has('storeMonitor') && OVERVIEW_KEYWORDS.test(text)) {
    modules.add('storeMonitor')
    modules.add('storeProblems')
  }

  return [...modules]
}

function canUseModule(moduleId, allowedPages) {
  const def = MODULE_BY_ID[moduleId]
  if (!def) return false
  return allowedPages.includes(def.pageKey)
}

function summarizeStore(s) {
  const ping =
    s.ping?.['8.8.8.8'] ||
    s.ping?.['google.com'] ||
    Object.values(s.ping || {})[0] ||
    null

  return {
    hostname: s.hostname || '',
    storeTag: s.storeTag || '',
    serial: s.serial || '',
    online: !!s.online,
    connState: s.connState || 'unknown',
    gatewayVendor: s.gatewayVendor || '',
    gatewayIp: s.gatewayIp || '',
    lastSeen: s.lastSeen || null,
    pingAvgMs: ping?.avgMs ?? null,
    packetLossPct: ping?.packetLossPct ?? null,
    cpuPct: s.cpuPct ?? null,
    memPct: s.memPct ?? null,
    downloadMbps: s.downloadMbps ?? null,
    uploadMbps: s.uploadMbps ?? null,
    issueCodes: (s.issues || []).map(i => i.code),
    issueSummary: (s.issues || []).map(i => i.message).join('; ') || null,
  }
}

function severityRank(s) {
  if (!s.online) return 0
  const codes = s.issueCodes || []
  if (codes.includes('offline') || codes.includes('isp_down')) return 1
  if (codes.some(c => ['hotspot', 'no_connectivity', 'packet_loss', 'dns', 'http'].includes(c))) return 2
  if (codes.length) return 3
  return 4
}

/** @returns {'summary' | 'standard' | 'full'} */
export function inferContextDetail(message) {
  const q = String(message || '').toLowerCase()
  if (/\b(hostname|hostnames|hostname.wise|hostname-wise|list all|every store|each store)\b/.test(q)) {
    return 'full'
  }
  if (/\b(how many|count|number|total|status|summary|overview|down|offline|online|stores are)\b/.test(q)) {
    return 'summary'
  }
  return 'standard'
}

async function buildStoreMonitorContext(staleMinutes = 10, detail = 'standard') {
  const fetchedAt = new Date().toISOString()
  if (!isInfluxStoreConfigured()) {
    return {
      module: 'storeMonitor',
      freshness: 'live',
      fetchedAt,
      configured: false,
      error: 'InfluxDB not configured',
    }
  }

  const stores = await fetchStoreSnapshot(staleMinutes, '-1h')
  const summary = buildOverviewSummary(stores)
  const offline = stores.filter(s => !s.online).map(summarizeStore)

  const base = {
    module: 'storeMonitor',
    freshness: 'live',
    fetchedAt,
    configured: true,
    staleMinutes,
    source: 'InfluxDB (PowerShell store agents)',
    note: `Online = heartbeat within last ${staleMinutes} min. Queried live when you sent the message.`,
    summary,
    offlineCount: offline.length,
  }

  if (detail === 'summary') {
    return {
      ...base,
      offlineHostnames: offline.slice(0, 20).map(s => ({
        hostname: s.hostname,
        storeTag: s.storeTag,
        lastSeen: s.lastSeen,
        connState: s.connState,
      })),
    }
  }

  const withIssues = stores
    .filter(s => s.issueCount > 0 || !s.online)
    .map(summarizeStore)
    .sort((a, b) => severityRank(a) - severityRank(b))

  if (detail === 'standard') {
    return {
      ...base,
      offlineHostnames: offline.slice(0, 25).map(s => ({
        hostname: s.hostname,
        storeTag: s.storeTag,
        lastSeen: s.lastSeen,
        connState: s.connState,
      })),
      topIssues: withIssues.slice(0, 15),
    }
  }

  const hostnameIndex = stores
    .map(summarizeStore)
    .sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)))
    .slice(0, 50)

  return {
    ...base,
    offlineHostnames: offline.slice(0, 40).map(s => ({
      hostname: s.hostname,
      storeTag: s.storeTag,
      lastSeen: s.lastSeen,
      connState: s.connState,
    })),
    topIssues: withIssues.slice(0, 25),
    hostnameWise: hostnameIndex,
  }
}

async function buildStoreProblemsContext() {
  const fetchedAt = new Date().toISOString()
  const tracker = getProblemSnapshotStatus()
  const intervalMin = Math.round((tracker.intervalMs || 120000) / 60000)

  if (!isInfluxStoreConfigured()) {
    return {
      module: 'storeProblems',
      freshness: 'periodic',
      fetchedAt,
      configured: false,
      error: 'InfluxDB not configured',
    }
  }

  const active = await StoreProblemHistory.find({ status: 'active' })
    .sort({ severity: 1, lastSeenAt: -1 })
    .limit(50)
    .lean()

  return {
    module: 'storeProblems',
    freshness: 'periodic',
    fetchedAt,
    configured: true,
    source: 'MongoDB StoreProblemHistory',
    snapshotIntervalMinutes: intervalMin,
    lastBackgroundSnapAt: tracker.lastSnapAt || null,
    activeProblemCount: active.length,
    note: `Problem lifecycle updated by background job every ~${intervalMin} min (not live Influx).`,
    activeProblems: active.map(r => ({
      hostname: r.hostname,
      storeTag: r.storeTag,
      code: r.code,
      severity: r.severity,
      message: r.message,
      online: r.online,
      connState: r.connState,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    })),
  }
}

async function buildSocContext() {
  const fetchedAt = new Date().toISOString()
  try {
    const result = await getESClient().search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: { bool: { must: [{ range: { '@timestamp': { gte: 'now-1h' } } }] } },
        aggs: {
          totalEvents: { value_count: { field: '@timestamp' } },
          denies: { filter: { term: { 'fgt.action.keyword': 'deny' } } },
          allows: { filter: { term: { 'fgt.action.keyword': 'accept' } } },
          topSrc: { terms: { field: 'fgt.srcip.keyword', size: 8 } },
          topDst: { terms: { field: 'fgt.dstip.keyword', size: 5 } },
        },
      },
    })

    const aggs = result.aggregations || {}
    return {
      module: 'soc',
      freshness: 'live',
      fetchedAt,
      configured: true,
      source: 'Elasticsearch firewall-*',
      window: 'last 1 hour',
      note: 'Aggregations queried live at send time.',
      stats: {
        totalEvents: aggs.totalEvents?.value ?? 0,
        denies: aggs.denies?.doc_count ?? 0,
        allows: aggs.allows?.doc_count ?? 0,
        topSourceIps: (aggs.topSrc?.buckets || []).map(b => ({ ip: b.key, count: b.doc_count })),
        topDestIps: (aggs.topDst?.buckets || []).map(b => ({ ip: b.key, count: b.doc_count })),
      },
    }
  } catch (err) {
    return {
      module: 'soc',
      freshness: 'live',
      fetchedAt,
      configured: false,
      error: err.message || 'Elasticsearch query failed',
    }
  }
}

const BUILDERS = {
  storeMonitor: (detail) => buildStoreMonitorContext(10, detail),
  storeProblems: buildStoreProblemsContext,
  soc: buildSocContext,
  zabbixInfra: (_, opts) => buildZabbixInfraContext(opts?.userMessage || ''),
}

/**
 * Instant crash summary from Influx — skips LLM.
 * @param {string} question
 * @param {string[]} allowedPages
 * @param {ReturnType<import('./queryContext.js').resolveQueryContext>} [ctx]
 */
export async function tryDirectCrashAnswer(question, allowedPages, ctx = null) {
  const q = String(question || '')
  const qLower = q.toLowerCase()

  if (isZabbixQuestion(q) || isInfraMonitorQuery(q) || isNetworkInfraQuery(q)) return null

  if (!allowedPages.includes('storeMonitor')) return null

  const wantsEvents = wantsCrashEventLog(q, ctx)

  const shouldRun =
    ctx?.directHandler === 'crash'
    || CRASH_KEYWORDS.test(qLower)
    || wantsEvents
    || (ctx?.appName && (ctx.topic === 'crash' || ctx.priorTopic === 'crash') && !isZabbixQuestion(q))
    || (ctx?.followUpKind === 'affected_stores' && ctx.priorTopic === 'crash')
    || (ctx?.followUpKind === 'crash_events' && ctx.priorTopic === 'crash')
    || (ctx?.isFollowUp && ctx.priorTopic === 'crash' && wantsEvents)

  if (!shouldRun) return null

  if (!isInfluxStoreConfigured()) {
    return {
      content: 'Store crash data unavailable: InfluxDB is not configured.',
      contextMeta: [{
        id: 'storeCrashes',
        label: 'App crashes',
        freshness: 'live',
        fetchedAt: new Date().toISOString(),
        configured: false,
        error: 'InfluxDB not configured',
      }],
      contextPreview: {},
    }
  }

  const appFilter = ctx?.appName || null
  const hostnameFilter = extractStoreHostname(q) || ctx?.hostname || null
  const range = ctx?.range || parseQuestionTimeRange(qLower)
  const fetchedAt = new Date().toISOString()
  const rangeLabel = formatRangeLabelFromInflux(range)
  const fmtTs = (v) => formatPortalTimestamp(v)

  if (wantsEvents || ctx?.wantsCrashEventList) {
    const events = await fetchCrashEventList(range, undefined, undefined, {
      appName: appFilter,
      hostname: hostnameFilter,
    })
    const titleApp = appFilter ? `${appFilter} ` : ''
    const lines = [
      `${titleApp}Crash event log (LIVE — fetched ${fmtTs(fetchedAt)})`,
      `Window: ${rangeLabel}`,
    ]
    if (appFilter) lines.push(`Filter: app matching "${appFilter}"`)
    if (hostnameFilter) lines.push(`Filter: hostname ${hostnameFilter}`)
    lines.push('', `Total events: ${events.length}`)
    if (!events.length) {
      lines.push(`No crash events with timestamps in ${rangeLabel}.`)
    } else {
      lines.push('', '── Crash events (timestamp · hostname · app · type) ──')
      const limit = events.length <= 100 ? events.length : 100
      for (const e of events.slice(0, limit)) {
        const host = e.hostname || e.storeTag || '—'
        const app = e.appName || '—'
        const type = crashTypeLabel(e.crashType)
        const countPart = e.count > 1 ? ` · ×${e.count}` : ''
        const msgPart = e.message ? ` · ${String(e.message).slice(0, 80)}` : ''
        lines.push(`    • ${fmtTs(e.ts)} · ${host} · ${app} · ${type}${countPart}${msgPart}`)
      }
      if (events.length > limit) lines.push(`    … ${events.length - limit} more (open Store Monitor → Crashes)`)
    }
    lines.push('', '(Direct answer from live Influx crash events — no LLM wait.)')

    const totalCount = events.reduce((n, e) => n + (e.count || 1), 0)
    return {
      content: lines.join('\n'),
      contextMeta: [{
        id: 'storeCrashes',
        label: appFilter ? `${appFilter} crash events` : 'App crash events',
        freshness: 'live',
        fetchedAt,
        configured: true,
        note: `InfluxDB event log (${rangeLabel}${appFilter ? ` · ${appFilter}` : ''})`,
      }],
      contextPreview: {
        crashes: {
          range,
          appFilter,
          totalEvents: totalCount,
          eventLog: true,
          eventsShown: Math.min(events.length, 100),
          sample: events.slice(0, 5).map(e => ({
            hostname: e.hostname || e.storeTag,
            app: e.appName,
            ts: e.ts,
          })),
        },
      },
      queryContext: ctx ? {
        topic: 'crash',
        appName: ctx.appName,
        isFollowUp: ctx.isFollowUp,
        range,
        eventLog: true,
      } : undefined,
    }
  }

  let summary = await fetchCrashSummary(range)
  if (appFilter) {
    summary = summary.filter(s => crashRecordMatches(s, appFilter, crashTypeLabel))
  }

  const totalEvents = summary.reduce((acc, s) => acc + s.totalCrashes, 0)
  const criticalEvents = summary
    .filter(s => s.crashSeverity === 'critical')
    .reduce((acc, s) => acc + s.totalCrashes, 0)
  const affectedStores = new Set(summary.map(s => s.storeTag || s.hostname).filter(Boolean)).size

  const byApp = {}
  for (const s of summary) {
    if (!s.appName) continue
    if (!byApp[s.appName]) byApp[s.appName] = { appName: s.appName, totalCrashes: 0, affectedStores: 0 }
    byApp[s.appName].totalCrashes += s.totalCrashes
    byApp[s.appName].affectedStores += 1
  }

  const byType = {}
  for (const s of summary) {
    const t = s.crashType || 'app_crash'
    if (!byType[t]) {
      byType[t] = {
        crashType: t,
        label: crashTypeLabel(t),
        severity: crashSeverity(t),
        totalCrashes: 0,
        affectedStores: 0,
      }
    }
    byType[t].totalCrashes += s.totalCrashes
    byType[t].affectedStores += 1
  }

  const byStore = {}
  for (const s of summary) {
    const key = s.storeTag || s.hostname
    if (!key) continue
    if (!byStore[key]) {
      byStore[key] = {
        hostname: s.hostname,
        storeTag: s.storeTag,
        totalCrashes: 0,
        apps: new Set(),
        crashTypes: new Set(),
      }
    }
    byStore[key].totalCrashes += s.totalCrashes
    if (s.appName) byStore[key].apps.add(s.appName)
    if (s.crashType) byStore[key].crashTypes.add(crashTypeLabel(s.crashType))
  }

  const topApps = Object.values(byApp).sort((a, b) => b.totalCrashes - a.totalCrashes).slice(0, 8)
  const topTypes = Object.values(byType).sort((a, b) => b.totalCrashes - a.totalCrashes).slice(0, 6)
  const allStores = Object.values(byStore).sort((a, b) => b.totalCrashes - a.totalCrashes)
  const topStores = allStores.slice(0, 10).map(s => ({
    hostname: s.hostname,
    storeTag: s.storeTag,
    totalCrashes: s.totalCrashes,
    appCount: s.apps.size,
    crashTypes: [...s.crashTypes],
  }))

  const titleApp = appFilter ? `${appFilter} ` : ''
  const lines = [
    `${titleApp}App Crashes (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    `Window: ${rangeLabel}`,
  ]
  if (appFilter) lines.push(`Filter: matching "${appFilter}"`)
  lines.push(
    '',
    `Total crash events: ${totalEvents}`,
    `Affected stores: ${affectedStores}`,
    `Critical events: ${criticalEvents}`,
  )

  const wantsStoreList =
    ctx?.wantsStoreList
    || ctx?.followUpKind === 'affected_stores'
    || (/\b(store|stores|which store|list|affected)\b/.test(qLower) && !wantsEvents)
    || (!!appFilter && !wantsEvents)

  if (totalEvents === 0) {
    const noDataMsg = appFilter
      ? `No crash events for "${appFilter}" in Influx for ${rangeLabel}.`
      : `No crash events recorded in Influx for ${rangeLabel}.`
    lines.push('', noDataMsg)
  } else {
    if (!appFilter && topTypes.length) {
      lines.push('', 'By crash type:')
      for (const t of topTypes) {
        lines.push(`  • ${t.label}: ${t.totalCrashes} (${t.affectedStores} stores)`)
      }
    }
    if (!appFilter && topApps.length) {
      lines.push('', 'Top apps:')
      for (const a of topApps) {
        lines.push(`  • ${a.appName}: ${a.totalCrashes} crashes across ${a.affectedStores} stores`)
      }
    }
    const storesToShow = wantsStoreList ? allStores.slice(0, 50) : topStores.slice(0, 1)
    if (wantsStoreList && storesToShow.length) {
      lines.push('', appFilter ? 'Affected stores:' : 'Top affected stores:')
      for (const s of storesToShow) {
        const typeList = s.crashTypes instanceof Set ? [...s.crashTypes] : (s.crashTypes || [])
        const types = typeList.length ? ` · ${typeList.join(', ')}` : ''
        lines.push(`  • ${s.hostname || s.storeTag} [${s.storeTag}] — ${s.totalCrashes} events${types}`)
      }
      if (allStores.length > storesToShow.length) {
        lines.push(`  … and ${allStores.length - storesToShow.length} more (open Store Monitor → Crashes)`)
      }
    } else if (topStores.length) {
      lines.push('', `Top store: ${topStores[0].hostname || topStores[0].storeTag} (${topStores[0].totalCrashes} events)`)
      lines.push('Tip: ask "show crash events with timestamp and hostname" for the full event log.')
    }
  }

  lines.push('', '(Direct answer from SocMon live Influx crash data — no LLM wait.)')

  const contextPreview = {
    crashes: {
      range,
      appFilter,
      totalEvents,
      affectedStores,
      criticalEvents,
      topApps: topApps.slice(0, 5),
      topTypes: topTypes.slice(0, 5).map(t => ({ label: t.label, totalCrashes: t.totalCrashes })),
      affectedStoreList: wantsStoreList
        ? allStores.slice(0, 20).map(s => ({
          hostname: s.hostname,
          storeTag: s.storeTag,
          totalCrashes: s.totalCrashes,
        }))
        : undefined,
    },
  }

  return {
    content: lines.join('\n'),
    contextMeta: [{
      id: 'storeCrashes',
      label: appFilter ? `${appFilter} crashes` : 'App crashes',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: `InfluxDB crash events (${rangeLabel}${appFilter ? ` · ${appFilter}` : ''})`,
    }],
    contextPreview,
    queryContext: ctx ? {
      topic: ctx.topic || 'crash',
      appName: ctx.appName,
      isFollowUp: ctx.isFollowUp,
      range,
    } : undefined,
  }
}

/**
 * Instant answer for simple store count/status — skips slow LLM call.
 * @param {string} question
 * @param {object} portalContext
 * @param {ReturnType<import('./queryContext.js').resolveQueryContext>} [ctx]
 */
export function tryDirectStoreAnswer(question, portalContext, ctx = null) {
  const sm = portalContext?.modules?.storeMonitor
  if (!sm?.summary || sm.configured === false) return null

  const q = String(question || '').toLowerCase()
  if (ctx?.directHandler === 'crash') return null
  if (ctx?.directHandler === 'xdr') return null
  if (ctx?.followUpKind === 'affected_stores' && (ctx.priorTopic === 'crash' || ctx.topic === 'crash')) {
    return null
  }
  if (ctx?.isFollowUp && ctx.priorTopic === 'crash' && /\b(affected|which stores|what stores)\b/.test(q)) {
    return null
  }
  if (CRASH_KEYWORDS.test(q)) return null
  if (/\b(sentinel|xdr|sentinelone|powerquery)\b/.test(q)) return null
  if (extractIpv4(q) || isZabbixQuestion(q) || isNetworkInfraQuery(q) || isInfraMonitorQuery(q)) return null
  const storeIntent =
    /\b(stores?|offline|online|down|store monitor|monitor status|how many stores)\b/.test(q)
    || (/\bstatus\b/.test(q) && /\b(store|stores)\b/.test(q))
    || (/\b(how many|count)\b/.test(q) && /\b(store|stores)\b/.test(q))
  if (!storeIntent) return null

  const s = sm.summary
  const fetched = sm.fetchedAt ? formatPortalTimestamp(sm.fetchedAt) : 'just now'
  const lines = [
    `Store Monitor (LIVE — fetched ${fetched})`,
    '',
    `Total stores: ${s.total}`,
    `Online: ${s.online}`,
    `Offline / down: ${s.offline}`,
    `With issues: ${s.withIssues}`,
  ]

  if (s.avgPingMs != null) lines.push(`Average ping: ${s.avgPingMs} ms`)
  if (s.avgDownloadMbps != null) lines.push(`Average download: ${s.avgDownloadMbps} Mbps`)

  const wantsList = /\b(hostname|hostnames|list|name|which|show)\b/.test(q)
  if (wantsList && sm.offlineHostnames?.length) {
    lines.push('', 'Offline stores (hostname):')
    for (const h of sm.offlineHostnames) {
      lines.push(`  • ${h.hostname || h.storeTag} [${h.storeTag}] — ${h.connState}, last seen ${h.lastSeen || 'unknown'}`)
    }
    if (sm.offlineCount > sm.offlineHostnames.length) {
      lines.push(`  … and ${sm.offlineCount - sm.offlineHostnames.length} more offline (open Store Monitor for full list)`)
    }
  } else if (s.offline === 0) {
    lines.push('', 'No stores are offline in the current live snapshot.')
  } else if (!wantsList) {
    lines.push('', `Tip: ask "list offline store hostnames" for the full offline list.`)
  }

  const sp = portalContext.modules?.storeProblems
  if (sp?.activeProblemCount != null) {
    lines.push(
      '',
      `Problem tracker (PERIODIC — ~${sp.snapshotIntervalMinutes || 2} min job): ${sp.activeProblemCount} active tracked problems`,
    )
  }

  lines.push('', '(Direct answer from SocMon live data — no LLM wait.)')
  return lines.join('\n')
}

/**
 * @param {import('../models/User.js').default} user
 * @param {string[]} moduleIds
 * @param {{ userMessage?: string }} [opts]
 */
export async function buildPortalContext(user, moduleIds = [], opts = {}) {
  const detail = inferContextDetail(opts.userMessage || '')
  const { allowedPages } = await computeUserPageAccess(user)
  const unique = [...new Set(moduleIds)].filter(id => canUseModule(id, allowedPages))

  const modules = {}
  const meta = []

  await Promise.all(
    unique.map(async (id) => {
      const def = MODULE_BY_ID[id]
      const builder = BUILDERS[id]
      if (!builder) return
      try {
        const data = id === 'storeMonitor'
          ? await builder(detail)
          : id === 'zabbixInfra'
            ? await builder(detail, { userMessage: opts.userMessage || '' })
            : await builder()
        modules[id] = data
        meta.push({
          id,
          label: def.label,
          freshness: def.freshness,
          fetchedAt: data.fetchedAt,
          configured: data.configured !== false,
          error: data.error || null,
          note: data.note || def.description,
          lastBackgroundSnapAt: data.lastBackgroundSnapAt || null,
          snapshotIntervalMinutes: data.snapshotIntervalMinutes || null,
        })
      } catch (err) {
        modules[id] = { module: id, error: err.message }
        meta.push({
          id,
          label: def.label,
          freshness: def.freshness,
          fetchedAt: new Date().toISOString(),
          configured: false,
          error: err.message,
          note: def.description,
        })
      }
    }),
  )

  return {
    portal: 'netpulse',
    user: { email: user.email, role: user.role },
    modules,
    meta,
  }
}

export function buildContextPreview(context) {
  const preview = {}
  const sm = context?.modules?.storeMonitor
  if (sm?.summary) {
    preview.storeMonitor = {
      total: sm.summary.total,
      online: sm.summary.online,
      offline: sm.summary.offline,
      withIssues: sm.summary.withIssues,
      avgPingMs: sm.summary.avgPingMs,
      avgDownloadMbps: sm.summary.avgDownloadMbps,
      offlineHostnames: (sm.offlineHostnames || []).slice(0, 10).map((h) => ({
        hostname: h.hostname,
        storeTag: h.storeTag,
        connState: h.connState,
        lastSeen: h.lastSeen,
      })),
    }
  }
  const sp = context?.modules?.storeProblems
  if (sp && sp.activeProblemCount != null) {
    preview.storeProblems = {
      activeProblemCount: sp.activeProblemCount,
      snapshotIntervalMinutes: sp.snapshotIntervalMinutes || 2,
      lastBackgroundSnapAt: sp.lastBackgroundSnapAt || null,
    }
  }
  const soc = context?.modules?.soc
  if (soc?.stats) {
    preview.soc = {
      window: soc.window || 'last 1 hour',
      totalEvents: soc.stats.totalEvents,
      denies: soc.stats.denies,
      allows: soc.stats.allows,
      topSourceIps: (soc.stats.topSourceIps || []).slice(0, 5),
    }
  }
  if (context?.contextPreview?.crashes) {
    preview.crashes = context.contextPreview.crashes
  }
  if (context?.contextPreview?.xdr) {
    preview.xdr = context.contextPreview.xdr
  }
  const zb = context?.modules?.zabbixInfra
  if (zb?.availability) {
    preview.zabbixInfra = {
      total: zb.availability.total,
      available: zb.availability.available,
      unavailable: zb.availability.unavailable,
      problemCount: zb.problemCount,
      hostFilter: zb.hostFilter,
      hostCount: (zb.hosts || []).length,
    }
  }
  return preview
}

export function formatContextForPrompt(context) {
  if (!context?.meta?.length) {
    return ''
  }

  const lines = [
    '=== NETPULSE PORTAL CONTEXT (authoritative — do NOT invent data outside this JSON) ===',
    'Rules:',
    '- Answer ONLY using fields in this JSON. Never fabricate hostnames, store tags, IPs, or counts.',
    '- Each module has freshness: "live" = queried when the user sent the message; "periodic" = background snapshot.',
    '- State which freshness type you used when citing store or firewall numbers.',
    '- If hostnameWise or topIssues lists are truncated, say how many stores exist in summary.total.',
    '- For zabbixInfra: use hosts[].ports for per-interface bandwidth. inRate/outRate are formatted; inBps/outBps are raw bytes/sec.',
    '- Rank or highlight busiest interfaces when the user asks about utilization — compute from inBps+outBps when helpful.',
    '- If hostFilter is an IP and hosts[] is empty, say no Zabbix host matched that SNMP/management IP.',
    '',
    JSON.stringify(context),
    '=== END PORTAL CONTEXT ===',
  ]
  return lines.join('\n')
}
