import { Router } from 'express'
import { getESClient } from '../config/elasticsearch.js'

const router = Router()

router.get('/interfaces', async (req, res) => {
  try {
    const es = getESClient()
    const range = req.query.range || '24h'
    const result = await es.search({
      index: 'cisco-*',
      body: {
        size: 0,
        query: { bool: { must: [
          { range: { '@timestamp': { gte: `now-${range}` } } },
          { term: { 'cisco_mnemonic.keyword': 'UPDOWN' } }
        ] } },
        aggs: {
          timeline: {
            date_histogram: { field: '@timestamp', fixed_interval: '5m' },
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
      timeline: result.aggregations.timeline.buckets.map(b => ({
        time: b.key_as_string,
        up:   b.up.doc_count,
        down: b.down.doc_count,
        total: b.doc_count,
      })),
      top_interfaces: result.aggregations.top_interfaces.buckets,
      top_devices:    result.aggregations.top_devices.buckets,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/macflap', async (req, res) => {
  try {
    const es = getESClient()
    const range = req.query.range || '24h'
    const result = await es.search({
      index: 'cisco-*',
      body: {
        size: 50,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { bool: { must: [
          { range: { '@timestamp': { gte: `now-${range}` } } },
          { term: { 'cisco_mnemonic.keyword': 'MACFLAP_NOTIF' } }
        ] } },
        _source: ['@timestamp','cisco_mac_address','cisco_vlan_id','cisco_port_from','cisco_port_to','device_name','site_name','cisco_message'],
        aggs: {
          by_device: { terms: { field: 'device_name.keyword', size: 10 } },
          by_vlan:   { terms: { field: 'cisco_vlan_id.keyword', size: 10 } },
        }
      }
    })
    res.json({
      events:     result.hits.hits.map(h => h._source),
      by_device:  result.aggregations.by_device.buckets,
      by_vlan:    result.aggregations.by_vlan.buckets,
      total:      result.hits.total.value,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/traffic/timeline', async (req, res) => {
  try {
    const es = getESClient()
    const range = req.query.range || '24h'
    const interval = range === '1h' ? '1m' : range === '6h' ? '5m' : '1h'
    const result = await es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: { range: { '@timestamp': { gte: `now-${range}` } } },
        aggs: {
          timeline: {
            date_histogram: { field: '@timestamp', fixed_interval: interval },
            aggs: {
              allowed: { filter: { term: { 'fgt.action.keyword': 'allow' } } },
              denied:  { filter: { term: { 'fgt.action.keyword': 'deny' } } },
            },
          },
        },
      },
    })
    res.json(result.aggregations.timeline.buckets.map(b => ({
      time:    b.key_as_string,
      allowed: b.allowed.doc_count,
      denied:  b.denied.doc_count,
      total:   b.doc_count,
    })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/threats/top', async (req, res) => {
  try {
    const es = getESClient()
    const result = await es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: { bool: { must: [
          { range: { '@timestamp': { gte: 'now-24h' } } },
          { term: { 'fgt.subtype.keyword': 'ips' } }
        ] } },
        aggs: { attacks: { terms: { field: 'fgt.attack.keyword', size: 10 } } },
      },
    })
    res.json(result.aggregations.attacks.buckets.map(b => ({ name: b.key, count: b.doc_count })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/denied', async (req, res) => {
  try {
    const es = getESClient()
    const result = await es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: { bool: { must: [
          { range: { '@timestamp': { gte: 'now-24h' } } },
          { term: { 'fgt.action.keyword': 'deny' } }
        ] } },
        aggs: {
          by_src:     { terms: { field: 'fgt.srcip.keyword', size: 15 } },
          by_country: { terms: { field: 'fgt.srccountry.keyword', size: 15 } },
        },
      },
    })
    res.json({
      by_src:     result.aggregations.by_src.buckets.map(b => ({ ip: b.key, count: b.doc_count })),
      by_country: result.aggregations.by_country.buckets.map(b => ({ country: b.key, count: b.doc_count })),
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/events/recent', async (req, res) => {
  try {
    const es = getESClient()
    const index = req.query.type === 'cisco' ? 'cisco-*' : req.query.type === 'firewall' ? 'firewall-*' : 'firewall-*,cisco-*'
    const result = await es.search({
      index,
      body: {
        size: req.query.size || 50,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { range: { '@timestamp': { gte: 'now-24h' } } },
      },
    })
    res.json(result.hits.hits.map(h => ({ ...h._source, _index: h._index })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/sessions', async (req, res) => {
  try {
    const es = getESClient()
    const result = await es.search({
      index: 'firewall-*',
      body: {
        size: 100,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { bool: { must: [
          { range: { '@timestamp': { gte: 'now-1h' } } },
          { term: { 'fgt.type.keyword': 'traffic' } }
        ] } },
      },
    })
    res.json(result.hits.hits.map(h => h._source))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router
