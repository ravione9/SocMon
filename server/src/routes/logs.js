import { Router } from 'express'
import { getESClient } from '../config/elasticsearch.js'
import { fortigateConfigKind } from '../utils/fortigateConfigKind.js'
import { fortigateVpnFilterBool } from '../utils/fortigateVpnQuery.js'
import { fortigateUserLoginFailedBool, ciscoUserLoginFailedBool } from '../utils/loginFailureQuery.js'
const router = Router()

const SERVER_TZ = process.env.TZ || 'UTC'

function getTimeRange(req) {
  const range = req.query.range || '12h'
  const dateFrom = req.query.from
  const dateTo = req.query.to
  return dateFrom && dateTo ? { gte: dateFrom, lte: dateTo } : { gte: 'now-' + range }
}

function ecsUserName(userField) {
  if (!userField) return ''
  if (typeof userField === 'string') return userField
  if (typeof userField === 'object') return userField.name || userField.username || userField.id || ''
  return ''
}

/** Cisco CONFIG_I text often: "Configured from console by USER on vty0" */
function parseCiscoConfigByUser(msg) {
  if (!msg) return ''
  const s = String(msg)
  let m = s.match(/\bby\s+(\S+?)(?=\s+on\b|[,;\s]*$)/i)
  if (m) return m[1].replace(/^['"`]+|['"`]+$/g, '')
  m = s.match(/\buser\s+['"]?(\S+?)['"]?(?:\s|$|,|;)/i)
  if (m) return m[1].replace(/['"`]+/g, '')
  return ''
}

function mapCiscoConfigHit(h) {
  const src = h._source || {}
  const msg = src.cisco_message || src.message || ''
  const byUser =
    ecsUserName(src.user) ||
    ecsUserName(src.host?.user) ||
    parseCiscoConfigByUser(msg)
  return {
    ...src,
    _id: h._id,
    _index: h._index,
    change_by: byUser || '—',
    change_what: msg || '—',
  }
}

function parseFortiKey(msg, key) {
  const s = String(msg || '')
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let m = s.match(new RegExp(`${esc}="([^"]*)"`, 'i'))
  if (m) return m[1].trim()
  m = s.match(new RegExp(`${esc}='([^']*)'`, 'i'))
  if (m) return m[1].trim()
  m = s.match(new RegExp(`\\b${esc}=([^\\s,]+)`, 'i'))
  if (m) return m[1].replace(/^['"]+|['"]+$/g, '').trim()
  return ''
}

const BOGUS_FW_HOSTNAME = /^(root|syslog|nobody|user|localhost|elasticsearch|elastic)$/i

function isPlausibleFirewallHostname(s) {
  if (s == null || typeof s !== 'string') return false
  const t = s.trim()
  if (!t) return false
  return !BOGUS_FW_HOSTNAME.test(t)
}

function pickFirewallName(...vals) {
  for (const v of vals) {
    if (typeof v !== 'string') continue
    const t = v.trim()
    if (t && isPlausibleFirewallHostname(t)) return t
  }
  return ''
}

function firstScalarIp(val) {
  if (val == null || val === '') return ''
  if (Array.isArray(val)) return String(val.find(Boolean) ?? '')
  return String(val)
}

/** FortiGate hostname + IP; skips collector host.name when bogus (e.g. root). */
function firewallIdentityFromSrc(src) {
  const f = src.fgt || {}
  const msg = f.msg || src.message || ''
  const host = src.host || {}
  const obs = src.observer || {}
  const source = src.source || {}
  const device = src.device || {}
  const devFlat = typeof src['fgt.devname'] === 'string' ? src['fgt.devname'] : ''
  const name = pickFirewallName(
    f.devname ? String(f.devname) : '',
    devFlat,
    parseFortiKey(msg, 'devname'),
    typeof obs.hostname === 'string' ? obs.hostname : '',
    typeof obs.name === 'string' ? obs.name : '',
    typeof device.name === 'string' ? device.name : '',
    typeof host.hostname === 'string' ? host.hostname : '',
    typeof host.name === 'string' ? host.name : '',
    typeof src.hostname === 'string' ? src.hostname : '',
  )
  const ip = String(
    firstScalarIp(host.ip) ||
      firstScalarIp(obs.ip) ||
      firstScalarIp(source.ip) ||
      f.devip ||
      f['device-ip'] ||
      parseFortiKey(msg, 'devip') ||
      '',
  ).trim()
  return { name, ip }
}

function mapFirewallConfigHit(h) {
  const src = h._source || {}
  const f = src.fgt || {}
  const msg = f.msg || src.message || ''
  const byUser =
    f.user ||
    f.admin ||
    f.un ||
    parseFortiKey(msg, 'user') ||
    parseFortiKey(msg, 'admin') ||
    parseFortiKey(msg, 'usr')
  const whatParts = [f.cfgpath, f.cmd, f.act, f.oid].filter(Boolean)
  const changeWhat = whatParts.length ? whatParts.join(' · ') : msg
  const { name: firewallName, ip: firewallIp } = firewallIdentityFromSrc(src)
  return {
    ...src,
    _id: h._id,
    _index: h._index,
    change_by: byUser || '—',
    change_what: changeWhat || msg || '—',
    change_kind: fortigateConfigKind(src),
    firewall_name: firewallName,
    firewall_ip: firewallIp,
  }
}

function byDeviceCountsFromCiscoHits(hits) {
  const m = {}
  for (const h of hits) {
    const k = h.device_name || 'Unknown'
    m[k] = (m[k] || 0) + 1
  }
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }))
}

router.get('/interfaces', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const result = await es.search({
      index: 'cisco-*',
      body: {
        size: 0,
        query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'cisco_mnemonic.keyword': 'UPDOWN' } }] } },
        aggs: {
          timeline: {
            date_histogram: { field: '@timestamp', fixed_interval: '5m', time_zone: SERVER_TZ },
            aggs: {
              up:   { filter: { match: { cisco_message: 'changed state to up' } } },
              down: { filter: { match: { cisco_message: 'changed state to down' } } },
            }
          },
          top_interfaces: { terms: { field: 'cisco_interface_full.keyword', size: 10 } },
          top_devices:    { terms: { field: 'device_name.keyword', size: 10 } },
        }
      }
    })
    res.json({
      timeline: result.aggregations?.timeline?.buckets?.map(b => ({ time: b.key_as_string, up: b.up.doc_count, down: b.down.doc_count, total: b.doc_count })) ?? [],
      top_interfaces: result.aggregations?.top_interfaces?.buckets ?? [],
      top_devices:    result.aggregations?.top_devices?.buckets ?? [],
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/macflap', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const result = await es.search({
      index: 'cisco-*',
      body: {
        size: 50,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'cisco_mnemonic.keyword': 'MACFLAP_NOTIF' } }] } },
        _source: ['@timestamp','cisco_mac_address','cisco_vlan_id','cisco_port_from','cisco_port_to','device_name','site_name','cisco_message'],
        aggs: {
          by_device: { terms: { field: 'device_name.keyword', size: 10 } },
          by_vlan:   { terms: { field: 'cisco_vlan_id.keyword', size: 10 } },
        }
      }
    })
    res.json({
      events:    result.hits.hits.map(h => h._source),
      by_device: result.aggregations?.by_device?.buckets ?? [],
      by_vlan:   result.aggregations?.by_vlan?.buckets ?? [],
      total:     result.hits.total.value,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

function getInterval(req) {
  const { from, to, range } = req.query
  if (from && to) {
    const ms = new Date(to) - new Date(from)
    if (ms <= 3_600_000)    return '1m'
    if (ms <= 21_600_000)   return '5m'
    if (ms <= 86_400_000)   return '30m'
    if (ms <= 604_800_000)  return '2h'
    return '6h'
  }
  const map = { '15m':'1m', '1h':'1m', '6h':'5m', '12h':'15m', '24h':'1h', '3d':'2h', '7d':'6h', '30d':'12h' }
  return map[range] || '1h'
}

router.get('/traffic/timeline', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const interval = getInterval(req)
    const result = await es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: { range: { '@timestamp': tr } },
        aggs: {
          timeline: {
            date_histogram: { field: '@timestamp', fixed_interval: interval, time_zone: SERVER_TZ },
            aggs: {
              allowed: { filter: { term: { 'fgt.action.keyword': 'allow' } } },
              denied:  { filter: { term: { 'fgt.action.keyword': 'deny' } } },
            },
          },
        },
      },
    })
    res.json(result.aggregations?.timeline?.buckets?.map(b => ({ time: b.key_as_string, allowed: b.allowed.doc_count, denied: b.denied.doc_count, total: b.doc_count })) ?? [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/threats/top', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const result = await es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'fgt.subtype.keyword': 'ips' } }] } },
        aggs: { attacks: { terms: { field: 'fgt.attack.keyword', size: 10 } } },
      },
    })
    res.json(result.aggregations?.attacks?.buckets?.map(b => ({ name: b.key, count: b.doc_count })) ?? [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/denied', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const result = await es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'fgt.action.keyword': 'deny' } }] } },
        aggs: {
          by_src:     { terms: { field: 'fgt.srcip.keyword', size: 15 } },
          by_country: {
            terms: {
              field: 'fgt.srccountry.keyword',
              size: 20,
              exclude: ['Reserved', 'private', 'Private'],
            },
          },
          reserved_count: {
            filter: { term: { 'fgt.srccountry.keyword': 'Reserved' } },
          },
        },
      },
    })
    res.json({
      by_src:        result.aggregations?.by_src?.buckets?.map(b => ({ ip: b.key, count: b.doc_count })) ?? [],
      by_country:    result.aggregations?.by_country?.buckets?.map(b => ({ country: b.key, count: b.doc_count })) ?? [],
      reserved_count: result.aggregations?.reserved_count?.doc_count ?? 0,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/events/recent', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const index = req.query.type === 'cisco' ? 'cisco-*' : req.query.type === 'firewall' ? 'firewall-*' : 'firewall-*,cisco-*'
    const result = await es.search({
      index,
      body: {
        size: parseInt(req.query.size) || 50,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { range: { '@timestamp': tr } },
      },
    })
    res.json(result.hits.hits.map(h => ({ ...h._source, _index: h._index })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/sessions', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const result = await es.search({
      index: 'firewall-*',
      body: {
        size: 100,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'fgt.type.keyword': 'traffic' } }] } },
      },
    })
    res.json(result.hits.hits.map(h => h._source))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

