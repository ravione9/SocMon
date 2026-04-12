import { Router } from 'express'
import { getESClient } from '../config/elasticsearch.js'
const router = Router()

const SERVER_TZ = process.env.TZ || 'UTC'

function getTimeRange(req) {
  const range = req.query.range || '24h'
  const dateFrom = req.query.from
  const dateTo = req.query.to
  return dateFrom && dateTo ? { gte: dateFrom, lte: dateTo } : { gte: 'now-' + range }
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

// Severity category → raw ES label values (mirrors getSevCategory on the frontend)
const SEV_MAP = {
  critical: ['critical','emergency','alert'],
  high:     ['error'],
  medium:   ['warning','warn'],
  low:      ['notice','notification'],
  info:     ['information','informational','info','debug','debugging'],
}

router.get('/search', async (req, res) => {
  try {
    const es  = getESClient()
    const { type, q, severity, srcip, dstip, action, logtype, device, mnemonic, site } = req.query
    const size = Math.min(parseInt(req.query.size) || 50, 500)
    const page = Math.max(parseInt(req.query.page) || 0, 0)
    const tr   = getTimeRange(req)
    const isFirewall = type === 'firewall'
    const index = isFirewall ? 'firewall-*' : 'cisco-*'

    const must   = [{ range: { '@timestamp': tr } }]
    const filter = []

    // free-text
    if (q) {
      const fields = isFirewall
        ? ['fgt.app','fgt.attack','fgt.srcip','fgt.dstip','fgt.srccountry','fgt.dstcountry','fgt.msg']
        : ['cisco_message','cisco_mnemonic','device_name','site_name']
      filter.push({ multi_match: { query: q, fields, type: 'phrase_prefix' } })
    }

    // SOC filters
    if (isFirewall) {
      if (srcip)   filter.push({ term: { 'fgt.srcip.keyword':    srcip  } })
      if (dstip)   filter.push({ term: { 'fgt.dstip.keyword':    dstip  } })
      if (action  && action   !== 'all') filter.push({ term: { 'fgt.action.keyword':   action  } })
      if (logtype && logtype  !== 'all') filter.push({ term: { 'fgt.subtype.keyword':  logtype } })
      if (severity && severity !== 'all' && SEV_MAP[severity])
        filter.push({ terms: { 'syslog_severity_label.keyword': SEV_MAP[severity] } })
    } else {
      // NOC filters
      if (device)   filter.push({ term: { 'device_name.keyword':      device   } })
      if (site)     filter.push({ term: { 'site_name.keyword':         site     } })
      if (mnemonic && mnemonic !== 'all') filter.push({ term: { 'cisco_mnemonic.keyword': mnemonic } })
      if (severity && severity !== 'all' && SEV_MAP[severity])
        filter.push({ terms: { 'cisco_severity_label.keyword': SEV_MAP[severity] } })
    }

    const sevField = isFirewall ? 'syslog_severity_label.keyword' : 'cisco_severity_label.keyword'

    const result = await es.search({
      index,
      body: {
        from: page * size,
        size,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { bool: { must, filter } },
        aggs: {
          by_severity: { terms: { field: sevField, size: 10 } },
          ...(isFirewall && { by_action: { terms: { field: 'fgt.action.keyword', size: 5 } } }),
        },
      },
    })

    res.json({
      total: result.hits.total.value,
      page,
      size,
      hits: result.hits.hits.map(h => ({ ...h._source, _id: h._id, _index: h._index })),
      aggs: {
        by_severity: result.aggregations?.by_severity?.buckets ?? [],
        by_action:   result.aggregations?.by_action?.buckets   ?? [],
      },
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router
