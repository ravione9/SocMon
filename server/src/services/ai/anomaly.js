import { complete } from './aiRouter.js'
import { getESClient } from '../../config/elasticsearch.js'

export async function detectAnomalies(site = null) {
  const must = [{ range: { '@timestamp': { gte: 'now-1h' } } }]
  if (site) must.push({ term: { 'site_name.keyword': site } })
  const result = await getESClient().search({
    index: 'firewall-*',
    body: {
      size: 0,
      query: { bool: { must } },
      aggs: {
        denied_per_min: {
          date_histogram: { field: '@timestamp', fixed_interval: '1m', time_zone: process.env.TZ || 'UTC' },
          aggs: { denied: { filter: { term: { 'fgt.action.keyword': 'deny' } } } },
        },
        top_src: { terms: { field: 'fgt.srcip.keyword', size: 10 } },
      },
    },
  })
  const buckets = result.aggregations.denied_per_min.buckets
  const counts = buckets.map(b => b.denied.doc_count)
  const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1)
  const max = Math.max(...counts)
  const topSrc = result.aggregations.top_src.buckets.map(b => `${b.key}(${b.doc_count})`).join(', ')
  const prompt = `Analyze for anomalies: avg denied/min=${avg.toFixed(1)}, max=${max}, top IPs=${topSrc}, site=${site || 'all'}
Return JSON: { "anomalies": [{ "type": string, "description": string, "severity": string }], "summary": string }`
  try {
    const raw = await complete(prompt, { maxTokens: 600 })
    return JSON.parse(raw.replace(/```json|```/g, '').trim())
  } catch {
    return { anomalies: [], summary: 'No anomalies detected' }
  }
}
