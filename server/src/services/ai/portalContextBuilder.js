import { getESClient } from '../../config/elasticsearch.js'
import StoreProblemHistory from '../../models/StoreProblemHistory.js'
import {
  isInfluxStoreConfigured,
  fetchStoreSnapshot,
  fetchStoreIssuesLite,
  getAnyCachedStoreSnapshot,
  fetchWifiConnectivityHistory,
  buildOverviewSummary,
  fetchCrashSummary,
  fetchCrashEventList,
  crashTypeLabel,
  crashSeverity,
} from '../influxStore.js'
import { getProblemSnapshotStatus } from '../storeProblemSnapshotter.js'
import { computeUserPageAccess } from '../../utils/computeUserPageAccess.js'
import { isXdrQuestion } from './xdrDirectAnswer.js'
import { isStoreMonitorConnectivityQuery, isStoreMonitorIssuesQuery, extractTopLimit } from './geoConnectionQuery.js'
import { isNetworkInfraQuery, isZabbixQuestion, extractIpv4, isInfraMonitorQuery, isIpInfraQuery, prefersLlmSynthesis, buildZabbixInfraContext, wantsDiskUsage, extractHostGroupFilter } from './zabbixDirectAnswer.js'
import {
  appNameMatches,
  crashRecordMatches,
  formatRangeLabelFromInflux,
  parseQuestionTimeRange,
  hasExplicitTimeRange,
  wantsCrashEventLog,
  extractStoreHostname,
} from './queryContext.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'

