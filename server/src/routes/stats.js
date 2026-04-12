import { Router } from 'express'
import { getESClient } from '../config/elasticsearch.js'
const router = Router()

function getTimeRange(req) {
  const range = req.query.range || '24h'
  const dateFrom = req.query.from
  const dateTo = req.query.to
  return dateFrom && dateTo ? { gte: dateFrom, lte: dateTo } : { gte: 'now-' + range }
}

router.get('/soc', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const [totalHits, deniedHits, ipsHits, authHits, utmHits, vpnHits] = await Promise.all([
      es.count({ index: 'firewall-*', body: { query: { range: { '@timestamp': tr } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'fgt.action.keyword': 'deny' } }] } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'fgt.subtype.keyword': 'ips' } }] } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { terms: { 'cisco_mnemonic.keyword': ['LOGIN_SUCCESS','LOGOUT','SSH2_USERAUTH','SSH2_SESSION'] } }] } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'fgt.type.keyword': 'utm' } }] } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'fgt.type.keyword': 'vpn' } }] } } } }),
    ])
    res.json({
      total:  totalHits.count,
      denied: deniedHits.count,
      ips:    ipsHits.count,
      auth:   authHits.count,
      utm:    utmHits.count,
      vpn:    vpnHits.count,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/noc', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const [total, updown, macflap, vlanmismatch, sites] = await Promise.all([
      es.count({ index: 'cisco-*', body: { query: { range: { '@timestamp': tr } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'cisco_mnemonic.keyword': 'UPDOWN' } }] } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'cisco_mnemonic.keyword': 'MACFLAP_NOTIF' } }] } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'cisco_mnemonic.keyword': 'NATIVE_VLAN_MISMATCH' } }] } } } }),
      es.search({ index: 'cisco-*,firewall-*', body: { size: 0, query: { range: { '@timestamp': tr } }, aggs: { sites: { terms: { field: 'site_name.keyword', size: 10 } } } } }),
    ])
    res.json({
      total:        total.count,
      updown:       updown.count,
      macflap:      macflap.count,
      vlanmismatch: vlanmismatch.count,
      sites:        sites.aggregations.sites.buckets,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router
