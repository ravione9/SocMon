import { createZabbixClient } from '../../services/zabbix.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'
import { isInfluxStoreConfigured, fetchStoreSnapshot, buildOverviewSummary } from '../influxStore.js'

const STORE_HOSTNAME_RE = /\b([A-Z]{2,5}\d+-[A-Z0-9]{4,})\b/i
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/

function extractStoreHostname(text) {
  const m = String(text || '').match(STORE_HOSTNAME_RE)
  return m ? m[1].toUpperCase() : null
}

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

function availLabel(code) {
  const c = String(code ?? '')
  if (c === '1') return 'available'
  if (c === '2') return 'unavailable'
  return 'unknown'
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

async function fetchZabbixSnapshot(client, { hostFilter = '', deviceTypeFilter = '' } = {}) {
  const { isZabbixConfigured, zabbixRpc, getUrl } = client
  if (!isZabbixConfigured()) return { configured: false }

  const search = String(hostFilter || '').trim()
  const hostParams = {
    monitored_hosts: true,
    output: ['hostid', 'host', 'name', 'status', 'available', 'active_available'],
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
      ? rows.filter(h => SWITCH_DEVICE_TYPES.has(classifyHost(h)))
      : deviceTypeFilter
        ? rows.filter(h => classifyHost(h) === deviceTypeFilter)
        : rows
    const availability = { total: filtered.length, available: 0, unavailable: 0, unknown: 0 }

    // Device type breakdown
    const deviceTypes = {}
    const deviceTypeDown = {}
    for (const h of filtered) {
      const a = availLabel(h.available)
      if (a === 'available') availability.available += 1
      else if (a === 'unavailable') availability.unavailable += 1
      else availability.unknown += 1

      const type = classifyHost(h)
      deviceTypes[type] = (deviceTypes[type] || 0) + 1
      if (a === 'unavailable') deviceTypeDown[type] = (deviceTypeDown[type] || 0) + 1
    }

    const hostids = filtered.map(h => String(h.hostid)).filter(Boolean)
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
          name: h.name || h.host,
          host: h.host,
          status: availLabel(h.available),
          type: classifyHost(h),
        }))
      })(),
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

  const targets = []
  if (allowedPages.includes('infra')) {
    targets.push({ key: 'infra', label: 'Infra Zabbix', client: createZabbixClient('ZABBIX') })
  }
  if (allowedPages.includes('storeZabbix') && (wantsStoreZabbix(question) || hostFilter)) {
    targets.push({ key: 'storeZabbix', label: 'Store Zabbix', client: createZabbixClient('STORE_ZABBIX') })
  }

  // Fetch Zabbix + optionally ISP data in parallel
  const [results, ispData] = await Promise.all([
    Promise.all(targets.map(async t => ({ ...t, data: await fetchZabbixSnapshot(t.client, { hostFilter, deviceTypeFilter }) }))),
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
