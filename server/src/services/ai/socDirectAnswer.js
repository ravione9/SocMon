import { getESClient } from '../../config/elasticsearch.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'
import { fortigateVpnFilterBool } from '../../utils/fortigateVpnQuery.js'
import { fortigateUserLoginFailedBool } from '../../utils/loginFailureQuery.js'

import { isInfraDeviceStatusQuery } from './zabbixDirectAnswer.js'
import { extractCountryFromQuestion, fetchFirewallCountryConnections } from './geoConnectionQuery.js'

function parseRange(q) {
  const text = String(q || '').toLowerCase()
  let m = text.match(/last\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/)
  if (m) return `-${m[1]}h`
  m = text.match(/last\s+(\d+)\s*(d|day|days)\b/)
  if (m) return `-${m[1]}d`
  if (/\b(last hour|1 hr|1hr|one hour)\b/.test(text)) return '-1h'
  if (/\b(last 24|24h|last day|today)\b/.test(text)) return '-24h'
  if (/\b(last week|7 day|7d)\b/.test(text)) return '-7d'
  return '-1h'
}

const FW_MARKERS = /\b(fortinet|fortigate|firewall|fgt|soc\b|fw status|firewall status|fw rules?|firewall rules?|firewall device|all firewall|firewall summ\w*|firewall activ\w*)\b/i
const CONN_MARKERS = /\b(connections?|sessions?|inbound connections?|outbound connections?|active sessions?|traffic sessions?|how many connections?|how many sessions?|total connections?|active connections?)\b/i

export function isFirewallQuestion(question) {
  const q = String(question || '')
  if (isInfraDeviceStatusQuery(q)) return false
  if (/\b(zabbix|infra monitor\w*|store monitor|influx|hostname|xdr|sentinel|store|stores|offline|isp|ping|speedtest)\b/i.test(q)) return false
  if (FW_MARKERS.test(q)) return true
  // Connection / session queries without store context → firewall sessions
  if (CONN_MARKERS.test(q) && !/\b(store|stores|hostname|ping|isp|influx|ldap|database|db|mongo)\b/i.test(q)) return true
  return false
}

function rangeGte(range) {
  const m = String(range || '-1h').match(/^-?(\d+)(h|d|m)$/)
  if (!m) return 'now-1h'
  return `now-${m[1]}${m[2]}`
}

function rangeLabel(range) {
  const m = String(range || '-1h').match(/^-?(\d+)(h|d|m)$/)
  if (!m) return 'last 1 hour'
  const unit = { h: 'hour', d: 'day', m: 'minute' }[m[2]] || m[2]
  return `last ${m[1]} ${unit}${Number(m[1]) !== 1 ? 's' : ''}`
}

async function fetchFirewallStats(range) {
  const es = getESClient()
  const gte = rangeGte(range)
  const tr = { gte, lte: 'now' }
  const timeoutMs = Number.parseInt(process.env.ES_SOC_TIMEOUT_MS || '8000', 10)

  const withTimeout = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)),
  ])

  const [statsRes, devicesRes] = await Promise.all([
    withTimeout(es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: { range: { '@timestamp': tr } },
        aggs: {
          total: { value_count: { field: '@timestamp' } },
          denies: { filter: { term: { 'fgt.action.keyword': 'deny' } } },
          allows: { filter: { term: { 'fgt.action.keyword': 'accept' } } },
          ips: { filter: { term: { 'fgt.subtype.keyword': 'ips' } } },
          utm: { filter: { term: { 'fgt.type.keyword': 'utm' } } },
          vpn: { filter: fortigateVpnFilterBool() },
          loginFailed: { filter: fortigateUserLoginFailedBool() },
          topSrcIp: { terms: { field: 'fgt.srcip.keyword', size: 8, order: { _count: 'desc' } } },
          topThreats: { terms: { field: 'fgt.attack.keyword', size: 6, order: { _count: 'desc' } } },
        },
      },
    })),
    withTimeout(es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: { range: { '@timestamp': { gte: 'now-24h', lte: 'now' } } },
        aggs: {
          byDevice: {
            terms: { field: 'fgt.devname.keyword', size: 50, missing: '(unknown)', order: { _count: 'desc' } },
            aggs: {
              denies: { filter: { term: { 'fgt.action.keyword': 'deny' } } },
            },
          },
        },
      },
    })),
  ])

  const agg = statsRes.aggregations || {}
  const devAgg = devicesRes.aggregations?.byDevice?.buckets || []

  return {
    total: agg.total?.value ?? 0,
    denies: agg.denies?.doc_count ?? 0,
    allows: agg.allows?.doc_count ?? 0,
    ips: agg.ips?.doc_count ?? 0,
    utm: agg.utm?.doc_count ?? 0,
    vpn: agg.vpn?.doc_count ?? 0,
    loginFailed: agg.loginFailed?.doc_count ?? 0,
    topSrcIp: (agg.topSrcIp?.buckets || []).map(b => ({ ip: b.key, count: b.doc_count })),
    topThreats: (agg.topThreats?.buckets || []).filter(b => b.key && b.key !== '-').map(b => ({ name: b.key, count: b.doc_count })),
    devices: devAgg.map(b => ({ name: b.key, total: b.doc_count, denies: b.denies?.doc_count ?? 0 })),
  }
}