/** Cisco switch/router CONFIG_I / “Configured from…” and FortiGate firewall configuration-change messages.
 *  Query: scope=all|cisco|firewall (default all). Use scope=cisco on NOC and scope=firewall on SOC. */
router.get('/config/changes', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const size = Math.min(Math.max(parseInt(req.query.size, 10) || 200, 1), 500)
    const rawScope = String(req.query.scope || 'all').toLowerCase()
    const scope = ['all', 'cisco', 'firewall'].includes(rawScope) ? rawScope : 'all'
    const needCisco = scope === 'all' || scope === 'cisco'
    const needFw = scope === 'all' || scope === 'firewall'

    const ciscoQuery = {
      bool: {
        must: [
          { range: { '@timestamp': tr } },
          {
            bool: {
              should: [
                { term: { 'cisco_mnemonic.keyword': 'CONFIG_I' } },
                { match_phrase_prefix: { cisco_message: 'Configured from' } },
                { match_phrase_prefix: { cisco_message: 'configuring interface' } },
              ],
              minimum_should_match: 1,
            },
          },
        ],
      },
    }

    const firewallConfigPhrases = [
      'Configuration changed',
      'configuration changed',
      'Object configured',
      'object configured',
      'Attribute configured',
      'attribute configured',
      'cfg restore',
      'CFG restore',
      'Configuration revision',
      'configuration revision',
    ]
    const firewallConfigFields = ['fgt.msg', 'message', 'fgt.logdesc']
    const firewallConfigShould = []
    for (const field of firewallConfigFields) {
      for (const phrase of firewallConfigPhrases) {
        firewallConfigShould.push({ match_bool_prefix: { [field]: phrase } })
      }
    }

    const firewallQuery = {
      bool: {
        must: [{ range: { '@timestamp': tr } }],
        filter: [
          {
            bool: {
              should: firewallConfigShould,
              minimum_should_match: 1,
            },
          },
        ],
      },
    }

    const ciscoSource = {
      includes: [
        '@timestamp', 'device_name', 'site_name', 'cisco_mnemonic', 'cisco_message', 'cisco_severity_label',
        'message', 'user', 'host',
      ],
    }
    const fwSource = {
      includes: [
        '@timestamp',
        'syslog_severity_label',
        'fgt',
        'host',
        'message',
        'hostname',
        'observer',
        'source',
      ],
    }

    let cisco = { total: 0, hits: [], by_device: [] }
    let firewall = { total: 0, hits: [] }

    if (needCisco && needFw) {
      const [ciscoR, fwR] = await Promise.all([
        es.search({
          index: 'cisco-*',
          body: {
            size,
            sort: [{ '@timestamp': { order: 'desc' } }],
            query: ciscoQuery,
            _source: ciscoSource,
          },
        }),
        es.search({
          index: 'firewall-*',
          body: {
            size,
            sort: [{ '@timestamp': { order: 'desc' } }],
            query: firewallQuery,
            _source: fwSource,
          },
        }),
      ])
      const ciscoHits = ciscoR.hits.hits.map(mapCiscoConfigHit)
      cisco = {
        total: typeof ciscoR.hits.total === 'object' ? ciscoR.hits.total.value : ciscoR.hits.total,
        hits: ciscoHits,
        by_device: byDeviceCountsFromCiscoHits(ciscoHits),
      }
      firewall = {
        total: typeof fwR.hits.total === 'object' ? fwR.hits.total.value : fwR.hits.total,
        hits: fwR.hits.hits.map(mapFirewallConfigHit),
      }
    } else if (needCisco) {
      const ciscoR = await es.search({
        index: 'cisco-*',
        body: {
          size,
          sort: [{ '@timestamp': { order: 'desc' } }],
          query: ciscoQuery,
          _source: ciscoSource,
        },
      })
      const ciscoHits = ciscoR.hits.hits.map(mapCiscoConfigHit)
      cisco = {
        total: typeof ciscoR.hits.total === 'object' ? ciscoR.hits.total.value : ciscoR.hits.total,
        hits: ciscoHits,
        by_device: byDeviceCountsFromCiscoHits(ciscoHits),
      }
    } else if (needFw) {
      const fwR = await es.search({
        index: 'firewall-*',
        body: {
          size,
          sort: [{ '@timestamp': { order: 'desc' } }],
          query: firewallQuery,
          _source: fwSource,
        },
      })
      firewall = {
        total: typeof fwR.hits.total === 'object' ? fwR.hits.total.value : fwR.hits.total,
        hits: fwR.hits.hits.map(mapFirewallConfigHit),
      }
    }

    res.json({ cisco, firewall, scope })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Severity category → raw ES label values (mirrors getSevCategory on the frontend)
const SEV_MAP = {
  critical: ['critical','emergency','alert'],
  high:     ['error'],
  medium:   ['warning','warn'],
  low:      ['notice','notification'],
  info:     ['information','informational','info','debug','debugging'],
}

/** FortiGate syslog numeric level (0–7) — int + string (many indices map level as keyword). */
const FGT_LEVEL_BY_SEV = {
  critical: [0, 1, 2, '0', '1', '2'],
  high: [3, '3'],
  medium: [4, '4'],
  low: [5, '5'],
  info: [6, 7, '6', '7'],
}

/** Case-friendly match on ECS log.level (terms on keyword are case-sensitive). */
const LOG_LEVEL_QUERY_STRING = {
  critical: '(critical OR emergency OR alert OR emerg OR crit OR fatal OR panic OR c OR a)',
  high: '(error OR err OR e)',
  medium: '(warning OR warn OR w OR medium)',
  low: '(notice OR notification OR n OR low)',
  info: '(information OR informational OR info OR debug OR debugging OR i OR d)',
}

/** Flexible text match on severity labels (table uses substring-style getSevCategory on analyzed fields). */
function syslogLabelMultiMatch(sevKey) {
  const labels = SEV_MAP[sevKey]
  if (!labels?.length) return null
  const q = labels.join(' ')
  return {
    multi_match: {
      query: q,
      fields: [
        'syslog_severity_label',
        'syslog_severity_label.keyword',
        'cisco_severity_label',
        'cisco_severity_label.keyword',
      ],
      type: 'best_fields',
      operator: 'or',
      lenient: true,
    },
  }
}

function fortinetSeverityMultiMatch(sevKey) {
  const labels = SEV_MAP[sevKey]
  if (!labels?.length) return null
  return {
    multi_match: {
      query: labels.join(' '),
      fields: ['fortinet.firewall.severity', 'fortinet.firewall.severity.keyword'],
      type: 'best_fields',
      operator: 'or',
      lenient: true,
    },
  }
}

/** One category of severity for FortiGate/ECS docs (aligned with client getSevCategory in logSeverity.js). */
function firewallSeverityMatchQuery(sevKey) {
  const labels = SEV_MAP[sevKey]
  if (!labels) return null
  const levels = FGT_LEVEL_BY_SEV[sevKey]
  const logLvlQs = LOG_LEVEL_QUERY_STRING[sevKey]
  const should = [
    { terms: { 'syslog_severity_label.keyword': labels } },
    syslogLabelMultiMatch(sevKey),
    fortinetSeverityMultiMatch(sevKey),
    { terms: { 'fgt.level': levels } },
    { terms: { 'log.syslog.severity.code': levels } },
  ].filter(Boolean)
  if (logLvlQs) {
    should.push({
      query_string: {
        query: logLvlQs,
        fields: ['log.level^2', 'log.level.keyword^1.5'],
        lenient: true,
        analyze_wildcard: false,
        default_operator: 'OR',
      },
    })
  }
  if (sevKey === 'high') {
    should.push({ term: { 'fgt.subtype.keyword': 'ips' } }, { term: { 'fgt.subtype': 'ips' } })
  }
  return { bool: { should, minimum_should_match: 1 } }
}

/** ES 7+ total with optional relation when track_total_hits is capped. */
function hitsTotalMeta(total) {
  if (total == null) return { value: 0, relation: 'eq' }
  if (typeof total === 'object' && 'value' in total) {
    return { value: total.value, relation: total.relation === 'gte' ? 'gte' : 'eq' }
  }
  if (typeof total === 'number') return { value: total, relation: 'eq' }
  return { value: 0, relation: 'eq' }
}

/** Avoid exact doc counts on huge windows — speeds up 7d/30d searches materially. */
const SEARCH_TRACK_TOTAL_HITS_CAP = Math.min(
  Math.max(parseInt(process.env.LOG_SEARCH_TRACK_TOTAL_CAP, 10) || 100000, 1000),
  2_000_000,
)

const FW_SEARCH_SOURCE = {
  includes: [
    '@timestamp',
    'syslog_severity_label',
    'fgt',
    'message',
    'device',
    'user',
    'host',
    'observer',
    'source',
    'fortinet',
    'log',
    'event',
    'hostname',
    'site_name',
  ],
}

const CISCO_SEARCH_SOURCE = {
  includes: [
    '@timestamp',
    'syslog_severity_label',
    'cisco_severity_label',
    'cisco_message',
    'cisco_mnemonic',
    'cisco_interface_full',
    'cisco_vlan_id',
    'device_name',
    'site_name',
    'user',
    'message',
  ],
}

/** Same filters as GET /search — used by /search and GET /export (search_after). */
function buildLogSearchClauses(req) {
  const { type, q, severity, srcip, dstip, srccountry, dstcountry, action, logtype, device, mnemonic, site, iface, vlan } = req.query
  const tr = getTimeRange(req)
  const isFirewall = type === 'firewall'
  const index = isFirewall ? 'firewall-*' : 'cisco-*'
  const must = [{ range: { '@timestamp': tr } }]
  const filter = []

  if (q) {
    const qStr = String(q).trim()
    if (qStr) {
      if (isFirewall) {
        const fields = [
          'fgt.app',
          'fgt.attack',
          'fgt.srcip',
          'fgt.dstip',
          'fgt.srccountry',
          'fgt.dstcountry',
          'fgt.msg',
          'fgt.logdesc',
          'fgt.type',
          'fgt.subtype',
          'message',
        ]
        filter.push({
          bool: {
            should: [
              { multi_match: { query: qStr, fields, type: 'bool_prefix' } },
              { multi_match: { query: qStr, fields, type: 'phrase_prefix' } },
            ],
            minimum_should_match: 1,
          },
        })
      } else {
        const fields = ['cisco_message', 'cisco_mnemonic', 'device_name', 'site_name']
        filter.push({ multi_match: { query: qStr, fields, type: 'phrase_prefix' } })
      }
    }
  }

  if (isFirewall) {
    // Term queries on indexed keyword fields — uses inverted index, fast on any window size.
    if (device && device !== 'all') {
      const dev = String(device).trim()
      if (dev) {
        filter.push({
          bool: {
            should: [
              { term: { 'fgt.devname.keyword': dev } },
              { term: { 'device.name.keyword': dev } },
              { term: { 'observer.name.keyword': dev } },
              { term: { 'observer.hostname.keyword': dev } },
              { term: { 'host.hostname.keyword': dev } },
              { term: { 'host.name.keyword': dev } },
              { term: { 'hostname.keyword': dev } },
            ],
            minimum_should_match: 1,
          },
        })
      }
    }
    if (srcip) filter.push({ term: { 'fgt.srcip.keyword': srcip } })
    if (dstip) filter.push({ term: { 'fgt.dstip.keyword': dstip } })
    if (srccountry) filter.push({ term: { 'fgt.srccountry.keyword': srccountry } })
    if (dstcountry) filter.push({ term: { 'fgt.dstcountry.keyword': dstcountry } })
    if (action && action !== 'all') filter.push({ term: { 'fgt.action.keyword': action } })
    if (logtype && logtype !== 'all') {
      const lt = String(logtype).toLowerCase()
      if (lt === 'utm') {
        filter.push({ term: { 'fgt.type.keyword': 'utm' } })
      } else if (lt === 'traffic') {
        filter.push({ term: { 'fgt.type.keyword': 'traffic' } })
      } else if (lt === 'vpn') {
        filter.push(fortigateVpnFilterBool())
      } else if (lt === 'login_fail') {
        filter.push(fortigateUserLoginFailedBool())
      } else if (lt === 'ips') {
        filter.push({
          bool: {
            should: [
              { term: { 'fgt.subtype.keyword': 'ips' } },
              { term: { 'fgt.type.keyword': 'ips' } },
            ],
            minimum_should_match: 1,
          },
        })
      } else {
        filter.push({ term: { 'fgt.subtype.keyword': logtype } })
      }
    }
    const sevNorm = String(severity || '')
      .toLowerCase()
      .trim()
    if (sevNorm && sevNorm !== 'all' && SEV_MAP[sevNorm]) {
      const fq = firewallSeverityMatchQuery(sevNorm)
      if (fq) filter.push(fq)
    }
  } else {
    if (device) filter.push({ term: { 'device_name.keyword': device } })
    if (site) filter.push({ term: { 'site_name.keyword': site } })
    if (mnemonic && mnemonic !== 'all') filter.push({ term: { 'cisco_mnemonic.keyword': mnemonic } })
    if (iface) filter.push({ match_phrase_prefix: { cisco_interface_full: iface } })
    if (vlan) filter.push({ term: { 'cisco_vlan_id.keyword': String(vlan) } })
    if (severity && severity !== 'all' && SEV_MAP[severity])
      filter.push({ terms: { 'cisco_severity_label.keyword': SEV_MAP[severity] } })
    if (logtype && logtype !== 'all') {
      const lt = String(logtype).toLowerCase()
      if (lt === 'login_fail') filter.push(ciscoUserLoginFailedBool())
    }
  }

  return { index, must, filter, isFirewall }
}

/** ES bool: omit empty `filter` array (some clusters treat it differently from missing). */
function buildBoolQuery(must, filter) {
  if (!filter?.length) return { bool: { must } }
  return { bool: { must, filter } }
}

function mergeExportQuery(req) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  return { ...req.query, ...body }
}

