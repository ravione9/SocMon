import { createZabbixClient } from '../../services/zabbix.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'
import { isInfluxStoreConfigured, fetchStoreSnapshot, buildOverviewSummary } from '../influxStore.js'
import { extractStoreHostname } from './queryContext.js'

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/

export function extractIpv4(text) {
  const m = String(text || '').match(IPV4_RE)
  return m ? m[0] : null
}

const SEV_LABEL = { 0: 'Not classified', 1: 'Info', 2: 'Warning', 3: 'Average', 4: 'High', 5: 'Disaster' }

const ZABBIX_MARKERS = /\b(zabbix|infra mon\w+|infra summar\w+|monitored hosts?|host availability)\b/i
const NETWORK_MARKERS = /\b(network devices?|network device|servers? status|server status|servers? down|network status|infra hosts?)\b/i

export function isInfraMonitorQuery(question) {
  return /\b(infra mon\w+|infra summar\w+)\b/i.test(String(question || ''))
}

/** fortigate | cisco | checkpoint | network | switch (cisco + snmp network) */
export function detectDeviceTypeFilter(question) {
  const q = String(question || '')
  if (/\b(fortinet|fortigate|fgt)\b/i.test(q)) return 'fortigate'
  if (/\b(switches?|all switches)\b/i.test(q)) return 'switch'
  if (/\b(cisco|catalyst|nexus|meraki)\b/i.test(q)) return 'cisco'
  if (/\b(routers?)\b/i.test(q)) return 'cisco'
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
  if (deviceType && /\b(status|health|up|down|available|summary|summ\w*|monitor|problem|issue|give me|show|list|all)\b/i.test(q)) return true
  if (/\b(fortinet|fortigate)\s+firewall\b/i.test(q)) return true
  if (/\b(cisco|network devices?|switches?|routers?|firewall device)\b/i.test(q) && /\b(status|health|summary|summ\w*|monitor|all)\b/i.test(q)) return true
  if (/\b(ping|icmp|latency|packet\s*loss|response\s*time|sensor)\b/i.test(q) && (deviceType || /\b(switches?|routers?|network devices?)\b/i.test(q))) return true
  return false
}

export function isIpInfraQuery(question) {
  const q = String(question || '')
  if (!extractIpv4(q)) return false
  if (/\b(firewall|fortigate|deny|denied|blocked|soc log|log search)\b/i.test(q)) return false
  if (/\b(store monitor|offline stores?|how many stores|store tag|influx)\b/i.test(q)) return false
  return true
}

