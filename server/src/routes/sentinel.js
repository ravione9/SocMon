import { Router } from 'express'
import { getESClient } from '../config/elasticsearch.js'
import {
  getSentinelIndex,
  ACTIVE_THREAT_BOOL,
  RESOLVED_THREAT_BOOL,
  AGENT_DISCONNECTED_BOOL,
  AGENT_CONNECTED_BOOL,
  hitsTotalValue,
  USB_PERIPHERAL_EVENT_BOOL,
  USB_PERIPHERAL_DISCONNECT_FILTER,
  BLUETOOTH_DEVICE_EVENT_BOOL,
  BLOCKED_OR_MITIGATED_BOOL,
  sentinelScopeClause,
} from '../utils/sentinelQueries.js'

const router = Router()

function getTimeRange(req) {
  const range = req.query.range || '15m'
  const dateFrom = req.query.from
  const dateTo = req.query.to
  return dateFrom && dateTo ? { gte: dateFrom, lte: dateTo } : { gte: 'now-' + range }
}

/**
 * Host group filter — align with pickHostGroup() (ECS + flat Sentinel fields).
 * Includes groupName / site_name / snake_case agent_realtime_info paths so dashboard + log filters match ingested docs.
 */
function hostGroupMustClause(hostGroup) {
  const hg = String(hostGroup || '').trim()
  if (!hg) return null
  return {
    bool: {
      should: [
        { term: { 'group.name.keyword': hg } },
        { term: { 'site.name.keyword': hg } },
        { term: { 'agentRealtimeInfo.groupName.keyword': hg } },
        { term: { 'agent_realtime_info.groupName.keyword': hg } },
        { term: { 'agent_realtime_info.group_name.keyword': hg } },
        { term: { 'groupName.keyword': hg } },
        { term: { 'site_name.keyword': hg } },
        { match_phrase: { 'group.name': hg } },
        { match_phrase: { 'site.name': hg } },
        { match_phrase: { 'agentRealtimeInfo.groupName': hg } },
        { match_phrase: { 'agent_realtime_info.groupName': hg } },
        { match_phrase: { groupName: hg } },
        { match_phrase: { site_name: hg } },
        { match_phrase: { 'related.group.name': hg } },
        { match_bool_prefix: { groupName: hg } },
        { match_bool_prefix: { 'group.name': hg } },
      ],
      minimum_should_match: 1,
    },
  }
}

function mergeExportQuery(req) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  return { ...req.query, ...body }
}

function appendHostGroup(must, hostGroup) {
  const c = hostGroupMustClause(hostGroup)
  if (c) must.push(c)
}

function multiEndpointMustClause(endpoints) {
  const raw = String(endpoints || '').trim()
  if (!raw) return null
  const list = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (!list.length) return null
  const hostFields = [
    'agentRealtimeInfo.agentComputerName.keyword',
    'host.name.keyword',
    'host.hostname.keyword',
  ]
  return {
    bool: {
      should: list.flatMap(ep =>
        hostFields.map(f => ({ term: { [f]: ep } }))
      ),
      minimum_should_match: 1,
    },
  }
}

function appendEndpoints(must, endpoints) {
  const c = multiEndpointMustClause(endpoints)
  if (c) must.push(c)
}

/** Time range + Sentinel scope only (no host group / text filters) — used for host-group discovery from logs. */
function buildSentinelScopeAndTimeMust(req) {
  const tr = getTimeRange(req)
  const rangeQ = { range: { '@timestamp': tr } }
  const scopeRaw = String(req.query.scope || 'all').toLowerCase()
  const scope = scopeRaw === 'bluetooth_only' ? 'bt_only' : scopeRaw
  const scopeMust =
    scope === 'no_usb'
      ? sentinelScopeClause('no_usb')
      : scope === 'usb_only'
        ? sentinelScopeClause('usb_only')
        : scope === 'bt_only'
          ? sentinelScopeClause('bt_only')
          : sentinelScopeClause('all')
  return [rangeQ, scopeMust]
}

/** Same keyword paths as hostGroupMustClause / pickHostGroup — merge terms across fields (parallel aggs). */
const HOST_GROUP_AGG_FIELDS = [
  'group.name.keyword',
  'site.name.keyword',
  'groupName.keyword',
  'site_name.keyword',
  'agentRealtimeInfo.groupName.keyword',
  'agent_realtime_info.groupName.keyword',
  'agent_realtime_info.group_name.keyword',
  'related.group.name.keyword',
]