export { parseQuestionTimeRange } from './queryContext.js'
export { isStoreMonitorIssuesQuery, extractTopLimit } from './geoConnectionQuery.js'

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
  if (isStoreMonitorIssuesQuery(text) || isStoreMonitorConnectivityQuery(text, ctx) || ctx?.directHandler === 'store') {
    if (pages.has('storeMonitor')) modules.add('storeMonitor')
    return [...modules]
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

  if (pages.has('storeMonitor') && (
    STORE_KEYWORDS.test(text)
    || OVERVIEW_KEYWORDS.test(text)
    || isStoreMonitorIssuesQuery(text)
    || isStoreMonitorConnectivityQuery(text, ctx)
  )) {
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

/** Match Store Monitor UI group rules (RP/LK prefix + Fortinet SD-WAN). */
export function deriveStoreGroups(hostname, gatewayVendor, isFortinet = false) {
  const h = String(hostname || '').toUpperCase()
  const v = String(gatewayVendor || '').toLowerCase()
  const groups = []
  if (h.startsWith('RP')) groups.push('RP Group')
  else if (h.startsWith('LK')) groups.push('POS System Group')
  if (isFortinet || v.includes('fortinet') || v.includes('fortigate')) groups.push('SD-WAN Group')
  if (groups.length === 0) groups.push('General Group')
  return groups
}

/** e.g. "Status of RoP group in store mon" → RP Group */
export function extractStoreGroupFilter(question, contextText = '') {
  const q = `${String(question || '')} ${String(contextText || '')}`.toLowerCase()
  if (/\b(rop|rp)\s*group\b/.test(q) || (/\bro\s*p\b/.test(q) && /\bgroup\b/.test(q))) return 'RP Group'
  if (/\bpos\s*(system\s*)?group\b/.test(q)) return 'POS System Group'
  if (/\bsd-?wan\s*group\b/.test(q)) return 'SD-WAN Group'
  if (/\bgeneral\s*group\b/.test(q)) return 'General Group'
  return null
}

/** Match Store Monitor → Stores tab interface filter. */
function isStoreOnWifi(store) {
  const iface = String(store.activeInterface || '').toLowerCase()
  if (iface === 'wi-fi' || iface === 'wifi' || iface.includes('wireless')) return true
  return store.connState === 'wifi_healthy'
}

function isStoreOnEthernet(store) {
  const iface = String(store.activeInterface || '').toLowerCase()
  if (iface === 'ethernet' || iface === 'lan') return true
  return store.connState === 'lan_healthy'
}

function buildGroupConnectivityStats(stores) {
  const names = ['RP Group', 'POS System Group', 'SD-WAN Group', 'General Group']
  const out = {}
  for (const name of names) {
    const list = stores.filter(s => deriveStoreGroups(s.hostname, s.gatewayVendor, s.isFortinet).includes(name))
    if (!list.length) continue
    const connBreakdown = {}
    let wifiConnected = 0
    let ethernetConnected = 0
    for (const s of list) {
      const k = s.connState || 'unknown'
      connBreakdown[k] = (connBreakdown[k] || 0) + 1
      if (isStoreOnWifi(s)) wifiConnected++
      if (isStoreOnEthernet(s)) ethernetConnected++
    }
    out[name] = {
      total: list.length,
      connBreakdown,
      wifiConnected,
      ethernetConnected,
      wifiHealthy: connBreakdown.wifi_healthy || 0,
      lanHealthy: connBreakdown.lan_healthy || 0,
      hotspot: connBreakdown.hotspot || 0,
    }
  }
  return out
}

function buildGroupSummaries(stores) {
  const names = ['RP Group', 'POS System Group', 'SD-WAN Group', 'General Group']
  const out = {}
  for (const name of names) {
    const list = stores.filter(s => deriveStoreGroups(s.hostname, s.gatewayVendor, s.isFortinet).includes(name))
    if (list.length) out[name] = buildOverviewSummary(list)
  }
  return out
}

function buildGroupOfflineHostnames(stores, limit = 25) {
  const names = ['RP Group', 'POS System Group', 'SD-WAN Group', 'General Group']
  const out = {}
  for (const name of names) {
    out[name] = stores
      .filter(s => !s.online && deriveStoreGroups(s.hostname, s.gatewayVendor, s.isFortinet).includes(name))
      .slice(0, limit)
      .map(s => ({
        hostname: s.hostname,
        storeTag: s.storeTag,
        lastSeen: s.lastSeen,
        connState: s.connState,
      }))
  }
  return out
}

/** @returns {'summary' | 'standard' | 'full'} */
export function inferContextDetail(message) {
  const q = String(message || '').toLowerCase()
  if (/\b(hostname|hostnames|hostname.wise|hostname-wise|list all|every store|each store)\b/.test(q)) {
    return 'full'
  }
  if (/\btop\s+\d+\b/.test(q) && /\b(issue|issues|problem|problems|device|devices|store|stores)\b/.test(q)) {
    return 'standard'
  }
  if (/\b(how many|count|number|total|status|summary|overview|down|offline|online|stores are)\b/.test(q)) {
    return 'summary'
  }
  return 'standard'
}

function problemSeverityRank(severity, online = false) {
  if (!online) return 0
  const s = String(severity || '').toLowerCase()
  if (s === 'critical') return 1
  if (s === 'high') return 2
  if (s === 'warning') return 3
  return 4
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
    groupSummaries: buildGroupSummaries(stores),
    groupConnectivityStats: buildGroupConnectivityStats(stores),
    groupOfflineHostnames: buildGroupOfflineHostnames(stores),
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

function problemMatchesGroupFilter(p, groupFilter) {
  if (!groupFilter) return true
  const h = String(p.hostname || '').toUpperCase()
  if (groupFilter === 'RP Group') return h.startsWith('RP')
  if (groupFilter === 'POS System Group') return h.startsWith('LK')
  const groups = deriveStoreGroups(p.hostname, p.gatewayVendor, /fortinet/i.test(String(p.gatewayVendor || '')))
  return groups.includes(groupFilter)
}

function metricRangeToSince(metricRange) {
  const m = String(metricRange || '-24h').match(/^-(\d+)(h|d|m)$/)
  if (!m) return new Date(Date.now() - 24 * 3600000)
  const n = parseInt(m[1], 10)
  const ms = m[2] === 'h' ? n * 3600000 : m[2] === 'd' ? n * 86400000 : n * 60000
  return new Date(Date.now() - ms)
}

/** Problem-tracker stores with issues in a time window (active or seen/resolved since). */
async function rankProblemsFromTracker(since, groupFilter, limit) {
  try {
    const filter = {
      $or: [
        { firstSeenAt: { $gte: since } },
        { lastSeenAt: { $gte: since } },
        { resolvedAt: { $gte: since } },
      ],
    }
    if (groupFilter === 'RP Group') filter.hostname = { $regex: /^RP/i }
    else if (groupFilter === 'POS System Group') filter.hostname = { $regex: /^LK/i }

    const rows = await StoreProblemHistory.find(filter)
      .sort({ severity: 1, lastSeenAt: -1 })
      .limit(Math.max(limit * 50, 2000))
      .lean()

    const byStore = new Map()
    for (const p of rows) {
      if (!problemMatchesGroupFilter(p, groupFilter)) continue
      const key = p.storeTag || p.hostname
      if (!key) continue
      const rank = problemSeverityRank(p.severity, p.online)
      const prev = byStore.get(key)
      if (!prev) {
        byStore.set(key, {
          ...p,
          rank,
          issues: [p],
          issueSummary: p.message || p.code,
        })
        continue
      }
      prev.issues.push(p)
      if (rank < prev.rank) {
        prev.rank = rank
        prev.severity = p.severity
        prev.message = p.message
        prev.code = p.code
        prev.online = p.online
        prev.connState = p.connState
      }
      prev.issueSummary = [...new Set(prev.issues.map(i => i.message || i.code).filter(Boolean))].join('; ')
      prev.lastSeenAt = prev.issues.reduce((max, i) => {
        const t = new Date(i.lastSeenAt || 0).getTime()
        return t > max ? t : max
      }, new Date(prev.lastSeenAt || 0).getTime())
      prev.lastSeenAt = new Date(prev.lastSeenAt)
    }
    return [...byStore.values()].sort((a, b) => a.rank - b.rank)
  } catch (e) {
    console.warn('[storeIssues] problem tracker query failed:', e.message)
    return []
  }
}

function isHeartbeatOnlyInfluxIssue(s) {
  const codes = s.issueCodes || []
  return codes.length === 1 && codes[0] === 'offline'
    && String(s.issueSummary || '').includes('heartbeat')
}

/**
 * @param {string} question
 * @param {string[]} allowedPages
 * @param {ReturnType<import('./queryContext.js').resolveQueryContext>} [ctx]
 */
export async function tryDirectStoreIssuesAnswer(question, allowedPages, ctx = null) {
  if (!allowedPages.includes('storeMonitor')) return null
  if (!isStoreMonitorIssuesQuery(question)) return null

  const limit = extractTopLimit(question)
  const groupFilter = extractStoreGroupFilter(question)
  const metricRange = parseQuestionTimeRange(question)
  const rangeLabel = formatRangeLabelFromInflux(metricRange)
  const since = metricRangeToSince(metricRange)
  const windowedQuery = hasExplicitTimeRange(question)
  const fetchedAt = new Date().toISOString()

  if (!isInfluxStoreConfigured()) {
    return {
      content: 'Store Monitor InfluxDB is not configured — cannot list stores with issues.',
      contextMeta: [{ id: 'storeMonitor', label: 'Store Monitor', freshness: 'live', configured: false, fetchedAt }],
      contextPreview: {},
      queryContext: { topic: 'store', isFollowUp: ctx?.isFollowUp },
    }
  }

  const [trackerRanked, storesInitial] = await Promise.all([
    rankProblemsFromTracker(since, groupFilter, limit),
    fetchStoreSnapshot(10, metricRange),
  ])

  let stores = storesInitial
  let snapshotNote = null
  if (!stores.length) {
    stores = getAnyCachedStoreSnapshot() || []
    if (stores.length) snapshotNote = 'Using recent cached Store Monitor snapshot (fresh Influx fetch returned no data).'
  }
  if (!stores.length) {
    stores = await fetchStoreIssuesLite(10, metricRange)
    if (stores.length) snapshotNote = 'Using lightweight Store Monitor fetch (full snapshot unavailable).'
  }
  if (!stores.length && metricRange !== '-24h') {
    stores = getAnyCachedStoreSnapshot() || await fetchStoreIssuesLite(10, '-24h')
    if (stores.length && !snapshotNote) {
      snapshotNote = 'Using 24h fallback window (12h fetch unavailable).'
    }
  }

  let scoped = groupFilter
    ? stores.filter(s => deriveStoreGroups(s.hostname, s.gatewayVendor, s.isFortinet).includes(groupFilter))
    : stores

  const summary = buildOverviewSummary(scoped)
  const lines = [
    `Store Monitor — top ${limit} devices with issues (${rangeLabel}, LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    groupFilter ? `Filter: ${groupFilter}` : null,
    windowedQuery
      ? `Ranking source: problem tracker events in ${rangeLabel} (offline, hotspot, DNS, packet loss, etc.) — not the 10-min heartbeat snapshot alone.`
      : null,
    '',
    summary.total > 0
      ? `Current snapshot — ${groupFilter || 'all stores'}: ${summary.total} total · ${summary.online} online · ${summary.offline} offline · ${summary.withIssues} with active issues now`
      : trackerRanked.length
        ? `Influx snapshot empty — problem tracker shows ${trackerRanked.length} store(s) with issues in ${rangeLabel}`
        : 'Total stores: 0 · Online: 0 · Offline: 0 · With issues: 0',
    trackerRanked.length
      ? `Problem tracker — ${trackerRanked.length} distinct store(s) with issue events in ${rangeLabel}${groupFilter ? ` (${groupFilter})` : ''}`
      : windowedQuery
        ? `Problem tracker — no recorded issue events in ${rangeLabel}${groupFilter ? ` for ${groupFilter}` : ''} (may still show current snapshot issues below)`
        : null,
    '',
  ].filter(line => line != null)

  if (snapshotNote) {
    lines.push(snapshotNote, '')
  }

  const fromInflux = scoped
    .filter(s => s.issueCount > 0 || !s.online)
    .map(summarizeStore)
    .sort((a, b) => severityRank(a) - severityRank(b))

  let ranked = []
  if (windowedQuery && trackerRanked.length) {
    ranked = trackerRanked.map(p => ({ source: 'tracker', rank: p.rank, tracker: p }))
  } else {
    const merged = new Map()
    for (const s of fromInflux) {
      if (windowedQuery && isHeartbeatOnlyInfluxIssue(s)) continue
      const key = s.storeTag || s.hostname
      if (!key) continue
      merged.set(key, { source: 'influx', rank: severityRank(s), influx: s })
    }
    for (const p of trackerRanked) {
      const key = p.storeTag || p.hostname
      if (!key) continue
      const prev = merged.get(key)
      if (!prev || p.rank < prev.rank) {
        merged.set(key, { source: prev?.source === 'influx' ? 'both' : 'tracker', rank: p.rank, influx: prev?.influx, tracker: p })
      } else if (prev && !prev.tracker) {
        merged.set(key, { ...prev, source: 'both', tracker: p })
      }
    }
    ranked = [...merged.values()].sort((a, b) => a.rank - b.rank)
  }

  if (ranked.length) {
    const rankSource = windowedQuery && trackerRanked.length
      ? `problem tracker (${rangeLabel})`
      : `live snapshot + problem tracker`
    lines.push(`Top ${Math.min(limit, ranked.length)} (worst first — ${rankSource}):`)
    for (const row of ranked.slice(0, limit)) {
      if (row.tracker && (windowedQuery || !row.influx)) {
        const p = row.tracker
        const status = p.status === 'resolved' ? 'resolved in window' : 'active'
        const issues = p.issueSummary || p.message || p.code
        lines.push(`  • ${p.hostname || p.storeTag} [${p.storeTag}] — ${p.severity}: ${issues} (${status}, last seen ${formatPortalTimestamp(p.lastSeenAt)})`)
      } else if (row.influx) {
        const s = row.influx
        const issues = s.issueSummary || (s.online ? 'online with issues' : 'offline')
        lines.push(`  • ${s.hostname || s.storeTag} [${s.storeTag}] — ${s.connState} · ${issues}`)
      }
    }
    if (ranked.length > limit) {
      lines.push(`  … ${ranked.length - limit} more with issues (open Store Monitor → Problems for full list)`)
    }
  } else if (summary.total === 0 && !trackerRanked.length) {
    lines.push('No stores with issues in the live snapshot or problem tracker for this window.')
    lines.push('If Store Monitor UI shows data, Influx may have timed out — retry in a few seconds.')
  } else {
    lines.push(`No stores with recorded issue events in ${rangeLabel}${groupFilter ? ` for ${groupFilter}` : ''}.`)
    if (summary.withIssues > 0) {
      lines.push(`Note: ${summary.withIssues} store(s) show issues in the current snapshot only (may be outside the ${rangeLabel} tracker window).`)
    }
  }

  const tracker = getProblemSnapshotStatus()
  lines.push('', `(Live Store Monitor — InfluxDB. Problem tracker refreshes ~${Math.round((tracker.intervalMs || 120000) / 60000)} min.)`)

  return {
    content: lines.join('\n'),
    skipLlmAnalysis: Boolean(windowedQuery && trackerRanked.length > 0),
    contextMeta: [{
      id: 'storeMonitor',
      label: 'Store Monitor',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: windowedQuery && trackerRanked.length
        ? `Top ${limit} from problem tracker (${rangeLabel})`
        : `Top ${limit} by issue severity`,
    }],
    contextPreview: {
      storeMonitor: {
        total: summary.total,
        withIssues: summary.withIssues,
        topIssuesCount: Math.min(limit, ranked.length),
      },
    },
    queryContext: {
      topic: 'store',
      isFollowUp: ctx?.isFollowUp,
      storeGroup: groupFilter || undefined,
      range: metricRange,
    },
  }
}

/**
 * Store Monitor WiFi / RP group with Influx history window (e.g. last 24h).
 * @param {string} question
 * @param {string[]} allowedPages
 * @param {ReturnType<import('./queryContext.js').resolveQueryContext>} [ctx]
 */
export async function tryDirectStoreConnectivityAnswer(question, allowedPages, ctx = null) {
  if (!allowedPages.includes('storeMonitor')) return null
  if (!isStoreMonitorConnectivityQuery(question, ctx)) return null
  if (!isInfluxStoreConfigured()) {
    return {
      content: 'Store Monitor InfluxDB is not configured — cannot query Wi-Fi history.',
      contextMeta: [{ id: 'storeMonitor', label: 'Store Monitor', freshness: 'live', configured: false }],
      contextPreview: {},
      queryContext: { topic: 'store', isFollowUp: ctx?.isFollowUp },
    }
  }

  const threadText = [ctx?.priorUser, question, ctx?.priorAssistant].filter(Boolean).join(' ')
  const groupFilter = extractStoreGroupFilter(question, threadText) || 'RP Group'
  const range = ctx?.range || parseQuestionTimeRange(question) || parseQuestionTimeRange(ctx?.priorUser) || '-24h'
  const rangeLabel = formatRangeLabelFromInflux(range)
  const wantsWifi = /\b(wifi|wi-?fi|wireless)\b/i.test(threadText)
  if (!wantsWifi) return null

  const fetchedAt = new Date().toISOString()
  const wifiHistory = await fetchWifiConnectivityHistory(range)

  let stores = await fetchStoreSnapshot(10, range)
  if (!stores.length) stores = getAnyCachedStoreSnapshot() || []
  if (!stores.length) stores = await fetchStoreIssuesLite(10, range)
  if (!stores.length && range !== '-24h') {
    stores = getAnyCachedStoreSnapshot() || await fetchStoreIssuesLite(10, '-24h')
  }

  const groupStores = stores.filter(s =>
    deriveStoreGroups(s.hostname, s.gatewayVendor, s.isFortinet).includes(groupFilter),
  )
  const groupTags = new Set(groupStores.map(s => s.storeTag))
  const histInGroup = wifiHistory.stores.filter(s => {
    const h = String(s.hostname || '').toUpperCase()
    if (groupFilter === 'RP Group') return h.startsWith('RP')
    if (groupFilter === 'POS System Group') return h.startsWith('LK')
    return groupTags.has(s.storeTag)
  })

  const uniqueWifiHealthy = histInGroup.filter(s => s.wifiHealthySamples > 0).length
  const uniqueWifiInterface = histInGroup.filter(s => s.wifiInterfaceSamples > 0).length
  const withDataInWindow = histInGroup.length
  const historyUnavailable = withDataInWindow === 0 && groupStores.length > 0 && wifiHistory.storesWithData === 0
  const snapStats = buildGroupConnectivityStats(groupStores)[groupFilter] || {
    total: groupStores.length,
    wifiConnected: groupStores.filter(isStoreOnWifi).length,
    wifiHealthy: groupStores.filter(s => s.connState === 'wifi_healthy').length,
    lanHealthy: groupStores.filter(s => s.connState === 'lan_healthy').length,
  }

  const summary = buildOverviewSummary(groupStores)
  const lines = [
    `Store Monitor — ${groupFilter} (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    `Window: ${rangeLabel} (InfluxDB connectivity history + latest snapshot in window)`,
    '',
    `Filter: ${groupFilter} (same rules as Store Monitor → ROP Groups tab)`,
    '',
    `── ${rangeLabel} — Wi-Fi history (unique devices) ──`,
    historyUnavailable
      ? `Wi-Fi history query returned no rows (Influx may be slow) — see latest snapshot below for current counts.`
      : `Devices with Wi-Fi Healthy at least once: ${uniqueWifiHealthy} of ${withDataInWindow} stores reporting in window`,
    historyUnavailable
      ? `Currently on Wi-Fi (snapshot): ${snapStats.wifiConnected} devices (${snapStats.wifiHealthy} Wi-Fi Healthy)`
      : `Devices with active Wi-Fi interface at least once: ${uniqueWifiInterface}`,
    historyUnavailable
      ? `Stores in ${groupFilter}: ${groupStores.length} (connectivity history unavailable for window)`
      : `Stores with connectivity data in window: ${withDataInWindow} (group total ${groupStores.length})`,
    '',
    '── Latest snapshot in window ──',
    `Total stores: ${summary.total}`,
    `Online: ${summary.online}`,
    `Offline / down: ${summary.offline}`,
    `Currently Wi-Fi connected: ${snapStats.wifiConnected} (Wi-Fi Healthy: ${snapStats.wifiHealthy}, LAN Healthy: ${snapStats.lanHealthy})`,
  ]
  if (summary.avgPingMs != null) lines.push(`Average ping: ${summary.avgPingMs} ms`)
  if (summary.avgDownloadMbps != null) lines.push(`Average download: ${summary.avgDownloadMbps} Mbps`)
  lines.push('', '(Live Store Monitor + InfluxDB history — SocMon.)')

  return {
    content: lines.join('\n'),
    contextMeta: [{
      id: 'storeMonitor',
      label: 'Store Monitor',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: `Wi-Fi unique counts from connectivity points in ${rangeLabel}`,
    }],
    contextPreview: {
      storeGroupConnectivity: {
        [groupFilter]: {
          window: rangeLabel,
          uniqueWifiHealthy,
          uniqueWifiInterface,
          currentlyWifi: snapStats.wifiConnected,
          total: groupStores.length,
        },
      },
    },
    queryContext: {
      topic: 'store',
      isFollowUp: ctx?.isFollowUp,
      storeGroup: groupFilter,
      range,
    },
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
    isStoreMonitorIssuesQuery(question)
    || isStoreMonitorConnectivityQuery(question)
    || /\b(stores?|offline|online|down|store monitor|store mon|monitor status|how many stores)\b/.test(q)
    || (/\bstatus\b/.test(q) && /\b(store|stores|store mon)\b/.test(q))
    || (/\b(how many|count)\b/.test(q) && /\b(store|stores|device|devices)\b/.test(q))
    || (/\bgroup\b/.test(q) && /\b(store|stores|store mon|rop|rp)\b/.test(q))
  if (!storeIntent) return null

  const groupFilter = extractStoreGroupFilter(question)
  const wantsWifi = /\b(wifi|wi-?fi|wireless)\b/.test(q)
  const wantsEthernet = /\b(ethernet|lan)\b/.test(q) && !wantsWifi
  const connStats = groupFilter
    ? sm.groupConnectivityStats?.[groupFilter]
    : null
  const s = groupFilter && sm.groupSummaries?.[groupFilter]
    ? sm.groupSummaries[groupFilter]
    : sm.summary
  const fetched = sm.fetchedAt ? formatPortalTimestamp(sm.fetchedAt) : 'just now'
  const title = groupFilter ? `Store Monitor — ${groupFilter}` : 'Store Monitor'
  const lines = [
    `${title} (LIVE — fetched ${fetched})`,
    '',
  ]
  if (groupFilter) {
    lines.push(`Filter: ${groupFilter} (stores in this group — same rules as Store Monitor → ROP Groups tab)`)
    lines.push('')
  }
  lines.push(
    `Total stores: ${s.total}`,
    `Online: ${s.online}`,
    `Offline / down: ${s.offline}`,
    `With issues: ${s.withIssues}`,
  )

  if (wantsWifi && connStats) {
    lines.push('')
    lines.push(`Wi-Fi connected devices: ${connStats.wifiConnected} of ${connStats.total} (${groupFilter})`)
    lines.push(`  • Wi-Fi Healthy (connState): ${connStats.wifiHealthy}`)
    lines.push(`  • LAN Healthy: ${connStats.lanHealthy}`)
    if (connStats.hotspot) lines.push(`  • Hotspot: ${connStats.hotspot}`)
    if (connStats.wifiConnected !== connStats.wifiHealthy) {
      lines.push(`  • Active interface Wi-Fi (broader count): ${connStats.wifiConnected}`)
    }
  } else if (wantsEthernet && connStats) {
    lines.push('')
    lines.push(`Ethernet/LAN connected devices: ${connStats.ethernetConnected} of ${connStats.total} (${groupFilter})`)
    lines.push(`  • LAN Healthy (connState): ${connStats.lanHealthy}`)
    lines.push(`  • Wi-Fi Healthy: ${connStats.wifiHealthy}`)
  } else if (wantsWifi && !groupFilter && sm.groupConnectivityStats) {
    let wifiTotal = 0
    let storeTotal = 0
    for (const g of Object.values(sm.groupConnectivityStats)) {
      wifiTotal += g.wifiConnected || 0
      storeTotal += g.total || 0
    }
    lines.push('')
    lines.push(`Wi-Fi connected devices (all groups): ${wifiTotal} of ${storeTotal}`)
  }

  if (s.avgPingMs != null) lines.push(`Average ping: ${s.avgPingMs} ms`)
  if (s.avgDownloadMbps != null) lines.push(`Average download: ${s.avgDownloadMbps} Mbps`)

  const wantsList = /\b(hostname|hostnames|list|name|which|show|top)\b/.test(q)
  const wantsTopIssues = isStoreMonitorIssuesQuery(question)
  const topLimit = extractTopLimit(question)
  const topIssues = (sm.topIssues || [])
    .filter(s => !groupFilter || deriveStoreGroups(s.hostname, s.gatewayVendor).includes(groupFilter))

  if (wantsTopIssues && topIssues.length) {
    lines.push('', `Top ${Math.min(topLimit, topIssues.length)} devices with issues:`)
    for (const s of topIssues.slice(0, topLimit)) {
      lines.push(`  • ${s.hostname || s.storeTag} [${s.storeTag}] — ${s.connState} · ${s.issueSummary || 'issues'}`)
    }
  }

  const offlineList = groupFilter
    ? (sm.groupOfflineHostnames?.[groupFilter] || [])
    : (sm.offlineHostnames || [])
  const offlineTotal = groupFilter ? s.offline : (sm.offlineCount ?? s.offline)

  if (wantsList && offlineList.length) {
    lines.push('', `Offline stores${groupFilter ? ` in ${groupFilter}` : ''} (hostname):`)
    for (const h of offlineList) {
      lines.push(`  • ${h.hostname || h.storeTag} [${h.storeTag}] — ${h.connState}, last seen ${h.lastSeen || 'unknown'}`)
    }
    if (offlineTotal > offlineList.length) {
      lines.push(`  … and ${offlineTotal - offlineList.length} more offline (open Store Monitor for full list)`)
    }
  } else if (s.offline === 0) {
    lines.push('', groupFilter ? `No stores offline in ${groupFilter} in the current snapshot.` : 'No stores are offline in the current live snapshot.')
  } else if (!wantsList) {
    lines.push('', groupFilter
      ? `Tip: ask "list offline ${groupFilter} hostnames" for stores in this group.`
      : 'Tip: ask "list offline store hostnames" for the full offline list.')
  }

  const sp = portalContext.modules?.storeProblems
  if (sp?.activeProblemCount != null && !groupFilter) {
    lines.push(
      '',
      `Problem tracker (PERIODIC — ~${sp.snapshotIntervalMinutes || 2} min job): ${sp.activeProblemCount} active tracked problems`,
    )
  }

  lines.push('', '(Live Store Monitor data — SocMon InfluxDB snapshot.)')
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
    if (sm.groupSummaries) {
      preview.storeGroups = Object.fromEntries(
        Object.entries(sm.groupSummaries).map(([name, g]) => [name, {
          total: g.total,
          online: g.online,
          offline: g.offline,
          withIssues: g.withIssues,
        }]),
      )
    }
    if (sm.groupConnectivityStats) {
      preview.storeGroupConnectivity = Object.fromEntries(
        Object.entries(sm.groupConnectivityStats).map(([name, g]) => [name, {
          total: g.total,
          wifiConnected: g.wifiConnected,
          wifiHealthy: g.wifiHealthy,
          lanHealthy: g.lanHealthy,
          ethernetConnected: g.ethernetConnected,
        }]),
      )
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
