import {
  isSentinelOneConfigured,
  isSentinelOneXdrConfigured,
  resolveSentinelOneXdrBase,
  fetchThreatsList,
  runSentinelOnePowerQuery,
} from '../../utils/sentinelOneApi.js'
import { buildPowerQueryText, DEFAULT_TABLE_COLUMNS } from '../../utils/xdrPowerQuery.js'
import { isSentinelPeripheralQuery, parseQuestionTimeRange } from './queryContext.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'
import {
  buildGeoConnectionPowerQuery,
  extractCountryFromQuestion,
  fetchFirewallCountryConnections,
  isGeoConnectionQuery,
  isStoreMonitorConnectivityQuery,
} from './geoConnectionQuery.js'

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/

const XDR_KEYWORDS = /\b(sentinel|sentinal|sentinelone|xdr|singularity|powerquery|power query|data lake)\b/i
const LOGIN_FAIL_KEYWORDS = /\b(failed login|login fail|login failure|logon fail|authentication fail|auth fail|4625|bad password|invalid logon)\b/i
const THREAT_INVENTORY_KEYWORDS = /\b(threats?|malware|incident|detections?|suspicious|infected|quarantine)\b/i

function isThreatInventoryQuery(question) {
  const q = String(question || '')
  // Common typo: "thread" instead of "threat" when paired with XDR / new / found / today.
  if (/\bthreads?\b/i.test(q) && /\b(new|found|today|xdr|sentinel|recent|active)\b/i.test(q)) return true
  if (THREAT_INVENTORY_KEYWORDS.test(q) && (XDR_KEYWORDS.test(q) || /\b(new|found|today|recent|active)\b/i.test(q))) return true
  return false
}

function threatRangeFromQuestion(question) {
  const q = String(question || '').toLowerCase()
  if (/\btoday\b/.test(q)) return '1d'
  if (/\b(last hour|past hour|1 hr|1hr)\b/.test(q)) return '1h'
  if (/\b(last 24|24 hour|24h|last day|past day)\b/.test(q)) return '24h'
  if (/\b(last week|7 day|7d|past week)\b/.test(q)) return '7d'
  const influxStyle = parseQuestionTimeRange(question)
  const m = /^-(\d+)([smhd])$/i.exec(influxStyle)
  if (m) return `${m[1]}${m[2].toLowerCase()}`
  return '24h'
}

function wantsNewThreatsOnly(question) {
  return /\b(new|recent|found|today|active|unresolved)\b/i.test(String(question || ''))
}

/** Follow-up after XDR that is clearly a different topic (Zabbix IP, bandwidth, store, etc.). */
function isOffTopicXdrFollowUp(question) {
  const q = String(question || '')
  if (isXdrQuestion(q) || buildXdrQueryFromQuestion(q) || isThreatInventoryQuery(q)) return false
  if (/\b(zabbix|infra mon|switch|switches|router|ping|icmp|network device|host availability)\b/i.test(q)) return true
  const ip = String(q).match(IPV4_RE)?.[0]
  if (ip && /\b(bandwidth|utilization|utilisation|traffic|throughput|interface|port|ping|switch|cpu|memory)\b/i.test(q)) {
    return true
  }
  if (/\b(bandwidth|utilization|utilisation|store monitor|offline stores?|usb disconnect|firewall deny|fortigate deny|hostname report)\b/i.test(q)) {
    return true
  }
  return false
}

function pqRangeFromQuestion(question) {
  const influxStyle = parseQuestionTimeRange(question)
  const m = /^-(\d+)([smhd])$/i.exec(influxStyle)
  if (m) return `${m[1]}${m[2].toLowerCase()}`
  return '1h'
}

function parsePqTimeRange(rangeStr) {
  const preset = String(rangeStr || '1h').trim()
  const m = /^(\d+)([smhd])$/i.exec(preset)
  if (!m) return { start: null, end: null }
  const mult =
    m[2].toLowerCase() === 's' ? 1000
      : m[2].toLowerCase() === 'm' ? 60000
        : m[2].toLowerCase() === 'h' ? 3600000
          : 86400000
  const end = Date.now()
  const start = end - Number(m[1]) * mult
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() }
}

function formatRangeLabel(range) {
  const m = /^(\d+)([smhd])$/i.exec(range)
  if (!m) return range
  const n = m[1]
  const u = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' }[m[2].toLowerCase()] || m[2]
  return `last ${n} ${u}`
}

