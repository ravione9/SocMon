import { getESClient } from '../../config/elasticsearch.js'

/** @typedef {{ name: string, direction: 'dst'|'src' }} CountryFilter */

const COUNTRY_ALIASES = [
  { re: /\b(china|chinese|prc|cn)\b/i, name: 'China' },
  { re: /\b(india|indian|in)\b/i, name: 'India' },
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

const CONNECTION_MARKERS = /\b(connections?|connect|connected|ip connect|network connection|traffic sessions?)\b/i

/**
 * @param {string} question
 * @returns {CountryFilter|null}
 */
export function extractCountryFromQuestion(question) {
  const q = String(question || '')
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
  return Boolean(extractCountryFromQuestion(q) && CONNECTION_MARKERS.test(q))
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
