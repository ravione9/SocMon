import { createZabbixClient } from '../../services/zabbix.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'
import { isInfluxStoreConfigured, fetchStoreSnapshot, buildOverviewSummary } from '../influxStore.js'
import { extractStoreHostname, isStoreHostnamePortalQuery } from './queryContext.js'
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
  if (IPV4_RE.test(s)) {
    return (h.interfaces || []).some(i => String(i.ip || '') === s)
  }
  return false
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
      row.in = v; row.inPoll = clock
    }
  }
  for (const it of outItems || []) {
    const hid = String(it.hostid)
    const idx = snmpIndexFromKey(it.key_)
    const row = ensure(hid, idx)
    const v = parseFloat(it.lastvalue)
    const clock = Number(it.lastclock) || 0
    if (Number.isFinite(v) && (row.outPoll == null || clock >= row.outPoll)) {
      row.out = v; row.outPoll = clock
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
]
const MEMORY_INVERT_KEY_RE = /pavailable/i

function readPctUtilItem(it, inverted = false) {
  const u = String(it.units || '').trim()
  if (u !== '%' && !/%/.test(u)) return null
  const v = parseFloat(it.lastvalue)
  if (!Number.isFinite(v)) return null
  const pct = inverted ? 100 - v : v
  return Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10
}

function pickHostPctMetric(itemRows, hostid, patterns, invertRe = null) {
  for (const re of patterns) {
    let best = null
    for (const it of itemRows) {
      if (String(it.hostid) !== String(hostid)) continue
      const key = String(it.key_ || '')
      if (!re.test(key)) continue
      const inverted = invertRe && invertRe.test(key)
      const pct = readPctUtilItem(it, inverted)
      if (pct == null) continue
      const clock = Number(it.lastclock) || 0
      if (!best || clock >= best.clock) {
        best = {
          percent: pct,
          itemName: it.name || key,
          key,
          clock,
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
  const hosts = await zabbixRpc('host.get', { ...baseParams, groupids, limit: 500 })
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
      output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock', 'name', 'units'],
      search: { key_: `${searchKey}*` },
      searchWildcardsEnabled: true,
      limit: 500,
    })
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
  ] = await Promise.all([
    fetchItemsChunked(zabbixRpc, hostids, 'agent.ping'),
    fetchItemsChunked(zabbixRpc, hostids, 'custom.ping.loss'),
    fetchItemsChunked(zabbixRpc, hostids, 'custom.ping.ms'),
    fetchItemsChunked(zabbixRpc, hostids, 'icmpping'),
    fetchItemsChunked(zabbixRpc, hostids, 'icmppingloss'),
    fetchItemsChunked(zabbixRpc, hostids, 'icmppingsec'),
    fetchItemsChunked(zabbixRpc, hostids, 'meraki.device.status'),
  ])
  const nowSec = Math.floor(Date.now() / 1000)
  const agentMap = buildHostMetricMap(agentPingItems, hostids)
  const lossMap = buildHostMetricMap(pingLossItems, hostids)
  const msMap = buildHostMetricMap(pingMsItems, hostids)
  const icmpMap = buildHostMetricMap(filterExactItemKey(icmpPingItems, 'icmpping'), hostids)
  const icmpLossMap = buildHostMetricMap(filterExactItemKey(icmpLossItems, 'icmppingloss'), hostids)
  const icmpSecMap = buildHostMetricMap(filterExactItemKey(icmpSecItems, 'icmppingsec'), hostids)
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
    const customLoss = pickFreshMetric(lossCls, hid)
    const icmpLoss = pickFreshMetric(icmpLossCls, hid)

    let ms = null
    let loss = null
    if (!customMs.stale && customMs.value != null && customMs.value >= 0) {
      ms = customMs.value
    } else if (!icmpSec.stale && icmpSec.value != null && icmpSec.value >= 0) {
      ms = Math.round(icmpSec.value * 1000 * 10) / 10
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

  return { summary, byHost }
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
  const attempts = [{ recent: true, ...params }, { ...params }]
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      return await zabbixRpc('problem.get', attempts[i])
    } catch (e) {
      if (e.code !== 'ZABBIX_API_ERROR' || i === attempts.length - 1) throw e
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

async function fetchZabbixSnapshot(client, { hostFilter = '', deviceTypeFilter = '', hostGroupFilter = '', includePing = false, includeBandwidth = false, includeDisk = false, includeCpuMemory = false, problemLimit = 12 } = {}) {
  const { isZabbixConfigured, zabbixRpc, getUrl } = client
  if (!isZabbixConfigured()) return { configured: false }

  const search = String(hostFilter || '').trim()
  const groupName = String(hostGroupFilter || '').trim()
  const isExactIp = search ? (IPV4_RE.test(search) && search.match(IPV4_RE)[0] === search) : false

  try {
    const baseParams = {
      monitored_hosts: true,
      output: ['hostid', 'host', 'name', 'status', 'available', 'active_available'],
      selectInterfaces: ['interfaceid', 'available', 'type', 'main', 'ip'],
      selectParentTemplates: ['templateid', 'name'],
      selectGroups: ['groupid', 'name'],
      sortfield: 'name',
    }

    const [version, hosts, groupMeta] = await Promise.all([
      zabbixRpc('apiinfo.version', {}).catch(() => ''),
      (async () => {
        if (groupName && !search) {
          const grp = await fetchHostsInGroup(zabbixRpc, groupName, baseParams)
          return grp.hosts
        }

        if (!search) {
          return zabbixRpc('host.get', { ...baseParams, limit: 500 })
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

        return zabbixRpc('host.get', {
          ...baseParams,
          search: { name: search, host: search },
          searchByAny: true,
          searchWildcardsEnabled: true,
          limit: 200,
        })
      })(),
      groupName && !search
        ? fetchHostsInGroup(zabbixRpc, groupName, baseParams).then(g => ({ groupFound: g.groupFound, groupName: g.groupName }))
        : Promise.resolve(null),
    ])

    const rows = isExactIp
      ? (hosts || [])
      : (hosts || []).filter(h => hostMatchesSearch(h, search))
    const filtered = deviceTypeFilter === 'switch'
      ? rows.filter(h => isPhysicalSwitchHost(h))
      : deviceTypeFilter
        ? rows.filter(h => classifyHost(h) === deviceTypeFilter)
        : rows
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

    const hostids = filtered.map(h => String(h.hostid)).filter(Boolean)
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
    if (hostids.length) {
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
      matchedHosts: filtered.map(h => ({
        hostid: String(h.hostid),
        name: h.name || h.host,
        host: h.host,
        status: availLabelFromHost(h),
        type: classifyHost(h),
        interfaceIps: (h.interfaces || []).map(i => i.ip).filter(Boolean),
        groups: (h.groups || []).map(g => g.name).filter(Boolean),
      })),
      hostFilter: search || null,
      deviceTypeFilter: deviceTypeFilter || null,
    }
  } catch (e) {
    const url = typeof getUrl === 'function' ? getUrl() : ''
    return {
      configured: true,
      error: e.message || String(e),
      errorCode: e.code || 'ZABBIX_ERROR',
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
      status: m.status || null,
    }))
}

/**
 * Live Zabbix JSON for LLM synthesis (bandwidth, interface analysis, etc.).
 * @param {string} userMessage
 */
export async function buildZabbixInfraContext(userMessage = '') {
  const fetchedAt = new Date().toISOString()
  const client = createZabbixClient('ZABBIX')
  if (!client.isZabbixConfigured()) {
    return {
      module: 'zabbixInfra',
      freshness: 'live',
      fetchedAt,
      configured: false,
      error: 'ZABBIX_URL + ZABBIX_API_TOKEN not configured',
    }
  }

  const ip = extractIpv4(userMessage)
  const deviceTypeFilter = detectDeviceTypeFilter(userMessage)
  const hostFilter = ip || ''
  const includePing = wantsPingStatus(userMessage)
  const includeBandwidth = wantsBandwidthUtil(userMessage)
    || /\b(bandwidth|utilization|utilisation|interface|port|traffic|throughput)\b/i.test(String(userMessage || ''))

  const data = await fetchZabbixSnapshot(client, {
    hostFilter,
    deviceTypeFilter,
    includePing,
    includeBandwidth,
  })

  if (!data.configured) {
    return { module: 'zabbixInfra', freshness: 'live', fetchedAt, configured: false, error: 'Zabbix not configured' }
  }
  if (data.error) {
    return {
      module: 'zabbixInfra',
      freshness: 'live',
      fetchedAt,
      configured: true,
      error: data.error,
      url: data.url || null,
    }
  }

  const matched = data.matchedHosts || []
  const hosts = matched.map(h => ({
    hostid: h.hostid,
    name: h.name,
    host: h.host,
    status: h.status,
    type: h.type,
    interfaceIps: h.interfaceIps,
    groups: h.groups,
    ping: includePing && data.pingMetrics?.byHost?.[h.hostid]
      ? {
          reach: data.pingMetrics.byHost[h.hostid].reach,
          ms: data.pingMetrics.byHost[h.hostid].ms,
          loss: data.pingMetrics.byHost[h.hostid].loss,
          source: data.pingMetrics.byHost[h.hostid].source,
        }
      : undefined,
    ports: includeBandwidth ? hostPortsFromSnapshot(data, h) : undefined,
  }))

  return {
    module: 'zabbixInfra',
    freshness: 'live',
    fetchedAt,
    configured: true,
    source: 'Infra Zabbix API (host.get + item.get net.if.*)',
    note: 'Live SNMP/interface metrics at send time. inBps/outBps are raw bytes/sec from Zabbix net.if.in/out items.',
    version: data.version,
    hostFilter: data.hostFilter,
    deviceTypeFilter: data.deviceTypeFilter,
    availability: data.availability,
    deviceTypes: data.deviceTypes,
    problemCount: data.problemCount,
    problems: (data.problems || []).slice(0, 10),
    hosts,
    pingSummary: includePing && data.pingMetrics ? data.pingMetrics.summary : undefined,
  }
}
