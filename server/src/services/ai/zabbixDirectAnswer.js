import { createZabbixClient } from '../../services/zabbix.js'
import { fetchAllMonitoredHosts, ZABBIX_HOST_FETCH_MAX } from '../../services/zabbixHostFetch.js'
import { buildStoreDisconnectMcpContext } from '../../services/storeDisconnectEvents.js'
import { buildStoreCrashMcpContext } from '../../services/storeCrashEvents.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'
import { isInfluxStoreConfigured, fetchStoreSnapshot, buildOverviewSummary } from '../influxStore.js'
import { extractStoreCode, extractStoreHostname, formatQueryWindowMeta, hasQueryHistoryWindow, isStoreHostnamePortalQuery, resolveQueryWindow, shouldUseStoreCodeAlias } from './queryContext.js'
import { isSocReportQuery } from './socDirectAnswer.js'
import { isXdrQuestion } from './xdrDirectAnswer.js'
import { isGeoConnectionQuery } from './geoConnectionQuery.js'
import { wantsDeepInfraFetch } from './directLlmSynthesis.js'

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/
const IPV4_RE_G = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g

const INFRA_HOST_STOP = /^(zabbix|infra|overview|detail|detailed|status|server|host|device|monitor|check|give|from|there|this|that|same|available|need|complete|analysis)$/i

export function extractIpv4(text) {
  const m = String(text || '').match(IPV4_RE)
  return m ? m[0] : null
}

/** Zabbix infra host name (e.g. ASRS_BACKUP_DB) from natural language. */
export function extractInfraHostName(text) {
  const t = String(text || '')
  const patterns = [
    /\b(?:details?\s+(?:on|of|for)|about|overview\s+(?:of|for)|report\s+(?:on|for|of)|check\s+(?:on|for))\s+([A-Za-z][A-Za-z0-9_.-]{3,})\b/i,
    /\b(?:host|server|database|db)\s+([A-Z][A-Z0-9_]{2,})\b/i,
    /\b([A-Z][A-Z0-9_]{2,})\b/,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    const name = m?.[1]
    if (name && !INFRA_HOST_STOP.test(name)) return name
  }
  return null
}

/** Infra host from prior chat (user question, Host filter line, or failed lookup). */
export function extractInfraHostFromThread(text) {
  const t = String(text || '')
  const hostFilter = t.match(/\bHost filter:\s*(\S+)/i)
  if (hostFilter?.[1] && hostFilter[1] !== 'true' && !IPV4_RE.test(hostFilter[1])) {
    return hostFilter[1]
  }
  const noMatch = t.match(/No monitored host matched "([^"]+)"/i)
  if (noMatch) return noMatch[1]
  const deviceAnalysis = t.match(/\bdevice analysis\s*—\s*(\S+)/i)
  if (deviceAnalysis?.[1] && !IPV4_RE.test(deviceAnalysis[1])) return deviceAnalysis[1]
  return extractInfraHostName(t)
}

/** Most relevant IP from prior chat (Host filter line, device analysis title, or last IP). */
export function extractIpv4FromThread(text) {
  const t = String(text || '')
  const hostFilter = t.match(/\bHost filter:\s*((?:\d{1,3}\.){3}\d{1,3})\b/i)
  if (hostFilter) return hostFilter[1]
  const utilTitle = t.match(/\b(?:Memory|CPU)\s+utilization\s*—\s*((?:\d{1,3}\.){3}\d{1,3})\b/i)
  if (utilTitle) return utilTitle[1]
  const utilTitleBoth = t.match(/\bCPU \/ memory utilization\s*—\s*((?:\d{1,3}\.){3}\d{1,3})\b/i)
  if (utilTitleBoth) return utilTitleBoth[1]
  const analysis = t.match(/\bdevice analysis\s*—\s*((?:\d{1,3}\.){3}\d{1,3})\b/i)
  if (analysis) return analysis[1]
  const iface = t.match(/\bInterface IPs:\s*((?:\d{1,3}\.){3}\d{1,3})\b/i)
  if (iface) return iface[1]
  const ips = t.match(IPV4_RE_G) || []
  return ips.length ? ips[ips.length - 1] : null
}

