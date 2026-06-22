/**
 * One-off diagnostic: tests the 4 root-cause hypotheses for "no USB events".
 * Runs inside netpulse-server (uses ES_HOST / ES_USER / ES_PASSWORD / ES_SENTINEL_INDEX).
 * Prints a verdict per hypothesis, never mutates anything.
 *
 *   1) Ingest pipeline stalled
 *   2) Device Control disabled (only connects, no disconnects)
 *   3) Index rotation / mapping mismatch
 *   4) Endpoint offline (the agent itself stopped reporting)
 */
import { Client } from '@elastic/elasticsearch'

const INDEX = process.env.ES_SENTINEL_INDEX || 'sentinel-*'

const es = new Client({
  node: process.env.ES_HOST,
  auth: { username: process.env.ES_USER, password: process.env.ES_PASSWORD },
  tls: { rejectUnauthorized: false },
})

const USB_PERIPHERAL_EVENT_BOOL = {
  bool: {
    should: [
      { match_phrase_prefix: { message: 'USB device' } },
      { match_phrase: { message: 'Removable device' } },
      { match_phrase: { message: 'Peripheral device' } },
      { match_phrase: { message: 'USB mass storage' } },
      { match_phrase: { message: 'USB storage' } },
      { match_phrase: { message: 'Device was connected' } },
      { match_phrase: { message: 'Device was disconnected' } },
      { match_phrase: { message: 'Device Control' } },
      {
        terms: {
          'event.action.keyword': [
            'usb_device_control',
            'device_control',
            'usb.connected',
            'usb.disconnected',
            'peripheral_device',
          ],
        },
      },
      { terms: { 'event.action': ['usb_device_control', 'device_control'] } },
      { terms: { 'event.category.keyword': ['device', 'peripheral'] } },
      { match_phrase: { 'event.original': 'USB' } },
      {
        simple_query_string: {
          query:
            '"USB device" | usb_device | "removable device" | "mass storage" | peripheral_device | "device control"',
          fields: ['message', 'event.original'],
          lenient: true,
          default_operator: 'or',
        },
      },
      { wildcard: { 'event.action.keyword': '*usb*' } },
      { wildcard: { 'event.action.keyword': '*USB*' } },
      { match_phrase_prefix: { 'sentinel_one.activity.data.externalDeviceType': 'USB' } },
      { match_phrase_prefix: { 'sentinel_one.activity.data.deviceClass': 'USB' } },
    ],
    minimum_should_match: 1,
  },
}

const banner = t => console.log('\n=== ' + t + ' ===')
const ok = (k, v) => console.log('  [OK]    ' + k.padEnd(28) + ' ' + v)
const warn = (k, v) => console.log('  [WARN]  ' + k.padEnd(28) + ' ' + v)
const bad = (k, v) => console.log('  [BAD]   ' + k.padEnd(28) + ' ' + v)
const info = (k, v) => console.log('  [info]  ' + k.padEnd(28) + ' ' + v)

function fmtAge(iso) {
  if (!iso) return 'no docs'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const dh = (Date.now() - t) / 36e5
  if (dh < 1) return `${(dh * 60).toFixed(0)}m ago`
  if (dh < 48) return `${dh.toFixed(1)}h ago`
  return `${(dh / 24).toFixed(1)}d ago`
}

const results = {}

