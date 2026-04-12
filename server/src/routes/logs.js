import { Router } from 'express'
import { getESClient } from '../config/elasticsearch.js'

const router = Router()

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
        query: { bool: { must: [{ range: { '@timestamp': { gte: 'now-24h' } } }, { term: { 'fgt.subtype.keyword': 'ips' } }] } },
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
        query: { bool: { must: [{ range: { '@timestamp': { gte: 'now-24h' } } }, { term: { 'fgt.action.keyword': 'deny' } }] } },
        aggs: {
          by_src: { terms: { field: 'fgt.srcip.keyword', size: 10 } },
          by_country: { terms: { field: 'fgt.srccountry.keyword', size: 10 } },
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
        query: { range: { '@timestamp': { gte: 'now-1h' } } },
        _source: ['@timestamp','fgt.srcip','fgt.dstip','fgt.action','fgt.app','fgt.attack','fgt.subtype','fgt.type','cisco_mnemonic','cisco_message','cisco_facility','site_name','device_name','cisco_severity_label','syslog_severity_label'],
      },
    })
    res.json(result.hits.hits.map(h => ({ ...h._source, _index: h._index })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/geo', async (req, res) => {
  try {
    const es = getESClient()
    const result = await es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: { bool: { must: [{ range: { '@timestamp': { gte: 'now-24h' } } }, { term: { 'fgt.action.keyword': 'deny' } }], must_not: [{ term: { 'fgt.srccountry.keyword': 'Reserved' } }] } },
        aggs: { by_country: { terms: { field: 'fgt.srccountry.keyword', size: 20 } } },
      },
    })
    res.json(result.aggregations.by_country.buckets.map(b => ({ country: b.key, count: b.doc_count })))
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
        query: { bool: { must: [{ range: { '@timestamp': { gte: 'now-1h' } } }, { term: { 'fgt.type.keyword': 'traffic' } }] } },
        _source: ['@timestamp','@timestamp','fgt','site_name','device_name'],
      },
    })
    res.json(result.hits.hits.map(h => h._source))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router