/** @returns {string|null} */
export function buildXdrQueryFromQuestion(question) {
  const q = String(question || '').toLowerCase()

  if (LOGIN_FAIL_KEYWORDS.test(q) || (XDR_KEYWORDS.test(q) && /\b(login|logon|auth)\b/.test(q) && /\b(fail|failed|failure)\b/.test(q))) {
    let base = "(event.type = 'Login' OR event.category = 'login') AND (event.action contains 'fail' OR event.id = '4625' OR message contains 'fail' OR message contains 'Failure' OR message contains 'failed')"
    if (/\bserver\b/.test(q)) {
      base += " AND (endpoint.name contains 'srv' OR endpoint.name contains 'SRV' OR endpoint.name contains 'server' OR endpoint.name contains 'dc' OR endpoint.name contains 'DC')"
    }
    return base
  }

  if (/\bprocess creation\b/.test(q)) {
    return "event.type = 'Process Creation'"
  }
  if (/\bdns\b/.test(q)) {
    return "event.type = 'DNS Resolved'"
  }
  if (/\bnetwork connection\b/.test(q) || /\bip connect\b/.test(q)) {
    return "event.type = 'IP Connect'"
  }

  const countryFilter = extractCountryFromQuestion(q)
  if (countryFilter && isGeoConnectionQuery(q)) {
    return buildGeoConnectionPowerQuery(countryFilter.name)
  }

  return null
}

export function isXdrQuestion(question) {
  const q = String(question || '')
  if (isStoreMonitorConnectivityQuery(q)) return false
  // USB/phoropter/peripheral logs live in Elasticsearch sentinel-*, not the XDR data lake.
  if (isSentinelPeripheralQuery(q)) return false
  if (XDR_KEYWORDS.test(q)) return true
  if (LOGIN_FAIL_KEYWORDS.test(q)) return true
  if (isGeoConnectionQuery(q)) return true
  if (/\bxdr\b/i.test(q) && /\b(device|connec|china|country|how many|endpoint|sentinel)\b/i.test(q)) return true
  return false
}

function rowVal(row, ...keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') return row[k]
  }
  return ''
}

function aggregateRows(rows) {
  const byEndpoint = new Map()
  const bySrcIp = new Map()
  const byUser = new Map()

  for (const row of rows) {
    const ep = rowVal(row, 'endpoint.name', 'host.name') || 'unknown'
    const ip = rowVal(row, 'src.ip', 'src.ip.address')
    const user = rowVal(row, 'user.name', 'src.process.user', 'tgt.process.user')

    byEndpoint.set(ep, (byEndpoint.get(ep) || 0) + 1)
    if (ip) bySrcIp.set(ip, (bySrcIp.get(ip) || 0) + 1)
    if (user) byUser.set(user, (byUser.get(user) || 0) + 1)
  }

  const top = (map, n = 10) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }))

  return {
    byEndpoint: top(byEndpoint, 15),
    bySrcIp: top(bySrcIp, 10),
    byUser: top(byUser, 10),
  }
}

function formatSampleRows(rows, limit = 8) {
  return rows.slice(0, limit).map((row) => {
    const ts = rowVal(row, 'timestamp', 'event.time', '@timestamp')
    const ep = rowVal(row, 'endpoint.name', 'host.name')
    const user = rowVal(row, 'user.name', 'src.process.user')
    const ip = rowVal(row, 'src.ip', 'src.ip.address')
    const dstIp = rowVal(row, 'tgt.ip', 'tgt.ip.address', 'dst.ip.address')
    const msg = String(rowVal(row, 'message', 'event.action') || '').slice(0, 120)
    return { timestamp: ts, endpoint: ep, user, srcIp: ip, dstIp, message: msg }
  })
}

function aggregateDstIps(rows) {
  const byDstIp = new Map()
  for (const row of rows) {
    const ip = rowVal(row, 'tgt.ip', 'tgt.ip.address', 'dst.ip.address')
    if (!ip) continue
    byDstIp.set(ip, (byDstIp.get(ip) || 0) + 1)
  }
  return [...byDstIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, count]) => ({ key, count }))
}