async function aggregateDistinctHostGroupsFromLogs(es, index, must) {
  const set = new Set()
  await Promise.all(
    HOST_GROUP_AGG_FIELDS.map(async field => {
      try {
        const r = await es.search({
          index,
          body: {
            size: 0,
            query: { bool: { must } },
            aggs: {
              by_hg: { terms: { field, size: 500, missing: '__missing__' } },
            },
          },
        })
        const buckets = r.aggregations?.by_hg?.buckets ?? []
        for (const b of buckets) {
          const k = b.key
          if (k == null || k === '__missing__') continue
          const s = String(k).trim()
          if (s && s !== '—') set.add(s)
        }
      } catch {
        /* field may be unmapped */
      }
    }),
  )
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

function strVal(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

/**
 * Human-readable event text — pipelines use different fields (ECS, SentinelOne, flattened dots).
 */
function pickEventAction(src) {
  const candidates = [
    strVal(src.event?.action),
    strVal(src['event.action']),
    strVal(src.event_action),
    strVal(src['event_action']),
  ]
  for (const c of candidates) {
    if (c) return c
  }
  return '—'
}

function pickSentinelMessage(src) {
  const ar = src.agentRealtimeInfo || src.agent_realtime_info || {}
  const s1 = src.sentinel_one || {}
  const act = s1.activity || {}
  const candidates = [
    strVal(src.event_message),
    strVal(src['event_message']),
    strVal(src.message),
    strVal(src['message']),
    strVal(src.log?.message),
    strVal(src['log.message']),
    strVal(src['@message']),
    strVal(src.event?.original),
    strVal(src['event.original']),
    strVal(src.event?.message),
    strVal(src['event.message']),
    strVal(act.description),
    strVal(act.primary_description),
    strVal(act.secondary_description),
    strVal(s1.activity?.description),
    strVal(s1.event?.message),
    strVal(src['sentinel_one.event.message']),
    strVal(src.event?.reason),
    strVal(src.rule?.description),
    strVal(src.network?.message),
    strVal(src.error?.message),
  ]
  for (const c of candidates) {
    if (c) return c
  }
  const action = strVal(src.event?.action)
  const reason = strVal(src.event?.reason)
  const typ = strVal(src.event?.type)
  const cat = Array.isArray(src.event?.category)
    ? src.event.category.map(strVal).filter(Boolean).join(',')
    : strVal(src.event?.category)
  const parts = [action, reason, typ, cat].filter(Boolean)
  if (parts.length) return parts.join(' — ')
  return ''
}

function pickSentinelUser(src) {
  const ar = src.agentRealtimeInfo || src.agent_realtime_info || {}
  const candidates = [
    strVal(src.user?.name),
    strVal(src.user?.full_name),
    strVal(src['user.name']),
    strVal(src.related?.user?.name),
    strVal(ar.activeUserName),
    strVal(ar.agentUserName),
    strVal(src.host?.user?.name),
    strVal(src.sentinel_one?.user?.name),
  ]
  for (const c of candidates) {
    if (c) return c
  }
  return '—'
}

/** Host group label from ECS or SentinelOne agent realtime (must stay in sync with hostGroupMustClause). */
function pickHostGroup(src) {
  const ar = src.agentRealtimeInfo || src.agent_realtime_info || {}
  const candidates = [
    strVal(src.group?.name),
    strVal(src['group.name']),
    strVal(src.site?.name),
    strVal(src['site.name']),
    strVal(src.groupName),
    strVal(ar.groupName),
    strVal(ar.group_name),
    strVal(src.related?.group?.name),
  ]
  for (const c of candidates) {
    if (c) return c
  }
  return '—'
}

function pickSentinelSeverity(src) {
  const ti = src.threatInfo || src.threat_info || {}
  const candidates = [
    strVal(ti.confidenceLevel),
    strVal(src.event?.severity),
    strVal(src['event.severity']),
    strVal(src.log?.level),
    strVal(src['log.level']),
    strVal(src.syslog_severity_label),
    strVal(src['syslog_severity_label']),
    strVal(src.sentinel_one?.threat?.severity),
  ]
  for (const c of candidates) {
    if (c) return c
  }
  return '—'
}

function threatNameFromActivityMessage(msg) {
  const m = String(msg || '')
  const patterns = [
    /threat:\s*([^\s.]+(?:\.[a-zA-Z0-9]+)?)/i,
    /threat\s+['"]?([A-Za-z0-9._-]+\.(?:exe|dll|bat|cmd|ps1|msi))['"]?/i,
    /:\s*([A-Za-z0-9._-]+\.(?:exe|dll|bat|cmd|ps1|msi))\s*\.?$/im,
  ]
  for (const re of patterns) {
    const x = re.exec(m)
    if (x && x[1]) return x[1].trim()
  }
  return ''
}

function mitigationStateFromMessage(msg) {
  const s = String(msg || '').toLowerCase()
  if (s.includes('successfully killed') || s.includes('killed the threat')) return 'killed'
  if (s.includes('successfully quarantined') || s.includes('quarantined the threat')) return 'quarantined'
  if (s.includes('successfully removed') || s.includes('removed the threat')) return 'removed'
  if (s.includes('successfully blocked') || s.includes('blocked the threat')) return 'blocked'
  if (s.includes('successfully mitigated') || (s.includes('threat was') && s.includes('mitigated'))) return 'mitigated'
  if (s.includes('marked as benign') || s.includes('marked_as_benign')) return 'benign'
  return ''
}

function normalizeThreat(src, id) {
  const ti = src.threatInfo || src.threat_info || {}
  const ad = src.agentDetectionInfo || src.agent_detection_info || {}
  const ar = src.agentRealtimeInfo || src.agent_realtime_info || {}
  const s1t = src.sentinel_one?.threat || {}
  const s1a = src.sentinel_one?.agent || {}
  const msg = pickSentinelMessage(src)

  let threatName = ti.threatName || s1t.name || src['threat.name'] || src.rule?.name || src.event?.reason || ''
  if (!threatName) threatName = threatNameFromActivityMessage(msg)
  if (!threatName) threatName = '—'

  let state = ti.threatState || s1t.threat_state || src.threat_state || src['event.action'] || ''
  if (!state || state === '—') {
    const inferred = mitigationStateFromMessage(msg)
    if (inferred) state = inferred
  }
  if (!state) state = '—'

  let classification = ti.classification || ti.threatClassification || s1t.classification || ''
  if (!classification && mitigationStateFromMessage(msg)) classification = 'Remediation'
  if (!classification) classification = '—'

  return {
    _id: id,
    '@timestamp': src['@timestamp'],
    threatName,
    classification,
    agent:
      ar.agentComputerName ||
      ad.agentComputerName ||
      s1a.computer_name ||
      src.host?.name ||
      src.host?.hostname ||
      '—',
    state,
    severity: ti.confidenceLevel || src.event?.severity || s1t.severity || '—',
    filePath: ti.filePath || ti.originatorProcess || ad.filePath || threatNameFromActivityMessage(msg) || '—',
  }
}

function normalizeSentinelEvent(src, id) {
  const ar = src.agentRealtimeInfo || src.agent_realtime_info || {}
  const ti = src.threatInfo || src.threat_info || {}
  const msg = pickSentinelMessage(src)
  const host =
    strVal(ar.agentComputerName) ||
    strVal(src.host?.name) ||
    strVal(src.host?.hostname) ||
    strVal(src['host.name']) ||
    strVal(src['host.hostname']) ||
    '—'
  const catRaw = Array.isArray(src.event?.category)
    ? src.event.category.map(strVal).filter(Boolean).join(',')
    : strVal(src.event?.category) || strVal(src.event?.type)
  return {
    _id: id,
    _index: src._index,
    '@timestamp': src['@timestamp'],
    eventAction: pickEventAction(src),
    message: (msg || '—').slice(0, 1200),
    host,
    hostGroup: pickHostGroup(src),
    user: pickSentinelUser(src),
    severity: pickSentinelSeverity(src),
    category: catRaw || '—',
    threatName: ti.threatName || '—',
  }
}

function normalizeConnectivity(src, id) {
  const ar = src.agentRealtimeInfo || src.agent_realtime_info || {}
  const msg = pickSentinelMessage(src) || String(src.message || src['event.original'] || src.event?.message || '')
  const net = ar.networkStatus || src['sentinel_one.agent.network_status'] || ''
  let kind = 'unknown'
  const n = String(net).toLowerCase()

  const disconnectedFromMsg =
    n === 'disconnected' ||
    /disconnect|offline|lost connection|lost connectivity|no longer connected|went offline|agent is offline|device disconnected|endpoint disconnected/i.test(
      msg,
    )
  const connectedFromMsg =
    n === 'connected' ||
    /reconnected|connected to management|agent is online|device connected|endpoint connected|came online|back online|now connected|successfully connected/i.test(
      msg,
    )

  if (n === 'disconnected' || disconnectedFromMsg) kind = 'disconnected'
  else if (n === 'connected' || connectedFromMsg) kind = 'connected'

  const displayStatus =
    net ||
    (kind === 'disconnected' ? 'disconnected' : kind === 'connected' ? 'connected' : '—')

  return {
    _id: id,
    '@timestamp': src['@timestamp'],
    agent: ar.agentComputerName || src.host?.name || src.host?.hostname || '—',
    site: src.site_name || src.groupName || '—',
    networkStatus: displayStatus,
    kind,
    message: msg.slice(0, 400) || '—',
  }
}

/** GET /api/sentinel/stats — KPI + histograms */
router.get('/stats', async (req, res) => {
  try {
    const es = getESClient()
    const ix = getSentinelIndex()
    const tr = getTimeRange(req)
    const rangeQ = { range: { '@timestamp': tr } }
    const mustBase = [rangeQ]
    appendHostGroup(mustBase, req.query.hostGroup)

    const [total, activeC, resolvedC, discC, connC, threatHist] = await Promise.all([
      es.count({ index: ix, body: { query: { bool: { must: mustBase } } } }),
      es.count({ index: ix, body: { query: { bool: { must: [...mustBase, ACTIVE_THREAT_BOOL] } } } }),
      es.count({ index: ix, body: { query: { bool: { must: [...mustBase, RESOLVED_THREAT_BOOL] } } } }),
      es.count({ index: ix, body: { query: { bool: { must: [...mustBase, AGENT_DISCONNECTED_BOOL] } } } }),
      es.count({ index: ix, body: { query: { bool: { must: [...mustBase, AGENT_CONNECTED_BOOL] } } } }),
      es.search({
        index: ix,
        body: {
          size: 0,
          query: { bool: { must: mustBase } },
          aggs: {
            threats_over_time: {
              date_histogram: { field: '@timestamp', fixed_interval: '1h', min_doc_count: 0 },
            },
          },
        },
      }),
    ])

    let severityBuckets = []
    try {
      const sevAgg = await es.search({
        index: ix,
        body: {
          size: 0,
          query: { bool: { must: [...mustBase, ACTIVE_THREAT_BOOL] } },
          aggs: {
            by_sev: {
              terms: { field: 'threatInfo.confidenceLevel.keyword', size: 8, missing: '__missing__' },
            },
          },
        },
      })
      severityBuckets = sevAgg.aggregations?.by_sev?.buckets ?? []
    } catch {
      try {
        const sevAgg2 = await es.search({
          index: ix,
          body: {
            size: 0,
            query: { bool: { must: [...mustBase, ACTIVE_THREAT_BOOL] } },
            aggs: {
              by_sev: { terms: { field: 'event.severity.keyword', size: 8, missing: '__missing__' } },
            },
          },
        })
        severityBuckets = sevAgg2.aggregations?.by_sev?.buckets ?? []
      } catch {
        severityBuckets = []
      }
    }

    const timeline =
      threatHist.aggregations?.threats_over_time?.buckets?.map(b => ({
        t: b.key_as_string || new Date(b.key).toISOString(),
        count: b.doc_count,
      })) ?? []

    res.json({
      index: ix,
      total: total.count,
      activeThreats: activeC.count,
      resolvedThreats: resolvedC.count,
      agentDisconnectedEvents: discC.count,
      agentConnectedEvents: connC.count,
      timeline,
      severityBreakdown: severityBuckets.map(b => ({
        key: b.key === '__missing__' ? 'Unknown' : String(b.key),
        count: b.doc_count,
      })),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /api/sentinel/threats?status=active|resolved */
router.get('/threats', async (req, res) => {
  try {
    const es = getESClient()
    const ix = getSentinelIndex()
    const tr = getTimeRange(req)
    const rangeQ = { range: { '@timestamp': tr } }
    const status = String(req.query.status || 'active').toLowerCase()
    const filter = status === 'resolved' ? RESOLVED_THREAT_BOOL : ACTIVE_THREAT_BOOL
    const size = Math.min(parseInt(req.query.size, 10) || 80, 200)
    const page = Math.max(parseInt(req.query.page, 10) || 0, 0)
    const excludeUsb = String(req.query.excludeUsb || '') === '1' || String(req.query.excludeUsb || '').toLowerCase() === 'true'
    const must = [rangeQ, filter]
    if (excludeUsb) must.push({ bool: { must_not: [USB_PERIPHERAL_EVENT_BOOL] } })
    appendHostGroup(must, req.query.hostGroup)

    const result = await es.search({
      index: ix,
      body: {
        track_total_hits: true,
        from: page * size,
        size,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { bool: { must } },
      },
    })

    res.json({
      total: hitsTotalValue(result.hits.total),
      page,
      size,
      hits: result.hits.hits.map(h => normalizeThreat(h._source || {}, h._id)),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /api/sentinel/connectivity — recent agent connect / disconnect events */
router.get('/connectivity', async (req, res) => {
  try {
    const es = getESClient()
    const ix = getSentinelIndex()
    const tr = getTimeRange(req)
    const rangeQ = { range: { '@timestamp': tr } }
    const size = Math.min(parseInt(req.query.size, 10) || 60, 200)
    const kind = String(req.query.kind || 'all').toLowerCase()

    let filter
    if (kind === 'disconnected') filter = AGENT_DISCONNECTED_BOOL
    else if (kind === 'connected') filter = AGENT_CONNECTED_BOOL
    else {
      filter = {
        bool: {
          should: [AGENT_DISCONNECTED_BOOL, AGENT_CONNECTED_BOOL],
          minimum_should_match: 1,
        },
      }
    }

    const must = [rangeQ, filter]
    appendHostGroup(must, req.query.hostGroup)

    const result = await es.search({
      index: ix,
      body: {
        track_total_hits: true,
        size,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { bool: { must } },
      },
    })

    res.json({
      total: hitsTotalValue(result.hits.total),
      hits: result.hits.hits.map(h => normalizeConnectivity(h._source || {}, h._id)),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

async function safeCount(es, index, must) {
  try {
    const r = await es.count({ index, body: { query: { bool: { must } } } })
    return r.count ?? 0
  } catch {
    return 0
  }
}

async function tryCardinality(es, index, must, fields) {
  for (const field of fields) {
    try {
      const r = await es.search({
        index,
        body: {
          size: 0,
          query: { bool: { must } },
          aggs: { c: { cardinality: { field, precision_threshold: 4000 } } },
        },
      })
      const v = r.aggregations?.c?.value
      if (v != null && v > 0) return Math.round(v)
    } catch {
      /* try next field */
    }
  }
  return 0
}

async function tryTopTerms(es, index, must, fields, size = 8) {
  // Fast path: try all fields in a single multi-agg query
  try {
    const aggs = {}
    for (let i = 0; i < fields.length; i++) {
      aggs[`f${i}`] = { terms: { field: fields[i], size, missing: '__missing__' } }
    }
    const r = await es.search({
      index,
      body: { size: 0, query: { bool: { must } }, aggs },
    })
    for (let i = 0; i < fields.length; i++) {
      const buckets = (r.aggregations?.[`f${i}`]?.buckets || []).filter(b => b.key !== '__missing__' && b.key !== '')
      if (buckets.length) {
        return buckets.map(b => ({ key: String(b.key), count: b.doc_count }))
      }
    }
    return []
  } catch {
    /* multi-agg can fail if any field is mapped as text; fall back to sequential */
  }
  for (const field of fields) {
    try {
      const r = await es.search({
        index,
        body: {
          size: 0,
          query: { bool: { must } },
          aggs: { top: { terms: { field, size, missing: '__missing__' } } },
        },
      })
      const buckets = (r.aggregations?.top?.buckets || []).filter(b => b.key !== '__missing__' && b.key !== '')
      if (buckets.length) {
        return buckets.map(b => ({ key: String(b.key), count: b.doc_count }))
      }
    } catch {
      /* try next field */
    }
  }
  return []
}

async function usbPeripheralActionSplit(es, index, rangeQ, hostGroup, endpoints) {
  const must = [rangeQ, USB_PERIPHERAL_EVENT_BOOL]
  appendHostGroup(must, hostGroup)
  appendEndpoints(must, endpoints)
  const run = field =>
    es.search({
      index,
      body: {
        size: 0,
        query: { bool: { must } },
        aggs: { actions: { terms: { field, size: 32, missing: '__missing__' } } },
      },
    })
  let buckets = []
  try {
    const r = await run('event.action.keyword')
    buckets = r.aggregations?.actions?.buckets || []
  } catch {
    try {
      const r = await run('event.action')
      buckets = r.aggregations?.actions?.buckets || []
    } catch {
      return { connected: 0, disconnected: 0, other: 0 }
    }
  }
  let connected = 0
  let disconnected = 0
  let other = 0
  for (const b of buckets) {
    const k = String(b.key).toLowerCase()
    const n = b.doc_count
    if (k === '__missing__') {
      other += n
      continue
    }
    if (k.includes('disconnect')) disconnected += n
    else if (k.includes('connect')) connected += n
    else other += n
  }
  return { connected, disconnected, other }
}

async function bluetoothPeripheralActionSplit(es, index, rangeQ, hostGroup, endpoints) {
  const must = [rangeQ, BLUETOOTH_DEVICE_EVENT_BOOL]
  appendHostGroup(must, hostGroup)
  appendEndpoints(must, endpoints)
  const run = field =>
    es.search({
      index,
      body: {
        size: 0,
        query: { bool: { must } },
        aggs: { actions: { terms: { field, size: 32, missing: '__missing__' } } },
      },
    })
  let buckets = []
  try {
    const r = await run('event.action.keyword')
    buckets = r.aggregations?.actions?.buckets || []
  } catch {
    try {
      const r = await run('event.action')
      buckets = r.aggregations?.actions?.buckets || []
    } catch {
      return { connected: 0, disconnected: 0, other: 0 }
    }
  }
  let connected = 0
  let disconnected = 0
  let other = 0
  for (const b of buckets) {
    const k = String(b.key).toLowerCase()
    const n = b.doc_count
    if (k === '__missing__') {
      other += n
      continue
    }
    if (k.includes('disconnect')) disconnected += n
    else if (k.includes('connect')) connected += n
    else other += n
  }
  return { connected, disconnected, other }
}

function alignHistograms(bucketsA, bucketsB) {
  const map = new Map()
  for (const b of bucketsA || []) {
    map.set(b.key, {
      t: b.key_as_string || new Date(b.key).toISOString(),
      total: b.doc_count,
      threats: 0,
    })
  }
  for (const b of bucketsB || []) {
    const row = map.get(b.key) || {
      t: b.key_as_string || new Date(b.key).toISOString(),
      total: 0,
      threats: 0,
    }
    row.threats = b.doc_count
    map.set(b.key, row)
  }
  return [...map.values()].sort((a, b) => new Date(a.t) - new Date(b.t))
}

/** GET /api/sentinel/dashboard?scope=all|no_usb|usb_only|bt_only — KPIs + charts + top lists */
router.get('/dashboard', async (req, res) => {
  try {
    const es = getESClient()
    const ix = getSentinelIndex()
    const tr = getTimeRange(req)
    const rangeQ = { range: { '@timestamp': tr } }
    const scopeRaw = String(req.query.scope || 'all').toLowerCase()
    const scope = scopeRaw === 'bluetooth_only' ? 'bt_only' : scopeRaw
    const scopeMust =
      scope === 'no_usb'
        ? sentinelScopeClause('no_usb')
        : scope === 'usb_only'
          ? sentinelScopeClause('usb_only')
          : scope === 'bt_only'
            ? sentinelScopeClause('bt_only')
            : sentinelScopeClause('all')

    const hostGroup = String(req.query.hostGroup || '').trim()
    const endpoints = String(req.query.endpoints || '').trim()
    const mustBase = [rangeQ, scopeMust]
    appendHostGroup(mustBase, hostGroup)
    appendEndpoints(mustBase, endpoints)

    const [
      total,
      threats,
      discC,
      connC,
      blockedC,
      totalHist,
      threatHist,
      usbOnlyCount,
      btOnlyCount,
    ] = await Promise.all([
      safeCount(es, ix, mustBase),
      safeCount(es, ix, [...mustBase, ACTIVE_THREAT_BOOL]),
      safeCount(es, ix, [...mustBase, AGENT_DISCONNECTED_BOOL]),
      safeCount(es, ix, [...mustBase, AGENT_CONNECTED_BOOL]),
      safeCount(es, ix, [...mustBase, BLOCKED_OR_MITIGATED_BOOL]),
      es.search({
        index: ix,
        body: {
          size: 0,
          query: { bool: { must: mustBase } },
          aggs: {
            h: {
              date_histogram: {
                field: '@timestamp',
                fixed_interval: '1h',
                min_doc_count: 0,
              },
            },
          },
        },
      }),
      es.search({
        index: ix,
        body: {
          size: 0,
          query: { bool: { must: [...mustBase, ACTIVE_THREAT_BOOL] } },
          aggs: {
            h: {
              date_histogram: {
                field: '@timestamp',
                fixed_interval: '1h',
                min_doc_count: 0,
              },
            },
          },
        },
      }),
      scope === 'no_usb' || scope === 'bt_only'
        ? Promise.resolve(0)
        : (() => {
            const m = [rangeQ, USB_PERIPHERAL_EVENT_BOOL]
            appendHostGroup(m, hostGroup)
            appendEndpoints(m, endpoints)
            return safeCount(es, ix, m)
          })(),
      scope === 'no_usb' || scope === 'usb_only'
        ? Promise.resolve(0)
        : (() => {
            const m = [rangeQ, BLUETOOTH_DEVICE_EVENT_BOOL]
            appendHostGroup(m, hostGroup)
            appendEndpoints(m, endpoints)
            return safeCount(es, ix, m)
          })(),
    ])

    const timeline = alignHistograms(
      totalHist.aggregations?.h?.buckets,
      threatHist.aggregations?.h?.buckets,
    )

    const activeEndpoints = await tryCardinality(es, ix, mustBase, [
      'agentRealtimeInfo.agentComputerName.keyword',
      'host.name.keyword',
      'host.hostname.keyword',
    ])

    const uniqueUsers = await tryCardinality(es, ix, mustBase, [
      'user.name.keyword',
      'agentRealtimeInfo.activeUserName.keyword',
      'user.id.keyword',
    ])

    const sites = await tryCardinality(es, ix, mustBase, [
      'group.name.keyword',
      'site.name.keyword',
      'agentRealtimeInfo.groupName.keyword',
      'groupName.keyword',
      'site_name.keyword',
    ])

    let usbEvents = 0
    let bluetoothEvents = 0
    if (scope === 'no_usb') {
      usbEvents = 0
      bluetoothEvents = 0
    } else if (scope === 'usb_only') {
      usbEvents = total
      bluetoothEvents = 0
    } else if (scope === 'bt_only') {
      usbEvents = 0
      bluetoothEvents = total
    } else {
      usbEvents = usbOnlyCount
      bluetoothEvents = btOnlyCount
    }

    const topEndpointsMust =
      scope === 'usb_only'
        ? (() => {
            const m = [rangeQ, USB_PERIPHERAL_EVENT_BOOL]
            appendHostGroup(m, hostGroup)
            appendEndpoints(m, endpoints)
            return m
          })()
        : scope === 'bt_only'
          ? (() => {
              const m = [rangeQ, BLUETOOTH_DEVICE_EVENT_BOOL]
              appendHostGroup(m, hostGroup)
              appendEndpoints(m, endpoints)
              return m
            })()
          : scope === 'no_usb'
            ? (() => {
                const m = [rangeQ, sentinelScopeClause('no_usb')]
                appendHostGroup(m, hostGroup)
                appendEndpoints(m, endpoints)
                return m
              })()
            : (() => {
                const m = [rangeQ]
                appendHostGroup(m, hostGroup)
                appendEndpoints(m, endpoints)
                return m
              })()

    const topUsbMust = (() => {
      const m = [rangeQ, USB_PERIPHERAL_EVENT_BOOL]
      appendHostGroup(m, hostGroup)
      appendEndpoints(m, endpoints)
      return m
    })()

    const topUsbDisconnectHostsMust = (() => {
      const m = [rangeQ, USB_PERIPHERAL_EVENT_BOOL, USB_PERIPHERAL_DISCONNECT_FILTER]
      appendHostGroup(m, hostGroup)
      appendEndpoints(m, endpoints)
      return m
    })()

    const topBluetoothMust = (() => {
      const m = [rangeQ, BLUETOOTH_DEVICE_EVENT_BOOL]
      appendHostGroup(m, hostGroup)
      appendEndpoints(m, endpoints)
      return m
    })()

    const deviceTermFields = [
      // SentinelOne Elastic integration — activity data (camelCase)
      'sentinel_one.activity.data.deviceName.keyword',
      'sentinel_one.activity.data.productName.keyword',
      'sentinel_one.activity.data.vendorName.keyword',
      'sentinel_one.activity.data.externalDeviceType.keyword',
      'sentinel_one.activity.data.deviceClass.keyword',
      // SentinelOne Elastic integration — activity data (snake_case)
      'sentinel_one.activity.data.device_name.keyword',
      'sentinel_one.activity.data.product_name.keyword',
      'sentinel_one.activity.data.vendor_name.keyword',
      'sentinel_one.activity.data.external_device_type.keyword',
      'sentinel_one.activity.data.device_class.keyword',
      // SentinelOne — other namespaces
      'sentinel_one.device.name.keyword',
      'sentinel_one.alert.info.device_name.keyword',
      // ECS standard
      'device.name.keyword',
      'device.product.keyword',
      'device.model.name.keyword',
      'device.type.keyword',
      // Flat dot-notation / custom pipelines
      'data.deviceName.keyword',
      'data.productName.keyword',
      'data.device_name.keyword',
      'data.product_name.keyword',
      'event.device.name.keyword',
      'device_name.keyword',
      'observer.product.keyword',
    ]

    const hostTermFields = [
      'agentRealtimeInfo.agentComputerName.keyword',
      'host.name.keyword',
      'host.hostname.keyword',
    ]

    const [
      topEndpoints,
      topUsb,
      topBluetooth,
      usbActionSplit,
      bluetoothActionSplit,
      topUsbDisconnectHosts,
    ] = await Promise.all([
      tryTopTerms(es, ix, topEndpointsMust, hostTermFields, 8),
      scope === 'no_usb' || scope === 'bt_only'
        ? Promise.resolve([])
        : tryTopTerms(es, ix, topUsbMust, deviceTermFields, 8),
      scope === 'no_usb' || scope === 'usb_only'
        ? Promise.resolve([])
        : tryTopTerms(es, ix, topBluetoothMust, deviceTermFields, 8),
      scope === 'usb_only' ? usbPeripheralActionSplit(es, ix, rangeQ, hostGroup, endpoints) : Promise.resolve(null),
      scope === 'bt_only' ? bluetoothPeripheralActionSplit(es, ix, rangeQ, hostGroup, endpoints) : Promise.resolve(null),
      scope === 'usb_only'
        ? tryTopTerms(es, ix, topUsbDisconnectHostsMust, hostTermFields, 10)
        : Promise.resolve([]),
    ])

    res.json({
      index: ix,
      scope,
      total,
      threats,
      activeEndpoints,
      usbEvents,
      bluetoothEvents,
      sites,
      uniqueUsers,
      eventTypes: {
        connected: connC,
        disconnected: discC,
        blocked: blockedC,
      },
      timeline,
      topEndpoints,
      topUsb,
      topUsbDisconnectHosts,
      topBluetooth,
      usbActionSplit,
      bluetoothActionSplit,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** Shared bool `must` clauses for sentinel event search + CSV export. */
function buildSentinelEventsMust(req) {
  const must = [...buildSentinelScopeAndTimeMust(req)]
  const scopeRaw = String(req.query.scope || 'all').toLowerCase()
  const scope = scopeRaw === 'bluetooth_only' ? 'bt_only' : scopeRaw
  appendHostGroup(must, req.query.hostGroup)

  const endpoint = String(req.query.endpoint || '').trim()
  if (endpoint) {
    must.push({
      bool: {
        should: [
          { term: { 'agentRealtimeInfo.agentComputerName.keyword': endpoint } },
          { term: { 'host.name.keyword': endpoint } },
          { term: { 'host.hostname.keyword': endpoint } },
        ],
        minimum_should_match: 1,
      },
    })
  }

  appendEndpoints(must, req.query.endpoints)

  const user = String(req.query.user || '').trim()
  if (user) {
    must.push({
      bool: {
        should: [
          { term: { 'user.name.keyword': user } },
          { term: { 'agentRealtimeInfo.activeUserName.keyword': user } },
        ],
        minimum_should_match: 1,
      },
    })
  }

  const peripheralDevice = String(req.query.usbDevice || req.query.bluetoothDevice || '').trim()
  if (peripheralDevice) {
    const esc = peripheralDevice.replace(/[\\*]/g, '')
    must.push({
      bool: {
        should: [
          { wildcard: { message: `*${esc}*` } },
          { term: { 'device.name.keyword': peripheralDevice } },
          { term: { 'device.product.keyword': peripheralDevice } },
          { term: { 'sentinel_one.activity.data.deviceName.keyword': peripheralDevice } },
          { term: { 'sentinel_one.activity.data.productName.keyword': peripheralDevice } },
          { term: { 'sentinel_one.activity.data.device_name.keyword': peripheralDevice } },
          { term: { 'sentinel_one.activity.data.product_name.keyword': peripheralDevice } },
          { term: { 'sentinel_one.activity.data.externalDeviceType.keyword': peripheralDevice } },
          { term: { 'sentinel_one.activity.data.external_device_type.keyword': peripheralDevice } },
          { term: { 'sentinel_one.activity.data.deviceClass.keyword': peripheralDevice } },
          { term: { 'sentinel_one.activity.data.device_class.keyword': peripheralDevice } },
          { term: { 'data.deviceName.keyword': peripheralDevice } },
          { term: { 'data.device_name.keyword': peripheralDevice } },
          { term: { 'device_name.keyword': peripheralDevice } },
        ],
        minimum_should_match: 1,
      },
    })
  }

  const eventKind = String(req.query.eventKind || '').toLowerCase()
  if (eventKind === 'connected') must.push(AGENT_CONNECTED_BOOL)
  else if (eventKind === 'disconnected') must.push(AGENT_DISCONNECTED_BOOL)
  else if (eventKind === 'blocked') must.push(BLOCKED_OR_MITIGATED_BOOL)

  const eventAction = String(req.query.eventAction || '').trim()
  if (eventAction) {
    const ea = eventAction.toLowerCase()
    if (ea === 'disconnected' && scope === 'usb_only') {
      must.push(USB_PERIPHERAL_DISCONNECT_FILTER)
    } else {
      must.push({
        bool: {
          should: [
            { term: { 'event.action.keyword': eventAction } },
            { term: { 'event.action': eventAction } },
          ],
          minimum_should_match: 1,
        },
      })
    }
  }

  const q = String(req.query.q || '').trim()
  if (q) {
    must.push({
      bool: {
        should: [
          { match_bool_prefix: { message: q } },
          { match_bool_prefix: { 'event.original': q } },
          { match_bool_prefix: { event_message: q } },
        ],
        minimum_should_match: 1,
      },
    })
  }

  return must
}

function csvEscapeSentinel(val) {
  if (val == null || val === '') return ''
  const s = String(val)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function searchAfterFromHit(hit, sortLen) {
  const s = hit?.sort
  const n = sortLen ?? 2
  if (Array.isArray(s) && s.length >= n && !s.slice(0, n).some(v => v === undefined || v === null)) return s.slice(0, n)
  return null
}

/** GET/POST /api/sentinel/events/export — full CSV; POST body avoids long query URLs. */
async function handleSentinelEventsExport(req, res) {
  try {
    const q = mergeExportQuery(req)
    const maxRows = Math.min(Math.max(parseInt(String(q.maxRows), 10) || 100000, 1), 200000)
    const batchSize = Math.min(1000, maxRows)
    const es = getESClient()
    const ix = getSentinelIndex()
    const must = buildSentinelEventsMust({ query: q })
    const sort = [{ '@timestamp': { order: 'desc' } }, { _shard_doc: 'desc' }]

    const headers = ['Time', 'Host group', 'Host', 'User', 'Severity', 'Category', 'Event action', 'Message']
    const headerLine = headers.map(csvEscapeSentinel).join(',') + '\n'

    let searchAfter = null
    let written = 0
    while (written < maxRows) {
      const take = Math.min(batchSize, maxRows - written)
      const body = {
        size: take,
        sort,
        query: { bool: { must } },
      }
      if (searchAfter) body.search_after = searchAfter

      const result = await es.search({ index: ix, body })
      const hits = result.hits.hits

      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', 'attachment; filename="netpulse-xdr-sentinel-export.csv"')
        res.write('\ufeff')
        res.write(headerLine)
      }

      if (!hits.length) break

      for (const h of hits) {
        const src = h._source || {}
        const row = normalizeSentinelEvent(src, h._id)
        const fullMsg = pickSentinelMessage(src).replace(/\r?\n/g, ' ')
        const line = [row['@timestamp'], row.hostGroup, row.host, row.user, row.severity, row.category, row.eventAction, fullMsg]
          .map(csvEscapeSentinel)
          .join(',')
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

router.get('/events/export', handleSentinelEventsExport)
router.post('/events/export', handleSentinelEventsExport)

/** Escape user input for Elasticsearch wildcard `value` (inside *...*). */
function escapeEsWildcardFragment(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/\?/g, '\\?')
}

/** Escape reserved characters for `query_string` query text. */
function escapeEsQueryString(s) {
  return String(s).replace(/([+\-=&|><!(){}[\]^"~*?:\\\/])/g, '\\$1')
}

/** GET /api/sentinel/hostname-search?q=...&scope=usb_only — substring search; not limited to top-N terms by volume. */
router.get('/hostname-search', async (req, res) => {
  try {
    const es = getESClient()
    const ix = getSentinelIndex()
    const qRaw = String(req.query.prefix ?? req.query.q ?? '').trim()
    if (qRaw.length < 2) return res.json({ hostnames: [] })

    const pat = `*${escapeEsWildcardFragment(qRaw)}*`
    const keywordFields = [
      'agentRealtimeInfo.agentComputerName.keyword',
      'host.name.keyword',
      'host.hostname.keyword',
      'agent.name.keyword',
      'related.host.name.keyword',
    ]

    const must = [...buildSentinelScopeAndTimeMust(req)]
    appendHostGroup(must, req.query.hostGroup)
    must.push({
      bool: {
        should: keywordFields.map(field => ({
          wildcard: { [field]: { value: pat, case_insensitive: true } },
        })),
        minimum_should_match: 1,
      },
    })

    const aggs = {}
    keywordFields.forEach((field, i) => {
      aggs[`h${i}`] = { terms: { field, size: 80, missing: '__missing__' } }
    })

    const r = await es.search({
      index: ix,
      body: {
        size: 0,
        track_total_hits: false,
        query: { bool: { must } },
        aggs,
      },
    })

    const set = new Set()
    const qLower = qRaw.toLowerCase()
    for (let i = 0; i < keywordFields.length; i++) {
      for (const b of r.aggregations?.[`h${i}`]?.buckets || []) {
        const k = String(b.key).trim()
        if (k && k !== '__missing__' && k.toLowerCase().includes(qLower)) set.add(k)
      }
    }

    if (set.size === 0) {
      const hitsR = await es.search({
        index: ix,
        body: {
          size: 80,
          track_total_hits: false,
          query: { bool: { must } },
          _source: [
            'host.name',
            'host.hostname',
            'agentRealtimeInfo',
            'agent_realtime_info',
            'agent',
          ],
        },
      })
      for (const h of hitsR.hits?.hits || []) {
        const src = h._source || {}
        const ar = src.agentRealtimeInfo || src.agent_realtime_info || {}
        const candidates = [
          ar.agentComputerName,
          src.host?.name,
          src.host?.hostname,
          src.agent?.name,
          src['host.name'],
          src['host.hostname'],
        ]
          .map(x => String(x || '').trim())
          .filter(Boolean)
        for (const c of candidates) {
          if (c.toLowerCase().includes(qLower)) set.add(c)
        }
      }
    }

    if (set.size === 0) {
      const looseMust = [...buildSentinelScopeAndTimeMust(req)]
      appendHostGroup(looseMust, req.query.hostGroup)
      looseMust.push({
        query_string: {
          query: `*${escapeEsQueryString(qRaw)}*`,
          fields: [
            'host.name^3',
            'host.hostname^2',
            'agentRealtimeInfo.agentComputerName^2',
            'message',
            'event_message',
            'log.message',
          ],
          analyze_wildcard: true,
          default_operator: 'OR',
        },
      })
      const wide = await es.search({
        index: ix,
        body: {
          size: 120,
          track_total_hits: false,
          query: { bool: { must: looseMust } },
          _source: [
            'host.name',
            'host.hostname',
            'agentRealtimeInfo',
            'agent_realtime_info',
            'agent',
            'message',
            'event_message',
          ],
        },
      })
      for (const h of wide.hits?.hits || []) {
        const src = h._source || {}
        const ar = src.agentRealtimeInfo || src.agent_realtime_info || {}
        const candidates = [
          ar.agentComputerName,
          src.host?.name,
          src.host?.hostname,
          src.agent?.name,
          src['host.name'],
          src['host.hostname'],
        ]
          .map(x => String(x || '').trim())
          .filter(Boolean)
        for (const c of candidates) {
          if (c.toLowerCase().includes(qLower)) set.add(c)
        }
      }
    }

    const hostnames = [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    res.json({ hostnames })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /api/sentinel/host-groups — distinct host group names from logs (same fields as dashboard filter). */
router.get('/host-groups', async (req, res) => {
  try {
    const es = getESClient()
    const ix = getSentinelIndex()
    const must = buildSentinelScopeAndTimeMust(req)
    const groups = await aggregateDistinctHostGroupsFromLogs(es, ix, must)
    res.json({ groups })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /api/sentinel/events — paginated raw events + drill filters */
router.get('/events', async (req, res) => {
  try {
    const es = getESClient()
    const ix = getSentinelIndex()
    const scopeRaw = String(req.query.scope || 'all').toLowerCase()
    const scope = scopeRaw === 'bluetooth_only' ? 'bt_only' : scopeRaw
    const must = buildSentinelEventsMust(req)

    const size = Math.min(parseInt(req.query.size, 10) || 50, 200)
    const page = Math.max(parseInt(req.query.page, 10) || 0, 0)
    const result = await es.search({
      index: ix,
      body: {
        track_total_hits: true,
        from: page * size,
        size,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { bool: { must } },
      },
    })

    res.json({
      total: hitsTotalValue(result.hits.total),
      page,
      size,
      scope,
      hits: result.hits.hits.map(h => {
        const row = normalizeSentinelEvent(h._source || {}, h._id)
        row._index = h._index
        return row
      }),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
