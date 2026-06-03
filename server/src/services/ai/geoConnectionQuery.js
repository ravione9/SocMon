import { getESClient } from '../../config/elasticsearch.js'

/** @typedef {{ name: string, direction: 'dst'|'src' }} CountryFilter */

const COUNTRY_ALIASES = [
  { re: /\b(china|chinese|prc|cn)\b/i, name: 'China' },
  // Do NOT use bare \bin\b — matches "in rop group", "in store mon", etc.
  { re: /\b(india|indian)\b/i, name: 'India' },
  { re: /\b(united states|u\.?s\.?a?\.?|america|american)\b/i, name: 'United States' },
  { re: /\b(russia|russian|ru)\b/i, name: 'Russia' },
  { re: /\b(pakistan|pakistani|pk)\b/i, name: 'Pakistan' },
  { re: /\b(singapore|sg)\b/i, name: 'Singapore' },
  { re: /\b(japan|japanese|jp)\b/i, name: 'Japan' },
  { re: /\b(hong kong|hk)\b/i, name: 'Hong Kong' },
  { re: /\b(uk|united kingdom|britain|british)\b/i, name: 'United Kingdom' },
  { re: /\b(germany|german|de)\b/i, name: 'Germany' },
  { re: /\b(australia|australian|au)\b/i, name: 'Australia' },
]

const CONNECTION_MARKERS = /\b(connections?|connect\w*|connected|ip connect|network connection|traffic sessions?|going to|devices?\b.*\b(?:to|from|china|india))\b/i

const STORE_CONN_FOLLOWUP = /\b(time range|time window|select time|historical|history|same query|check again|retry|for the past|in the past)\b/i
const STORE_CONN_TIME = /\b(last|past|previous)\s+\d+\s*(h|hr|hour|hours|m|min|minute|minutes|d|day|days)\b|\b(24\s*h|24\s*hours?|12\s*h|12\s*hours?|1\s*h|1\s*hour)\b/i

function combinedStoreConnText(question, ctx = null) {
  const parts = [question, ctx?.priorUser, ctx?.priorAssistant].filter(Boolean)
  return parts.join(' ')
}

/** Follow-up to a Store Monitor WiFi / RP group answer — stay on store path, not RCA/LLM-only. */
export function isStoreConnectivityFollowUp(question, ctx = null) {
  const priorStore = ctx?.priorTopic === 'store'
    || /Store Monitor/i.test(String(ctx?.priorAssistant || ''))
  if (!priorStore) return false
  const q = String(question || '').toLowerCase()
  const thread = combinedStoreConnText(question, ctx).toLowerCase()
  const hasWifiCtx = /\b(wifi|wi-?fi|wireless)\b/.test(thread)
    && (/\b(rop|rp)\s*group\b/.test(thread) || /\bro\s*p\b/.test(thread))
  if (!hasWifiCtx) return false
  if (STORE_CONN_FOLLOWUP.test(q)) return true
  if (STORE_CONN_TIME.test(q) && /\b(check|select|use|apply|same|again|wifi|range|time|hour)\b/.test(q)) return true
  return false
}

/** Store Monitor connectivity (WiFi, RP/RoP group) — not XDR geo. */
export function isStoreMonitorConnectivityQuery(question, ctx = null) {
  if (isStoreConnectivityFollowUp(question, ctx)) return true

  if (ctx?.priorAssistant && /Store Monitor/i.test(ctx.priorAssistant)) {
    const q2 = String(question || '').toLowerCase()
    const thread = combinedStoreConnText(question, ctx).toLowerCase()
    if (/\b(wifi|wi-?fi|wireless)\b/.test(thread) && /\b(rop|rp)\s*group\b/.test(thread)) {
      if (STORE_CONN_TIME.test(q2) || STORE_CONN_FOLLOWUP.test(q2)) return true
    }
  }

  const q = String(question || '').toLowerCase()
  if (/\b(sentinel|xdr|sentinelone|powerquery|fortigate|firewall|zabbix)\b/.test(q)) return false
  const ropGroup = /\b(rop|rp)\s*group\b/.test(q) || (/\bro\s*p\b/.test(q) && /\bgroup\b/.test(q))
  const storeCtx = /\b(store|stores|store mon|retail)\b/.test(q) || ropGroup
  const connCtx = /\b(wifi|wi-?fi|wireless|hotspot|ethernet|isp|connectivity|connect|connected|interface)\b/.test(q)
  if (ropGroup && connCtx) return true
  if (storeCtx && /\b(wifi|wi-?fi|wireless)\b/.test(q)) return true
  if (/\b(how many|count)\b/.test(q) && /\b(device|devices)\b/.test(q) && (ropGroup || /\b(wifi|wi-?fi)\b/.test(q))) {
    return true
  }
  if (STORE_CONN_TIME.test(q) && connCtx && ropGroup) return true
  return false
}