async function appendFirewallCountrySection(lines, { range, countryFilter, allowedPages }) {
  if (!allowedPages.includes('soc')) {
    lines.push('── FortiGate country-tagged sessions ──')
    lines.push('  SOC / firewall access not enabled for your account — cannot count country-tagged sessions.')
    lines.push('')
    return
  }

  try {
    const fw = await fetchFirewallCountryConnections(range, countryFilter)
    const dirLabel = countryFilter.direction === 'src' ? 'source country' : 'destination country'
    lines.push(`── FortiGate sessions (${dirLabel}: ${countryFilter.name}) ──`)
    lines.push(`  Total firewall log events: ${fw.total.toLocaleString()}`)
    lines.push(`  Allowed: ${fw.allows.toLocaleString()} · Denied: ${fw.denies.toLocaleString()}`)
    if (fw.byDevice.length) {
      lines.push('  Top FortiGate devices:')
      for (const d of fw.byDevice.slice(0, 6)) {
        lines.push(`    • ${d.name}: ${d.count.toLocaleString()}`)
      }
    }
    const topIps = countryFilter.direction === 'src' ? fw.topSrcIp : fw.topDstIp
    if (topIps.length) {
      lines.push(`  Top ${countryFilter.direction === 'src' ? 'source' : 'destination'} IPs:`)
      for (const ip of topIps.slice(0, 6)) {
        lines.push(`    • ${ip.ip}: ${ip.count.toLocaleString()}`)
      }
    }
    lines.push('')
    lines.push('  Note: SentinelOne IP Connect events do not include country by default; FortiGate logs use GeoIP on session start.')
    lines.push('')
    return fw
  } catch (err) {
    lines.push('── FortiGate country-tagged sessions ──')
    lines.push(`  Unavailable: ${err.message || String(err)}`)
    lines.push('')
    return null
  }
}

