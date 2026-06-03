import {
  isSentinelOneXdrConfigured,
  resolveSentinelOneXdrBase,
  runSentinelOnePowerQuery,
} from '../../utils/sentinelOneApi.js'
import { buildPowerQueryText, DEFAULT_TABLE_COLUMNS } from '../../utils/xdrPowerQuery.js'
import { parseQuestionTimeRange } from './queryContext.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'

const XDR_KEYWORDS = /\b(sentinel|sentinal|sentinelone|xdr|singularity|powerquery|power query|data lake)\b/i
const LOGIN_FAIL_KEYWORDS = /\b(failed login|login fail|login failure|logon fail|authentication fail|auth fail|4625|bad password|invalid logon)\b/i

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

  return null
}

export function isXdrQuestion(question) {
  const q = String(question || '')
  if (XDR_KEYWORDS.test(q)) return true
  if (LOGIN_FAIL_KEYWORDS.test(q)) return true
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
    const msg = String(rowVal(row, 'message', 'event.action') || '').slice(0, 120)
    return { timestamp: ts, endpoint: ep, user, srcIp: ip, message: msg }
  })
}

function buildQuestionForXdr(question, ctx) {
  if (!ctx?.isFollowUp || ctx.priorTopic !== 'xdr') return question
  const q = String(question || '')
  if (isXdrQuestion(q) || buildXdrQueryFromQuestion(q)) return q
  if (/\b(endpoint|endpoints|which|list|show|hostname|machine|machines|server|servers)\b/i.test(q)) {
    return `sentinel xdr failed login on server machines ${ctx.range ? ctx.range.replace(/^-/, 'last ') : 'last 1 hour'}`
  }
  return ctx.threadText || question
}

/**
 * Run live SentinelOne XDR PowerQuery — no LLM.
 * @param {string} question
 * @param {string[]} allowedPages
 * @param {ReturnType<import('./queryContext.js').resolveQueryContext>} [ctx]
 */
export async function tryDirectXdrAnswer(question, allowedPages, ctx = null) {
  if (!allowedPages.includes('sentinel')) return null

  const shouldRun =
    isXdrQuestion(question)
    || ctx?.directHandler === 'xdr'
    || (ctx?.isFollowUp && ctx.priorTopic === 'xdr')

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
  if (!rawQuery) {
    return {
      content: [
        'I can run live SentinelOne XDR PowerQuery for known patterns (failed login, process creation, DNS, network).',
        '',
        'Try:',
        '  • failed login on server machines last 1 hour',
        '  • sentinel xdr failed login last 24 hours',
        '',
        'Or use the Sentinel → XDR query tab for custom PowerQuery.',
      ].join('\n'),
      contextMeta: [{
        id: 'sentinelXdr',
        label: 'SentinelOne XDR',
        freshness: 'live',
        fetchedAt,
        configured: true,
        note: 'Could not map question to a safe PowerQuery template',
      }],
      contextPreview: {},
    }
  }

  const range = ctx?.range
    ? pqRangeFromQuestion(ctx.range)
    : pqRangeFromQuestion(effectiveQuestion)
  const { start, end } = parsePqTimeRange(range)
  const columns = [
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
  const result = await runSentinelOnePowerQuery({
    query: effectiveQuery,
    start,
    end,
    limit: 500,
  })

  const rows = result.rows || []
  const total = result.matchingEvents ?? rows.length
  const agg = aggregateRows(rows)
  const samples = formatSampleRows(rows)

  const lines = [
    `SentinelOne XDR (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    `Window: ${formatRangeLabel(range)}`,
    `XDR host: ${resolveSentinelOneXdrBase() || 'configured'}`,
    '',
    `Matching events: ${total}`,
    rows.length < total ? `(showing ${rows.length} rows in this response)` : '',
    '',
    'PowerQuery used:',
    effectiveQuery,
    '',
  ].filter(Boolean)

  const wantsEndpointList =
    ctx?.followUpKind === 'affected_stores'
    || ctx?.followUpKind === 'list'
    || /\b(which|list|show|endpoint|endpoints|hostname|machine|machines)\b/i.test(question)

  if (total === 0) {
    lines.push('No events matched in this time window.')
  } else {
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
        lines.push(`  • ${s.endpoint || '—'} | ${s.user || '—'} | ${s.srcIp || '—'} | ${s.message || '—'}`)
      }
    }
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
        topEndpoints: agg.byEndpoint.slice(0, 5),
        topSourceIps: agg.bySrcIp.slice(0, 5),
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