/** e.g. "top 20 devices with issue in store mon" */
export function isStoreMonitorIssuesQuery(question) {
  const q = String(question || '').toLowerCase()
  if (/\b(sentinel|xdr|zabbix|fortigate|sentinelone)\b/.test(q)) return false
  if (/\b(rca|root cause|why is|investigate)\b/.test(q) && !/\bstore mon\b/.test(q)) return false
  const storeCtx = /\b(store mon|store monitor|stores?)\b/.test(q)
  const issuesCtx = /\b(issue|issues|problem|problems|worst|troubled|affected)\b/.test(q)
  const listCtx = /\b(top|list|show|which|device|devices|worst)\b/.test(q)
  return storeCtx && issuesCtx && (listCtx || /\btop\s+\d+\b/.test(q))
}

export function extractTopLimit(question, defaultLimit = 20) {
  const m = String(question || '').match(/\btop\s+(\d+)\b/i)
  if (!m) return defaultLimit
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : defaultLimit
}

/**
 * @param {string} question
 * @returns {CountryFilter|null}
 */
export function extractCountryFromQuestion(question) {
  const q = String(question || '')
  if (isStoreMonitorConnectivityQuery(q)) return null
  let name = null
  for (const { re, name: canonical } of COUNTRY_ALIASES) {
    if (re.test(q)) {
      name = canonical
      break
    }
  }
  if (!name) return null

  let direction = 'dst'
  if (/\b(from|originating|origin|source country|src country)\b/i.test(q)) direction = 'src'
  if (/\b(to|toward|towards|into|destination country|dst country|made to)\b/i.test(q)) direction = 'dst'

  return { name, direction }
}

export function isGeoConnectionQuery(question) {
  const q = String(question || '')
  if (isStoreMonitorConnectivityQuery(q)) return false
  const country = extractCountryFromQuestion(q)
  if (!country) return false
  if (CONNECTION_MARKERS.test(q)) return true
  // "how many devices going to china" / XDR phrasing without exact "connection" spelling
  if (/\b(how many|count|total|devices?|endpoints?|machines?)\b/i.test(q)) return true
  if (/\bxdr\b/i.test(q)) return true
  if (/\b(sentinel|sentinelone)\b/i.test(q)) return true
  return false
}

/**
 * Best-effort PowerQuery — geo fields vary by tenant / marketplace enrichment.
 * @param {string} country
 */
export function buildGeoConnectionPowerQuery(country) {
  const c = String(country || '').replace(/'/g, "\\'")
  const geoClause = [
    `tgt.ip.location.country contains '${c}'`,
    `dst.endpoint.location.country contains '${c}'`,
    `geo.country contains '${c}'`,
    `location.country contains '${c}'`,
    `message contains '${c}'`,
  ].join(' OR ')
  return `event.type = 'IP Connect' AND (${geoClause})`
}

function rangeGte(range) {
  const m = String(range || '-12h').match(/^-?(\d+)(h|d|m)$/)
  if (!m) return 'now-12h'
  return `now-${m[1]}${m[2]}`
}

/**
 * FortiGate firewall sessions tagged with src/dst country (Elasticsearch firewall-*).
 * @param {string} range e.g. -12h
 * @param {CountryFilter} countryFilter
 */
export async function fetchFirewallCountryConnections(range, countryFilter) {
  const es = getESClient()
  const gte = rangeGte(range)
  const field = countryFilter.direction === 'src' ? 'fgt.srccountry.keyword' : 'fgt.dstcountry.keyword'
  const timeoutMs = Number.parseInt(process.env.ES_SOC_TIMEOUT_MS || '12000', 10)

  const withTimeout = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)),
  ])

  const res = await withTimeout(es.search({
    index: 'firewall-*',
    body: {
      size: 0,
      query: {
        bool: {
          filter: [
            { range: { '@timestamp': { gte, lte: 'now' } } },
            { term: { [field]: countryFilter.name } },
          ],
        },
      },
      aggs: {
        total: { value_count: { field: '@timestamp' } },
        allows: { filter: { term: { 'fgt.action.keyword': 'accept' } } },
        denies: { filter: { term: { 'fgt.action.keyword': 'deny' } } },
        topDstIp: { terms: { field: 'fgt.dstip.keyword', size: 8, order: { _count: 'desc' } } },
        topSrcIp: { terms: { field: 'fgt.srcip.keyword', size: 8, order: { _count: 'desc' } } },
        byDevice: { terms: { field: 'fgt.devname.keyword', size: 10, order: { _count: 'desc' } } },
      },
    },
  }))

  const agg = res.aggregations || {}
  return {
    total: agg.total?.value ?? 0,
    allows: agg.allows?.doc_count ?? 0,
    denies: agg.denies?.doc_count ?? 0,
    topDstIp: (agg.topDstIp?.buckets || []).map(b => ({ ip: b.key, count: b.doc_count })),
    topSrcIp: (agg.topSrcIp?.buckets || []).map(b => ({ ip: b.key, count: b.doc_count })),
    byDevice: (agg.byDevice?.buckets || []).map(b => ({ name: b.key, count: b.doc_count })),
    field,
  }
}