async function tryThreatListAnswer(question, ctx, fetchedAt) {
  const range = ctx?.range
    ? pqRangeFromQuestion(ctx.range)
    : threatRangeFromQuestion(question)
  const newOnly = wantsNewThreatsOnly(question)
  const listQuery = {
    range,
    limit: '25',
    mitigation: 'all',
    ...(newOnly ? {} : { incidents: 'all' }),
  }

  if (!isSentinelOneConfigured()) {
    return null
  }

  const { threats, pagination } = await fetchThreatsList(listQuery)
  const total = pagination?.totalItems ?? pagination?.total ?? threats?.length ?? 0
  const lines = [
    `SentinelOne threats (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    `Window: ${formatRangeLabel(range)}${newOnly ? ' · new/unresolved focus' : ''}`,
    '',
    `Threats found: ${total}${threats?.length && total > threats.length ? ` (showing ${threats.length})` : ''}`,
    '',
  ]

  if (!threats?.length) {
    lines.push('No threats matched in this window.')
  } else {
    lines.push('Recent threats:')
    for (const t of threats.slice(0, 20)) {
      const created = t.createdAt ? formatPortalTimestamp(t.createdAt) : '—'
      lines.push(
        `  • ${t.threatName || '—'} · ${t.agentComputerName || '—'} · ${t.mitigationStatus || '—'} · ${t.incidentStatus || '—'} · ${created}`,
      )
    }
    if (threats.length > 20) lines.push(`  … and ${threats.length - 20} more in this page`)
  }

  lines.push('', '(Direct answer from live SentinelOne Threats API — no LLM wait.)')

  return {
    content: lines.join('\n'),
    contextMeta: [{
      id: 'sentinelXdr',
      label: 'SentinelOne XDR',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: `Threats API · ${formatRangeLabel(range)}`,
    }],
    contextPreview: {
      xdr: {
        range,
        totalEvents: total,
        rowCount: threats?.length ?? 0,
        query: 'GET /threats',
        topEndpoints: [...new Map(
          (threats || []).map(t => [t.agentComputerName || 'unknown', 0]),
        ).keys()].slice(0, 5).map(key => ({
          key,
          count: (threats || []).filter(t => (t.agentComputerName || 'unknown') === key).length,
        })),
      },
    },
    queryContext: ctx ? { topic: 'xdr', isFollowUp: ctx.isFollowUp, range } : undefined,
  }
}

function buildQuestionForXdr(question, ctx) {
  if (!ctx?.isFollowUp || ctx.priorTopic !== 'xdr') return question
  const q = String(question || '')
  if (isOffTopicXdrFollowUp(q)) return q
  if (isXdrQuestion(q) || buildXdrQueryFromQuestion(q) || isThreatInventoryQuery(q)) return q
  if (/\b(endpoint|endpoints|which|list|show|hostname|machine|machines)\b/i.test(q)) {
    return `sentinel xdr failed login ${ctx.range ? ctx.range.replace(/^-/, 'last ') : 'last 1 hour'}`
  }
  // Never merge full thread — assistant suggestion text pollutes PowerQuery templates.
  return q
}

/**
 * Run live SentinelOne XDR PowerQuery — no LLM.
 * @param {string} question
 * @param {string[]} allowedPages
 * @param {ReturnType<import('./queryContext.js').resolveQueryContext>} [ctx]
 */
export async function tryDirectXdrAnswer(question, allowedPages, ctx = null) {
  if (!allowedPages.includes('sentinel')) return null

  if (ctx?.isFollowUp && ctx.priorTopic === 'xdr' && isOffTopicXdrFollowUp(question)) {
    return null
  }

  const shouldRun =
    !isStoreMonitorConnectivityQuery(question)
    && (
      isXdrQuestion(question)
      || ctx?.directHandler === 'xdr'
      || (ctx?.isFollowUp && ctx.priorTopic === 'xdr')
    )

  if (!shouldRun) return null

  const effectiveQuestion = buildQuestionForXdr(question, ctx)

  const fetchedAt = new Date().toISOString()

  if (!isSentinelOneXdrConfigured()) {
    return {
      content: [
        'SentinelOne XDR is not configured on this NetPulse server.',
        '',
        'Set in .env:',
        '  SENTINEL_ONE_XDR_BASE_URL=https://xdr.ap1.sentinelone.net',
        '  SENTINEL_ONE_XDR_API_TOKEN=<Log Read Access token>',
        '',
        'Then restart the API container.',
      ].join('\n'),
      contextMeta: [{
        id: 'sentinelXdr',
        label: 'SentinelOne XDR',
        freshness: 'live',
        fetchedAt,
        configured: false,
        error: 'XDR not configured',
      }],
      contextPreview: {},
    }
  }

  const rawQuery = buildXdrQueryFromQuestion(effectiveQuestion)

  if (isThreatInventoryQuery(effectiveQuestion)) {
    try {
      const threatAnswer = await tryThreatListAnswer(effectiveQuestion, ctx, fetchedAt)
      if (threatAnswer) return threatAnswer
    } catch (err) {
      if (!rawQuery) {
        return {
          content: [
            `SentinelOne threat lookup failed: ${err.message || String(err)}`,
            '',
            'Check SENTINEL_ONE_API_TOKEN (Threat Read) and console URL in .env.',
          ].join('\n'),
          contextMeta: [{
            id: 'sentinelXdr',
            label: 'SentinelOne XDR',
            freshness: 'live',
            fetchedAt,
            configured: true,
            error: err.message || String(err),
          }],
          contextPreview: {},
        }
      }
    }
  }

  // Build geo query when user clearly asked XDR + country even if phrasing was loose/typoed.
  if (!rawQuery) {
    const countryFilter = extractCountryFromQuestion(effectiveQuestion)
    if (countryFilter && (isGeoConnectionQuery(effectiveQuestion) || isXdrQuestion(effectiveQuestion))) {
      rawQuery = buildGeoConnectionPowerQuery(countryFilter.name)
    } else if (isXdrQuestion(effectiveQuestion)) {
      if (isSentinelPeripheralQuery(effectiveQuestion)) return null
      return {
        content: [
          'Could not map this question to a SentinelOne XDR PowerQuery template.',
          '',
          'USB/phoropter/peripheral connect-disconnect events are NOT in the XDR data lake.',
          'Use netpulse_query with "hostname report USB phoropter …" (Elasticsearch sentinel-* Device Control).',
          '',
          'XDR examples: "Sentinel XDR connections to China last 12 hours" or "failed login last 1 hour".',
        ].join('\n'),
        contextMeta: [{
          id: 'sentinelXdr',
          label: 'SentinelOne XDR',
          freshness: 'live',
          fetchedAt,
          configured: true,
          error: 'No PowerQuery template matched',
        }],
        contextPreview: {},
        queryContext: { topic: 'xdr', isFollowUp: ctx?.isFollowUp },
      }
    } else {
      return null
    }
  }

  const range = ctx?.range
    ? pqRangeFromQuestion(ctx.range)
    : pqRangeFromQuestion(effectiveQuestion)
  const { start, end } = parsePqTimeRange(range)
  const countryFilter = extractCountryFromQuestion(effectiveQuestion)
  const isGeoQuery = Boolean(countryFilter && rawQuery?.includes('IP Connect'))
  const columns = isGeoQuery
    ? [
      'timestamp',
      'event.type',
      'endpoint.name',
      'src.ip',
      'tgt.ip',
      'tgt.port',
      'src.process.name',
      'message',
    ]
    : [
      'timestamp',
      'event.type',
      'event.action',
      'event.id',
      'endpoint.name',
      'user.name',
      'src.ip',
      'src.process.user',
      'message',
    ]

  const effectiveQuery = buildPowerQueryText(rawQuery, columns, 500)
  let result = { rows: [], matchingEvents: 0 }
  let xdrError = null
  try {
    result = await runSentinelOnePowerQuery({
      query: effectiveQuery,
      start,
      end,
      limit: 500,
    })
  } catch (err) {
    xdrError = err.message || String(err)
    if (!isGeoQuery) throw err
  }

  const rows = result.rows || []
  const total = result.matchingEvents ?? rows.length
  const agg = aggregateRows(rows)
  const dstAgg = isGeoQuery ? aggregateDstIps(rows) : []
  const samples = formatSampleRows(rows)

  const lines = [
    `SentinelOne XDR (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    `Window: ${formatRangeLabel(range)}`,
    `XDR host: ${resolveSentinelOneXdrBase() || 'configured'}`,
  ]
  if (countryFilter) {
    const dirLabel = countryFilter.direction === 'src' ? 'from' : 'to'
    lines.push(`Country filter: connections ${dirLabel} ${countryFilter.name}`)
  }
  lines.push('')

  if (xdrError) {
    lines.push(`XDR PowerQuery error: ${xdrError}`)
    lines.push('(Geo fields may not exist in your tenant — see FortiGate section below for country-tagged sessions.)')
    lines.push('')
  } else {
    lines.push(`Matching XDR events: ${total}`)
    if (rows.length < total) lines.push(`(showing ${rows.length} rows in this response)`)
    lines.push('')
    lines.push('PowerQuery used:')
    lines.push(effectiveQuery)
    lines.push('')
  }

  const wantsEndpointList =
    ctx?.followUpKind === 'affected_stores'
    || ctx?.followUpKind === 'list'
    || /\b(which|list|show|endpoint|endpoints|hostname|machine|machines)\b/i.test(question)

  if (!xdrError && total === 0) {
    if (isGeoQuery) {
      lines.push('No XDR IP Connect events matched the country geo filter in this window.')
      lines.push('SentinelOne IP Connect logs usually do not include country unless geo enrichment is enabled.')
      lines.push('')
    } else {
      lines.push('No events matched in this time window.')
    }
  } else if (!xdrError && total > 0) {
    if (agg.byEndpoint.length) {
      lines.push(wantsEndpointList ? 'Endpoints:' : 'Top endpoints:')
      const endpointLimit = wantsEndpointList ? 25 : 15
      for (const { key, count } of agg.byEndpoint.slice(0, endpointLimit)) {
        lines.push(`  • ${key}: ${count}`)
      }
      if (wantsEndpointList && agg.byEndpoint.length > endpointLimit) {
        lines.push(`  … and ${agg.byEndpoint.length - endpointLimit} more`)
      }
      lines.push('')
    }
    if (agg.bySrcIp.length) {
      lines.push('Top source IPs:')
      for (const { key, count } of agg.bySrcIp) {
        lines.push(`  • ${key}: ${count}`)
      }
      lines.push('')
    }
    if (dstAgg.length) {
      lines.push('Top destination IPs:')
      for (const { key, count } of dstAgg) {
        lines.push(`  • ${key}: ${count}`)
      }
      lines.push('')
    }
    if (agg.byUser.length) {
      lines.push('Top users:')
      for (const { key, count } of agg.byUser) {
        lines.push(`  • ${key}: ${count}`)
      }
      lines.push('')
    }
    if (samples.length) {
      lines.push('Sample events:')
      for (const s of samples) {
        const dst = s.dstIp ? ` → ${s.dstIp}` : ''
        lines.push(`  • ${s.endpoint || '—'} | ${s.srcIp || '—'}${dst} | ${s.message || '—'}`)
      }
    }
  }

  let fwStats = null
  if (isGeoQuery && countryFilter) {
    fwStats = await appendFirewallCountrySection(lines, { range, countryFilter, allowedPages })
  }

  lines.push('', '(Direct answer from live SentinelOne XDR PowerQuery — no LLM wait.)')

  return {
    content: lines.join('\n'),
    contextMeta: [{
      id: 'sentinelXdr',
      label: 'SentinelOne XDR',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: `PowerQuery · ${formatRangeLabel(range)}`,
    }],
    contextPreview: {
      xdr: {
        range,
        totalEvents: total,
        rowCount: rows.length,
        query: rawQuery,
        country: countryFilter?.name || null,
        firewallCountryEvents: fwStats?.total ?? null,
        topEndpoints: agg.byEndpoint.slice(0, 5),
        topSourceIps: agg.bySrcIp.slice(0, 5),
        topDestIps: dstAgg.slice(0, 5),
      },
    },
    effectiveQuery,
    queryContext: ctx ? {
      topic: 'xdr',
      isFollowUp: ctx.isFollowUp,
      range,
    } : undefined,
  }
}