async function main() {
  // -- TEST 0: confirm we can read the index pattern at all --
  banner('Test 0 — index pattern exists')
  try {
    const cat = await es.cat.indices({
      index: INDEX,
      format: 'json',
      h: 'index,docs.count,store.size,creation.date.string',
      s: 'index',
    })
    const arr = Array.isArray(cat) ? cat : (cat?.body ?? [])
    if (!arr.length) {
      bad('matching indices', `0 (pattern "${INDEX}" matches nothing — index rotation suspect)`)
      results.indicesExist = false
    } else {
      ok('matching indices', `${arr.length} found`)
      const top = arr.slice(-5)
      for (const r of top) info('  index', `${r.index}  docs=${r['docs.count']}  size=${r['store.size']}`)
      results.indicesExist = true
      results.indexNames = arr.map(r => r.index)
    }
  } catch (e) {
    bad('cat indices', e.message)
    results.indicesExist = false
  }

  // -- TEST 1A: most-recent doc anywhere in the index --
  banner('Test 1A — newest doc in sentinel-*  (ingest stalled?)')
  try {
    const r = await es.search({
      index: INDEX,
      body: {
        size: 1,
        sort: [{ '@timestamp': 'desc' }],
        _source: ['@timestamp', 'event.action', 'message', 'host.hostname', 'agent.hostname'],
      },
    })
    const hit = r.hits?.hits?.[0]
    if (!hit) {
      bad('any doc found', 'NONE — index empty')
      results.newestAny = null
    } else {
      const ts = hit._source['@timestamp']
      const ageH = (Date.now() - new Date(ts).getTime()) / 36e5
      results.newestAny = ts
      results.newestAnyAgeH = ageH
      ;(ageH > 24 ? bad : ok)('newest @timestamp', `${ts}  (${fmtAge(ts)})`)
      info('  in index', hit._index)
      info('  event.action', hit._source.event?.action ?? '—')
      info('  host', hit._source.host?.hostname ?? hit._source.agent?.hostname ?? '—')
    }
  } catch (e) {
    bad('search', e.message)
  }

  // -- TEST 1B: most-recent USB doc only --
  banner('Test 1B — newest USB peripheral doc')
  try {
    const r = await es.search({
      index: INDEX,
      body: {
        size: 1,
        sort: [{ '@timestamp': 'desc' }],
        query: { bool: { must: [USB_PERIPHERAL_EVENT_BOOL] } },
        _source: ['@timestamp', 'event.action', 'message', 'host.hostname', 'agent.hostname'],
      },
    })
    const hit = r.hits?.hits?.[0]
    if (!hit) {
      bad('newest USB doc', 'NONE — pattern matches no USB docs at all')
      results.newestUsb = null
    } else {
      const ts = hit._source['@timestamp']
      const ageH = (Date.now() - new Date(ts).getTime()) / 36e5
      results.newestUsb = ts
      results.newestUsbAgeH = ageH
      ;(ageH > 24 ? bad : ok)('newest USB @timestamp', `${ts}  (${fmtAge(ts)})`)
      info('  event.action', hit._source.event?.action ?? '—')
      const m = hit._source.message
      info('  message', m ? (m.length > 90 ? m.slice(0, 90) + '…' : m) : '—')
      info('  host', hit._source.host?.hostname ?? hit._source.agent?.hostname ?? '—')
    }
  } catch (e) {
    bad('search', e.message)
  }

  // -- TEST 2: action distribution on USB docs (Device Control disabled?) --
  banner('Test 2 — USB event.action distribution (last 90d)')
  try {
    const r = await es.search({
      index: INDEX,
      body: {
        size: 0,
        query: {
          bool: {
            must: [
              USB_PERIPHERAL_EVENT_BOOL,
              { range: { '@timestamp': { gte: 'now-90d' } } },
            ],
          },
        },
        aggs: {
          actions: { terms: { field: 'event.action.keyword', size: 32, missing: '__missing__' } },
          per_day: {
            date_histogram: { field: '@timestamp', calendar_interval: '1d', min_doc_count: 1 },
          },
        },
      },
    })
    const buckets = r.aggregations?.actions?.buckets || []
    if (!buckets.length) bad('action buckets', '0 — no USB docs in 90d')
    else {
      let connected = 0, disconnected = 0, other = 0
      for (const b of buckets) {
        const k = String(b.key).toLowerCase()
        const n = b.doc_count
        if (k.includes('disconnect')) disconnected += n
        else if (k.includes('connect')) connected += n
        else other += n
        info('  ' + b.key, n)
      }
      ok('connected (90d)', connected)
      ;(disconnected === 0 ? bad : ok)('disconnected (90d)', disconnected + (disconnected === 0 ? '  ← Device Control disconnects NEVER fired' : ''))
      ok('other (90d)', other)
      results.disconnected90d = disconnected
      results.connected90d = connected
    }

    const days = r.aggregations?.per_day?.buckets || []
    info('  days with any USB doc', days.length)
    if (days.length) {
      const last = days[days.length - 1]
      info('  last active day', last.key_as_string + ' (' + last.doc_count + ' docs)')
      results.lastUsbDay = last.key_as_string
    }
  } catch (e) {
    bad('search', e.message)
  }

  // -- TEST 3: dashboard query (12h, scope=usb_only) — exact code path --
  banner('Test 3 — Reproduce /api/sentinel/dashboard?range=12h&scope=usb_only')
  try {
    const range12h = { range: { '@timestamp': { gte: 'now-12h', lte: 'now' } } }
    const r = await es.search({
      index: INDEX,
      body: {
        size: 0,
        query: { bool: { must: [range12h, USB_PERIPHERAL_EVENT_BOOL] } },
        aggs: {
          actions: { terms: { field: 'event.action.keyword', size: 32, missing: '__missing__' } },
          hosts: { terms: { field: 'host.hostname.keyword', size: 5 } },
        },
      },
    })
    const total =
      typeof r.hits?.total === 'object' ? r.hits.total.value : r.hits?.total ?? 0
    ;(total === 0 ? bad : ok)('usb events in last 12h', total)
    const buckets = r.aggregations?.actions?.buckets || []
    let connected = 0, disconnected = 0, other = 0
    for (const b of buckets) {
      const k = String(b.key).toLowerCase()
      const n = b.doc_count
      if (k.includes('disconnect')) disconnected += n
      else if (k.includes('connect')) connected += n
      else other += n
    }
    info('  connected (12h)', connected)
    info('  disconnected (12h)', disconnected)
    info('  other (12h)', other)
    info('  top hosts (12h)', (r.aggregations?.hosts?.buckets || []).map(b => `${b.key}=${b.doc_count}`).join(', ') || '—')
    results.dash12h = { total, connected, disconnected, other }
  } catch (e) {
    bad('search', e.message)
  }

  // -- TEST 4: agent / endpoint heartbeat (is the host still reporting?) --
  banner('Test 4 — endpoint last-seen across all event types')
  try {
    const host = 'WGON-4GE2298MTH'
    const r = await es.search({
      index: INDEX,
      body: {
        size: 1,
        sort: [{ '@timestamp': 'desc' }],
        query: {
          bool: {
            should: [
              { term: { 'host.hostname.keyword': host } },
              { term: { 'agent.hostname.keyword': host } },
              { match_phrase: { message: host } },
            ],
            minimum_should_match: 1,
          },
        },
        _source: ['@timestamp', 'event.action', 'host.hostname', 'agent.hostname', 'message'],
      },
    })
    const hit = r.hits?.hits?.[0]
    if (!hit) bad('endpoint last-seen', `host "${host}" never seen in any event`)
    else {
      const ts = hit._source['@timestamp']
      const ageH = (Date.now() - new Date(ts).getTime()) / 36e5
      ;(ageH > 24 ? bad : ok)(`last-seen ${host}`, `${ts}  (${fmtAge(ts)})`)
      info('  event.action', hit._source.event?.action ?? '—')
      results.endpointLastSeen = ts
      results.endpointAgeH = ageH
    }
  } catch (e) {
    bad('search', e.message)
  }

  // -- VERDICT --
  banner('VERDICT')
  const newestAnyAgeH = results.newestAnyAgeH
  const newestUsbAgeH = results.newestUsbAgeH
  const dash = results.dash12h || { total: 0, disconnected: 0 }

  if (newestAnyAgeH != null && newestAnyAgeH > 24) {
    bad('cause #1 (ingest stalled)', `MATCHES — newest doc anywhere is ${fmtAge(results.newestAny)}`)
  } else if (newestAnyAgeH != null) {
    ok('cause #1 (ingest stalled)', `ruled out — fresh docs ${fmtAge(results.newestAny)}`)
  }

  if (results.connected90d > 0 && results.disconnected90d === 0) {
    bad('cause #2 (Device Control off)', 'MATCHES — connects exist but 0 disconnects in 90d')
  } else if (results.disconnected90d > 0) {
    ok('cause #2 (Device Control off)', `ruled out — ${results.disconnected90d} disconnects in 90d`)
  } else {
    info('cause #2 (Device Control off)', 'inconclusive — no USB docs at all in 90d')
  }

  if (!results.indicesExist) {
    bad('cause #3 (index rotation)', `MATCHES — pattern "${INDEX}" matches NO indices`)
  } else if (newestAnyAgeH > 1 && newestUsbAgeH > 24 && results.disconnected90d === 0) {
    info('cause #3 (index rotation)', 'possible — verify the connector still writes to sentinel-*')
  } else {
    ok('cause #3 (index rotation)', `ruled out — ${results.indexNames?.length || 0} indices visible`)
  }

  if (results.endpointAgeH != null && results.endpointAgeH > 24) {
    bad('cause #4 (endpoint offline)', `MATCHES — host last seen ${fmtAge(results.endpointLastSeen)}`)
  } else if (results.endpointAgeH != null) {
    ok('cause #4 (endpoint offline)', `ruled out — host last seen ${fmtAge(results.endpointLastSeen)}`)
  } else {
    info('cause #4 (endpoint offline)', 'inconclusive — host name not found in any doc')
  }

  console.log('\n--- raw summary ---')
  console.log(JSON.stringify(results, null, 2))
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