/**
 * Instant FortiGate/SOC status — no LLM.
 * @param {string} question
 * @param {string[]} allowedPages
 * @param {object} [ctx]
 */
export async function tryDirectSOCAnswer(question, allowedPages, ctx = null) {
  if (!isFirewallQuestion(question)) return null
  if (!allowedPages.includes('soc')) return null

  const fetchedAt = new Date().toISOString()
  const countryFilter = extractCountryFromQuestion(question)
  const wantsConnections = /\b(connections?|sessions?|how many conn|active conn|traffic)\b/i.test(question)
  const range = ctx?.range || parseRange(question)

  if (countryFilter && wantsConnections) {
    try {
      const fw = await fetchFirewallCountryConnections(range, countryFilter)
      const window = rangeLabel(range)
      const dirLabel = countryFilter.direction === 'src' ? 'source country' : 'destination country'
      const lines = [
        `FortiGate / SOC — connections by country (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
        `Window: ${window}`,
        `Filter: ${dirLabel} = ${countryFilter.name}`,
        '',
        `Total firewall log events: ${fw.total.toLocaleString()}`,
        `Allowed sessions: ${fw.allows.toLocaleString()}`,
        `Denied sessions: ${fw.denies.toLocaleString()}`,
        '',
      ]
      if (fw.byDevice.length) {
        lines.push('Top FortiGate devices:')
        for (const d of fw.byDevice.slice(0, 8)) {
          lines.push(`  • ${d.name}: ${d.count.toLocaleString()}`)
        }
        lines.push('')
      }
      const topIps = countryFilter.direction === 'src' ? fw.topSrcIp : fw.topDstIp
      if (topIps.length) {
        lines.push(`Top ${countryFilter.direction === 'src' ? 'source' : 'destination'} IPs:`)
        for (const ip of topIps.slice(0, 8)) {
          lines.push(`  • ${ip.ip}: ${ip.count.toLocaleString()}`)
        }
        lines.push('')
      }
      lines.push('(Direct answer from live Elasticsearch firewall-* — no LLM wait.)')
      return {
        content: lines.join('\n'),
        contextMeta: [{
          id: 'soc',
          label: 'SOC / FortiGate',
          freshness: 'live',
          fetchedAt,
          configured: true,
          note: `${countryFilter.name} · ${fw.total.toLocaleString()} events`,
        }],
        contextPreview: {
          soc: {
            window,
            totalEvents: fw.total,
            denies: fw.denies,
            allows: fw.allows,
            country: countryFilter.name,
          },
        },
        queryContext: { topic: 'soc', isFollowUp: ctx?.isFollowUp },
      }
    } catch (e) {
      return {
        content: `FortiGate country connection lookup failed.\nError: ${e.message}`,
        contextMeta: [{ id: 'soc', label: 'SOC / Firewall', freshness: 'live', fetchedAt, configured: false, error: e.message }],
        contextPreview: {},
        queryContext: { topic: 'soc', isFollowUp: ctx?.isFollowUp },
      }
    }
  }

  let stats
  try {
    stats = await fetchFirewallStats(range)
  } catch (e) {
    return {
      content: `FortiGate / SOC data is currently unavailable.\nError: ${e.message}\n\nCheck that Elasticsearch (${process.env.ES_HOST || 'ES_HOST'}) is reachable from the NetPulse server.`,
      contextMeta: [{ id: 'soc', label: 'SOC / Firewall', freshness: 'live', fetchedAt, configured: false, error: e.message }],
      contextPreview: {},
      queryContext: { topic: 'soc', isFollowUp: ctx?.isFollowUp },
    }
  }

  const window = rangeLabel(range)
  const lines = [
    `FortiGate / SOC firewall status (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    `Window: ${window}`,
    '',
  ]

  if (wantsConnections) {
    lines.push('── Connection / session summary ──')
    lines.push(`  Total firewall events    : ${stats.total.toLocaleString()}`)
    lines.push(`  Allowed (accepted) sessions : ${stats.allows.toLocaleString()}`)
    lines.push(`  Denied sessions          : ${stats.denies.toLocaleString()}`)
    lines.push(`  VPN sessions             : ${stats.vpn.toLocaleString()}`)
    lines.push('')
  } else {
    lines.push('── Overall stats ──')
    lines.push(`  Total firewall events : ${stats.total.toLocaleString()}`)
    lines.push(`  Denied sessions       : ${stats.denies.toLocaleString()}`)
    lines.push(`  Allowed sessions      : ${stats.allows.toLocaleString()}`)
    lines.push(`  IPS events            : ${stats.ips.toLocaleString()}`)
    lines.push(`  UTM events            : ${stats.utm.toLocaleString()}`)
    lines.push(`  VPN events            : ${stats.vpn.toLocaleString()}`)
    lines.push(`  Login failures        : ${stats.loginFailed.toLocaleString()}`)
    lines.push('')
  }

  if (stats.devices.length) {
    lines.push('── FortiGate devices (last 24 h) ──')
    for (const d of stats.devices.slice(0, 20)) {
      const pct = d.total > 0 ? Math.round((d.denies / d.total) * 100) : 0
      lines.push(`  • ${d.name} — ${d.total.toLocaleString()} events · ${d.denies.toLocaleString()} denies (${pct}%)`)
    }
    if (stats.devices.length > 20) lines.push(`  … ${stats.devices.length - 20} more devices (open SOC → Overview)`)
    lines.push('')
  } else {
    lines.push('  No FortiGate devices found in last 24 h — check ES index `firewall-*`.')
    lines.push('')
  }

  if (stats.topSrcIp.length) {
    lines.push('── Top blocked source IPs ──')
    for (const s of stats.topSrcIp.slice(0, 6)) {
      lines.push(`  • ${s.ip} — ${s.count.toLocaleString()} denies`)
    }
    lines.push('')
  }

  if (stats.topThreats.length) {
    lines.push('── Top IPS threats ──')
    for (const t of stats.topThreats.slice(0, 5)) {
      lines.push(`  • ${t.name} (${t.count.toLocaleString()} hits)`)
    }
    lines.push('')
  }

  lines.push('(Direct answer from live Elasticsearch firewall-* — no LLM wait.)')

  return {
    content: lines.join('\n'),
    contextMeta: [{
      id: 'soc',
      label: 'SOC / FortiGate',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: `${stats.total.toLocaleString()} events · ${stats.denies.toLocaleString()} denies · ${stats.devices.length} devices`,
    }],
    contextPreview: {
      soc: {
        window,
        totalEvents: stats.total,
        denies: stats.denies,
        allows: stats.allows,
        ips: stats.ips,
        utm: stats.utm,
        vpn: stats.vpn,
        devices: stats.devices.length,
      },
    },
    queryContext: { topic: 'soc', isFollowUp: ctx?.isFollowUp },
  }
}