export function isZabbixQuestion(question) {
  const q = String(question || '')
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

export function wantsPingStatus(question) {
  return /\b(ping|icmp|latency|packet\s*loss|response\s*time|sensor\s*data|reachable|unreachable)\b/i.test(String(question || ''))
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
      output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock'],
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

async function fetchZabbixSnapshot(client, { hostFilter = '', deviceTypeFilter = '', includePing = false } = {}) {
  const { isZabbixConfigured, zabbixRpc, getUrl } = client
  if (!isZabbixConfigured()) return { configured: false }

  const search = String(hostFilter || '').trim()
  const hostParams = {
    monitored_hosts: true,
    output: ['hostid', 'host', 'name', 'status', 'available', 'active_available'],
    selectInterfaces: ['interfaceid', 'available', 'type', 'main', 'ip'],
    selectParentTemplates: ['templateid', 'name'],
    selectGroups: ['groupid', 'name'],
    sortfield: 'name',
    limit: search ? 200 : 500,
  }
  if (search) {
    hostParams.search = { name: search, host: search }
    hostParams.searchByAny = true
    hostParams.searchWildcardsEnabled = true
  }

  try {
    const [version, hosts] = await Promise.all([
      zabbixRpc('apiinfo.version', {}).catch(() => ''),
      zabbixRpc('host.get', hostParams),
    ])

    const rows = hosts || []
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
        limit: 12,
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
        return sorted.slice(0, deviceTypeFilter === 'switch' ? 50 : 25).map(h => ({
          hostid: String(h.hostid),
          name: h.name || h.host,
          host: h.host,
          status: availLabelFromHost(h),
          type: classifyHost(h),
        }))
      })(),
      pingMetrics,
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
  if (!isZabbixQuestion(question)) return null

  const fetchedAt = new Date().toISOString()
  const ip = extractIpv4(question)
  const hostname = extractStoreHostname(question) || ctx?.hostname
  const deviceTypeFilter = detectDeviceTypeFilter(question)
  const hostFilter = ip || (hostname && /\b(for|of|about|status)\b/i.test(question) ? hostname : '')
  const wantsIsp = /\bisp\b/i.test(question)
  const includePing = wantsPingStatus(question)

  const targets = []
  if (allowedPages.includes('infra')) {
    targets.push({ key: 'infra', label: 'Infra Zabbix', client: createZabbixClient('ZABBIX') })
  }
  if (allowedPages.includes('storeZabbix') && (wantsStoreZabbix(question) || hostFilter)) {
    targets.push({ key: 'storeZabbix', label: 'Store Zabbix', client: createZabbixClient('STORE_ZABBIX') })
  }

  // Fetch Zabbix + optionally ISP data in parallel
  const [results, ispData] = await Promise.all([
    Promise.all(targets.map(async t => ({
      ...t,
      data: await fetchZabbixSnapshot(t.client, { hostFilter, deviceTypeFilter, includePing }),
    }))),
    wantsIsp && allowedPages.includes('storeMonitor') && isInfluxStoreConfigured()
      ? fetchStoreSnapshot(10, '-1h').then(stores => buildOverviewSummary(stores)).catch(() => null)
      : Promise.resolve(null),
  ])

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

  const lines = [
    `Infra Zabbix summary (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    filterLabel ? `Filter: ${filterLabel}` : hostFilter ? `Host filter: ${hostFilter}` : 'All monitored hosts (network devices & servers)',
    '',
  ]

  for (const { label, data } of results) {
    lines.push(`── ${label} ──`)
    if (!data.configured) {
      lines.push('  Not configured — set ZABBIX_URL + ZABBIX_API_TOKEN (or STORE_ZABBIX_*) in .env')
      lines.push('')
      continue
    }
    if (data.error) {
      lines.push(`  Unreachable: ${data.error}`)
      if (data.url) lines.push(`  URL: ${data.url}`)
      if (data.errorCode === 'ZABBIX_FETCH') {
        lines.push('  Tip: if Zabbix works in your browser but not from Docker, use host.docker.internal port-forward or run the server on the host.')
      }
      lines.push('')
      continue
    }
    const a = data.availability
    const dt = data.deviceTypes || {}
    const dtDown = data.deviceTypeDown || {}

    const TYPE_LABEL = { cisco: 'Cisco devices', fortigate: 'FortiGate firewalls', checkpoint: 'CheckPoint FW', juniper: 'Juniper', network: 'Network devices', vm: 'Virtual machines', server: 'Servers', database: 'Databases', isp: 'ISP monitors', other: 'Other' }
    const TYPE_ORDER = ['cisco', 'fortigate', 'checkpoint', 'juniper', 'network', 'server', 'vm', 'database', 'isp', 'other']

    lines.push(`  Version: ${data.version || '—'}`)
    lines.push(`  Total monitored: ${a.total} · available ${a.available} · down ${a.unavailable} · unknown ${a.unknown}`)
    lines.push(`  Active problems: ${data.problemCount}`)

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
      const hostTitle = filterLabel ? `${filterLabel}:` : 'Sample hosts (network devices first):'
      const hostLimit = deviceTypeFilter === 'switch' ? 50 : 15
      lines.push(`  ${hostTitle}`)
      for (const h of data.hosts.slice(0, hostLimit)) {
        const typeTag = h.type && h.type !== 'other' ? ` [${h.type}]` : ''
        lines.push(`    • ${h.name}${typeTag} — ${h.status}`)
      }
      if (a.total > hostLimit) lines.push(`    … and ${a.total - hostLimit} more (open Infra Monitoring → Hosts)`)
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
    if (data.problems.length) {
      lines.push('  Top problems:')
      for (const p of data.problems.slice(0, 8)) {
        lines.push(`    • [${p.severity}] ${p.name}${p.hosts ? ` · ${p.hosts}` : ''}`)
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