/** FortiGate / network host name from a prior Zabbix assistant reply. */
export function extractZabbixHostFromThread(text) {
  const t = String(text || '')
  let m = t.match(/•\s*([\w][\w.-]*)\s*\[(?:fortigate|cisco|juniper|checkpoint|network)\]/i)
  if (m) return m[1]
  m = t.match(/Host details:[\s\S]*?•\s*([\w][\w.-]*)\s*\[/i)
  if (m) return m[1]
  m = t.match(/Sample hosts[\s\S]*?•\s*([\w][\w.-]*)\s*\[/i)
  if (m) return m[1]
  return null
}

/** Resolve IP or Zabbix host for follow-ups ("same device", "explain VPN", etc.). */
export function resolveInfraHostFilter(question, ctx = null) {
  const q = String(question || '')
  if (ctx?.subjectChanged) {
    return {
      ip: extractIpv4(q) || null,
      host: extractInfraHostName(q) || null,
    }
  }
  const inheritZabbixThread = ctx?.isFollowUp
    || (ctx?.priorTopic === 'zabbix' && wantsCpuMemoryUtil(q))
  const ip = extractIpv4(q)
    || ctx?.ip
    || (inheritZabbixThread ? extractIpv4FromThread(ctx?.threadText) : null)
    || (inheritZabbixThread ? extractIpv4FromThread(ctx?.priorAssistant) : null)
    || (inheritZabbixThread ? extractIpv4FromThread(ctx?.priorUser) : null)

  let host = extractInfraHostName(q)
    || extractZabbixHostFromThread(q)
  if (!host && inheritZabbixThread) {
    host = ctx?.infraHost
      || ctx?.zabbixHost
      || extractInfraHostFromThread(ctx?.priorUser)
      || extractInfraHostFromThread(ctx?.threadText)
      || extractInfraHostFromThread(ctx?.priorAssistant)
      || extractZabbixHostFromThread(ctx?.priorAssistant)
      || extractZabbixHostFromThread(ctx?.threadText)
      || extractZabbixHostFromThread(ctx?.priorUser)
  }

  const wantsHostFromCtx = inheritZabbixThread && host && (
    /\b(same|this|that|it|there|device|host|firewall|fortigate|vpn|tunnel|problem|issue|explain|why|what|how|more|status|bandwidth|ping|interface|zabbix|available|overview|detailed|check)\b/i.test(q)
    || /\b(available in zabbix|from zabbix|in zabbix)\b/i.test(q)
  )

  return {
    ip: ip || null,
    host: wantsHostFromCtx ? host : (ip ? null : host || null),
  }
}

const SEV_LABEL = { 0: 'Not classified', 1: 'Info', 2: 'Warning', 3: 'Average', 4: 'High', 5: 'Disaster' }

const ZABBIX_MARKERS = /\b(zabbix|infra mon\w+|infra summar\w+|monitored hosts?|host availability)\b/i
const NETWORK_MARKERS = /\b(network devices?|network device|servers? status|server status|servers? down|network status|infra hosts?)\b/i

export function isInfraMonitorQuery(question) {
  return /\b(infra mon\w+|infra summar\w+)\b/i.test(String(question || ''))
}

const SWITCH_WORD = /\b(switch(?:es)?|all switches)\b/i
const ROUTER_WORD = /\b(router(?:s)?)\b/i

/** Pull host group name from prior chat text (assistant or user). */
export function extractHostGroupFromThread(text) {
  const t = String(text || '')
  const patterns = [
    /\bHost group:\s*([\w.-]+)/i,
    /\bhost group[:\s]+([\w.-]+)/i,
    /\b(?:of|for|from)\s+([\w.-]+)\s+group\b/i,
    /\b([\w][\w.-]*)\s+group\b/i,
    /\b(lenskart-[\w-]+)\b/i,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    const name = m?.[1]
    if (name && isValidHostGroupName(name)) return name
  }
  return null
}

const GROUP_NAME_STOP = /^(this|that|the|why|only|given|with|in|a|an|how|many|server|servers|host|hosts)$/i

/** Product/context words — not Zabbix host group names (e.g. "alerts in zabbix"). */
const HOST_GROUP_META_STOP = /^(zabbix|infra|monitoring|monitor|netpulse|socmon|alert|alerts|problem|problems|trigger|triggers|right|now|currently|active|the|this|that|store|sentinel|immediately|today)$/i

function isValidHostGroupName(name) {
  const n = String(name || '').trim()
  if (!n) return false
  if (IPV4_RE.test(n)) return false
  if (GROUP_NAME_STOP.test(n)) return false
  if (HOST_GROUP_META_STOP.test(n)) return false
  return true
}

/** Current Zabbix triggers/problems — not a host-group membership query. */
export function wantsZabbixAlertsQuery(question) {
  const q = String(question || '')
  if (!/\b(alert|alerts|trigger|triggers|problem|problems)\b/i.test(q)) return false
  return ZABBIX_MARKERS.test(q)
    || /\b(infra mon|infra monitoring|infra zabbix)\b/i.test(q)
    || (/\b(right now|currently|active|now)\b/i.test(q) && /\bzabbix\b/i.test(q))
}

function hasExplicitHostGroupInQuestion(question) {
  const q = String(question || '')
  return /\b(?:host\s*group|hostgroup)\s+[\w.-]+/i.test(q)
    || /\b[\w][\w.-]*-[\w.-]+\s+group\b/i.test(q)
    || /\b(?:of|for|from)\s+[\w.-]+\s+group\b/i.test(q)
}

/** Zabbix host group name from natural language, e.g. lenskart-database. */
export function extractHostGroupFilter(question, ctx = null) {
  const q = String(question || '')

  // Follow-up first: "this group", "in this group", "why only 3 in this group"
  if (ctx?.isFollowUp && (/\b(this|that)\s+group\b/i.test(q) || /\bin\s+this\s+group\b/i.test(q) || (/\bgroup\b/i.test(q) && /\b(why|only|\d+)\b/i.test(q)))) {
    const fromThread = extractHostGroupFromThread(ctx?.threadText)
      || extractHostGroupFromThread(ctx?.priorAssistant)
      || extractHostGroupFromThread(ctx?.priorUser)
    if (fromThread) return fromThread
    if (ctx?.hostGroup) return ctx.hostGroup
  }

  // "report of lenskart-database group", "disk usage for lenskart-database group"
  let m = q.match(/\b(?:of|for|from)\s+(["']?)([\w.-]+)\1\s+group\b/i)
  if (m && isValidHostGroupName(m[2])) return m[2]

  // "lenskart-database group" (name before the word group)
  m = q.match(/\b([\w][\w.-]*)\s+group\b/i)
  if (m && isValidHostGroupName(m[1])) return m[1]

  m = q.match(/\b(?:belong(?:s|ing)?\s+to|belonging\s+to|member\s+of)\s+(?:the\s+)?(?:host\s*group\s+|group\s+)?([A-Za-z0-9][\w.-]*)\b/i)
  if (m && isValidHostGroupName(m[1])) return m[1]

  // "in lenskart-database" — skip "in zabbix" / "in infra" (product context, not a group)
  m = q.match(/\bin\s+(?:the\s+)?(?:host\s*group\s+|group\s+)?([A-Za-z0-9][\w.-]+)\b/i)
  if (m && isValidHostGroupName(m[1])) return m[1]

  m = q.match(/\b(?:host\s*group|hostgroup|group)\s+(["']?)([\w.-]+)\1\b/i)
  if (m && isValidHostGroupName(m[2])) return m[2]

  m = q.match(/\b(?:servers?|hosts?)\s+(?:in|from|of)\s+(["']?)([\w.-]+)\1\b/i)
  if (m && isValidHostGroupName(m[2])) return m[2]

  if (/\b(this|that)\s+group\b/i.test(q) || /\bin\s+this\s+group\b/i.test(q)) {
    const fromThread = extractHostGroupFromThread(ctx?.threadText)
      || extractHostGroupFromThread(ctx?.priorAssistant)
      || extractHostGroupFromThread(ctx?.priorUser)
    if (fromThread) return fromThread
  }

  if (ctx?.hostGroup) return ctx.hostGroup
  return null
}

export function wantsDiskUsage(question) {
  const q = String(question || '')
  return /\b(disk|filesystem|fs|storage|space)\b/i.test(q)
    && /\b(usage|utilization|utilisation|util|report|used|free|capacity|full)\b/i.test(q)
}

/** Host CPU / RAM % from Zabbix — not interface bandwidth. */
export function wantsCpuMemoryUtil(question) {
  const q = String(question || '')
  if (!/\b(cpu|memory|mem|ram)\b/i.test(q)) return false
  if (/\b(bandwidth|traffic|throughput|interface|net\.if|bits\s*received|bits\s*sent)\b/i.test(q)) return false
  return /\b(utilization|utilisation|usage|used|load|percent|performance|\%)\b/i.test(q)
    || Boolean(extractIpv4(q))
}

/** Zabbix history/trend time-series for CPU/RAM graphs. */
export function wantsCpuMemoryHistory(question) {
  const q = String(question || '')
  const hasMetric = /\b(cpu|memory|mem|ram)\b/i.test(q)
    || Boolean(extractStoreHostname(q) || extractIpv4(q))
    || parseHistoryItemIds(q).length > 0
  if (!hasMetric) return false
  const hasTrendKw = /\b(graph|graphical|chart|visual|plot|timeline|trend|history|time\s*series)\b/i.test(q)
  const hasRangeKw = /\b(?:last|past|previous)\s+\d+\s*(?:d|day|days|h|hr|hrs|hour|hours)\b/i.test(q)
    || /\b\d+\s*(?:d|day|days|h|hr|hrs|hour|hours)\b/i.test(q)
    || /\b(30d|14d|7d|5d|2d|24h|12h|6h|3h|1h)\b/i.test(q)
  const hasDateKw = /\b\d{4}-\d{2}-\d{2}\b/.test(q)
    || /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(q)
    || /\b(?:from|to|between|time_from|time_to|start|end)\b/i.test(q) && /\b\d{10}\b/.test(q)
    || /\b(?:whole\s+day|entire\s+day|full\s+day)\b/i.test(q)
    || /\bitem\s*#?\s*\d{4,}\b/i.test(q)
    || /\b\d{1,2}:\d{2}\b/.test(q)
  return hasTrendKw || hasRangeKw || hasDateKw
}

/** Auto-fetch CPU/RAM history when MCP/queryContext supplies an absolute window. */
function shouldIncludeCpuMemoryHistory(question, opts = {}) {
  if (wantsCpuMemoryHistory(question)) return true
  const w = opts.queryWindow || resolveQueryWindow(question, opts.queryContext, opts)
  if (!hasQueryHistoryWindow(w)) return false
  const q = String(question || '')
  if (/\b(cpu|memory|mem|ram|utilization|utilisation)\b/i.test(q)) return true
  if (parseHistoryItemIds(q).length > 0) return true
  const hostScoped = Boolean(extractStoreHostname(q) || extractIpv4(q))
  return hostScoped && w.toSec < Math.floor(Date.now() / 1000) - 3600
}

/** Auto-fetch interface history when an absolute window is set and traffic is in scope. */
function shouldIncludeInterfaceHistory(question, opts = {}) {
  if (wantsInterfaceHistory(question)) return true
  const w = opts.queryWindow || resolveQueryWindow(question, opts.queryContext, opts)
  if (!hasQueryHistoryWindow(w)) return false
  const q = String(question || '')
  return /\b(interface|interfaces|bandwidth|throughput|traffic|net\.if|ports?)\b/i.test(q)
    || wantsBandwidthUtil(q)
}

function isPastHistoricalWindow(window) {
  return Boolean(window?.to && window.to < Math.floor(Date.now() / 1000) - 3600)
}

function enrichCpuMemoryHistoryWithSessionSnapshot(history, window) {
  if (!history || !window) return history
  const targetSec = window.requestedAtSec ?? Math.floor((window.from + window.to) / 2)
  for (const h of history.hosts || []) {
    h.sessionSnapshot = {
      targetSec,
      targetAt: formatPortalTimestamp(targetSec * 1000),
      cpu: h.cpu?.points?.length ? nearestHistoryPoint(h.cpu.points, targetSec) : null,
      memory: h.memory?.points?.length ? nearestHistoryPoint(h.memory.points, targetSec) : null,
    }
  }
  const anyPoints = (history.hosts || []).some(
    (h) => h.cpu?.points?.length || h.memory?.points?.length,
  )
  if (!anyPoints && !history.error) {
    history.emptyReason = 'No Zabbix history/trend points in window — check retention or item polling interval.'
  }
  history.note = [
    history.note,
    'sessionSnapshot = nearest CPU/RAM point to window center; prefer cpuAtSession/memoryAtSession or sessionSnapshot over hosts[].cpu for past sessions.',
  ].filter(Boolean).join(' ')
  return history
}

function applySessionCpuMemoryToHosts(hosts, cpuMemoryHistory) {
  if (!Array.isArray(hosts) || !cpuMemoryHistory?.hosts?.length) return
  const snapByHost = Object.fromEntries(
    cpuMemoryHistory.hosts.map((h) => [String(h.hostid), h.sessionSnapshot]),
  )
  for (const host of hosts) {
    const snap = snapByHost[String(host.hostid)]
    if (!snap) continue
    if (snap.cpu?.percent != null) {
      host.cpuAtSession = {
        percent: snap.cpu.percent,
        at: snap.cpu.at,
        deltaSec: snap.cpu.deltaSec,
        source: 'zabbix_history',
      }
    }
    if (snap.memory?.percent != null) {
      host.memoryAtSession = {
        percent: snap.memory.percent,
        at: snap.memory.at,
        deltaSec: snap.memory.deltaSec,
        source: 'zabbix_history',
      }
    }
  }
}

/** Zabbix net.if.in/out time-series (same window rules as cpuMemoryHistory). */
export function wantsInterfaceHistory(question) {
  const q = String(question || '')
  const hasIface = /\b(interface|interfaces|bandwidth|throughput|traffic|net\.if|ports?)\b/i.test(q)
    || wantsBandwidthUtil(q)
  if (!hasIface) return false
  const hasTrendKw = /\b(graph|graphical|chart|visual|plot|timeline|trend|history|time\s*series)\b/i.test(q)
  const hasRangeKw = /\b(?:last|past|previous)\s+\d+\s*(?:d|day|days|h|hr|hrs|hour|hours)\b/i.test(q)
    || /\b\d+\s*(?:d|day|days|h|hr|hrs|hour|hours)\b/i.test(q)
    || /\b(30d|14d|7d|5d|2d|24h|12h|6h|3h|1h)\b/i.test(q)
  const hasDateKw = /\b\d{4}-\d{2}-\d{2}\b/.test(q)
    || /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(q)
    || (/\b(?:from|to|between|time_from|time_to|start|end)\b/i.test(q) && /\b\d{10}\b/.test(q))
    || /\b(?:whole\s+day|entire\s+day|full\s+day)\b/i.test(q)
    || /\bitem\s*#?\s*\d{4,}\b/i.test(q)
    || /\b\d{1,2}:\d{2}\b/.test(q)
  return hasTrendKw || hasRangeKw || hasDateKw
}

const ZABBIX_INTERFACE_HISTORY_MAX_PORTS = Math.min(
  Math.max(parseInt(process.env.ZABBIX_INTERFACE_HISTORY_MAX_PORTS || '8', 10) || 8, 1),
  20,
)

/** 0 = no cap (default). Set ZABBIX_CONTEXT_HISTORY_MAX_SEC to limit span in seconds. */
const ZABBIX_HISTORY_MAX_SEC = parseInt(process.env.ZABBIX_CONTEXT_HISTORY_MAX_SEC || '0', 10) || 0

const PORTAL_TZ_OFFSET = process.env.PORTAL_TZ_OFFSET || '+05:30'

function pad2(n) {
  return String(n).padStart(2, '0')
}

function monthIndex(name) {
  const m = String(name || '').toLowerCase().slice(0, 3)
  const map = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
  return map[m] || null
}

function istUnix(year, month, day, hour = 0, min = 0, sec = 0) {
  const iso = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(min)}:${pad2(sec)}${PORTAL_TZ_OFFSET}`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function parseEpochSec(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function formatHistoryWindowLabel(from, to) {
  const span = to - from
  if (span >= 86400 && span % 86400 < 7200) return `${Math.round(span / 86400)}d`
  if (span >= 3600) return `${Math.round(span / 3600)}h`
  return `${Math.max(1, Math.round(span / 60))}m`
}

function buildHistoryWindowResult(from, to, parseNote) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null
  let clampedFrom = from
  const span = to - from
  if (ZABBIX_HISTORY_MAX_SEC > 0 && span > ZABBIX_HISTORY_MAX_SEC) {
    clampedFrom = to - ZABBIX_HISTORY_MAX_SEC
  }
  const rangeSec = to - clampedFrom
  return {
    from: clampedFrom,
    to,
    rangeSec,
    windowLabel: formatHistoryWindowLabel(clampedFrom, to),
    parseNote,
  }
}

function extractCalendarParts(q) {
  let m = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (m) return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }
  m = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s-]+(\d{4})\b/i)
  if (m) {
    const mo = monthIndex(m[2])
    if (mo) return { y: Number(m[3]), mo, d: Number(m[1]) }
  }
  return null
}

function parseExplicitUnixWindow(raw) {
  const q = String(raw || '')
  const fromMatch = q.match(/\b(?:from|time_from|start|since)\s*[=:]?\s*(\d{10})\b/i)
  const toMatch = q.match(/\b(?:to|time_to|end|until)\s*[=:]?\s*(\d{10})\b/i)
  if (fromMatch && toMatch) {
    return buildHistoryWindowResult(Number(fromMatch[1]), Number(toMatch[1]), 'explicit unix from/to in question')
  }
  const stamps = [...q.matchAll(/\b(1\d{9})\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 1_500_000_000 && n < 2_100_000_000)
  if (stamps.length >= 2) {
    const from = Math.min(stamps[0], stamps[1])
    const to = Math.max(stamps[0], stamps[1])
    return buildHistoryWindowResult(from, to, 'paired unix timestamps in question')
  }
  return null
}

function parseCalendarDateWindow(raw) {
  const q = String(raw || '').toLowerCase()
  const parts = extractCalendarParts(q)
  if (!parts) return null

  const timeRange = q.match(/\b(\d{1,2}):(\d{2})\s*(?:-|–|to)\s*(\d{1,2}):(\d{2})\b/)
  if (timeRange) {
    const from = istUnix(parts.y, parts.mo, parts.d, Number(timeRange[1]), Number(timeRange[2]))
    const to = istUnix(parts.y, parts.mo, parts.d, Number(timeRange[3]), Number(timeRange[4]), 59)
    return buildHistoryWindowResult(from, to, `calendar date ${parts.y}-${pad2(parts.mo)}-${pad2(parts.d)} + time range (IST)`)
  }

  const timePoint = q.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\b/)
  if (timePoint && !/\blast\s+\d+\s*(?:d|day|h|hour)/.test(q)) {
    const center = istUnix(
      parts.y, parts.mo, parts.d,
      Number(timePoint[1]), Number(timePoint[2]), Number(timePoint[3] || 0),
    )
    if (center) {
      return buildHistoryWindowResult(center - 900, center + 900, `±15m around ${timePoint[1]}:${timePoint[2]} on ${parts.y}-${pad2(parts.mo)}-${pad2(parts.d)} (IST)`)
    }
  }

  const from = istUnix(parts.y, parts.mo, parts.d, 0, 0, 0)
  const to = istUnix(parts.y, parts.mo, parts.d, 23, 59, 59)
  const note = /\b(whole\s+day|entire\s+day|full\s+day)\b/.test(q)
    ? `whole day ${parts.y}-${pad2(parts.mo)}-${pad2(parts.d)} (IST)`
    : `calendar date ${parts.y}-${pad2(parts.mo)}-${pad2(parts.d)} (IST full day)`
  return buildHistoryWindowResult(from, to, note)
}

function clampHistoryRangeSec(sec) {
  const n = Math.max(Math.floor(sec), 3600)
  if (ZABBIX_HISTORY_MAX_SEC <= 0) return n
  return Math.min(n, ZABBIX_HISTORY_MAX_SEC)
}

function relativeRangeToSec(range) {
  const m = String(range || '-24h').match(/^-(\d+)(m|h|d)$/)
  if (!m) return 86400
  const n = Number(m[1])
  if (m[2] === 'm') return clampHistoryRangeSec(n * 60)
  if (m[2] === 'h') return clampHistoryRangeSec(n * 3600)
  return clampHistoryRangeSec(n * 86400)
}

/** Parse CPU/RAM history window from natural language (default 24h ending now, max 30d). */
function parseZabbixHistoryRangeSec(message) {
  const q = String(message || '').toLowerCase()

  let m = q.match(/\b(?:last|past|previous)\s+(\d+)\s*(?:d|day|days)\b/)
  if (m) return clampHistoryRangeSec(Number(m[1]) * 86400)
  m = q.match(/\b(\d+)\s*(?:d|day|days)\b/)
  if (m) return clampHistoryRangeSec(Number(m[1]) * 86400)

  m = q.match(/\b(?:last|past|previous)\s+(\d+)\s*(?:h|hr|hrs|hour|hours)\b/)
  if (m) return clampHistoryRangeSec(Number(m[1]) * 3600)
  m = q.match(/\b(\d+)\s*(?:h|hr|hrs|hour|hours)\b/)
  if (m) return clampHistoryRangeSec(Number(m[1]) * 3600)

  if (/\b(30\s*d|30d|last\s+30\s*days?)\b/.test(q)) return 30 * 86400
  if (/\b(14\s*d|14d|last\s+14\s*days?|two\s+weeks?|fortnight)\b/.test(q)) return 14 * 86400
  if (/\b(7\s*d|7d|last\s+week|one\s+week|past\s+week)\b/.test(q)) return 7 * 86400
  if (/\b(5\s*d|5d|last\s+5\s*days?|five\s+days?)\b/.test(q)) return 5 * 86400
  if (/\b(2\s*d|2d|last\s+2\s*days?)\b/.test(q)) return 2 * 86400
  if (/\b(12\s*h|12h)\b/.test(q)) return 12 * 3600
  if (/\b(6\s*h|6h)\b/.test(q)) return 6 * 3600
  if (/\b(3\s*h|3h)\b/.test(q)) return 3 * 3600
  if (/\b(1\s*h|1h)\b/.test(q)) return 3600
  if (/\b(24\s*h|24h|last\s+24|last\s+day|past\s+day)\b/.test(q)) return 86400
  return 86400
}

/** Absolute or relative Zabbix history window for CPU/RAM / interface series. */
function parseZabbixHistoryWindow(message, opts = {}) {
  const w = opts.queryWindow || resolveQueryWindow(message, opts.queryContext, opts)
  if (w.fromSec && w.toSec) {
    const built = buildHistoryWindowResult(w.fromSec, w.toSec, w.parseNote)
    if (built) return built
  }
  const now = Math.floor(Date.now() / 1000)
  const rangeSec = parseZabbixHistoryRangeSec(message) || relativeRangeToSec(w.range)
  return {
    from: now - rangeSec,
    to: now,
    rangeSec,
    windowLabel: w.label || formatHistoryWindowLabel(now - rangeSec, now),
    parseNote: w.parseNote || 'relative window ending now',
  }
}

function parseHistoryItemIds(message) {
  const ids = new Set()
  const q = String(message || '')
  for (const m of q.matchAll(/\bitem\s*#?\s*(\d{4,})\b/gi)) ids.add(String(m[1]))
  for (const m of q.matchAll(/\b(?:cpu|memory|mem|ram)\s+item\s+(\d{4,})\b/gi)) ids.add(String(m[1]))
  return [...ids]
}

function nearestHistoryPoint(points, targetSec) {
  if (!Array.isArray(points) || !points.length || !Number.isFinite(targetSec)) return null
  let best = points[0]
  let bestDelta = Math.abs(best.clock - targetSec)
  for (const p of points) {
    const d = Math.abs(p.clock - targetSec)
    if (d < bestDelta) {
      best = p
      bestDelta = d
    }
  }
  return {
    clock: best.clock,
    at: best.at,
    percent: best.percent,
    deltaSec: bestDelta,
  }
}

function historyMaxPointsForRange(rangeSec) {
  const cap = Math.min(
    Math.max(parseInt(process.env.ZABBIX_CONTEXT_HISTORY_MAX_POINTS || '240', 10) || 240, 60),
    500,
  )
  if (rangeSec <= 86400) return Math.min(120, cap)
  if (rangeSec <= 7 * 86400) return Math.min(168, cap)
  return cap
}

/** Which resource metrics the user asked for (memory-only, cpu-only, or both). */
export function resolveCpuMemoryScope(question) {
  const q = String(question || '').toLowerCase()
  const wantsCpu = /\bcpu\b/.test(q)
  const wantsMemory = /\b(memory|mem|ram)\b/.test(q)
  if (wantsCpu && wantsMemory) return { wantsCpu: true, wantsMemory: true }
  if (wantsMemory) return { wantsCpu: false, wantsMemory: true }
  if (wantsCpu) return { wantsCpu: true, wantsMemory: false }
  return { wantsCpu: true, wantsMemory: true }
}

export function wantsHostGroupCheck(question) {
  const q = String(question || '')
  if (/\b(belong(?:s|ing)?\s+to|belonging\s+to|member\s+of|in\s+(?:the\s+)?group|host\s*group)\b/i.test(q)) {
    return true
  }
  const ip = extractIpv4(q)
  const hg = extractHostGroupFilter(q)
  return Boolean(ip && hg && hg !== ip && !IPV4_RE.test(hg))
}

/** fortigate | cisco | checkpoint | network | switch | server | vm | database */
export function detectDeviceTypeFilter(question, ctx = null) {
  const q = String(question || '')
  // Host group names like lenskart-database are not device-type filters.
  if (extractHostGroupFilter(q, ctx)) return null
  if (/\b(fortinet|fortigate|fgt)\b/i.test(q)) return 'fortigate'
  if (SWITCH_WORD.test(q)) return 'switch'
  if (/\b(cisco|catalyst|nexus|meraki)\b/i.test(q)) return 'cisco'
  if (ROUTER_WORD.test(q)) return 'cisco'
  if (/\b(servers?|all servers?|server health|server availability)\b/i.test(q)) return 'server'
  if (/\b(virtual machines?|vms?)\b/i.test(q)) return 'vm'
  // "lenskart-database" is a group name — not device type database
  if (/\b(?:db servers?|mssql servers?)\b/i.test(q)) return 'database'
  if (/\bdatabases?\b/i.test(q) && !/[\w-]-database\b/i.test(q)) return 'database'
  if (/\b(checkpoint|check point)\b/i.test(q)) return 'checkpoint'
  if (/\b(juniper)\b/i.test(q)) return 'juniper'
  return null
}

/** Device availability in Infra Zabbix — not SOC log/traffic queries. */
export function isInfraDeviceStatusQuery(question) {
  const q = String(question || '')
  const deviceType = detectDeviceTypeFilter(q)
  if (/\b(deny|denied|denies|connections?|sessions?|traffic|blocked|login fail|ips event|utm event|soc log)\b/i.test(q)) return false
  if (/\b(store monitor|offline stores?|influx)\b/i.test(q)) return false
  if (deviceType && /\b(status|health|up|down|available|summary|summ\w*|monitor|problem|issue|give me|show|list|all|report)\b/i.test(q)) return true
  if (wantsDiskUsage(q)) return true
  if (/\b(fortinet|fortigate)\s+firewall\b/i.test(q)) return true
  if (/\b(cisco|network devices?|switch(?:es)?|router(?:s)?|firewall device)\b/i.test(q) && /\b(status|health|summary|summ\w*|monitor|all)\b/i.test(q)) return true
  if (/\b(ping|icmp|latency|packet\s*loss|response\s*time|sensor)\b/i.test(q) && (deviceType || SWITCH_WORD.test(q) || ROUTER_WORD.test(q) || /\b(network devices?)\b/i.test(q))) return true
  return false
}

export function isIpInfraQuery(question) {
  const q = String(question || '')
  if (!extractIpv4(q)) return false
  if (/\b(firewall|fortigate|deny|denied|blocked|soc log|log search)\b/i.test(q)) return false
  if (/\b(store monitor|offline stores?|how many stores|store tag|influx)\b/i.test(q)) return false
  return true
}

/** Detect clarification / definition phrases that should never route to live data.
 *  e.g. "details means all the resource details", "by details I mean ...", "I meant ..." */
function isClarificationPhrase(q) {
  const t = String(q || '')
  if (/\b\w+\s+means?\b/i.test(t)) return true
  if (/\bby\s+\w+\s+I\s+mean\b/i.test(t)) return true
  if (/\bI\s+mean(t|)\b/i.test(t)) return true
  if (/\bwhat\s+I\s+(mean|meant|said)\b/i.test(t)) return true
  return false
}

export function isZabbixQuestion(question, ctx = null) {
  const q = String(question || '')
  // XDR / geo hunts must never route to Infra Zabbix (even if prior chat mentions an IP).
  if (isXdrQuestion(q) || isGeoConnectionQuery(q)) return false
  if (/\bxdr\b/i.test(q) && /\b(sentinel|connection|connec|china|country|device|endpoint)\b/i.test(q)) return false
  if (isStoreHostnamePortalQuery(q) && !extractIpv4(q)) return false
  if (isSocReportQuery(q)) return false
  if (isClarificationPhrase(q)) return false
  if (wantsZabbixAlertsQuery(q)) return true
  if (wantsCpuMemoryUtil(q) && extractIpv4(q)) return true
  if (ctx?.priorTopic === 'zabbix' && wantsCpuMemoryUtil(q)) {
    const threadIp = ctx?.ip
      || extractIpv4FromThread(ctx?.threadText)
      || extractIpv4FromThread(ctx?.priorAssistant)
      || extractIpv4FromThread(ctx?.priorUser)
    if (threadIp) return true
  }
  if (wantsDiskUsage(q) && (extractHostGroupFilter(q, ctx) || /\b(server|servers|zabbix|infra|host|group)\b/i.test(q))) return true
  if (wantsHostGroupCheck(q) && extractIpv4(q)) return true
  if (wantsBandwidthUtil(q, ctx) && extractHostGroupFilter(q, ctx)) return true
  if (extractHostGroupFilter(q, ctx) && wantsDiskUsage(q)) return true
  if (extractHostGroupFilter(q, ctx) && /\b(server|servers|host)\b/i.test(q) && !/\b(bandwidth|soc|firewall)\b/i.test(q)) return true
  if (ctx?.isFollowUp && ctx?.priorTopic === 'zabbix' && !isSocReportQuery(q) && !ctx?.subjectChanged) {
    if (extractStoreHostname(q) && !extractIpv4(q)) return false
    if (/\b(group|why|only|server|disk|this|that|\d+|bandwidth|same|device|firewall|fortigate|vpn|tunnel|problem|issue|explain|what|how|more|ping|interface|analysis|recommend)\b/i.test(q)) {
      return true
    }
    if ((ctx?.ip || ctx?.zabbixHost || ctx?.infraHost) && /\b(same|this|that|it|those|above|device|host|firewall|tunnel|vpn|more|also|why|how)\b/i.test(q)) {
      return true
    }
  }
  return ZABBIX_MARKERS.test(q)
    || isIpInfraQuery(q)
    || isInfraDeviceStatusQuery(q)
    || (NETWORK_MARKERS.test(q) && !/\b(store monitor|influx|offline stores)\b/i.test(q))
}

export function isNetworkInfraQuery(question) {
  const q = String(question || '')
  return NETWORK_MARKERS.test(q) || ZABBIX_MARKERS.test(q) || isIpInfraQuery(q) || isInfraDeviceStatusQuery(q)
}

function wantsStoreZabbix(question) {
  return /\b(store zabbix|store hosts?|store server|pos server|retail server)\b/i.test(String(question || ''))
}

function hostMatchesSearch(h, search) {
  const s = String(search || '').trim()
  if (!s) return true
  const low = s.toLowerCase()
  if (String(h.name || '').toLowerCase().includes(low) || String(h.host || '').toLowerCase().includes(low)) {
    return true
  }
  // Alias matching: LKST973 / LK973 should match RP973-* hosts in Zabbix.
  // Keep RP full-host searches strict by applying alias only for LK/LKST input.
  const queryCode = shouldUseStoreCodeAlias(s) ? extractStoreCode(s) : null
  if (queryCode) {
    const hostCode = extractStoreCode(h.name || '') || extractStoreCode(h.host || '')
    if (hostCode && hostCode === queryCode) return true
  }
  if (IPV4_RE.test(s)) {
    return (h.interfaces || []).some(i => String(i.ip || '') === s)
  }
  return false
}

/** Match Influx store snapshot row to RP/LK/LKST hostname or tag. */
function storeRecordMatchesHostname(store, hostname) {
  const h = String(hostname || '').toLowerCase()
  const sh = String(store?.hostname || '').toLowerCase()
  const tag = String(store?.storeTag || '').toLowerCase()
  if (sh === h || sh.includes(h) || tag.includes(h) || tag.startsWith(`${h}_`)) return true
  if (!shouldUseStoreCodeAlias(hostname)) return false
  const queryCode = extractStoreCode(hostname)
  if (!queryCode) return false
  const hostCode = extractStoreCode(store?.hostname || '')
  const tagCode = extractStoreCode(store?.storeTag || '')
  return queryCode === hostCode || queryCode === tagCode
}

function formatCpuMemoryMetric(metric) {
  if (!metric) return undefined
  return {
    percent: metric.percent,
    itemName: metric.itemName,
    itemid: metric.itemid || null,
    key: metric.key || null,
    polledAt: metric.clock ? formatPortalTimestamp(Number(metric.clock) * 1000) : null,
  }
}

function ifaceLabelFromItem(it) {
  const name = String(it.name || '')
  // "Interface port1(JIO): Bits received" → "port1(JIO)"
  const m = name.match(/^Interface\s+(.+?):\s*(Bits|Inbound|Outbound|packets|errors|discards|speed|status)/i)
  if (m) return m[1].trim()
  // fallback: strip "Interface " prefix and anything after ":"
  const m2 = name.match(/^Interface\s+(.+)/)
  if (m2) return m2[1].replace(/:.*$/, '').trim().slice(0, 50)
  // derive from key_: net.if.in[ifHCInOctets.3] → index 3 only useful with a name
  return String(it.key_ || '').slice(0, 50)
}

/** Extract SNMP index suffix from a key like net.if.in[ifHCInOctets.3] → "3" */
function snmpIndexFromKey(key) {
  const m = String(key || '').match(/\[.*?\.(\d+)\]$/)
  return m ? m[1] : String(key || '')
}

async function fetchInterfaceMetrics(zabbixRpc, hostids) {
  if (!hostids.length) return { byHost: {}, indexToName: {} }
  const [inItemsAll, outItemsAll, statusItems] = await Promise.all([
    fetchItemsChunked(zabbixRpc, hostids, 'net.if.in'),
    fetchItemsChunked(zabbixRpc, hostids, 'net.if.out'),
    fetchItemsChunked(zabbixRpc, hostids, 'net.if.status'),
  ])
  // Keep only the exact traffic items (not discards/errors), identified by having a bps/octets unit or key
  const isTrafficItem = it => {
    const k = String(it.key_ || '')
    const u = String(it.units || '').toLowerCase()
    // net.if.in[ifHCInOctets.x] or net.if.in[ifInOctets.x] → traffic
    // net.if.in.discards / net.if.in.errors / net.if.in.multicast → not traffic
    return /^net\.if\.(in|out)\[/.test(k) || u === 'bps' || u === 'b/s'
  }
  const inItems = (inItemsAll || []).filter(isTrafficItem)
  const outItems = (outItemsAll || []).filter(isTrafficItem)

  // Build SNMP-index → human interface name from ALL in/out/status items (including discards, errors)
  // Their names follow the pattern "Interface port1(JIO): Inbound packets discarded"
  const indexToNameByHost = {}
  const allItemsForNames = [...(inItemsAll || []), ...(outItemsAll || []), ...(statusItems || [])]
  for (const it of allItemsForNames) {
    const hid = String(it.hostid)
    const idx = snmpIndexFromKey(it.key_)
    const rawName = String(it.name || '')
    if (!indexToNameByHost[hid]) indexToNameByHost[hid] = {}
    if (!indexToNameByHost[hid][idx] && /^Interface\s+/i.test(rawName)) {
      indexToNameByHost[hid][idx] = ifaceLabelFromItem(it)
    }
  }

  const byHost = {}
  const ensure = (hid, idx) => {
    if (!byHost[hid]) byHost[hid] = {}
    if (!byHost[hid][idx]) byHost[hid][idx] = { in: null, out: null, status: null, inPoll: null, outPoll: null }
    return byHost[hid][idx]
  }
  for (const it of inItems || []) {
    const hid = String(it.hostid)
    const idx = snmpIndexFromKey(it.key_)
    const row = ensure(hid, idx)
    const v = parseFloat(it.lastvalue)
    const clock = Number(it.lastclock) || 0
    if (Number.isFinite(v) && (row.inPoll == null || clock >= row.inPoll)) {
      row.in = v
      row.inPoll = clock
      row.inItem = {
        itemid: String(it.itemid),
        key: it.key_,
        itemName: it.name,
        units: it.units || 'bps',
        valueType: Number(it.value_type),
      }
    }
  }
  for (const it of outItems || []) {
    const hid = String(it.hostid)
    const idx = snmpIndexFromKey(it.key_)
    const row = ensure(hid, idx)
    const v = parseFloat(it.lastvalue)
    const clock = Number(it.lastclock) || 0
    if (Number.isFinite(v) && (row.outPoll == null || clock >= row.outPoll)) {
      row.out = v
      row.outPoll = clock
      row.outItem = {
        itemid: String(it.itemid),
        key: it.key_,
        itemName: it.name,
        units: it.units || 'bps',
        valueType: Number(it.value_type),
      }
    }
  }
  for (const it of statusItems || []) {
    const hid = String(it.hostid)
    const idx = snmpIndexFromKey(it.key_)
    const row = ensure(hid, idx)
    const v = parseFloat(it.lastvalue)
    if (Number.isFinite(v)) {
      row.status = v === 1 ? 'up' : v === 2 ? 'down' : String(v)
    }
  }
  return { byHost, indexToNameByHost }
}

function formatBytesPerSec(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gbps`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} Mbps`
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)} Kbps`
  return `${Math.round(v)} bps`
}

function formatBytes(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(2)} MB`
  if (v >= 1024) return `${(v / 1024).toFixed(2)} KB`
  return `${Math.round(v)} B`
}

function formatDiskLine(hostName, disk) {
  const sizePart = disk.usedBytes != null && disk.totalBytes != null
    ? ` (${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)})`
    : ''
  return `    • ${hostName} — ${disk.mount || '—'} — ${disk.percent}% used${sizePart}`
}

const DISK_KEY_RES = [
  /^vfs\.fs\.size\[.*pused/i,
  /^vfs\.fs\.dependent\.size\[.*pused/i,
  /^vfs\.fs\.size\[.*pfree/i,
  /^vfs\.fs\.dependent\.size\[.*pfree/i,
]
const DISK_INVERT_KEY_RE = /pfree/i

const CPU_KEY_RES = [
  /^system\.cpu\.util(\b|\[)/i,
  /^system\.cpu\.utilization(\b|\[)/i,
  /^perf_counter\[.*Processor.*Time/i,
  /^vmware\.vm\.cpu\.usage\.perf/i,
  /^vmware\.hv\.cpu\.usage\.perf/i,
  /^vmware\.vm\.cpu\.utilization/i,
  /^vmware\.hv\.cpu\.utilization/i,
  // FortiGate / FortiOS SNMP CPU
  /\bfgsyscpuusage\b/i,
  /\bfgcpuusage\b/i,
  // Cisco SNMP CPU (5-min average is most stable)
  /\bcpmcputotal5min(rev)?\b/i,
  /\bcpmcputotal1min(rev)?\b/i,
  // Generic SNMP HOST-RESOURCES CPU load
  /\bhrprocessorload\b/i,
  // Common shorthand keys vendors expose (e.g. "cpu_usage_pct")
  /\bcpu[_.]?usage(_pct)?\b/i,
  /\bcpu[_.]?load(_pct)?\b/i,
  /\bcpu\b.*\b(usage|utili[sz]ation|load)\b/i,
]

const MEMORY_KEY_RES = [
  /^vm\.memory\.utilization(\b|\[)/i,
  /^vm\.memory\.util(\b|\[)/i,
  /^vm\.memory\.size\[pused/i,
  /^vmware\.vm\.memory\.usage/i,
  /^vmware\.hv\.memory\.usage/i,
  /^vmware\.vm\.memory\.utilization/i,
  /^vmware\.hv\.memory\.utilization/i,
  /^vm\.memory\.size\[pavailable/i,
  // FortiGate / FortiOS SNMP memory %
  /\bfgsysmemusage\b/i,
  /\bfgmemusage\b/i,
  // Cisco memory pool used (%)
  /\bciscomemorypoolused\b/i,
  /\bcempmempoolusedpct\b/i,
  // Generic vendor shorthand keys
  /\bmem(?:ory)?[_.]?usage(_pct)?\b/i,
  /\bmem(?:ory)?[_.]?used(_pct)?\b/i,
  /\bmem(?:ory)?\b.*\b(usage|utili[sz]ation|used)\b/i,
]
const MEMORY_INVERT_KEY_RE = /pavailable|memoryfree|memfree|memavail/i

function readPctUtilItem(it, inverted = false) {
  const u = String(it.units || '').trim()
  const v = parseFloat(it.lastvalue)
  if (!Number.isFinite(v)) return null
  const keyOrName = `${String(it.key_ || '')} ${String(it.name || '')}`.toLowerCase()
  const percentLike = u === '%' || /%/.test(u)
    || /\b(percent|pct|usage|utili[sz]ation|cpu|memory|mem)\b/.test(keyOrName)
  if (!percentLike || v < 0 || v > 100) return null
  const pct = inverted ? 100 - v : v
  return Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10
}

function parseLooseNumber(raw) {
  if (raw == null || raw === '') return NaN
  const s = String(raw).trim().replace(/,/g, '')
  const n = Number(s)
  if (Number.isFinite(n)) return n
  const m = s.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/i)
  return m ? Number(m[0]) : NaN
}

function zabbixHistoryKind(valueType) {
  const v = Number(valueType)
  if (v === 0) return { history: 0, parse: (x) => Number(x), trends: true }
  if (v === 3) return { history: 3, parse: (x) => Number(x), trends: true }
  if (v === 1) return { history: 1, parse: parseLooseNumber, trends: false }
  if (v === 4) return { history: 4, parse: parseLooseNumber, trends: false }
  return null
}

function downsampleHistoryPoints(points, maxPoints) {
  if (!points?.length || points.length <= maxPoints) return points
  const out = []
  const step = points.length / maxPoints
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * step)
    const end = Math.min(points.length, Math.floor((i + 1) * step))
    const chunk = points.slice(start, end)
    if (!chunk.length) continue
    let sum = 0
    for (const p of chunk) sum += Number(p.value)
    const mid = chunk[Math.floor(chunk.length / 2)]
    out.push({ clock: mid.clock, value: sum / chunk.length })
  }
  return out
}

function trendQueryBounds(from, to) {
  const fromHour = Math.floor(Number(from) / 3600) * 3600
  const toHour = Math.ceil(Number(to) / 3600) * 3600
  return {
    from: Number.isFinite(fromHour) ? fromHour : from,
    to: Number.isFinite(toHour) && toHour > fromHour ? toHour : to,
  }
}

function formatDurationSeconds(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n < 0) return null
  const total = Math.round(n)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (days > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

async function fetchItemHistorySeries(zabbixRpc, metric, from, to, maxPoints = 120, opts = {}) {
  const valueMode = opts.valueMode === 'traffic' ? 'traffic' : 'percent'
  const itemid = String(metric?.itemid || '').trim()
  if (!itemid) return null

  let valueType = Number(metric?.valueType)
  let units = metric?.units || ''
  let itemName = metric?.itemName || metric?.key || itemid
  let key = metric?.key || ''

  if (!Number.isFinite(valueType)) {
    const metaRows = await zabbixRpc('item.get', {
      itemids: [itemid],
      output: ['itemid', 'name', 'key_', 'value_type', 'units'],
    }).catch(() => [])
    const meta = (metaRows || [])[0]
    if (!meta) return null
    valueType = Number(meta.value_type)
    units = meta.units || units
    itemName = meta.name || itemName
    key = meta.key_ || key
  }

  const hk = zabbixHistoryKind(valueType)
  if (!hk) return null

  const span = to - from
  const preferTrend = span > 2 * 86400 && hk.trends
  let points = []
  let source = null

  async function fetchTrends() {
    if (!hk.trends) return []
    const trendWindow = trendQueryBounds(from, to)
    const tr = await zabbixRpc('trend.get', {
      itemids: [itemid],
      time_from: trendWindow.from,
      time_till: trendWindow.to,
      output: ['clock', 'value_avg'],
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: 5000,
    }).catch(() => [])
    return (tr || [])
      .map((row) => ({ clock: Number(row.clock), value: Number(row.value_avg) }))
      .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
  }

  async function fetchHistory() {
    const hist = await zabbixRpc('history.get', {
      history: hk.history,
      itemids: [itemid],
      time_from: from,
      time_till: to,
      output: ['clock', 'value'],
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: 15000,
    }).catch(() => [])
    return (hist || [])
      .map((row) => ({ clock: Number(row.clock), value: hk.parse(row.value) }))
      .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
  }

  if (preferTrend) {
    points = await fetchTrends()
    if (points.length) source = 'trend'
    if (!points.length) {
      points = await fetchHistory()
      if (points.length) source = 'history'
    }
  } else {
    points = await fetchHistory()
    if (points.length) source = 'history'
    if (!points.length && hk.trends) {
      points = await fetchTrends()
      if (points.length) source = 'trend'
    }
  }

  points = downsampleHistoryPoints(points, maxPoints)
  if (!points.length) return null

  return {
    itemid,
    itemName,
    key,
    units,
    source,
    from,
    to,
    pointCount: points.length,
    points: points.map((p) => {
      const base = { clock: p.clock, at: formatPortalTimestamp(p.clock * 1000) }
      if (valueMode === 'traffic') {
        const bps = Math.round(Number(p.value) * 10) / 10
        return { ...base, bps, rate: formatBytesPerSec(bps) }
      }
      return {
        ...base,
        percent: Math.round(Math.max(0, Math.min(100, p.value)) * 10) / 10,
      }
    }),
  }
}

async function fetchCpuMemoryHistory(zabbixRpc, cpuMemoryMetrics, matchedHosts, window, maxPoints = 120) {
  const byHost = cpuMemoryMetrics?.byHost || {}
  const hostMeta = Object.fromEntries((matchedHosts || []).map(h => [String(h.hostid), h]))
  const from = window.from
  const to = window.to
  const rangeSec = window.rangeSec
  const hosts = []
  const diagnostics = {
    hostsWithCpuItem: 0,
    hostsWithMemoryItem: 0,
    cpuPointsTotal: 0,
    memoryPointsTotal: 0,
    cpuItemKeys: [],
    memoryItemKeys: [],
  }

  for (const [hostid, metrics] of Object.entries(byHost)) {
    const meta = hostMeta[hostid]
    const row = {
      hostid,
      name: meta?.name || meta?.host || hostid,
      cpu: null,
      memory: null,
    }
    if (metrics?.cpu) {
      diagnostics.hostsWithCpuItem += 1
      if (metrics.cpu.key && diagnostics.cpuItemKeys.length < 5) {
        diagnostics.cpuItemKeys.push(metrics.cpu.key)
      }
      row.cpu = await fetchItemHistorySeries(zabbixRpc, metrics.cpu, from, to, maxPoints)
      if (row.cpu?.points?.length) diagnostics.cpuPointsTotal += row.cpu.points.length
    }
    if (metrics?.memory) {
      diagnostics.hostsWithMemoryItem += 1
      if (metrics.memory.key && diagnostics.memoryItemKeys.length < 5) {
        diagnostics.memoryItemKeys.push(metrics.memory.key)
      }
      row.memory = await fetchItemHistorySeries(zabbixRpc, metrics.memory, from, to, maxPoints)
      if (row.memory?.points?.length) diagnostics.memoryPointsTotal += row.memory.points.length
    }
    if (row.cpu || row.memory) hosts.push(row)
  }

  return {
    windowSec: rangeSec,
    windowLabel: window.windowLabel,
    parseNote: window.parseNote,
    from,
    to,
    fromAt: formatPortalTimestamp(from * 1000),
    toAt: formatPortalTimestamp(to * 1000),
    hosts,
    diagnostics,
    note: 'Fetched via Zabbix history.get → trend.get fallback on CPU/memory % items (system.cpu.util, fgSysCpuUsage, hrProcessorLoad, etc.). diagnostics.cpuItemKeys lists which keys were actually matched per host.',
  }
}

async function fetchInterfaceHistory(zabbixRpc, interfaceMetrics, matchedHosts, window, maxPoints = 120) {
  const byHost = interfaceMetrics?.byHost || {}
  const nameMap = interfaceMetrics?.indexToNameByHost || {}
  const hosts = []

  for (const h of matchedHosts || []) {
    const hid = String(h.hostid || '')
    if (!hid) continue
    const ifaceEntries = Object.entries(byHost[hid] || {})
      .filter(([, m]) => m.inItem?.itemid || m.outItem?.itemid)
      .sort((a, b) => ((b[1].in ?? 0) + (b[1].out ?? 0)) - ((a[1].in ?? 0) + (a[1].out ?? 0)))
      .slice(0, ZABBIX_INTERFACE_HISTORY_MAX_PORTS)

    const ports = []
    for (const [idx, m] of ifaceEntries) {
      const portRow = {
        interface: nameMap[hid]?.[idx] || idx,
        snmpIndex: idx,
        in: null,
        out: null,
      }
      if (m.inItem?.itemid) {
        portRow.in = await fetchItemHistorySeries(
          zabbixRpc, m.inItem, window.from, window.to, maxPoints, { valueMode: 'traffic' },
        )
      }
      if (m.outItem?.itemid) {
        portRow.out = await fetchItemHistorySeries(
          zabbixRpc, m.outItem, window.from, window.to, maxPoints, { valueMode: 'traffic' },
        )
      }
      if (portRow.in || portRow.out) ports.push(portRow)
    }
    if (ports.length) {
      hosts.push({
        hostid: hid,
        name: h.name || h.host || hid,
        ports,
      })
    }
  }

  return {
    windowSec: window.rangeSec,
    windowLabel: window.windowLabel,
    parseNote: window.parseNote,
    from: window.from,
    to: window.to,
    fromAt: formatPortalTimestamp(window.from * 1000),
    toAt: formatPortalTimestamp(window.to * 1000),
    hosts,
    note: 'Fetched via Zabbix history.get / trend.get on net.if.in / net.if.out item IDs. hosts[].ports[].in/out.points use bps + rate.',
  }
}

async function fetchInterfaceHistoryByItemIds(zabbixRpc, itemIds, window, maxPoints = 120) {
  const items = []
  for (const itemid of itemIds) {
    const series = await fetchItemHistorySeries(
      zabbixRpc, { itemid }, window.from, window.to, maxPoints, { valueMode: 'traffic' },
    )
    if (series) {
      const row = {
        itemid,
        direction: /net\.if\.out/i.test(series.key || '') ? 'out' : 'in',
        ...series,
      }
      if (window.requestedAtSec) {
        row.valueAt = nearestTrafficPoint(series.points, window.requestedAtSec)
      }
      items.push(row)
    }
  }
  return {
    windowSec: window.rangeSec,
    windowLabel: window.windowLabel,
    parseNote: window.parseNote,
    from: window.from,
    to: window.to,
    fromAt: formatPortalTimestamp(window.from * 1000),
    toAt: formatPortalTimestamp(window.to * 1000),
    items,
    note: 'Fetched by explicit Zabbix net.if item ID(s) via history.get / trend.get.',
  }
}

function nearestTrafficPoint(points, targetSec) {
  if (!Array.isArray(points) || !points.length || !Number.isFinite(targetSec)) return null
  let best = points[0]
  let bestDelta = Math.abs(best.clock - targetSec)
  for (const p of points) {
    const d = Math.abs(p.clock - targetSec)
    if (d < bestDelta) {
      best = p
      bestDelta = d
    }
  }
  return {
    clock: best.clock,
    at: best.at,
    bps: best.bps,
    rate: best.rate,
    deltaSec: bestDelta,
  }
}

async function fetchCpuMemoryHistoryByItemIds(zabbixRpc, itemIds, window, maxPoints = 120) {
  const items = []
  for (const itemid of itemIds) {
    const series = await fetchItemHistorySeries(zabbixRpc, { itemid }, window.from, window.to, maxPoints)
    if (series) {
      const row = { itemid, ...series }
      if (window.requestedAtSec) {
        row.valueAt = nearestHistoryPoint(series.points, window.requestedAtSec)
      }
      items.push(row)
    }
  }
  return {
    windowSec: window.rangeSec,
    windowLabel: window.windowLabel,
    parseNote: window.parseNote,
    from: window.from,
    to: window.to,
    fromAt: formatPortalTimestamp(window.from * 1000),
    toAt: formatPortalTimestamp(window.to * 1000),
    items,
    note: 'Fetched by explicit Zabbix item ID(s) via history.get / trend.get.',
  }
}

function pickHostPctMetric(itemRows, hostid, patterns, invertRe = null) {
  for (const re of patterns) {
    let best = null
    for (const it of itemRows) {
      if (String(it.hostid) !== String(hostid)) continue
      const key = String(it.key_ || '')
      const name = String(it.name || '')
      const haystack = `${key} ${name}`
      if (!re.test(haystack)) continue
      const inverted = invertRe && invertRe.test(haystack)
      const pct = readPctUtilItem(it, inverted)
      if (pct == null) continue
      const clock = Number(it.lastclock) || 0
      if (!best || clock >= best.clock) {
        best = {
          percent: pct,
          itemName: name || key,
          key,
          clock,
          itemid: String(it.itemid),
          valueType: Number(it.value_type),
          units: it.units || '',
        }
      }
    }
    if (best) return best
  }
  return null
}

async function fetchCpuMemoryMetrics(zabbixRpc, hostids) {
  if (!hostids.length) return { byHost: {} }
  const itemRows = await fetchUtilizationItems(zabbixRpc, hostids)
  const byHost = {}
  for (const hid of hostids) {
    const cpu = pickHostPctMetric(itemRows, hid, CPU_KEY_RES)
    const memory = pickHostPctMetric(itemRows, hid, MEMORY_KEY_RES, MEMORY_INVERT_KEY_RE)
    if (cpu || memory) byHost[hid] = { cpu, memory }
  }
  return { byHost }
}

function formatMetricClock(clock) {
  if (!clock) return '—'
  return formatPortalTimestamp(Number(clock) * 1000)
}

function extractMountFromKey(key) {
  const m = String(key || '').match(/\[\s*([^,\]]+)/)
  return m ? m[1].replace(/^"|"$/g, '') : ''
}

function extractFsModeFromKey(key) {
  const m = String(key || '').match(/\[[^,]*,\s*([^\]]+)\]/)
  return m ? m[1].trim().replace(/^"|"$/g, '').toLowerCase() : ''
}

function readDiskPercent(it) {
  const v = parseFloat(it.lastvalue)
  if (!Number.isFinite(v)) return null
  const clamped = Math.max(0, Math.min(100, v))
  return Math.round(clamped * 10) / 10
}

function readDiskBytes(it) {
  const v = parseFloat(it.lastvalue)
  if (!Number.isFinite(v) || v < 0) return null
  const u = String(it.units || '').trim().toUpperCase()
  const mul = ({ B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 })[u]
  return mul ? v * mul : v
}

async function fetchUtilizationItems(zabbixRpc, hostids) {
  const out = []
  for (let i = 0; i < hostids.length; i += 400) {
    const batch = await zabbixRpc('item.get', {
      hostids: hostids.slice(i, i + 400),
      monitored: true,
      filter: { status: 0, value_type: [0, 3] },
      output: ['itemid', 'hostid', 'name', 'key_', 'value_type', 'units', 'lastvalue', 'lastclock'],
      limit: 5000,
    })
    out.push(...(batch || []))
  }
  return out
}

async function fetchDiskMetrics(zabbixRpc, hostids) {
  if (!hostids.length) return { byHost: {}, rows: [] }
  const itemRows = await fetchUtilizationItems(zabbixRpc, hostids)
  const fsByteIndex = {}
  for (const it of itemRows) {
    const key = String(it.key_ || '')
    if (!/^vfs\.fs(?:\.dependent)?\.size\[/i.test(key)) continue
    const mode = extractFsModeFromKey(key)
    if (!['used', 'total', 'free'].includes(mode)) continue
    const u = String(it.units || '').trim().toUpperCase()
    if (u && !['B', 'KB', 'MB', 'GB', 'TB', 'PB'].includes(u)) continue
    const hostid = String(it.hostid)
    const mount = extractMountFromKey(key)
    if (!hostid || !mount) continue
    const k = `${hostid}|${mount}|${mode}`
    if (!fsByteIndex[k] || (it.lastvalue !== '' && it.lastvalue != null)) fsByteIndex[k] = it
  }

  const lookupFsBytes = (hostid, mount, mode) => {
    const it = fsByteIndex[`${hostid}|${mount}|${mode}`]
    return it ? readDiskBytes(it) : null
  }

  const byHost = {}
  for (const it of itemRows) {
    const key = String(it.key_ || '')
    if (!DISK_KEY_RES.some(re => re.test(key))) continue
    const u = String(it.units || '').trim()
    if (u !== '%' && !/%/.test(u)) continue
    const hostid = String(it.hostid)
    const pct = readDiskPercent(it)
    if (pct == null) continue
    const inverted = DISK_INVERT_KEY_RE.test(key)
    const valuePct = inverted ? Math.max(0, Math.round((100 - pct) * 10) / 10) : pct
    const mount = extractMountFromKey(key)
    const cur = byHost[hostid]
    if (!cur || valuePct > cur.percent) {
      let usedBytes = lookupFsBytes(hostid, mount, 'used')
      let totalBytes = lookupFsBytes(hostid, mount, 'total')
      const freeBytes = lookupFsBytes(hostid, mount, 'free')
      if (usedBytes == null && totalBytes != null && freeBytes != null) usedBytes = Math.max(0, totalBytes - freeBytes)
      if (totalBytes == null && usedBytes != null && freeBytes != null) totalBytes = usedBytes + freeBytes
      if (usedBytes == null && totalBytes != null) usedBytes = totalBytes * (valuePct / 100)
      if (totalBytes == null && usedBytes != null && valuePct > 0) totalBytes = usedBytes / (valuePct / 100)
      byHost[hostid] = {
        mount,
        percent: valuePct,
        usedBytes: usedBytes != null ? Math.round(usedBytes) : null,
        totalBytes: totalBytes != null ? Math.round(totalBytes) : null,
        freeBytes: freeBytes != null ? Math.round(freeBytes) : null,
        itemName: it.name || key,
      }
    }
  }

  const rows = Object.entries(byHost)
    .map(([hostid, d]) => ({ hostid, ...d }))
    .sort((a, b) => b.percent - a.percent)
  return { byHost, rows }
}

async function fetchHostsInGroup(zabbixRpc, groupName, baseParams) {
  const name = String(groupName || '').trim()
  if (!name) return []
  let groups = await zabbixRpc('hostgroup.get', {
    output: ['groupid', 'name'],
    filter: { name },
  }).catch(() => [])
  if (!groups?.length) {
    groups = await zabbixRpc('hostgroup.get', {
      output: ['groupid', 'name'],
      search: { name },
      searchWildcardsEnabled: true,
    }).catch(() => [])
    groups = (groups || []).filter(g => String(g.name || '').toLowerCase() === name.toLowerCase())
  }
  if (!groups?.length) return { hosts: [], groupFound: false, groupName: name }
  const groupids = groups.map(g => g.groupid)
  const hosts = await zabbixRpc('host.get', { ...baseParams, groupids, limit: ZABBIX_HOST_FETCH_MAX })
  return { hosts: hosts || [], groupFound: true, groupName: groups[0].name || name }
}

export function wantsPingStatus(question) {
  return /\b(ping|icmp|latency|packet\s*loss|response\s*time|sensor\s*data|reachable|unreachable)\b/i.test(String(question || ''))
}

export function wantsBandwidthUtil(question, ctx = null) {
  const q = String(question || '')
  if (wantsCpuMemoryUtil(q) && !/\b(bandwidth|traffic|throughput|interface|port|net\.if|bits\s*received|bits\s*sent)\b/i.test(q)) {
    return false
  }
  if (!/\b(bandwidth|utilization|utilisation|traffic|throughput|bits\s*received|bits\s*sent|interface\s+usage|interface\s+bandwidth)\b/i.test(q)) {
    return false
  }
  return Boolean(extractIpv4(q))
    || /\b(interfaces?|ports?)\b/i.test(q)
    || Boolean(extractHostGroupFilter(q, ctx))
}

/** Analytical infra queries — load live Zabbix into LLM context instead of a rigid template. */
export function prefersLlmSynthesis(question, ctx = null) {
  const c = ctx || {}
  const q = String(question || '')
  if (c.chatMode === 'rca') return false

  // Bandwidth / interface / IP queries are now handled by the direct path
  // (buildZabbixInfraContext returns named per-port Mbps data). No LLM needed.
  if (wantsBandwidthUtil(q)) return false
  if (wantsCpuMemoryUtil(q)) return false
  if (wantsDiskUsage(q)) return false
  if (extractHostGroupFilter(q)) return false
  if (extractIpv4(q)) return false
  if (/\b(all port|every port|each port|all interface|every interface)\b/i.test(q)) return false

  // Only send to LLM for open-ended analytical questions with no live data equivalent
  if (/\b(explain|help me understand|interpret|recommend|compare|analyse|analyze|summarize|summarise)\b/i.test(q)) {
    return true
  }
  // "why only 3" follow-ups on Zabbix host groups — re-fetch via direct path, not LLM
  if (c.isFollowUp && c.priorTopic === 'zabbix' && extractHostGroupFilter(q, c)) return false
  if (/\bwhy\b/i.test(q) && extractHostGroupFilter(q, c)) return false
  return false
}

const PING_STALE_SEC = Number.parseInt(process.env.ZABBIX_PING_STALE_SEC || '900', 10)

function deriveHostAvail(h) {
  const active = String(h.active_available ?? '')
  // Zabbix 7+ active_available: only trust explicit up/down; '0' falls through to interfaces.
  if (active === '1' || active === '2') return active
  const ifaces = h.interfaces
  if (Array.isArray(ifaces) && ifaces.length > 0) {
    let any1 = false
    let any2 = false
    let any0 = false
    for (const iface of ifaces) {
      const a = String(iface.available ?? '')
      if (a === '1') any1 = true
      else if (a === '2') any2 = true
      else any0 = true
    }
    if (any1 && !any2) return '1'
    if (any2 && !any1) return '2'
    if (any1 && any2) return '2'
    if (any0 && !any1 && !any2) return '0'
  }
  const legacy = String(h.available ?? '')
  if (legacy === '1' || legacy === '2' || legacy === '0') return legacy
  return '0'
}

function availLabelFromHost(h) {
  const a = deriveHostAvail(h)
  if (a === '1') return 'available'
  if (a === '2') return 'unavailable'
  return 'unknown'
}

async function fetchItemsChunked(zabbixRpc, hostids, searchKey) {
  const out = []
  for (let i = 0; i < hostids.length; i += 400) {
    const chunk = hostids.slice(i, i + 400)
    const batch = await zabbixRpc('item.get', {
      hostids: chunk,
      output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock', 'name', 'units', 'value_type'],
      search: { key_: `${searchKey}*` },
      searchWildcardsEnabled: true,
      limit: 500,
    })
    out.push(...(batch || []))
  }
  return out
}

async function fetchItemsByNameChunked(zabbixRpc, hostids, searchText) {
  const out = []
  for (let i = 0; i < hostids.length; i += 400) {
    const chunk = hostids.slice(i, i + 400)
    const batch = await zabbixRpc('item.get', {
      hostids: chunk,
      output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock', 'name', 'units', 'value_type'],
      search: { name: `*${searchText}*`, key_: `*${searchText}*` },
      searchByAny: true,
      searchWildcardsEnabled: true,
      filter: { status: 0 },
      limit: 500,
    }).catch(() => [])
    out.push(...(batch || []))
  }
  return out
}

function buildHostMetricMap(items, hostids) {
  const picked = {}
  for (const it of items || []) {
    const hid = String(it.hostid)
    const v = parseFloat(it.lastvalue)
    if (!Number.isFinite(v)) continue
    const key = String(it.key_ || '')
    const clock = Number(it.lastclock) || 0
    const prevKey = picked[hid]?.key ?? ''
    const isExact = /\[8\.8\.8\.8\]/.test(key)
    const prevIsExact = /\[8\.8\.8\.8\]/.test(prevKey)
    const prevClock = picked[hid]?.clock ?? -1
    const take = picked[hid] == null
      || (isExact && !prevIsExact)
      || (isExact === prevIsExact && clock >= prevClock)
    if (take) picked[hid] = { value: v, key, clock }
  }
  const valueByHost = {}
  const clockByHost = {}
  for (const hid of hostids) {
    valueByHost[hid] = picked[hid]?.value ?? null
    clockByHost[hid] = picked[hid]?.clock > 0 ? picked[hid].clock : null
  }
  return { valueByHost, clockByHost }
}

function baseItemKey(key) {
  return String(key || '').split('[')[0].trim()
}

function isUptimeItem(it) {
  const key = baseItemKey(it?.key_).toLowerCase()
  const name = String(it?.name || '').toLowerCase()
  if (key === 'agent.ping' || key === 'icmpping') return false
  return [
    'uptime',
    'system.uptime',
    'sysuptime',
    'hrsystemuptime',
    'device.uptime',
  ].includes(key)
    || /\b(system|device|host|fortigate|firewall)?\s*uptime\b/i.test(name)
}

async function fetchUptimeItems(zabbixRpc, hostids) {
  const batches = await Promise.all([
    fetchItemsChunked(zabbixRpc, hostids, 'uptime'),
    fetchItemsChunked(zabbixRpc, hostids, 'system.uptime'),
    fetchItemsChunked(zabbixRpc, hostids, 'sysUpTime'),
    fetchItemsChunked(zabbixRpc, hostids, 'hrSystemUptime'),
    fetchItemsChunked(zabbixRpc, hostids, 'device.uptime'),
  ])
  const byId = new Map()
  for (const it of batches.flat()) {
    if (it?.itemid && isUptimeItem(it)) byId.set(String(it.itemid), it)
  }
  return [...byId.values()]
}

function classifyFreshMetrics(valueByHost, clockByHost, hostids, nowSec = Math.floor(Date.now() / 1000)) {
  const fresh = {}
  const staleFlags = {}
  for (const hid of hostids) {
    const v = valueByHost[hid]
    const clock = clockByHost[hid]
    if (v == null) {
      fresh[hid] = null
      staleFlags[hid] = false
    } else if (clock == null || (nowSec - clock) > PING_STALE_SEC) {
      fresh[hid] = null
      staleFlags[hid] = true
    } else {
      fresh[hid] = v
      staleFlags[hid] = false
    }
  }
  return { fresh, staleFlags }
}

function reachFromPingValue(v) {
  if (v == null) return null
  if (v === 1) return 'reachable'
  if (v === 0) return 'unreachable'
  return null
}

function reachFromMerakiStatus(v) {
  if (v == null) return null
  if (v === 1) return 'reachable'
  if (v === 0) return 'unreachable'
  return 'degraded'
}

function pickFreshMetric(cls, hid) {
  if (cls.staleFlags[hid]) return { value: null, stale: true }
  return { value: cls.fresh[hid], stale: false }
}

function filterExactItemKey(items, exactKey) {
  return (items || []).filter(it => String(it.key_ || '').split('[')[0] === exactKey)
}

async function fetchPingMetrics(zabbixRpc, hostids) {
  if (!hostids.length) {
    return {
      summary: { reachable: 0, unreachable: 0, degraded: 0, noData: 0, stale: 0, avgMs: null, maxMs: null },
      byHost: {},
    }
  }
  const [
    agentPingItems,
    pingLossItems,
    pingMsItems,
    icmpPingItems,
    icmpLossItems,
    icmpSecItems,
    merakiStatusItems,
    latencyNameItems,
  ] = await Promise.all([
    fetchItemsChunked(zabbixRpc, hostids, 'agent.ping'),
    fetchItemsChunked(zabbixRpc, hostids, 'custom.ping.loss'),
    fetchItemsChunked(zabbixRpc, hostids, 'custom.ping.ms'),
    fetchItemsChunked(zabbixRpc, hostids, 'icmpping'),
    fetchItemsChunked(zabbixRpc, hostids, 'icmppingloss'),
    fetchItemsChunked(zabbixRpc, hostids, 'icmppingsec'),
    fetchItemsChunked(zabbixRpc, hostids, 'meraki.device.status'),
    Promise.all([
      fetchItemsByNameChunked(zabbixRpc, hostids, 'latency'),
      fetchItemsByNameChunked(zabbixRpc, hostids, 'response time'),
      fetchItemsByNameChunked(zabbixRpc, hostids, 'ping time'),
    ]).then((rows) => rows.flat()),
  ])
  const latencyById = new Map()
  for (const it of [...(latencyNameItems || [])]) {
    const key = String(it.key_ || '').toLowerCase()
    const name = String(it.name || '').toLowerCase()
    const unit = String(it.units || '').toLowerCase()
    if (/loss|packet loss|cpu|memory|uptime|availability/.test(`${key} ${name}`)) continue
    if (/(latency|response time|ping time|icmppingsec|custom\.ping\.ms)/.test(`${key} ${name}`) || unit === 'ms' || unit === 's') {
      if (it.itemid) latencyById.set(String(it.itemid), it)
    }
  }
  for (const it of [...(pingMsItems || []), ...(icmpSecItems || [])]) {
    if (it.itemid) latencyById.set(String(it.itemid), it)
  }
  const latencyItems = [...latencyById.values()]
  const nowSec = Math.floor(Date.now() / 1000)
  const agentMap = buildHostMetricMap(agentPingItems, hostids)
  const lossMap = buildHostMetricMap(pingLossItems, hostids)
  const msMap = buildHostMetricMap(pingMsItems, hostids)
  const icmpMap = buildHostMetricMap(filterExactItemKey(icmpPingItems, 'icmpping'), hostids)
  const icmpLossMap = buildHostMetricMap(filterExactItemKey(icmpLossItems, 'icmppingloss'), hostids)
  const icmpSecMap = buildHostMetricMap(filterExactItemKey(icmpSecItems, 'icmppingsec'), hostids)
  const latencyMap = buildHostMetricMap(latencyItems, hostids)
  const merakiMap = buildHostMetricMap(filterExactItemKey(merakiStatusItems, 'meraki.device.status'), hostids)

  const agentCls = classifyFreshMetrics(agentMap.valueByHost, agentMap.clockByHost, hostids, nowSec)
  const lossCls = classifyFreshMetrics(lossMap.valueByHost, lossMap.clockByHost, hostids, nowSec)
  const msCls = classifyFreshMetrics(msMap.valueByHost, msMap.clockByHost, hostids, nowSec)
  const icmpCls = classifyFreshMetrics(icmpMap.valueByHost, icmpMap.clockByHost, hostids, nowSec)
  const icmpLossCls = classifyFreshMetrics(icmpLossMap.valueByHost, icmpLossMap.clockByHost, hostids, nowSec)
  const icmpSecCls = classifyFreshMetrics(icmpSecMap.valueByHost, icmpSecMap.clockByHost, hostids, nowSec)
  const merakiCls = classifyFreshMetrics(merakiMap.valueByHost, merakiMap.clockByHost, hostids, nowSec)

  const summary = { reachable: 0, unreachable: 0, degraded: 0, noData: 0, stale: 0, avgMs: null, maxMs: null }
  const byHost = {}
  const msVals = []

  for (const hid of hostids) {
    const agent = pickFreshMetric(agentCls, hid)
    const icmp = pickFreshMetric(icmpCls, hid)
    const meraki = pickFreshMetric(merakiCls, hid)

    let reach = 'no data'
    let source = null
    let pollClock = null

    if (agent.stale || icmp.stale || meraki.stale) {
      reach = 'stale'
      source = agent.stale ? 'agent.ping' : icmp.stale ? 'icmpping' : 'meraki.device.status'
      pollClock = agent.stale ? agentMap.clockByHost[hid]
        : icmp.stale ? icmpMap.clockByHost[hid]
          : merakiMap.clockByHost[hid]
      summary.stale += 1
    } else if (agent.value != null) {
      reach = reachFromPingValue(agent.value) || 'degraded'
      source = 'agent.ping'
      pollClock = agentMap.clockByHost[hid]
    } else if (icmp.value != null) {
      reach = reachFromPingValue(icmp.value) || 'degraded'
      source = 'icmpping'
      pollClock = icmpMap.clockByHost[hid]
    } else if (meraki.value != null) {
      reach = reachFromMerakiStatus(meraki.value)
      source = 'meraki.device.status'
      pollClock = merakiMap.clockByHost[hid]
    } else {
      summary.noData += 1
    }

    if (reach === 'reachable') summary.reachable += 1
    else if (reach === 'unreachable') summary.unreachable += 1
    else if (reach === 'degraded') summary.degraded += 1

    const customMs = pickFreshMetric(msCls, hid)
    const icmpSec = pickFreshMetric(icmpSecCls, hid)
    const genericLatency = pickFreshMetric(classifyFreshMetrics(latencyMap.valueByHost, latencyMap.clockByHost, hostids, nowSec), hid)
    const customLoss = pickFreshMetric(lossCls, hid)
    const icmpLoss = pickFreshMetric(icmpLossCls, hid)

    let ms = null
    let loss = null
    if (!customMs.stale && customMs.value != null && customMs.value >= 0) {
      ms = customMs.value
    } else if (!icmpSec.stale && icmpSec.value != null && icmpSec.value >= 0) {
      ms = Math.round(icmpSec.value * 1000 * 10) / 10
    } else if (!genericLatency.stale && genericLatency.value != null && genericLatency.value >= 0) {
      ms = genericLatency.value
    }
    if (!customLoss.stale && customLoss.value != null) loss = customLoss.value
    else if (!icmpLoss.stale && icmpLoss.value != null) loss = icmpLoss.value

    if (ms != null && ms >= 0) msVals.push(ms)

    byHost[hid] = {
      reach,
      ms,
      loss,
      source,
      msPoll: msMap.clockByHost[hid] || icmpSecMap.clockByHost[hid] || null,
      lossPoll: lossMap.clockByHost[hid] || icmpLossMap.clockByHost[hid] || null,
      agentPoll: pollClock,
    }
  }

  if (msVals.length) {
    msVals.sort((a, b) => a - b)
    summary.avgMs = Math.round(msVals.reduce((a, b) => a + b, 0) / msVals.length * 10) / 10
    summary.maxMs = msVals[msVals.length - 1]
  }

  return {
    summary,
    byHost,
    items: {
      agent: agentPingItems || [],
      icmp: filterExactItemKey(icmpPingItems, 'icmpping'),
      icmpSec: filterExactItemKey(icmpSecItems, 'icmppingsec'),
      icmpLoss: filterExactItemKey(icmpLossItems, 'icmppingloss'),
      latency: latencyItems,
    },
  }
}

/**
 * Pull Zabbix history.get points for ping items inside a session window
 * and compute uptime% (agent.ping or icmpping), avg latency (icmppingsec),
 * avg loss (icmppingloss). Used by storeZabbix dossier session snapshots.
 *
 * @param {(method: string, params: object) => Promise<any>} zabbixRpc
 * @param {{ agent: any[], icmp: any[], icmpSec: any[], icmpLoss: any[] }} items
 * @param {string[]} hostids
 * @param {{ from: number, to: number, rangeSec: number, windowLabel?: string, parseNote?: string }} window
 */
async function fetchPingHistorySnapshot(zabbixRpc, items, hostids, window) {
  if (!window || !hostids?.length) return null
  const itemsByHost = (list, key) => {
    const map = {}
    for (const it of list || []) {
      const hid = String(it.hostid)
      if (!map[hid]) map[hid] = []
      map[hid].push({
        itemid: String(it.itemid),
        valueType: Number(it.value_type),
        key,
        itemKey: it.key_ || '',
        itemName: it.name || '',
        units: it.units || '',
      })
    }
    return map
  }
  const agentBy = itemsByHost(items.agent || [], 'agent.ping')
  const icmpBy = itemsByHost(items.icmp || [], 'icmpping')
  const secBy = itemsByHost(items.icmpSec || [], 'icmppingsec')
  const latencyBy = itemsByHost(items.latency || [], 'latency')
  const lossBy = itemsByHost(items.icmpLoss || [], 'icmppingloss')

  // history.get → trend.get fallback (raw history retention may be shorter
  // than the queried age; trends keep hourly aggregates for ~1 year).
  async function getPoints(itemid, valueType) {
    const hk = zabbixHistoryKind(valueType)
    if (!hk) return { points: [], source: null }
    const histRows = await zabbixRpc('history.get', {
      history: hk.history,
      itemids: [itemid],
      time_from: window.from,
      time_till: window.to,
      output: ['clock', 'value'],
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: 5000,
    }).catch(() => [])
    let points = (histRows || [])
      .map((r) => ({ clock: Number(r.clock), value: hk.parse(r.value) }))
      .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
    if (points.length) return { points, source: 'history' }
    if (!hk.trends) return { points: [], source: null }
    const trendWindow = trendQueryBounds(window.from, window.to)
    const trendRows = await zabbixRpc('trend.get', {
      itemids: [itemid],
      time_from: trendWindow.from,
      time_till: trendWindow.to,
      output: ['clock', 'value_avg', 'num'],
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: 5000,
    }).catch(() => [])
    points = (trendRows || [])
      .map((r) => ({
        clock: Number(r.clock),
        value: Number(r.value_avg),
        weight: Number(r.num) || 1,
      }))
      .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
    return { points, source: points.length ? 'trend' : null }
  }

  const byHost = {}
  const diagnostics = {
    hostidsChecked: hostids.length,
    itemCounts: {
      agent: 0,
      icmp: 0,
      icmpSec: 0,
      icmpLoss: 0,
    },
    sourcesUsed: { uptime: null, ms: null, loss: null },
  }

  for (const hid of hostids.map(String)) {
    const agentItems = agentBy[hid] || []
    const icmpItems = icmpBy[hid] || []
    const secItems = [...(secBy[hid] || []), ...(latencyBy[hid] || [])]
    const lossItems = lossBy[hid] || []
    diagnostics.itemCounts.agent += agentItems.length
    diagnostics.itemCounts.icmp += icmpItems.length
    diagnostics.itemCounts.icmpSec += secItems.length
    diagnostics.itemCounts.icmpLoss += lossItems.length

    const reachItems = agentItems.length ? agentItems : icmpItems
    const reachKey = agentItems.length ? 'agent.ping' : 'icmpping'

    let totalSamples = 0
    let upSamples = 0
    let uptimeSource = null
    for (const it of reachItems) {
      const { points, source } = await getPoints(it.itemid, it.valueType)
      if (source && !uptimeSource) uptimeSource = source
      for (const p of points) {
        const weight = p.weight || 1
        totalSamples += weight
        if (Number(p.value) >= 0.5) upSamples += weight
      }
    }

    const msPoints = []
    let msSource = null
    for (const it of secItems) {
      const { points, source } = await getPoints(it.itemid, it.valueType)
      if (source && !msSource) msSource = source
      const units = String(it.units || '').toLowerCase()
      const keyOrName = `${String(it.itemKey || '')} ${String(it.itemName || '')}`.toLowerCase()
      const multiplier = units === 'ms' || /custom\.ping\.ms|milliseconds?/.test(keyOrName) ? 1 : 1000
      msPoints.push(...points.map((p) => ({ ...p, value: Number(p.value) * multiplier })))
    }
    const lossPoints = []
    let lossSource = null
    for (const it of lossItems) {
      const { points, source } = await getPoints(it.itemid, it.valueType)
      if (source && !lossSource) lossSource = source
      lossPoints.push(...points)
    }

    if (uptimeSource && !diagnostics.sourcesUsed.uptime) diagnostics.sourcesUsed.uptime = uptimeSource
    if (msSource && !diagnostics.sourcesUsed.ms) diagnostics.sourcesUsed.ms = msSource
    if (lossSource && !diagnostics.sourcesUsed.loss) diagnostics.sourcesUsed.loss = lossSource

    const avgMs = msPoints.length
      ? Math.round((msPoints.reduce((s, p) => s + p.value, 0) / msPoints.length) * 10) / 10
      : null
    const minMs = msPoints.length
      ? Math.round(Math.min(...msPoints.map((p) => p.value)) * 10) / 10
      : null
    const maxMs = msPoints.length
      ? Math.round(Math.max(...msPoints.map((p) => p.value)) * 10) / 10
      : null
    const avgLossPct = lossPoints.length
      ? Math.round((lossPoints.reduce((s, p) => s + p.value, 0) / lossPoints.length) * 10) / 10
      : null
    const uptimePct = totalSamples > 0
      ? Math.round((upSamples / totalSamples) * 10000) / 100
      : null

    if (totalSamples || msPoints.length || lossPoints.length) {
      byHost[hid] = {
        uptimePct,
        upSamples,
        totalSamples,
        reachSource: reachKey,
        uptimeDataSource: uptimeSource,
        avgMs,
        minMs,
        maxMs,
        msSamples: msPoints.length,
        msDataSource: msSource,
        avgLossPct,
        lossSamples: lossPoints.length,
        lossDataSource: lossSource,
      }
    }
  }

  return {
    windowSec: window.rangeSec,
    windowLabel: window.windowLabel,
    parseNote: window.parseNote,
    from: window.from,
    to: window.to,
    fromAt: formatPortalTimestamp(window.from * 1000),
    toAt: formatPortalTimestamp(window.to * 1000),
    byHost,
    diagnostics,
    note: 'Computed from Zabbix history.get on agent.ping / icmpping / icmppingsec / icmppingloss in the window, with trend.get fallback when raw history is past retention. uptimePct = up samples ÷ total samples × 100. Empty diagnostics.itemCounts means the host has no ping items in this Zabbix template (check Zabbix host config, not just data retention).',
  }
}

function applySessionPingToHosts(hosts, pingHistory) {
  if (!Array.isArray(hosts) || !pingHistory?.byHost) return
  for (const host of hosts) {
    const row = pingHistory.byHost[String(host.hostid)]
    if (!row) continue
    host.pingAtSession = {
      uptimePct: row.uptimePct,
      avgMs: row.avgMs,
      minMs: row.minMs,
      maxMs: row.maxMs,
      avgLossPct: row.avgLossPct,
      reachSource: row.reachSource,
      totalSamples: row.totalSamples,
      msSamples: row.msSamples,
      lossSamples: row.lossSamples,
    }
  }
}

async function fetchUptimeHistorySnapshot(zabbixRpc, matchedHosts, window, maxPoints = 120) {
  if (!window || !matchedHosts?.length) return null
  const hostids = matchedHosts.map((h) => String(h.hostid)).filter(Boolean)
  const uptimeItems = await fetchUptimeItems(zabbixRpc, hostids)
  const itemsByHost = {}
  for (const it of uptimeItems) {
    const hid = String(it.hostid)
    if (!itemsByHost[hid]) itemsByHost[hid] = []
    itemsByHost[hid].push(it)
  }

  async function readSeries(it) {
    const valueType = Number(it.value_type)
    const hk = zabbixHistoryKind(valueType)
    if (!hk) return null

    const fetchHistory = async () => {
      const rows = await zabbixRpc('history.get', {
        history: hk.history,
        itemids: [String(it.itemid)],
        time_from: window.from,
        time_till: window.to,
        output: ['clock', 'value'],
        sortfield: 'clock',
        sortorder: 'ASC',
        limit: 5000,
      }).catch(() => [])
      return (rows || [])
        .map((r) => ({ clock: Number(r.clock), value: hk.parse(r.value) }))
        .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
    }

    const fetchTrends = async () => {
      if (!hk.trends) return []
      const trendWindow = trendQueryBounds(window.from, window.to)
      const rows = await zabbixRpc('trend.get', {
        itemids: [String(it.itemid)],
        time_from: trendWindow.from,
        time_till: trendWindow.to,
        output: ['clock', 'value_avg'],
        sortfield: 'clock',
        sortorder: 'ASC',
        limit: 5000,
      }).catch(() => [])
      return (rows || [])
        .map((r) => ({ clock: Number(r.clock), value: Number(r.value_avg) }))
        .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
    }

    let source = 'history'
    let points = await fetchHistory()
    if (!points.length) {
      points = await fetchTrends()
      source = points.length ? 'trend' : null
    }
    if (!points.length) return null

    points = downsampleHistoryPoints(points, maxPoints)
    const targetSec = window.requestedAtSec ?? Math.floor((window.from + window.to) / 2)
    const nearest = nearestHistoryPoint(
      points.map((p) => ({
        clock: p.clock,
        at: formatPortalTimestamp(p.clock * 1000),
        percent: p.value,
      })),
      targetSec,
    )
    const seconds = nearest?.percent ?? null
    return {
      itemid: String(it.itemid),
      key: it.key_ || '',
      itemName: it.name || it.key_ || String(it.itemid),
      units: it.units || '',
      source,
      pointCount: points.length,
      sessionSnapshot: seconds == null
        ? null
        : {
          clock: nearest.clock,
          at: nearest.at,
          seconds,
          label: formatDurationSeconds(seconds),
          deltaSec: nearest.deltaSec,
        },
      points: points.map((p) => ({
        clock: p.clock,
        at: formatPortalTimestamp(p.clock * 1000),
        seconds: Math.round(Number(p.value)),
        label: formatDurationSeconds(p.value),
      })),
    }
  }

  const hosts = []
  const diagnostics = {
    hostsChecked: hostids.length,
    hostsWithUptimeItem: 0,
    uptimeItemKeys: [],
    uptimePointsTotal: 0,
  }

  for (const h of matchedHosts) {
    const hid = String(h.hostid)
    const candidates = itemsByHost[hid] || []
    if (candidates.length) diagnostics.hostsWithUptimeItem += 1
    for (const it of candidates) {
      if (it.key_ && diagnostics.uptimeItemKeys.length < 8) diagnostics.uptimeItemKeys.push(it.key_)
      const series = await readSeries(it)
      if (!series) continue
      diagnostics.uptimePointsTotal += series.pointCount || 0
      hosts.push({
        hostid: hid,
        name: h.name || h.host || hid,
        host: h.host || null,
        uptime: series,
      })
      break
    }
  }

  return {
    windowSec: window.rangeSec,
    windowLabel: window.windowLabel,
    parseNote: window.parseNote,
    from: window.from,
    to: window.to,
    fromAt: formatPortalTimestamp(window.from * 1000),
    toAt: formatPortalTimestamp(window.to * 1000),
    hosts,
    diagnostics,
    note: 'Fetched from Zabbix uptime counter items (uptime / system.uptime / sysUpTime / hrSystemUptime) via history.get with trend.get hour-bucket fallback. This is device uptime duration, not availability percentage.',
  }
}

function applySessionUptimeToHosts(hosts, uptimeHistory) {
  if (!Array.isArray(hosts) || !uptimeHistory?.hosts?.length) return
  const byHost = Object.fromEntries(
    uptimeHistory.hosts.map((h) => [String(h.hostid), h.uptime?.sessionSnapshot]),
  )
  for (const host of hosts) {
    const row = byHost[String(host.hostid)]
    if (row) host.uptimeAtSession = row
  }
}

function formatPingLine(name, ping) {
  const parts = []
  if (ping.reach === 'reachable') parts.push('ping OK')
  else if (ping.reach === 'unreachable') parts.push('ping FAIL')
  else if (ping.reach === 'degraded') parts.push('ping degraded')
  else if (ping.reach === 'stale') parts.push('ping stale')
  else parts.push('ping —')
  if (ping.source) parts.push(`via ${ping.source}`)
  if (ping.ms != null) parts.push(`${ping.ms} ms`)
  if (ping.loss != null) parts.push(`loss ${ping.loss}%`)
  if (ping.agentPoll) parts.push(`@ ${formatPortalTimestamp(ping.agentPoll * 1000)}`)
  return `    • ${name} · ${parts.join(' · ')}`
}

function isWirelessApHost(h) {
  const name = String(h.name || h.host || '')
  return /^\[wireless\]/i.test(name) || /\bAP[-\s\d]/i.test(name) || /[-_]AP[-\d]/i.test(name)
}

function isPhysicalSwitchHost(h) {
  if (!SWITCH_DEVICE_TYPES.has(classifyHost(h))) return false
  return !isWirelessApHost(h)
}

async function problemGet(zabbixRpc, params) {
  const queue = [{ recent: true, ...params }, { ...params }]
  const seen = new Set()
  while (queue.length) {
    const attempt = queue.shift()
    const key = JSON.stringify(attempt)
    if (seen.has(key)) continue
    seen.add(key)
    try {
      return await zabbixRpc('problem.get', attempt)
    } catch (e) {
      if (e.code !== 'ZABBIX_API_ERROR') throw e
      const msg = String(e.message || '').toLowerCase()
      // Some Zabbix builds reject extra params on problem.get (observed: selectHosts).
      // Degrade gracefully: strip the unsupported field and retry so the rest of the
      // Store/Infra snapshot still works.
      if (msg.includes('unexpected parameter') && msg.includes('selecthosts') && attempt.selectHosts) {
        const next = { ...attempt }
        delete next.selectHosts
        queue.push(next)
        continue
      }
      // Keep existing compatibility behavior for servers that reject "recent".
      if (msg.includes('unexpected parameter') && msg.includes('recent') && attempt.recent !== undefined) {
        const next = { ...attempt }
        delete next.recent
        queue.push(next)
        continue
      }
      if (!queue.length) throw e
    }
  }
  return []
}

function classifyHost(h) {
  const templates = (h.parentTemplates || []).map(t => String(t.name || '').toLowerCase()).join(' ')
  const groups = (h.groups || []).map(g => String(g.name || '').toLowerCase()).join(' ')
  if (/cisco/.test(templates)) return 'cisco'
  if (/fortigate|fortinet/.test(templates)) return 'fortigate'
  if (/checkpoint|check point/.test(templates)) return 'checkpoint'
  if (/juniper/.test(templates)) return 'juniper'
  if (/aruba|mikrotik|ubiquiti|meraki/.test(templates)) return 'network'
  if (/switch|router|snmp/.test(templates) && !/linux|windows|server/.test(templates)) return 'network'
  if (/virtual machine|vm\b/.test(groups)) return 'vm'
  if (/server/.test(groups)) return 'server'
  if (/database|mssql/.test(groups)) return 'database'
  if (/isp/.test(groups)) return 'isp'
  return 'other'
}

const SWITCH_DEVICE_TYPES = new Set(['cisco', 'network', 'juniper'])
const INTERFACE_STALE_SEC = Number.parseInt(process.env.ZABBIX_INTERFACE_STALE_SEC || '1800', 10)
const ZABBIX_CONTEXT_HOST_LIST_CAP = Math.min(
  Math.max(parseInt(process.env.ZABBIX_CONTEXT_HOST_LIST_CAP || '1000', 10) || 1000, 50),
  ZABBIX_HOST_FETCH_MAX,
)
const ZABBIX_CONTEXT_ENRICH_LIMIT = Math.min(
  Math.max(parseInt(process.env.ZABBIX_CONTEXT_ENRICH_LIMIT || '250', 10) || 250, 25),
  ZABBIX_HOST_FETCH_MAX,
)

async function globalProblemCount(zabbixRpc) {
  try {
    return Number(await zabbixRpc('problem.get', { recent: true, countOutput: true })) || 0
  } catch (e) {
    if (e.code !== 'ZABBIX_API_ERROR') throw e
    return Number(await zabbixRpc('problem.get', { countOutput: true })) || 0
  }
}

function prioritizeHostsForList(hosts, cap) {
  const sorted = [...hosts].sort((a, b) => {
    const rank = (h) => {
      const s = availLabelFromHost(h)
      if (s === 'unavailable') return 0
      if (s === 'unknown') return 1
      return 2
    }
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return String(a.name || a.host).localeCompare(String(b.name || b.host))
  })
  return sorted.slice(0, cap)
}

function mapLiteHostRow(h) {
  return {
    hostid: String(h.hostid),
    name: h.name || h.host,
    host: h.host,
    status: availLabelFromHost(h),
    type: classifyHost(h),
    interfaceIps: (h.interfaces || []).map(i => i.ip).filter(Boolean),
    groups: (h.groups || []).map(g => g.name).filter(Boolean),
  }
}

async function fetchZabbixSnapshot(client, { hostFilter = '', deviceTypeFilter = '', hostGroupFilter = '', includePing = false, includeBandwidth = false, includeDisk = false, includeCpuMemory = false, includeProblems = true, problemLimit = 12, inventoryLite = false } = {}) {
  const { isZabbixConfigured, zabbixRpc, getUrl } = client
  if (!isZabbixConfigured()) return { configured: false }

  const search = String(hostFilter || '').trim()
  const groupName = String(hostGroupFilter || '').trim()
  const isExactIp = search ? (IPV4_RE.test(search) && search.match(IPV4_RE)[0] === search) : false
  const broadInventory = !search && !groupName

  try {
    const baseParams = broadInventory && inventoryLite
      ? {
        monitored_hosts: true,
        output: ['hostid', 'host', 'name', 'status', 'available', 'active_available'],
        sortfield: 'name',
      }
      : {
      monitored_hosts: true,
      output: ['hostid', 'host', 'name', 'status', 'available', 'active_available'],
      selectInterfaces: ['interfaceid', 'available', 'type', 'main', 'ip'],
      selectParentTemplates: ['templateid', 'name'],
      selectGroups: ['groupid', 'name'],
      sortfield: 'name',
    }

    const [version, hostFetch, groupMeta] = await Promise.all([
      zabbixRpc('apiinfo.version', {}).catch(() => ''),
      (async () => {
        const hostSearch = async (term, limit = 200) => {
          const q = String(term || '').trim()
          if (!q) return []
          const variants = [q, `${q}*`, `${q}-*`, `*${q}*`]
          for (const v of variants) {
            const rows = await zabbixRpc('host.get', {
              ...baseParams,
              search: { name: v, host: v },
              searchByAny: true,
              searchWildcardsEnabled: true,
              limit,
            })
            if (rows?.length) return rows
          }
          return []
        }

        if (groupName && !search) {
          const grp = await fetchHostsInGroup(zabbixRpc, groupName, baseParams)
          return grp.hosts
        }

        if (!search) {
          return fetchAllMonitoredHosts(zabbixRpc, baseParams)
        }

        if (isExactIp) {
          const ifaces = await zabbixRpc('hostinterface.get', {
            output: ['hostid'],
            filter: { ip: search },
          }).catch(() => [])
          const ipHostIds = [...new Set((ifaces || []).map(i => String(i.hostid)).filter(Boolean))]
          if (!ipHostIds.length) return []
          return zabbixRpc('host.get', { ...baseParams, hostids: ipHostIds, limit: 50 })
        }

        const primary = await hostSearch(search, 200)
        if (primary?.length) return primary

        // Alias rescue path:
        // Query can be LKST973 while Zabbix host is RP973-xxxx. Primary host.get
        // search by LKST term returns zero rows, so hostMatchesSearch never gets a
        // chance to apply code-level alias matching. On LKST inputs, retry with
        // RP/LK/code probes, then let hostMatchesSearch finalize.
        const code = shouldUseStoreCodeAlias(search) ? extractStoreCode(search) : null
        if (!code) return primary

        const probeTerms = [`RP${code}`, `LK${code}`, code]
        for (const term of probeTerms) {
          const alt = await hostSearch(term, 300)
          if (alt?.length) return alt
        }

        // Last-resort alias resolver for LKST inputs:
        // 1) lightweight host scan (hostid/host/name only)
        // 2) local alias matcher (LKST code -> RP code)
        // 3) hydrate matched hostids with full baseParams.
        const liteFetch = await fetchAllMonitoredHosts(zabbixRpc, {
          output: ['hostid', 'host', 'name'],
          sortfield: 'name',
        }).catch(() => ({ rows: [] }))
        const liteHosts = liteFetch.rows || []
        const matchedIds = [...new Set((liteHosts || [])
          .filter(h => hostMatchesSearch(h, search))
          .map(h => String(h.hostid))
          .filter(Boolean))]
        if (matchedIds.length) {
          return zabbixRpc('host.get', {
            ...baseParams,
            hostids: matchedIds.slice(0, 300),
            limit: 300,
          })
        }
        return primary
      })(),
      groupName && !search
        ? fetchHostsInGroup(zabbixRpc, groupName, baseParams).then(g => ({ groupFound: g.groupFound, groupName: g.groupName }))
        : Promise.resolve(null),
    ])

    const hosts = Array.isArray(hostFetch)
      ? hostFetch
      : (hostFetch?.rows || [])
    const inventoryTotal = Array.isArray(hostFetch) ? null : (hostFetch?.total ?? null)
    const inventoryTruncated = Array.isArray(hostFetch) ? false : Boolean(hostFetch?.truncated)

    const rows = isExactIp
      ? hosts
      : hosts.filter(h => hostMatchesSearch(h, search))
    const filtered = deviceTypeFilter === 'switch'
      ? rows.filter(h => isPhysicalSwitchHost(h))
      : deviceTypeFilter
        ? rows.filter(h => classifyHost(h) === deviceTypeFilter)
        : rows
    const scopedQuery = Boolean(search || groupName)
    const monitoredHostTotal = inventoryTotal ?? filtered.length
    const availability = { total: filtered.length, available: 0, unavailable: 0, unknown: 0 }

    // Device type breakdown
    const deviceTypes = {}
    const deviceTypeDown = {}
    for (const h of filtered) {
      const a = availLabelFromHost(h)
      if (a === 'available') availability.available += 1
      else if (a === 'unavailable') availability.unavailable += 1
      else availability.unknown += 1

      const type = classifyHost(h)
      deviceTypes[type] = (deviceTypes[type] || 0) + 1
      if (a === 'unavailable') deviceTypeDown[type] = (deviceTypeDown[type] || 0) + 1
    }

    const listCap = scopedQuery ? filtered.length : ZABBIX_CONTEXT_HOST_LIST_CAP
    const listedHosts = scopedQuery
      ? filtered
      : prioritizeHostsForList(filtered, listCap)
    const hostsListTruncated = !scopedQuery && filtered.length > listedHosts.length

    const enrichHosts = scopedQuery
      ? filtered
      : listedHosts.slice(0, Math.min(listedHosts.length, ZABBIX_CONTEXT_ENRICH_LIMIT))
    const hostids = enrichHosts.map(h => String(h.hostid)).filter(Boolean)
    let pingMetrics = null
    if (includePing && hostids.length) {
      pingMetrics = await fetchPingMetrics(zabbixRpc, hostids)
    }
    let interfaceMetrics = null
    if (includeBandwidth && hostids.length) {
      interfaceMetrics = await fetchInterfaceMetrics(zabbixRpc, hostids)
    }
    let diskMetrics = null
    if (includeDisk && hostids.length) {
      diskMetrics = await fetchDiskMetrics(zabbixRpc, hostids)
    }
    let cpuMemoryMetrics = null
    if (includeCpuMemory && hostids.length) {
      cpuMemoryMetrics = await fetchCpuMemoryMetrics(zabbixRpc, hostids)
    }
    let problemCount = 0
    let problems = []
    if (includeProblems) {
      try {
        if (scopedQuery && hostids.length) {
          try {
            problemCount = Number(await zabbixRpc('problem.get', {
              hostids,
              recent: true,
              countOutput: true,
            })) || 0
          } catch {
            problemCount = Number(await zabbixRpc('problem.get', { hostids, countOutput: true })) || 0
          }
          problems = await problemGet(zabbixRpc, {
            hostids,
            sortfield: ['eventid'],
            sortorder: 'DESC',
            limit: Math.max(1, Math.min(Number(problemLimit) || 12, 50)),
            output: ['eventid', 'name', 'severity', 'clock', 'acknowledged'],
            selectHosts: ['hostid', 'host', 'name'],
          })
        } else if (!scopedQuery) {
          problemCount = await globalProblemCount(zabbixRpc)
          problems = await problemGet(zabbixRpc, {
            sortfield: ['eventid'],
            sortorder: 'DESC',
            limit: Math.max(1, Math.min(Number(problemLimit) || 12, 50)),
            output: ['eventid', 'name', 'severity', 'clock', 'acknowledged'],
            selectHosts: ['hostid', 'host', 'name'],
          })
        }
      } catch {
        problemCount = 0
        problems = []
      }
    }

    return {
      configured: true,
      version: String(version || ''),
      availability,
      deviceTypes,
      deviceTypeDown,
      problemCount,
      problems: (problems || []).map(p => ({
        name: p.name,
        severity: SEV_LABEL[p.severity] || p.severity,
        hosts: (p.hosts || []).map(h => h.name || h.host).filter(Boolean).join(', '),
        clock: p.clock ? formatPortalTimestamp(Number(p.clock) * 1000) : '',
      })),
      hosts: (() => {
        const priority = ['cisco', 'fortigate', 'checkpoint', 'juniper', 'network']
        const sorted = [...filtered].sort((a, b) => {
          const ta = classifyHost(a), tb = classifyHost(b)
          const pa = priority.indexOf(ta), pb = priority.indexOf(tb)
          if (pa !== -1 && pb === -1) return -1
          if (pa === -1 && pb !== -1) return 1
          return (a.name || a.host).localeCompare(b.name || b.host)
        })
        return sorted.slice(0, groupName ? 50 : (deviceTypeFilter === 'switch' ? 50 : 25)).map(h => ({
          hostid: String(h.hostid),
          name: h.name || h.host,
          host: h.host,
          status: availLabelFromHost(h),
          type: classifyHost(h),
        }))
      })(),
      pingMetrics,
      interfaceMetrics,
      diskMetrics,
      cpuMemoryMetrics,
      hostGroupFilter: groupName || null,
      hostGroupFound: groupMeta?.groupFound ?? (groupName ? null : undefined),
      matchedHosts: listedHosts.map(mapLiteHostRow),
      monitoredHostTotal,
      hostsReturned: listedHosts.length,
      hostsListTruncated,
      hostsListCap: scopedQuery ? null : listCap,
      inventoryTruncated,
      hostFilter: search || null,
      deviceTypeFilter: deviceTypeFilter || null,
    }
  } catch (e) {
    const url = typeof getUrl === 'function' ? getUrl() : ''
    return {
      configured: true,
      error: e.message || String(e),
      errorCode: e.code || 'ZABBIX_ERROR',
      hint: e.hint || null,
      url: url ? url.replace(/\/api_jsonrpc\.php.*/, '') : '',
    }
  }
}

/**
 * Live Zabbix network/server status — no LLM.
 * @param {string} question
 * @param {string[]} allowedPages
 * @param {object} [ctx]
 */
export async function tryDirectZabbixAnswer(question, allowedPages, ctx = null) {
  if (!isZabbixQuestion(question, ctx)) return null
  if (ctx?.subjectChanged && extractStoreHostname(question) && !extractIpv4(question)) return null
  if (prefersLlmSynthesis(question, ctx)) return null

  const fetchedAt = new Date().toISOString()
  const { ip, host: zabbixHostFromCtx } = resolveInfraHostFilter(question, ctx)
  const hostname = extractStoreHostname(question) || ctx?.hostname
  const infraHost = extractInfraHostName(question)
    || ctx?.infraHost
    || (ctx?.isFollowUp ? extractInfraHostFromThread(ctx?.priorUser) : null)
    || (ctx?.isFollowUp ? extractInfraHostFromThread(ctx?.threadText) : null)
  const alertsQuery = wantsZabbixAlertsQuery(question)
  const cpuMemoryQuery = wantsCpuMemoryUtil(question)
  const metricScope = resolveCpuMemoryScope(question)
  const bandwidthQuery = wantsBandwidthUtil(question, ctx)
  let hostGroupFilter = extractHostGroupFilter(question, ctx) || ctx?.hostGroup
  if (ip && hostGroupFilter && (hostGroupFilter === ip || IPV4_RE.test(hostGroupFilter))) {
    hostGroupFilter = ''
  }
  if ((bandwidthQuery || cpuMemoryQuery) && ip) {
    hostGroupFilter = ''
  }
  if (alertsQuery && !hasExplicitHostGroupInQuestion(question)) {
    hostGroupFilter = ''
  }
  const isMembershipCheck = wantsHostGroupCheck(question) && ip && hostGroupFilter && !bandwidthQuery
  const scopedHostGroup = hostGroupFilter && !ip && !(hostname && /\b(for|of|about|status)\b/i.test(question)) ? hostGroupFilter : ''
  const isGroupFollowUp = Boolean(
    ctx?.isFollowUp && scopedHostGroup && ctx?.priorTopic === 'zabbix' && !bandwidthQuery && !isSocReportQuery(question),
  )
  const includeDisk = wantsDiskUsage(question) || isMembershipCheck
    || (isGroupFollowUp && wantsDiskUsage(question))
    || (scopedHostGroup && wantsDiskUsage(question))
  const deviceTypeFilter = (scopedHostGroup || isMembershipCheck) ? null : detectDeviceTypeFilter(question, ctx)
  const hostFilter = ip
    || zabbixHostFromCtx
    || infraHost
    || (hostname && (/\b(for|of|about|status)\b/i.test(question) || ctx?.isFollowUp) ? hostname : '')
  const wantsIsp = /\bisp\b/i.test(question)
  const deepAnalysis = wantsDeepInfraFetch(question, ctx?.chatMode, { ...ctx, zabbixHost: zabbixHostFromCtx || infraHost })
    && Boolean(ip || hostFilter)
  const includePing = wantsPingStatus(question) || (deepAnalysis && !cpuMemoryQuery)
  const includeBandwidth = (bandwidthQuery || (deepAnalysis && !cpuMemoryQuery)) && !cpuMemoryQuery
  const includeCpuMemory = cpuMemoryQuery || (deepAnalysis && /\b(cpu|memory|mem|ram)\b/i.test(question))
  const problemLimit = alertsQuery ? 25 : (deepAnalysis ? 50 : 12)

  const targets = []
  if (allowedPages.includes('infra')) {
    targets.push({ key: 'infra', label: 'Infra Zabbix', client: createZabbixClient('ZABBIX') })
  }
  // Only query Store Zabbix when explicitly requested — avoid noisy "not configured" entries
  // when the user is asking about infra hosts or IPs that live only in Infra Zabbix.
  const storeZabbixExplicit = wantsStoreZabbix(question)
    || /\b(store|retail|pos)\b/i.test(String(question || ''))
    || (ctx?.isFollowUp && ctx?.priorStoreZabbix)
  if (allowedPages.includes('storeZabbix') && storeZabbixExplicit) {
    targets.push({ key: 'storeZabbix', label: 'Store Zabbix', client: createZabbixClient('STORE_ZABBIX') })
  }

  const [results, ispData] = await Promise.all([
    Promise.all(targets.map(async t => ({
      ...t,
      data: await fetchZabbixSnapshot(t.client, {
        hostFilter,
        deviceTypeFilter,
        hostGroupFilter: scopedHostGroup,
        includePing,
        includeBandwidth,
        problemLimit,
        includeDisk,
        includeCpuMemory,
      }),
    }))),
    wantsIsp && allowedPages.includes('storeMonitor') && isInfluxStoreConfigured()
      ? fetchStoreSnapshot(10, '-1h').then(stores => buildOverviewSummary(stores)).catch(() => null)
      : Promise.resolve(null),
  ])

  if (isMembershipCheck && results.length) {
    const { label, data } = results[0]
    if (data?.configured && !data.error) {
      const matched = data.matchedHosts?.[0]
      const lines = [`Host group membership (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`, '']
      lines.push(`── ${label} ──`)
      if (!matched) {
        lines.push(`  No monitored host with interface IP ${ip} in Zabbix.`)
        lines.push('  Open Infra Monitoring → Hosts to verify the device is monitored.')
      } else {
        const belongs = (matched.groups || []).some(g => String(g).toLowerCase() === hostGroupFilter.toLowerCase())
        lines.push(`  IP ${ip} → ${matched.name} [${matched.type}] — ${matched.status}`)
        lines.push(`  Host groups: ${(matched.groups || []).join(', ') || '—'}`)
        lines.push(`  Belongs to "${hostGroupFilter}": ${belongs ? 'YES' : 'NO'}`)
        const disk = data.diskMetrics?.byHost?.[matched.hostid]
        if (disk) {
          lines.push('')
          lines.push('  Disk usage (highest filesystem):')
          lines.push(formatDiskLine(matched.name, disk))
        }
      }
      lines.push('', '(Direct answer from live Zabbix API — no LLM wait.)')
      return {
        content: lines.join('\n'),
        contextMeta: [{ id: 'zabbix', label: label, freshness: 'live', fetchedAt, configured: true }],
        contextPreview: {},
        queryContext: { topic: 'zabbix', hostname: ip, isFollowUp: ctx?.isFollowUp },
      }
    }
  }

  if (!targets.length) {
    return {
      content: [
        'Zabbix data is not available for your account.',
        '',
        'You need access to Infra Monitoring or Store Zabbix in NetPulse.',
        'Ask an admin to grant the `infra` or `storeZabbix` page permission.',
      ].join('\n'),
      contextMeta: [{ id: 'zabbix', label: 'Zabbix', freshness: 'live', fetchedAt, configured: false }],
      contextPreview: {},
      queryContext: { topic: 'zabbix', isFollowUp: ctx?.isFollowUp },
    }
  }

  const TYPE_LABEL = {
    cisco: 'Cisco devices',
    switch: 'Network switches',
    fortigate: 'FortiGate firewalls',
    checkpoint: 'CheckPoint FW',
    juniper: 'Juniper',
    network: 'Network devices',
    vm: 'Virtual machines',
    server: 'Servers',
    database: 'Databases',
    isp: 'ISP monitors',
    other: 'Other',
  }
  const filterLabel = deviceTypeFilter ? TYPE_LABEL[deviceTypeFilter] || deviceTypeFilter : null
  const diskReport = Boolean(scopedHostGroup && includeDisk && wantsDiskUsage(question))
  const bandwidthReport = Boolean(scopedHostGroup && includeBandwidth)
  const ipBandwidthReport = Boolean(bandwidthQuery && hostFilter && !scopedHostGroup && !cpuMemoryQuery)
  const ipCpuMemoryReport = Boolean(cpuMemoryQuery && hostFilter && !scopedHostGroup)
  const focusedMetricReport = ipCpuMemoryReport && !(metricScope.wantsCpu && metricScope.wantsMemory)
  const metricReportTitle = metricScope.wantsMemory && !metricScope.wantsCpu
    ? 'Memory utilization'
    : metricScope.wantsCpu && !metricScope.wantsMemory
      ? 'CPU utilization'
      : 'CPU / memory utilization'

  const lines = [
    alertsQuery
      ? `Infra Zabbix — active alerts & problems (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`
      : ipCpuMemoryReport
        ? `${metricReportTitle} — ${hostFilter} (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`
      : ipBandwidthReport
        ? `Interface bandwidth — ${hostFilter} (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`
      : diskReport
      ? `Disk usage report — host group: ${scopedHostGroup} (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`
      : bandwidthReport
        ? `Bandwidth / interface traffic — host group: ${scopedHostGroup} (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`
        : deepAnalysis && hostFilter
          ? `Infra Zabbix device analysis — ${hostFilter} (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`
          : `Infra Zabbix summary (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    filterLabel
      ? `Filter: ${filterLabel}`
      : scopedHostGroup
        ? `Host group: ${scopedHostGroup}`
        : alertsQuery
          ? 'Scope: all Infra Zabbix hosts (current triggers/problems)'
          : hostFilter
            ? `Host filter: ${hostFilter}`
            : 'All monitored hosts (network devices & servers)',
    '',
  ]

  if (isGroupFollowUp && /\bwhy|only|\d+\s+server/i.test(question)) {
    lines.push('  (Follow-up — re-fetched full host group membership from Zabbix, not device-type filter.)')
    lines.push('')
  }

  for (const { label, key, data } of results) {
    // Skip secondary sources (Store Zabbix) when they have no matching data — avoids cluttering output
    const isSecondary = key === 'storeZabbix'
    if (isSecondary && (!data.configured || data.error)) continue
    if (isSecondary && data.availability?.total === 0 && hostFilter) continue

    lines.push(`── ${label} ──`)
    if (!data.configured) {
      if (!isSecondary) {
        lines.push('  Not configured — set ZABBIX_URL + ZABBIX_API_TOKEN in .env')
        lines.push('')
      }
      continue
    }
    if (data.error) {
      lines.push(`  Unreachable: ${data.error}`)
      if (data.url) lines.push(`  URL: ${data.url}`)
      lines.push('')
      continue
    }

    if (focusedMetricReport && includeCpuMemory && data.cpuMemoryMetrics?.byHost) {
      const cm = data.cpuMemoryMetrics.byHost
      const sectionTitle = metricScope.wantsMemory && !metricScope.wantsCpu
        ? 'Memory utilization (Zabbix % items):'
        : metricScope.wantsCpu && !metricScope.wantsMemory
          ? 'CPU utilization (Zabbix % items):'
          : 'CPU / memory utilization (Zabbix % items):'
      lines.push(`  ${sectionTitle}`)
      const hostsForMetrics = data.matchedHosts?.length ? data.matchedHosts : data.hosts
      for (const h of hostsForMetrics) {
        const hid = String(h.hostid || '')
        const m = cm[hid]
        lines.push(`    ${h.name}:`)
        if (metricScope.wantsCpu) {
          if (m?.cpu) {
            lines.push(`      CPU: ${m.cpu.percent}% · ${m.cpu.itemName} · @ ${formatMetricClock(m.cpu.clock)}`)
          } else {
            lines.push('      CPU: no % item found (check Zabbix agent/template on this host)')
          }
        }
        if (metricScope.wantsMemory) {
          if (m?.memory) {
            lines.push(`      Memory: ${m.memory.percent}% · ${m.memory.itemName} · @ ${formatMetricClock(m.memory.clock)}`)
          } else {
            lines.push('      Memory: no % item found (check Zabbix agent/template on this host)')
          }
        }
      }
      if (!Object.keys(cm).length) {
        lines.push('    No matching utilization items on these hosts.')
      }
      lines.push('')
      continue
    }

    const a = data.availability
    const dt = data.deviceTypes || {}
    const dtDown = data.deviceTypeDown || {}

    const TYPE_LABEL = { cisco: 'Cisco devices', fortigate: 'FortiGate firewalls', checkpoint: 'CheckPoint FW', juniper: 'Juniper', network: 'Network devices', vm: 'Virtual machines', server: 'Servers', database: 'Databases', isp: 'ISP monitors', other: 'Other' }
    const TYPE_ORDER = ['cisco', 'fortigate', 'checkpoint', 'juniper', 'network', 'server', 'vm', 'database', 'isp', 'other']

    if (data.hostGroupFound === false) {
      lines.push(`  Host group "${data.hostGroupFilter}" not found in Zabbix.`)
      lines.push('  Open Infra Monitoring → Hosts and verify the exact group name.')
      lines.push('')
      continue
    }

    if (a.total === 0 && hostFilter) {
      lines.push(`  No monitored host matched "${hostFilter}" (searched name, host, and SNMP interface IP).`)
      lines.push('  Open Infra Monitoring → Hosts to verify the device is monitored in Zabbix.')
      lines.push('')
    }
    lines.push(`  Version: ${data.version || '—'}`)
    lines.push(`  Total monitored: ${a.total} · available ${a.available} · down ${a.unavailable} · unknown ${a.unknown}`)
    lines.push(`  Active problems: ${data.problemCount}`)

    if (data.problems.length) {
      const problemCap = alertsQuery ? 25 : (deepAnalysis ? data.problems.length : 8)
      lines.push(alertsQuery ? '  Current alerts/problems:' : (deepAnalysis ? '  Active problems (all matched):' : '  Top problems:'))
      for (const p of data.problems.slice(0, problemCap)) {
        const when = p.clock ? ` · since ${p.clock}` : ''
        lines.push(`    • [${p.severity}] ${p.name}${p.hosts ? ` · ${p.hosts}` : ''}${when}`)
      }
      if (data.problems.length > problemCap) {
        lines.push(`    … ${data.problems.length - problemCap} more (open Infra Monitoring → Problems)`)
      }
    } else if (alertsQuery) {
      lines.push('  No active problems/triggers in Zabbix right now.')
    }

    // Device type breakdown
    const typeEntries = TYPE_ORDER.filter(t => dt[t]).map(t => {
      const down = dtDown[t] ? ` ⚠ ${dtDown[t]} down` : ''
      return `    • ${TYPE_LABEL[t]}: ${dt[t]}${down}`
    })
    if (typeEntries.length) {
      lines.push('  Device breakdown:')
      typeEntries.forEach(e => lines.push(e))
    }
    if (data.hosts.length) {
      const hostTitle = scopedHostGroup
        ? `All hosts in group (${a.total}):`
        : filterLabel
          ? `${filterLabel}:`
          : 'Sample hosts (network devices first):'
      const hostLimit = scopedHostGroup ? 50 : (deviceTypeFilter === 'switch' ? 50 : 15)
      lines.push(`  ${hostTitle}`)
      for (const h of data.hosts.slice(0, hostLimit)) {
        const typeTag = h.type && h.type !== 'other' ? ` [${h.type}]` : ''
        lines.push(`    • ${h.name}${typeTag} — ${h.status}`)
      }
      if (a.total > hostLimit) lines.push(`    … and ${a.total - hostLimit} more (open Infra Monitoring → Hosts)`)
    }

    if (deepAnalysis && data.matchedHosts?.length) {
      lines.push('  Host details:')
      for (const h of data.matchedHosts) {
        const typeTag = h.type && h.type !== 'other' ? ` [${h.type}]` : ''
        lines.push(`    • ${h.name}${typeTag} — ${h.status}`)
        if (h.groups?.length) lines.push(`      Zabbix groups: ${h.groups.join(', ')}`)
        if (h.interfaceIps?.length) lines.push(`      Interface IPs: ${[...new Set(h.interfaceIps)].join(', ')}`)
      }
    }

    if (includePing && data.pingMetrics) {
      const pm = data.pingMetrics
      const s = pm.summary
      lines.push('  Ping / ICMP sensors (agent.ping · icmpping · meraki.device.status):')
      lines.push(`    Reachable: ${s.reachable} · Unreachable: ${s.unreachable} · Degraded: ${s.degraded || 0} · No data: ${s.noData} · Stale: ${s.stale}`)
      if (s.avgMs != null) lines.push(`    Latency avg: ${s.avgMs} ms · max: ${s.maxMs} ms (fresh polls, last ${PING_STALE_SEC / 60} min)`)

      const ranked = data.hosts
        .map(h => ({ ...h, ping: pm.byHost[h.hostid] }))
        .filter(h => h.ping)
        .sort((a, b) => {
          const rank = { unreachable: 0, degraded: 1, stale: 2, 'no data': 3, reachable: 4 }
          const ra = rank[a.ping.reach] ?? 4
          const rb = rank[b.ping.reach] ?? 4
          if (ra !== rb) return ra - rb
          return (b.ping.ms ?? -1) - (a.ping.ms ?? -1)
        })

      if (ranked.length) {
        lines.push('  Ping status by host:')
        const pingLimit = deviceTypeFilter === 'switch' ? 50 : 25
        for (const h of ranked.slice(0, pingLimit)) {
          lines.push(formatPingLine(h.name, h.ping))
        }
        if (ranked.length > pingLimit) lines.push(`    … ${ranked.length - pingLimit} more hosts with ping items`)
      } else {
        lines.push('  No ping/ICMP/Meraki status items found on these hosts.')
      }
    }

    if (includeCpuMemory && data.cpuMemoryMetrics?.byHost) {
      const cm = data.cpuMemoryMetrics.byHost
      const sectionTitle = metricScope.wantsMemory && !metricScope.wantsCpu
        ? 'Memory utilization (Zabbix % items):'
        : metricScope.wantsCpu && !metricScope.wantsMemory
          ? 'CPU utilization (Zabbix % items):'
          : 'CPU / memory utilization (Zabbix % items):'
      lines.push(`  ${sectionTitle}`)
      const hostsForMetrics = data.matchedHosts?.length ? data.matchedHosts : data.hosts
      for (const h of hostsForMetrics) {
        const hid = String(h.hostid || '')
        const m = cm[hid]
        lines.push(`    ${h.name}:`)
        if (metricScope.wantsCpu) {
          if (m?.cpu) {
            lines.push(`      CPU: ${m.cpu.percent}% · ${m.cpu.itemName} · @ ${formatMetricClock(m.cpu.clock)}`)
          } else {
            lines.push('      CPU: no % item found (check Zabbix agent/template on this host)')
          }
        }
        if (metricScope.wantsMemory) {
          if (m?.memory) {
            lines.push(`      Memory: ${m.memory.percent}% · ${m.memory.itemName} · @ ${formatMetricClock(m.memory.clock)}`)
          } else {
            lines.push('      Memory: no % item found (check Zabbix agent/template on this host)')
          }
        }
      }
      if (!Object.keys(cm).length) {
        lines.push('    No matching utilization items on these hosts.')
      }
    }

    if (includeBandwidth && data.interfaceMetrics?.byHost) {
      const ifm = data.interfaceMetrics.byHost
      const nameMap = data.interfaceMetrics.indexToNameByHost || {}
      lines.push('  Interface traffic (net.if.in / net.if.out):')
      if (!Object.keys(ifm).length && data.hosts.every(h => h.status === 'unavailable' || h.status === 'down')) {
        lines.push('    Host(s) unavailable — no SNMP/interface data while device is down.')
      }
      for (const h of data.hosts) {
        const hid = String(h.hostid || '')
        const ifaces = ifm[hid]
        if (!ifaces) continue
        lines.push(`    ${h.name}:`)
        const hostNames = nameMap[hid] || {}
        const entries = Object.entries(ifaces).sort((a, b) => {
          const aUp = a[1].status === 'up', bUp = b[1].status === 'up'
          if (aUp && !bUp) return -1
          if (bUp && !aUp) return 1
          return (b[1].in ?? 0) - (a[1].in ?? 0)
        })
        let shown = 0
        for (const [idx, m] of entries) {
          if (m.in == null && m.out == null && m.status !== 'up') continue
          if (shown >= 40) { lines.push(`      … more interfaces`); break }
          const label = hostNames[idx] || idx
          const inVal = m.in != null ? formatBytesPerSec(m.in) : '—'
          const outVal = m.out != null ? formatBytesPerSec(m.out) : '—'
          const st = m.status ? ` · ${m.status}` : ''
          lines.push(`      • ${label} · in ${inVal} · out ${outVal}${st}`)
          shown++
        }
      }
      if (!Object.keys(ifm).length) {
        lines.push('    No net.if.in/out items found for matched hosts.')
      }
    }

    if (includeDisk && data.diskMetrics?.rows?.length) {
      const diskRows = data.diskMetrics.rows
      const critical = diskRows.filter(r => r.percent >= 90).length
      const high = diskRows.filter(r => r.percent >= 75 && r.percent < 90).length
      lines.push(`  Disk usage (vfs.fs.size — highest filesystem per host):`)
      lines.push(`    Hosts with data: ${diskRows.length} · Critical (≥90%): ${critical} · High (75–90%): ${high}`)
      const hostById = Object.fromEntries((data.matchedHosts || []).map(h => [h.hostid, h.name]))
      const diskLimit = scopedHostGroup ? 50 : 25
      for (const row of diskRows.slice(0, diskLimit)) {
        const hostName = hostById[row.hostid] || row.hostid
        lines.push(formatDiskLine(hostName, row))
      }
      if (diskRows.length > diskLimit) lines.push(`    … ${diskRows.length - diskLimit} more hosts with disk items`)
      if (scopedHostGroup && data.matchedHosts?.length) {
        const diskHostIds = new Set(diskRows.map(r => String(r.hostid)))
        const noDisk = data.matchedHosts.filter(h => !diskHostIds.has(String(h.hostid)))
        if (noDisk.length) {
          lines.push(`    Hosts without disk items: ${noDisk.length}`)
          for (const h of noDisk.slice(0, 20)) {
            const typeTag = h.type && h.type !== 'other' ? ` [${h.type}]` : ''
            lines.push(`      • ${h.name}${typeTag} — no vfs.fs.size data`)
          }
          if (noDisk.length > 20) lines.push(`      … ${noDisk.length - 20} more without disk metrics`)
        }
      }
    } else if (includeDisk) {
      lines.push('  No disk/filesystem usage items (vfs.fs.size) found on matched hosts.')
    }

    if (data.problems.length && !alertsQuery) {
      const problemCap = deepAnalysis ? data.problems.length : 8
      lines.push(deepAnalysis ? '  Active problems (all matched):' : '  Top problems:')
      for (const p of data.problems.slice(0, problemCap)) {
        const when = p.clock ? ` · since ${p.clock}` : ''
        lines.push(`    • [${p.severity}] ${p.name}${p.hosts ? ` · ${p.hosts}` : ''}${when}`)
      }
      if (!deepAnalysis && data.problems.length > problemCap) {
        lines.push(`    … ${data.problems.length - problemCap} more (open Infra Monitoring → Problems)`)
      }
    }
    lines.push('')
  }

  // ISP / store connectivity data
  if (ispData) {
    const cb = ispData.connBreakdown || {}
    const ispDown = cb.isp_down || 0
    const hotspot = cb.hotspot || 0
    const noConn = cb.no_connectivity || 0
    const lanHealthy = cb.lan_healthy || 0
    lines.push('── Store ISP / Connectivity (Store Monitor LIVE) ──')
    lines.push(`  ISP / internet down: ${ispDown}`)
    lines.push(`  Hotspot (mobile fallback): ${hotspot}`)
    lines.push(`  No connectivity: ${noConn}`)
    lines.push(`  LAN healthy: ${lanHealthy}`)
    const other = (ispData.total || 0) - ispDown - hotspot - noConn - lanHealthy
    if (other > 0) lines.push(`  Other states: ${other}`)
    lines.push('')
  } else if (wantsIsp) {
    lines.push('── ISP data ──')
    lines.push('  ISP connectivity data is from Store Monitor (InfluxDB) — enable it above or ask "how many stores have ISP down".')
    lines.push('')
  }

  lines.push('(Direct answer from live Zabbix API — no LLM wait.)')

  const preview = {}
  for (const { key, data } of results) {
    if (data.configured && !data.error && data.availability) {
      preview[key] = {
        total: data.availability.total,
        available: data.availability.available,
        unavailable: data.availability.unavailable,
        problems: data.problemCount,
      }
    }
  }

  const okResults = results.filter(r => r.data.configured && !r.data.error && r.data.availability)
  if (!okResults.length) {
    lines.push('No Zabbix server responded. Check ZABBIX_URL / STORE_ZABBIX_URL in .env and network access from the NetPulse server.')
  }

  const contextMeta = okResults.map(r => ({
    id: r.key === 'storeZabbix' ? 'storeZabbix' : 'zabbix',
    label: r.label,
    freshness: 'live',
    fetchedAt,
    configured: true,
    note: `${r.data.availability.total} hosts · ${r.data.problemCount} problems`,
  }))
  if (ispData) {
    contextMeta.push({ id: 'storeMonitor', label: 'Store Monitor (ISP)', freshness: 'live', fetchedAt, configured: true, note: `ISP down: ${ispData.connBreakdown?.isp_down ?? 0}` })
  }

  return {
    content: lines.join('\n'),
    contextMeta,
    contextPreview: { zabbix: preview },
    queryContext: { topic: 'zabbix', hostname: hostFilter || undefined, isFollowUp: ctx?.isFollowUp },
  }
}

function hostPortsFromSnapshot(data, host) {
  const hid = String(host.hostid || '')
  const ifaces = data.interfaceMetrics?.byHost?.[hid] || {}
  const nameMap = data.interfaceMetrics?.indexToNameByHost?.[hid] || {}
  return Object.entries(ifaces)
    .filter(([, m]) => m.in != null || m.out != null || m.status != null)
    .sort((a, b) => {
      // sort: up first, then by inbps desc
      const sa = a[1].status, sb = b[1].status
      if (sa === 'up' && sb !== 'up') return -1
      if (sb === 'up' && sa !== 'up') return 1
      return (b[1].in ?? 0) - (a[1].in ?? 0)
    })
    .map(([idx, m]) => ({
      interface: nameMap[idx] || idx,
      inBps: m.in,
      outBps: m.out,
      inRate: formatBytesPerSec(m.in),
      outRate: formatBytesPerSec(m.out),
      inItemId: m.inItem?.itemid || null,
      outItemId: m.outItem?.itemid || null,
      status: m.status || null,
    }))
}

function buildInterfaceMetricsState(data, matchedHosts, includeBandwidth) {
  if (!includeBandwidth) {
    return {
      available: null,
      reason: 'not_requested',
      nextAction: 'Add keywords like "interfaces", "traffic", "bandwidth", or "throughput" to request net.if metrics.',
    }
  }

  const hosts = Array.isArray(matchedHosts) ? matchedHosts : []
  if (!hosts.length) {
    return {
      available: false,
      reason: 'no_hosts',
      checkedHosts: 0,
      hostsWithAnyItems: 0,
      hostsWithTraffic: 0,
      trafficPorts: 0,
      freshTrafficPorts: 0,
      staleTrafficPorts: 0,
      staleThresholdSec: INTERFACE_STALE_SEC,
      nextAction: 'No matching hosts were returned. Refine hostname/IP filter or verify host exists in this Zabbix scope.',
    }
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const byHost = data?.interfaceMetrics?.byHost || {}
  let checkedHosts = 0
  let hostsWithAnyItems = 0
  let hostsWithTraffic = 0
  let trafficPorts = 0
  let freshTrafficPorts = 0
  let staleTrafficPorts = 0

  for (const h of hosts) {
    const hid = String(h?.hostid || '')
    if (!hid) continue
    checkedHosts += 1
    const rows = Object.values(byHost[hid] || {})
    if (rows.length) hostsWithAnyItems += 1

    let hostHasTraffic = false
    for (const m of rows) {
      const hasTraffic = Number.isFinite(m?.in) || Number.isFinite(m?.out)
      if (!hasTraffic) continue
      hostHasTraffic = true
      trafficPorts += 1
      const poll = Math.max(Number(m?.inPoll) || 0, Number(m?.outPoll) || 0)
      if (poll > 0 && (nowSec - poll) > INTERFACE_STALE_SEC) staleTrafficPorts += 1
      else freshTrafficPorts += 1
    }
    if (hostHasTraffic) hostsWithTraffic += 1
  }

  if (trafficPorts === 0) {
    return {
      available: false,
      reason: 'no_net_if_items',
      checkedHosts,
      hostsWithAnyItems,
      hostsWithTraffic,
      trafficPorts,
      freshTrafficPorts,
      staleTrafficPorts,
      staleThresholdSec: INTERFACE_STALE_SEC,
      nextAction: 'Enable and monitor SNMP traffic items (net.if.in/out[...]) on the host template; verify item status is enabled and supported.',
    }
  }

  if (freshTrafficPorts === 0 && staleTrafficPorts > 0) {
    return {
      available: false,
      reason: 'items_stale',
      checkedHosts,
      hostsWithAnyItems,
      hostsWithTraffic,
      trafficPorts,
      freshTrafficPorts,
      staleTrafficPorts,
      staleThresholdSec: INTERFACE_STALE_SEC,
      nextAction: `net.if traffic items exist but are stale (> ${INTERFACE_STALE_SEC}s). Check SNMP reachability, credentials, and item update intervals.`,
    }
  }

  return {
    available: true,
    reason: staleTrafficPorts > 0 ? 'partial_stale' : 'ok',
    checkedHosts,
    hostsWithAnyItems,
    hostsWithTraffic,
    trafficPorts,
    freshTrafficPorts,
    staleTrafficPorts,
    staleThresholdSec: INTERFACE_STALE_SEC,
    nextAction: staleTrafficPorts > 0
      ? `Some net.if traffic items are stale (> ${INTERFACE_STALE_SEC}s); verify polling health for affected interfaces.`
      : 'Traffic metrics are available.',
  }
}

function buildCpuMemoryMetricsState(data, matchedHosts, includeCpuMemory, storeAgentMetrics) {
  if (!includeCpuMemory) {
    return {
      available: null,
      reason: 'not_requested',
      nextAction: 'Add keywords like "cpu", "memory", "ram", or "utilization" to request CPU/RAM metrics.',
    }
  }

  const cm = data?.cpuMemoryMetrics?.byHost || {}
  const hosts = Array.isArray(matchedHosts) ? matchedHosts : []
  let hostsWithCpu = 0
  let hostsWithMemory = 0
  let primaryZabbix = null
  const zabbixHosts = []

  for (const h of hosts) {
    const m = cm[String(h?.hostid || '')]
    if (m?.cpu) hostsWithCpu += 1
    if (m?.memory) hostsWithMemory += 1
    if (!m?.cpu && !m?.memory) continue
    const row = {
      hostid: h.hostid,
      name: h.name,
      host: h.host,
      cpu: formatCpuMemoryMetric(m.cpu),
      memory: formatCpuMemoryMetric(m.memory),
    }
    zabbixHosts.push(row)
    if (!primaryZabbix) primaryZabbix = row
  }

  const zabbixAvailable = hostsWithCpu > 0 || hostsWithMemory > 0
  const agentAvailable = Boolean(
    storeAgentMetrics && (storeAgentMetrics.cpuPct != null || storeAgentMetrics.memPct != null),
  )

  const zabbix = {
    available: zabbixAvailable,
    source: 'Zabbix % utilization items (system.cpu.util / vm.memory.utilization)',
    checkedHosts: hosts.length,
    hostsWithCpu,
    hostsWithMemory,
    hosts: zabbixHosts,
    primary: primaryZabbix,
  }

  const storeAgent = storeAgentMetrics
    ? {
      available: agentAvailable,
      source: storeAgentMetrics.source,
      hostname: storeAgentMetrics.hostname,
      storeTag: storeAgentMetrics.storeTag,
      cpuPct: storeAgentMetrics.cpuPct ?? null,
      memPct: storeAgentMetrics.memPct ?? null,
      online: storeAgentMetrics.online ?? null,
    }
    : null

  const available = zabbixAvailable || agentAvailable

  let reason = 'no_cpu_mem_items'
  if (zabbixAvailable && agentAvailable) reason = 'zabbix_and_store_agent'
  else if (zabbixAvailable) reason = 'zabbix_items'
  else if (agentAvailable) reason = 'store_agent'
  else if (storeAgentMetrics) reason = 'no_metrics'

  const display = {
    cpuPct: storeAgent?.cpuPct ?? primaryZabbix?.cpu?.percent ?? null,
    memPct: storeAgent?.memPct ?? primaryZabbix?.memory?.percent ?? null,
    cpuSource: storeAgent?.cpuPct != null
      ? 'store_agent'
      : (primaryZabbix?.cpu ? 'zabbix' : null),
    memSource: storeAgent?.memPct != null
      ? 'store_agent'
      : (primaryZabbix?.memory ? 'zabbix' : null),
  }

  let nextAction = 'No CPU/RAM from Zabbix items or store agent.'
  if (zabbixAvailable && agentAvailable) {
    nextAction = 'CPU/RAM available from both Zabbix (network gear / monitored host templates) and Store Monitor agent (store PC). Prefer storeAgent for POS PC; hosts[].cpu/memory for Zabbix-monitored devices.'
  } else if (zabbixAvailable) {
    nextAction = 'CPU/RAM from Zabbix utilization items on matched hosts. See hosts[].cpu and hosts[].memory.'
  } else if (agentAvailable) {
    nextAction = 'Store PC CPU/RAM from PowerShell agent heartbeat (~5 min). No Zabbix % items on matched hosts.'
  } else if (storeAgentMetrics) {
    nextAction = 'Store found in Influx but agent is not reporting cpu_usage_pct/mem_used_pct, and no Zabbix CPU/memory % items on matched hosts.'
  } else if (hosts.length) {
    nextAction = 'No Zabbix CPU/memory % items on matched hosts. Store PC metrics may be in netpulse_storeMonitor (Influx agent).'
  } else {
    nextAction = 'No matching hosts. Refine hostname filter or verify the device exists in this Zabbix scope.'
  }

  return {
    available,
    reason,
    zabbix,
    storeAgent,
    display,
    nextAction,
  }
}

/**
 * Live Zabbix JSON for LLM synthesis (bandwidth, interface analysis, etc.).
 * @param {string} userMessage
 */
/**
 * Shared snapshot-builder used by both Infra Zabbix and Store Zabbix module
 * exporters. The two flavors differ only in which env-var-backed Zabbix
 * client they hit and how the result is labelled, so we centralise the
 * snapshot logic here to keep them in lockstep.
 */
async function buildZabbixContextFromClient({ moduleId, envName, sourceLabel, missingError }, userMessage = '', opts = {}) {
  const fetchedAt = new Date().toISOString()
  const client = createZabbixClient(envName)
  if (!client.isZabbixConfigured()) {
    return {
      module: moduleId,
      freshness: 'live',
      fetchedAt,
      configured: false,
      error: missingError,
    }
  }

  const ip = extractIpv4(userMessage)
  const hostname = extractStoreHostname(userMessage)
  const deviceTypeFilter = detectDeviceTypeFilter(userMessage)
  // For store-centric questions like "RP973 ping/interfaces", hostname filter
  // is the critical selector. Without this, we'd fetch broad host sets and the
  // resulting item.get fan-out could exceed Claude Desktop's tool timeout.
  const hostFilter = ip || hostname || ''
  const resolvedQueryWindow = opts.queryWindow || resolveQueryWindow(userMessage, opts.queryContext, opts)
  const includeInterfaceHistory = shouldIncludeInterfaceHistory(userMessage, opts)
  const includeCpuMemoryHistory = shouldIncludeCpuMemoryHistory(userMessage, opts)
  const includePing = wantsPingStatus(userMessage)
    || /\b(ping|icmp|latency|packet\s*loss|uptime|availability|drops?|disconnect)\b/i.test(String(userMessage || ''))
    || (Boolean(hostFilter) && hasQueryHistoryWindow(resolvedQueryWindow))
  const includeBandwidth = wantsBandwidthUtil(userMessage)
    || /\b(bandwidth|utilization|utilisation|interface|port|traffic|throughput)\b/i.test(String(userMessage || ''))
    || includeInterfaceHistory
  const includeCpuMemory = wantsCpuMemoryUtil(userMessage)
    || /\b(cpu|memory|mem|ram)\b/i.test(String(userMessage || ''))
    || Boolean(hostFilter)
    || includeCpuMemoryHistory
  // Host-detail queries do not need problem.get every time; that call can be
  // expensive on some Zabbix deployments and is only useful when alerts are
  // explicitly requested or for broad overviews with no host filter.
  const broadQuery = !hostFilter
  const inventoryLite = moduleId === 'storeZabbix' && broadQuery && shouldUseLiteZabbixInventory(userMessage)
  const includeProblems = wantsZabbixAlertsQuery(userMessage)
    || (broadQuery && !inventoryLite)

  const data = await fetchZabbixSnapshot(client, {
    hostFilter,
    deviceTypeFilter,
    includePing,
    includeBandwidth,
    includeCpuMemory,
    includeProblems,
    inventoryLite,
  })

  if (!data.configured) {
    return { module: moduleId, freshness: 'live', fetchedAt, configured: false, error: `${sourceLabel} not configured` }
  }
  if (data.error) {
    return {
      module: moduleId,
      freshness: 'live',
      fetchedAt,
      configured: true,
      error: data.error,
      errorCode: data.errorCode || null,
      hint: data.hint || null,
      url: data.url || null,
    }
  }

  const matched = data.matchedHosts || []
  const cmByHost = data.cpuMemoryMetrics?.byHost || {}

  let storeAgentMetrics = null
  if (moduleId === 'storeZabbix' && hostname && isInfluxStoreConfigured()) {
    try {
      const stores = await fetchStoreSnapshot(10, '-1h')
      const store = stores.find(s => storeRecordMatchesHostname(s, hostname))
      if (store) {
        storeAgentMetrics = {
          hostname: store.hostname,
          storeTag: store.storeTag,
          cpuPct: store.cpuPct ?? null,
          memPct: store.memPct ?? null,
          online: store.online,
          source: 'Influx store agent (Store Monitor)',
        }
      }
    } catch {
      // Non-fatal — Zabbix context still returns without agent metrics.
    }
  }

  const historyWindowForFetch = (includeCpuMemoryHistory || includeInterfaceHistory)
    ? parseZabbixHistoryWindow(userMessage, { ...opts, queryWindow: resolvedQueryWindow })
    : null
  const pastHistoricalQuery = isPastHistoricalWindow(historyWindowForFetch)

  const hosts = matched.map(h => {
    const hid = String(h.hostid)
    const zabbixCm = cmByHost[hid]
    const cpuMetric = includeCpuMemory ? formatCpuMemoryMetric(zabbixCm?.cpu) : undefined
    const memoryMetric = includeCpuMemory ? formatCpuMemoryMetric(zabbixCm?.memory) : undefined
    if (pastHistoricalQuery) {
      if (cpuMetric) {
        cpuMetric.source = 'live_lastvalue'
        cpuMetric.note = 'Current Zabbix poll — use cpuAtSession or cpuMemoryHistory.sessionSnapshot for the requested window.'
      }
      if (memoryMetric) {
        memoryMetric.source = 'live_lastvalue'
        memoryMetric.note = 'Current Zabbix poll — use memoryAtSession or cpuMemoryHistory.sessionSnapshot for the requested window.'
      }
    }
    return {
      hostid: h.hostid,
      name: h.name,
      host: h.host,
      status: h.status,
      type: h.type,
      interfaceIps: h.interfaceIps,
      groups: h.groups,
      ping: includePing && data.pingMetrics?.byHost?.[hid]
        ? {
          reach: data.pingMetrics.byHost[hid].reach,
          ms: data.pingMetrics.byHost[hid].ms,
          loss: data.pingMetrics.byHost[hid].loss,
          source: data.pingMetrics.byHost[hid].source,
        }
        : undefined,
      ports: includeBandwidth ? hostPortsFromSnapshot(data, h) : undefined,
      cpu: cpuMetric,
      memory: memoryMetric,
    }
  })
  const interfaceMetricsState = buildInterfaceMetricsState(data, matched, includeBandwidth)
  const cpuMemoryMetricsState = buildCpuMemoryMetricsState(data, matched, includeCpuMemory, storeAgentMetrics)

  let cpuMemoryHistory = null
  let interfaceHistory = null
  let pingHistory = null
  let uptimeHistory = null
  const historyWindow = historyWindowForFetch
  const historyMaxPoints = historyWindow
    ? historyMaxPointsForRange(historyWindow.rangeSec)
    : 120
  const historyItemIds = parseHistoryItemIds(userMessage)

  if (includeCpuMemoryHistory && historyWindow) {
    try {
      if (historyItemIds.length) {
        cpuMemoryHistory = await fetchCpuMemoryHistoryByItemIds(
          client.zabbixRpc,
          historyItemIds,
          historyWindow,
          historyMaxPoints,
        )
      } else if (matched.length && data.cpuMemoryMetrics?.byHost) {
        cpuMemoryHistory = await fetchCpuMemoryHistory(
          client.zabbixRpc,
          data.cpuMemoryMetrics,
          matched,
          historyWindow,
          historyMaxPoints,
        )
      }
      if (cpuMemoryHistory) {
        enrichCpuMemoryHistoryWithSessionSnapshot(cpuMemoryHistory, historyWindow)
        applySessionCpuMemoryToHosts(hosts, cpuMemoryHistory)
      }
    } catch (err) {
      cpuMemoryHistory = {
        windowSec: historyWindow.rangeSec,
        windowLabel: historyWindow.windowLabel,
        parseNote: historyWindow.parseNote,
        from: historyWindow.from,
        to: historyWindow.to,
        hosts: [],
        items: [],
        error: err?.message || 'Failed to fetch Zabbix CPU/memory history',
      }
    }
  }

  if (includePing && historyWindow && data.pingMetrics?.items) {
    try {
      const hostids = matched.map((h) => String(h.hostid))
      pingHistory = await fetchPingHistorySnapshot(
        client.zabbixRpc,
        data.pingMetrics.items,
        hostids,
        historyWindow,
      )
      if (pingHistory) applySessionPingToHosts(hosts, pingHistory)
    } catch (err) {
      pingHistory = {
        windowSec: historyWindow.rangeSec,
        windowLabel: historyWindow.windowLabel,
        from: historyWindow.from,
        to: historyWindow.to,
        byHost: {},
        error: err?.message || 'Failed to fetch Zabbix ping history',
      }
    }
  }

  if (historyWindow && matched.length) {
    try {
      uptimeHistory = await fetchUptimeHistorySnapshot(
        client.zabbixRpc,
        matched,
        historyWindow,
        historyMaxPoints,
      )
      if (uptimeHistory) applySessionUptimeToHosts(hosts, uptimeHistory)
    } catch (err) {
      uptimeHistory = {
        windowSec: historyWindow.rangeSec,
        windowLabel: historyWindow.windowLabel,
        from: historyWindow.from,
        to: historyWindow.to,
        hosts: [],
        diagnostics: { error: err?.message || 'Failed to fetch Zabbix uptime history' },
      }
    }
  }

  if (includeInterfaceHistory && historyWindow) {
    try {
      if (historyItemIds.length) {
        interfaceHistory = await fetchInterfaceHistoryByItemIds(
          client.zabbixRpc,
          historyItemIds,
          historyWindow,
          historyMaxPoints,
        )
      } else if (matched.length && data.interfaceMetrics?.byHost) {
        interfaceHistory = await fetchInterfaceHistory(
          client.zabbixRpc,
          data.interfaceMetrics,
          matched,
          historyWindow,
          historyMaxPoints,
        )
      }
    } catch (err) {
      interfaceHistory = {
        windowSec: historyWindow.rangeSec,
        windowLabel: historyWindow.windowLabel,
        parseNote: historyWindow.parseNote,
        from: historyWindow.from,
        to: historyWindow.to,
        hosts: [],
        items: [],
        error: err?.message || 'Failed to fetch Zabbix interface history',
      }
    }
  }

  return {
    module: moduleId,
    freshness: historyWindow?.from && historyWindow?.to
      && historyWindow.to < Math.floor(Date.now() / 1000) - 3600
      ? 'historical'
      : 'live',
    fetchedAt,
    configured: true,
    queryWindow: formatQueryWindowMeta(resolvedQueryWindow),
    source: `${sourceLabel} API (host.get + item.get net.if.*)`,
    note: moduleId === 'storeZabbix'
      ? 'Session window data (use these for past sessions, NOT live hosts[].cpu/memory/ping which is current poll): hosts[].cpuAtSession / memoryAtSession (Zabbix CPU/RAM history.get) · hosts[].pingAtSession (Zabbix agent.ping/icmpping history → uptimePct, avgMs, avgLossPct) · cpuMemoryHistory · interfaceHistory · pingHistory · disconnectEvents (BH or query-window-overlap mode). storeAgentMetrics = Influx agent snapshot (alternate source).'
      : 'Live SNMP/interface metrics at send time. For past windows use cpuMemoryHistory.sessionSnapshot / cpuAtSession and pingHistory (Zabbix agent.ping/icmpping history). interfaceHistory provides historical net.if series when an absolute window or trend/history keywords are used.',
    version: data.version,
    hostFilter: data.hostFilter,
    deviceTypeFilter: data.deviceTypeFilter,
    availability: data.availability,
    monitoredHostTotal: data.monitoredHostTotal ?? data.availability?.total ?? null,
    hostsReturned: data.hostsReturned ?? (data.matchedHosts || []).length,
    hostsListTruncated: data.hostsListTruncated ?? false,
    hostsListCap: data.hostsListCap ?? null,
    inventoryTruncated: data.inventoryTruncated ?? false,
    deviceTypes: data.deviceTypes,
    problemCount: data.problemCount,
    problems: (data.problems || []).slice(0, 10),
    hosts,
    storeAgentMetrics,
    interfaceMetricsState,
    cpuMemoryMetricsState,
    cpuMemoryHistory,
    interfaceHistory,
    pingHistory,
    uptimeHistory,
    pingSummary: includePing && data.pingMetrics ? data.pingMetrics.summary : undefined,
  }
}

export async function buildZabbixInfraContext(userMessage = '', opts = {}) {
  return buildZabbixContextFromClient({
    moduleId: 'zabbixInfra',
    envName: 'ZABBIX',
    sourceLabel: 'Infra Zabbix',
    missingError: 'ZABBIX_URL + ZABBIX_API_TOKEN not configured',
  }, userMessage, opts)
}

function isDisconnectFocusedQuery(userMessage) {
  const msg = String(userMessage || '').trim()
  if (!msg) return false
  const disconnectKw = /\b(disconnect|disconn|went down|back up|came back|still offline|active disconnect|offline event|rop|uptime|bh duration|business hour)\b/i
  const zabbixKw = /\b(ping|interface|bandwidth|cpu|memory|host count|how many host|zabbix|unavailable host|snmp|port status|alert|problem)\b/i
  return disconnectKw.test(msg) && !zabbixKw.test(msg)
}

function shouldUseLiteZabbixInventory(userMessage) {
  const msg = String(userMessage || '').trim()
  const detailKw = /\b(ping|interface|bandwidth|cpu|memory|alert|problem|host list|list host|show host|all host|device type|switch)\b/i
  return !detailKw.test(msg)
}

async function buildStoreZabbixZabbixStub(userMessage = '') {
  const fetchedAt = new Date().toISOString()
  const client = createZabbixClient('STORE_ZABBIX')
  if (!client.isZabbixConfigured()) {
    return {
      module: 'storeZabbix',
      freshness: 'live',
      fetchedAt,
      configured: false,
      error: 'STORE_ZABBIX_URL + STORE_ZABBIX_API_TOKEN not configured',
      zabbixSkipped: true,
      zabbixSkipReason: 'disconnect-focused query — Zabbix host inventory skipped for MCP latency',
    }
  }
  let reachable = null
  try {
    const ping = await client.zabbixPing({ timeoutMs: 6000 })
    reachable = Boolean(ping?.ok)
  } catch {
    reachable = false
  }
  return {
    module: 'storeZabbix',
    freshness: 'live',
    fetchedAt,
    configured: true,
    zabbixSkipped: true,
    zabbixSkipReason: 'disconnect-focused query — Zabbix host inventory skipped for MCP latency',
    zabbixReachable: reachable,
    error: reachable ? null : 'Store Zabbix API unreachable',
  }
}

export async function buildStoreZabbixContext(userMessage = '', opts = {}) {
  const disconnectBlock = await buildStoreDisconnectMcpContext(userMessage, opts)
  const crashBlock = await buildStoreCrashMcpContext(userMessage, opts, opts.queryContext || null)
  const hostScope = extractIpv4(userMessage) || extractStoreHostname(userMessage)
  const skipZabbixInventory = isDisconnectFocusedQuery(userMessage) && !hostScope

  const zabbixBlock = skipZabbixInventory
    ? await buildStoreZabbixZabbixStub(userMessage)
    : await buildZabbixContextFromClient({
      moduleId: 'storeZabbix',
      envName: 'STORE_ZABBIX',
      sourceLabel: 'Store Zabbix',
      missingError: 'STORE_ZABBIX_URL + STORE_ZABBIX_API_TOKEN not configured',
    }, userMessage, opts)

  const zabbixConfigured = zabbixBlock.configured !== false
  const zabbixError = zabbixBlock.error || null

  return {
    ...zabbixBlock,
    ...disconnectBlock,
    ...crashBlock,
    module: 'storeZabbix',
    configured: disconnectBlock.disconnectConfigured !== false || zabbixConfigured,
    zabbixConfigured,
    zabbixReachable: zabbixConfigured && !zabbixError,
    zabbixError,
    note: [
      disconnectBlock.disconnectNote,
      crashBlock.crashNote,
      zabbixConfigured && !zabbixError
        ? 'Zabbix host metrics (ping, interfaces, CPU/RAM) from STORE_ZABBIX API.'
        : (zabbixError || 'Zabbix metrics unavailable — set STORE_ZABBIX_URL + STORE_ZABBIX_API_TOKEN in server .env.'),
      'Disconnect events/activeDisconnectEvents use Mongo BH rules (same as Store Zabbix ROP tab) and do not require Zabbix.',
    ].filter(Boolean).join(' '),
  }
}
