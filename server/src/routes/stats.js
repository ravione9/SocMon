import { Router } from 'express'
import { getESClient } from '../config/elasticsearch.js'

const router = Router()

router.get('/soc', async (req, res) => {
  try {
    const es = getESClient()
    const range = req.query.range || '24h'

    const [totalHits, deniedHits, ipsHits, authHits, utmHits, vpnHits] = await Promise.all([
      es.count({ index: 'firewall-*', body: { query: { range: { '@timestamp': { gte: `now-${range}` } } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': { gte: `now-${range}` } } }, { term: { 'fgt.action.keyword': 'deny' } }] } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': { gte: `now-${range}` } } }, { term: { 'fgt.subtype.keyword': 'ips' } }] } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': { gte: `now-${range}` } } }, { terms: { 'cisco_mnemonic.keyword': ['LOGIN_SUCCESS','LOGOUT','SSH2_USERAUTH','SSH2_SESSION'] } }] } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': { gte: `now-${range}` } } }, { term: { 'fgt.type.keyword': 'utm' } }] } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': { gte: `now-${range}` } } }, { term: { 'fgt.type.keyword': 'vpn' } }] } } } }),
    ])

    res.json({
      total:    totalHits.count,
      denied:   deniedHits.count,
      ips:      ipsHits.count,
      auth:     authHits.count,
      utm:      utmHits.count,
      vpn:      vpnHits.count,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/noc', async (req, res) => {
  try {
    const es = getESClient()
    const range = req.query.range || '24h'

    const [total, updown, macflap, vlanmismatch, sites] = await Promise.all([
      es.count({ index: 'cisco-*', body: { query: { range: { '@timestamp': { gte: `now-${range}` } } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': { gte: `now-${range}` } } }, { term: { 'cisco_mnemonic.keyword': 'UPDOWN' } }] } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': { gte: `now-${range}` } } }, { term: { 'cisco_mnemonic.keyword': 'MACFLAP_NOTIF' } }] } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': { gte: `now-${range}` } } }, { term: { 'cisco_mnemonic.keyword': 'NATIVE_VLAN_MISMATCH' } }] } } } }),
      es.search({ index: 'cisco-*,firewall-*', body: { size: 0, query: { range: { '@timestamp': { gte: `now-${range}` } } }, aggs: { sites: { terms: { field: 'site_name.keyword', size: 10 } } } } }),
    ])

    res.json({
      total:        total.count,
      updown:       updown.count,
      macflap:      macflap.count,
      vlanmismatch: vlanmismatch.count,
      sites:        sites.aggregations.sites.buckets,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