function csvEscape(val) {
  if (val == null || val === '') return ''
  const s = String(val)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** search_after values from ES (must match sort array length). */
function searchAfterFromHit(hit, sortLen) {
  const s = hit?.sort
  const n = sortLen ?? 2
  if (Array.isArray(s) && s.length >= n && !s.slice(0, n).some(v => v === undefined || v === null)) return s.slice(0, n)
  return null
}

function exportFirewallCsvLine(src) {
  const f = src.fgt || {}
  const ts = src['@timestamp'] || ''
  const sev = src.syslog_severity_label || ''
  const device =
    (typeof src.device?.name === 'string' && src.device.name) ||
    (typeof src.device?.hostname === 'string' && src.device.hostname) ||
    (f.devname != null && String(f.devname)) ||
    ''
  const user =
    (f.user != null && String(f.user)) ||
    (f.authuser != null && String(f.authuser)) ||
    (src.user?.name != null && String(src.user.name)) ||
    ''
  const action = f.action || src['fgt.action'] || ''
  const srcip = f.srcip || src['fgt.srcip'] || ''
  const dstip = f.dstip || src['fgt.dstip'] || ''
  const country = f.srccountry || src['fgt.srccountry'] || ''
  const app = f.app || f.subtype || src['fgt.app'] || src['fgt.subtype'] || ''
  const msg = f.msg || src.message || ''
  return [ts, sev, device, user, action, srcip, dstip, country, app, msg].map(csvEscape).join(',')
}

const CISCO_USER_RES = [
  /(?:Authentication failed|authentication failed)[^.]*?user\s+['"]?([A-Za-z0-9._@\\-]+)/i,
  /User\s+([A-Za-z0-9._@\\-]+)\s+(?:fail|invalid|denied|locked)/i,
  /login failed.*?for\s+['"]?([A-Za-z0-9._@\\-]+)/i,
  /for user\s+['"]?([A-Za-z0-9._@\\-]+)/i,
  /username[:=]\s*['"]?([A-Za-z0-9._@\\-]+)/i,
  /by\s+username\s+['"]?([A-Za-z0-9._@\\-]+)/i,
]

function ciscoUserFromMessage(msg) {
  const s = String(msg || '')
  for (const re of CISCO_USER_RES) {
    const m = s.match(re)
    if (m?.[1]) return m[1].trim()
  }
  return ''
}

function exportCiscoCsvLine(src) {
  const ts = src['@timestamp'] || ''
  const sev = src.syslog_severity_label || src.cisco_severity_label || ''
  const device = src.device_name || ''
  const msg = src.cisco_message || ''
  let user = ciscoUserFromMessage(msg)
  if (!user && src.user?.name) user = String(src.user.name)
  const mnemonic = src.cisco_mnemonic || ''
  const iface = src.cisco_interface_full || ''
  const vlan = src.cisco_vlan_id != null ? String(src.cisco_vlan_id) : ''
  return [ts, sev, device, user, mnemonic, iface, vlan, msg].map(csvEscape).join(',')
}

/** ES 7/8 terms agg: buckets array, or keyed object in some configs. */
function normalizeTermsBuckets(agg) {
  if (!agg) return []
  const raw = agg.buckets
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return Object.values(raw).filter(Boolean)
  return []
}

router.get('/search', async (req, res) => {
  try {
    const es = getESClient()
    const size = Math.min(parseInt(req.query.size) || 50, 500)
    const page = Math.max(parseInt(req.query.page) || 0, 0)
    const fast = String(req.query.fast || '').toLowerCase() === '1' || String(req.query.fast || '').toLowerCase() === 'true'
    const { index, must, filter, isFirewall } = buildLogSearchClauses(req)

    const sevField = isFirewall ? 'syslog_severity_label.keyword' : 'cisco_severity_label.keyword'

    // Detect very wide ranges → drop heavy aggs to keep response under timeout.
    const trMs = (() => {
      const { from, to, range } = req.query
      if (from && to) {
        const ms = new Date(to) - new Date(from)
        return Number.isFinite(ms) ? ms : 0
      }
      const map = { '15m': 9e5, '1h': 3.6e6, '6h': 2.16e7, '12h': 4.32e7, '24h': 8.64e7, '3d': 2.592e8, '7d': 6.048e8, '30d': 2.592e9 }
      return map[range] || 0
    })()
    const wideRange = trMs > 7 * 86_400_000  // > 7 days
    const skipDeviceAgg = String(req.query.skipDeviceAgg || '').toLowerCase() === '1'

    // `by_sev_cat` (filters agg with five full-text bool queries) is very expensive on multi‑million
    // doc windows; severity breakdown uses `by_severity` + client mapping (LogSearch.jsx).
    const result = await es.search(
      {
        index,
        body: {
          // Use a small cap instead of false so pagination total is available.
          // false would return total=0, breaking page navigation.
          track_total_hits: fast || wideRange ? 5000 : SEARCH_TRACK_TOTAL_HITS_CAP,
          timeout: fast ? '45s' : wideRange ? '210s' : '150s',
          from: page * size,
          size,
          ...(fast || wideRange ? { terminate_after: Math.max(size * 20, 5000) } : {}),
          sort: [{ '@timestamp': { order: 'desc' } }],
          query: buildBoolQuery(must, filter),
          _source: isFirewall ? FW_SEARCH_SOURCE : CISCO_SEARCH_SOURCE,
          aggs: {
            ...(wideRange ? {} : { by_severity: { terms: { field: sevField, size: 15 } } }),
            ...(isFirewall && !wideRange && {
              by_action: { terms: { field: 'fgt.action.keyword', size: 8 } },
            }),
            // Device agg: sampler caps at shard_size docs per shard → fast even on large indices.
            // Both indexed fields merged on client side.
            ...(isFirewall && !skipDeviceAgg && !wideRange && {
              device_sample: {
                sampler: { shard_size: 500 },
                aggs: {
                  by_devname: {
                    terms: { field: 'fgt.devname.keyword', size: 50, missing: '__missing__' },
                  },
                  by_device_name: {
                    terms: { field: 'device.name.keyword', size: 50, missing: '__missing__' },
                  },
                },
              },
            }),
          },
        },
      },
      { requestTimeout: fast ? 90_000 : wideRange ? 300_000 : 240_000 },
    )

    const totalMeta = hitsTotalMeta(result.hits.total)

    // Merge both device name fields, dedupe, strip missing sentinel.
    const deviceBuckets = (() => {
      const s = result.aggregations?.device_sample
      const raw = [
        ...normalizeTermsBuckets(s?.by_devname),
        ...normalizeTermsBuckets(s?.by_device_name),
      ]
      const m = new Map()
      for (const b of raw) {
        const k = String(b.key ?? '').trim()
        if (!k || k === '__missing__') continue
        m.set(k, (m.get(k) || 0) + (b.doc_count || 0))
      }
      return [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, doc_count]) => ({ key, doc_count }))
    })()

    res.json({
      total: totalMeta.value,
      totalRelation: totalMeta.relation,
      page,
      size,
      hits: result.hits.hits.map(h => ({ ...h._source, _id: h._id, _index: h._index })),
      aggs: {
        by_severity: result.aggregations?.by_severity?.buckets ?? [],
        by_action: result.aggregations?.by_action?.buckets ?? [],
        by_device: deviceBuckets,
        by_sev_cat: null,
      },
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * Full result set for the same filters as /search, using search_after (not limited to 10k deep paging).
 * UTF-8 CSV with BOM — opens in Excel. Cap: maxRows (default 100000).
 * Use POST with JSON body for long filter strings (GET query URLs can truncate).
 */
async function handleLogsExport(req, res) {
  try {
    const q = mergeExportQuery(req)
    const { type } = q
    if (type !== 'firewall' && type !== 'cisco') {
      return res.status(400).json({ error: 'Query parameter type must be "firewall" or "cisco".' })
    }

    const maxRows = Math.min(Math.max(parseInt(String(q.maxRows), 10) || 100000, 1), 200000)
    const batchSize = Math.min(1000, maxRows)

    const es = getESClient()
    const { index, must, filter, isFirewall } = buildLogSearchClauses({ query: q })
    const sort = [{ '@timestamp': { order: 'desc' } }, { _shard_doc: 'desc' }]

    const safeType = type === 'firewall' ? 'soc' : 'noc'
    const filename = `netpulse-${safeType}-logs-export.csv`

    const headers = isFirewall
      ? ['Time', 'Severity', 'Device', 'User', 'Action', 'Src IP', 'Dst IP', 'Country', 'App/Type', 'Message']
      : ['Time', 'Severity', 'Device', 'User', 'Mnemonic', 'Interface', 'VLAN', 'Message']
    const headerLine = headers.map(csvEscape).join(',') + '\n'

    let searchAfter = null
    let written = 0

    while (written < maxRows) {
      const take = Math.min(batchSize, maxRows - written)
      const body = {
        size: take,
        sort,
        query: buildBoolQuery(must, filter),
      }
      if (searchAfter) body.search_after = searchAfter

      const result = await es.search({ index, body })
      const hits = result.hits.hits

      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
        res.write('\ufeff')
        res.write(headerLine)
      }

      if (!hits.length) break

      for (const h of hits) {
        const src = h._source || {}
        const line = isFirewall ? exportFirewallCsvLine(src) : exportCiscoCsvLine(src)
        res.write(line + '\n')
        written++
        if (written >= maxRows) break
      }

      searchAfter = searchAfterFromHit(hits[hits.length - 1], sort.length)
      if (!searchAfter) break
      if (hits.length < take) break
    }

    res.end()
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
    else res.end()
  }
}

router.get('/export', handleLogsExport)
router.post('/export', handleLogsExport)

export default router
