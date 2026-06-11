import { Router } from 'express'
import { createZabbixClient } from '../services/zabbix.js'
import { fetchRopUptimeReport } from '../services/ropUptimeReport.js'

export function createZabbixRouter(client) {
  const {
    isZabbixConfigured,
    zabbixRpc,
    zabbixPing,
    getZabbixToken,
    getUrl,
    getAuthMode,
    urlEnv,
    tokenEnv,
    tokenAliasEnv,
    authEnv,
    tlsEnv,
  } = client

  const router = Router()

const SEVERITY_LABEL = {
  0: 'Not classified',
  1: 'Information',
  2: 'Warning',
  3: 'Average',
  4: 'High',
  5: 'Disaster',
}

function mapProblems(problems) {
  return (problems || []).map((p) => ({
    eventid: p.eventid,
    objectid: p.objectid,
    name: p.name,
    severity: p.severity,
    severityLabel: SEVERITY_LABEL[p.severity] || 'Unknown',
    clock: p.clock,
    r_clock: p.r_clock,
    acknowledged: String(p.acknowledged) === '1',
    hosts: (p.hosts || []).map((h) => ({
      hostid: h.hostid,
      host: h.host,
      name: h.name,
    })),
  }))
}

/** Filter monitored host rows by optional Zabbix group name (exact) and/or host name search (substring). */
function filterOverviewHosts(rows, groupName, q) {
  let out = rows || []
  const g = String(groupName || '').trim()
  if (g) {
    out = out.filter((h) => (h.hostgroups || h.groups || []).some((x) => (x.name || '') === g))
  }
  const search = String(q || '').trim().toLowerCase()
  if (search) {
    out = out.filter((h) => {
      const name = String(h.name || '').toLowerCase()
      const host = String(h.host || '').toLowerCase()
      return name.includes(search) || host.includes(search)
    })
  }
  return out
}

const HOST_FETCH_MAX = 10000
const HOST_DETAIL_CHUNK = 500
/** Treat Zabbix item data older than this as stale (typical poll interval 2–5 min). */
const NET_HEALTH_STALE_DEFAULT_SEC = 300

function parseNetHealthStaleAfter(query) {
  const raw = parseInt(String(query.staleAfter ?? query.staleAfterSec ?? ''), 10)
  if (!Number.isFinite(raw)) return NET_HEALTH_STALE_DEFAULT_SEC
  return Math.min(Math.max(raw, 60), 3600)
}

function pollAgeBounds(clocks) {
  const valid = clocks.filter((c) => c != null && c > 0)
  if (!valid.length) return { oldestPoll: null, newestPoll: null }
  return { oldestPoll: Math.min(...valid), newestPoll: Math.max(...valid) }
}

async function monitoredHostCount() {
  try {
    return Number(await zabbixRpc('host.get', { monitored_hosts: true, countOutput: true })) || 0
  } catch (e) {
    if (e.code !== 'ZABBIX_API_ERROR') throw e
    return Number(await zabbixRpc('host.get', { countOutput: true })) || 0
  }
}

/** Fetch all monitored hosts (paginated by hostid chunks when > HOST_FETCH_MAX). */
async function fetchAllMonitoredHosts(baseParams = {}, { maxTotal = HOST_FETCH_MAX, chunkSize = HOST_DETAIL_CHUNK } = {}) {
  const total = await monitoredHostCount()
  if (total <= maxTotal) {
    const rows = await zabbixRpc('host.get', {
      monitored_hosts: true,
      sortfield: 'hostid',
      sortorder: 'ASC',
      limit: maxTotal,
      ...baseParams,
    })
    return { rows: rows || [], total, truncated: false }
  }

  const idRows = await zabbixRpc('host.get', {
    monitored_hosts: true,
    output: ['hostid'],
    sortfield: 'hostid',
    sortorder: 'ASC',
    limit: maxTotal,
  })
  const ids = (idRows || []).map((h) => String(h.hostid)).filter(Boolean)
  const truncated = ids.length < total
  const all = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const hostids = ids.slice(i, i + chunkSize)
    const batch = await zabbixRpc('host.get', {
      monitored_hosts: true,
      hostids,
      limit: chunkSize,
      ...baseParams,
    })
    all.push(...(batch || []))
  }
  return { rows: all, total, truncated }
}

async function problemCountForHostids(hostids) {
  if (!hostids?.length) return 0
  try {
    return await zabbixRpc('problem.get', { hostids, recent: true, countOutput: true })
  } catch (e) {
    if (e.code !== 'ZABBIX_API_ERROR') throw e
    return zabbixRpc('problem.get', { hostids, countOutput: true })
  }
}

async function problemGet(params) {
  const attempts = [
    { recent: true, ...params },
    { ...params },
  ]
  const { selectHosts, selectAcknowledges, ...rest } = params
  if (selectHosts || selectAcknowledges) {
    attempts.push({ recent: true, ...rest })
    attempts.push({ ...rest })
  }
  for (let i = 0; i < attempts.length; i++) {
    try {
      return await zabbixRpc('problem.get', attempts[i])
    } catch (e) {
      if (e.code !== 'ZABBIX_API_ERROR' || i === attempts.length - 1) throw e
    }
  }
  return []
}

async function problemCountParams() {
  try {
    return await zabbixRpc('problem.get', { recent: true, countOutput: true })
  } catch (e) {
    if (e.code !== 'ZABBIX_API_ERROR') throw e
    return zabbixRpc('problem.get', { countOutput: true })
  }
}

async function severityCountParams(hostids, scopeFiltered) {
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  if (scopeFiltered && !hostids?.length) return counts
  await Promise.all(
    [0, 1, 2, 3, 4, 5].map(async (severity) => {
      const base = { countOutput: true, severities: [String(severity)] }
      if (scopeFiltered) base.hostids = hostids
      try {
        counts[severity] = Number(await zabbixRpc('problem.get', { recent: true, ...base })) || 0
      } catch (e) {
        if (e.code !== 'ZABBIX_API_ERROR') throw e
        counts[severity] = Number(await zabbixRpc('problem.get', base)) || 0
      }
    }),
  )
  return counts
}

function aggregateSeverity(rows) {
  const c = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const p of rows || []) {
    const s = Number(p.severity)
    if (s >= 0 && s <= 5) c[s]++
  }
  return c
}

function sendZabbixError(res, e) {
  if (e.code === 'ZABBIX_NOT_CONFIGURED') {
    return res.status(503).json({ error: e.message })
  }
  const status =
    e.code === 'ZABBIX_HTTP' ||
    e.code === 'ZABBIX_FETCH' ||
    e.code === 'ZABBIX_BAD_RESPONSE' ||
    e.code === 'ZABBIX_TIMEOUT'
      ? 502
      : 500
  return res.status(status).json({
    error: e.message,
    code: e.code,
    hint: e.hint,
    zabbixCode: e.zabbixCode,
  })
}

router.get('/config', async (req, res) => {
  const url = getUrl()
  const token = getZabbixToken()
  const configured = isZabbixConfigured()
  let probe = null
  if (configured) {
    probe = await zabbixPing({ timeoutMs: 8000 })
  }
  res.json({
    configured,
    reachable: probe ? probe.ok : null,
    probe,
    zabbixUrl: url ? url.replace(/\/api_jsonrpc\.php.*$/i, '') : null,
    authMode: getAuthMode(),
    tokenPresent: Boolean(token),
    tokenSuffix: token ? `…${token.slice(-6)}` : null,
  })
})

router.get('/diagnostic', async (req, res) => {
  const ping = await zabbixPing()
  res.json({
    zabbixUrl: getUrl() || null,
    tokenConfigured: Boolean(getZabbixToken()),
    ping,
    tips: [
      'Use the full URL ending in api_jsonrpc.php (often /zabbix/api_jsonrpc.php).',
      `Variable names: ${urlEnv} and ${tokenEnv} (or ${tokenAliasEnv}).`,
      'Docker: put the same vars in project root .env (compose env_file) or server/.env inside the mounted server folder.',
      `HTTPS with self-signed: set ${tlsEnv}=1 on the API server only for testing.`,
      `Zabbix 7.4+: set ${authEnv}=bearer. Older: try ${authEnv}=body or leave auto.`,
    ],
  })
})

/**
 * Derive availability for a host:
 *   '1' = Available, '2' = Unavailable, '0' = Unknown.
 *
 * Zabbix 7+: prefer host.active_available (matches Zabbix UI widgets).
 * Older / fallback: interface.available, then legacy host.available.
 */
function deriveHostAvail(h) {
  const active = String(h.active_available ?? '')
  if (active === '1' || active === '2' || active === '0') return active

  const ifaces = h.interfaces
  if (Array.isArray(ifaces) && ifaces.length > 0) {
    let any1 = false
    let any2 = false
    let any0 = false
    for (const iface of ifaces) {
      const a = String(iface.available ?? '')
      if (a === '1') any1 = true
      else if (a === '2') any2 = true
      else any0 = true
    }
    if (any1 && !any2) return '1'
    if (any2 && !any1) return '2'
    if (any1 && any2) return '2'
    if (any0 && !any1 && !any2) return '0'
  }
  const legacy = String(h.available ?? '')
  if (legacy === '1' || legacy === '2' || legacy === '0') return legacy
  return '0'
}

function hostAvailability(hosts) {
  const out = { available: 0, unavailable: 0, unknown: 0, total: 0 }
  for (const h of hosts || []) {
    out.total++
    const a = deriveHostAvail(h)
    if (a === '1') out.available++
    else if (a === '2') out.unavailable++
    else out.unknown++
  }
  return out
}

function topProblemHosts(problems, max = 8) {
  const counts = {}
  for (const p of problems || []) {
    for (const h of p.hosts || []) {
      const key = h.hostid || h.host
      if (!key) continue
      if (!counts[key]) counts[key] = { hostid: h.hostid, host: h.host, name: h.name, count: 0, maxSeverity: 0 }
      counts[key].count++
      const s = Number(p.severity)
      if (s > counts[key].maxSeverity) counts[key].maxSeverity = s
    }
  }
  return Object.values(counts)
    .sort((a, b) => b.count - a.count || b.maxSeverity - a.maxSeverity)
    .slice(0, max)
}

function hostGroupSummary(hosts) {
  const groups = {}
  for (const h of hosts || []) {
    for (const g of h.groups || []) {
      const name = g.name || g.groupid || 'Ungrouped'
      if (!groups[name]) groups[name] = { name, count: 0 }
      groups[name].count++
    }
  }
  return Object.values(groups).sort((a, b) => b.count - a.count).slice(0, 15)
}

router.get('/overview', async (req, res) => {
  try {
    if (!isZabbixConfigured()) {
      return res.status(503).json({
        error: 'Zabbix not configured',
        hint: `Set ${urlEnv} and ${tokenEnv} (see server/.env.example and GET /api/zabbix/diagnostic)`,
      })
    }

    let selectGroupsParam
    try {
      await zabbixRpc('hostgroup.get', { output: ['groupid'], limit: 1 })
      selectGroupsParam = { selectHostGroups: ['groupid', 'name'] }
    } catch {
      selectGroupsParam = { selectGroups: ['groupid', 'name'] }
    }

    const groupFilter = String(req.query.group || '').trim()
    const qFilter = String(req.query.q || '').trim()

    const [version, hostFetch] = await Promise.all([
      zabbixRpc('apiinfo.version', {}),
      fetchAllMonitoredHosts({
        output: ['hostid', 'host', 'name', 'status', 'available', 'active_available'],
        selectInterfaces: ['interfaceid', 'available', 'type'],
        ...selectGroupsParam,
      }),
    ])
    const { rows: hostRows, total: monitoredHostTotal, truncated: hostsTruncated } = hostFetch

    const hostsForGroups = (hostRows || []).map((h) => ({
      ...h,
      groups: h.hostgroups || h.groups || [],
    }))
    const filteredRows = filterOverviewHosts(hostsForGroups, groupFilter, qFilter)
    const hostids = filteredRows.map((h) => String(h.hostid))
    const scopeFiltered = Boolean(groupFilter || qFilter)

    const problemQuery = (extra) => {
      if (scopeFiltered && !hostids.length) return Promise.resolve([])
      if (scopeFiltered) return problemGet({ hostids, ...extra })
      return problemGet(extra)
    }

    const [problemCount, problems, severityCounts] = await Promise.all([
      scopeFiltered && !hostids.length ? Promise.resolve(0) : scopeFiltered ? problemCountForHostids(hostids) : problemCountParams(),
      problemQuery({
        sortfield: ['eventid'],
        sortorder: 'DESC',
        limit: 500,
        output: ['eventid', 'name', 'severity', 'clock', 'r_clock', 'objectid', 'acknowledged'],
        selectHosts: ['hostid', 'host', 'name'],
      }),
      severityCountParams(hostids, scopeFiltered),
    ])

    const availBase = scopeFiltered ? filteredRows : hostRows
    const avail = hostAvailability(availBase)
    const topHosts = topProblemHosts(problems)
    const groupStats = hostGroupSummary(scopeFiltered ? filteredRows : hostsForGroups)
    const healthPct = avail.total > 0 ? Math.round((avail.available / avail.total) * 1000) / 10 : 0
    const latestProblems = (problems || []).slice(0, 50)

    res.json({
      version: String(version || ''),
      monitoredHosts: avail.total,
      monitoredHostTotal,
      hostsTruncated,
      activeProblems: Number(problemCount) || 0,
      severityCounts,
      problems: mapProblems(latestProblems),
      availability: avail,
      healthPercent: healthPct,
      topProblemHosts: topHosts,
      hostGroups: groupStats,
      /** Full group list for filter dropdowns (always unfiltered). */
      allHostGroups: hostGroupSummary(hostsForGroups),
      dashboardFilter: { group: groupFilter || null, q: qFilter || null },
      scopeFiltered,
    })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

function hostSearchParams(q) {
  const trimmed = String(q || '').trim()
  if (!trimmed) return {}
  return {
    search: { name: trimmed, host: trimmed },
    searchByAny: true,
    searchWildcardsEnabled: true,
  }
}

router.get('/hosts', async (req, res) => {
  try {
    if (!isZabbixConfigured()) {
      return res.status(503).json({ error: 'Zabbix not configured' })
    }
    const reqLimit = parseInt(String(req.query.limit || '5000'), 10)
    const limit = Math.min(Math.max(Number.isFinite(reqLimit) ? reqLimit : 5000, 1), HOST_FETCH_MAX)
    let selectGroupsKey = 'selectGroups'
    try {
      await zabbixRpc('hostgroup.get', { output: ['groupid'], limit: 1 })
      selectGroupsKey = 'selectHostGroups'
    } catch { /* keep selectGroups */ }
    const { rows: raw, total: monitoredHostTotal, truncated: hostsTruncated } = await fetchAllMonitoredHosts({
      output: ['hostid', 'host', 'name', 'status', 'available', 'active_available'],
      selectInterfaces: ['interfaceid', 'available', 'type', 'ip', 'dns', 'port', 'main'],
      [selectGroupsKey]: ['groupid', 'name'],
      sortfield: 'name',
      ...hostSearchParams(req.query.q),
    }, { maxTotal: limit })
    const hosts = (raw || []).map((h) => {
      const ifaces = Array.isArray(h.interfaces) ? h.interfaces : []
      const primary = ifaces.find((i) => String(i.main) === '1') || ifaces[0]
      const ip = primary?.ip || ''
      const dns = primary?.dns || ''
      return {
        hostid: h.hostid,
        host: h.host,
        name: h.name,
        ip: ip || dns || h.host,
        dns,
        monitored: String(h.status) === '0',
        availability: availLabel(deriveHostAvail(h)),
        availabilityCode: deriveHostAvail(h),
        groups: (h.hostgroups || h.groups || []).map((g) => g.name).filter(Boolean),
      }
    })
    res.json({ hosts, total: monitoredHostTotal, returned: hosts.length, truncated: hostsTruncated })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

function availLabel(code) {
  const c = String(code)
  if (c === '1') return 'Available'
  if (c === '2') return 'Unavailable'
  return 'Unknown'
}

function graphItemRows(g) {
  if (!g || typeof g !== 'object') return []
  const a = g.graphitems || g.gitems || g.graphItems
  return Array.isArray(a) ? a : []
}

function itemIdFromGraphItem(gi) {
  if (gi == null || typeof gi !== 'object') return null
  let raw = gi.itemid ?? gi.item_id
  if ((raw == null || raw === '') && Array.isArray(gi.items) && gi.items[0]) {
    const first = gi.items[0]
    raw = first.itemid ?? first.item_id
  }
  if (raw == null || raw === '') return null
  return String(raw)
}

function normalizeHexColor(c) {
  if (c == null || c === '') return null
  const s = String(c).trim()
  if (s.startsWith('#')) return s
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`
  return s
}

/** Parse numeric-looking Zabbix char/text values (e.g. "12.3", "45 %"). */
function parseLooseNumber(raw) {
  if (raw == null || raw === '') return NaN
  const s = String(raw).trim().replace(/,/g, '')
  const n = Number(s)
  if (Number.isFinite(n)) return n
  const m = s.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/i)
  return m ? Number(m[0]) : NaN
}

/**
 * Map item value_type → history.get type + value parser.
 * Char/text (1/4) are common on Linux templates (JSONPath / dependent items); they have no trends.
 * @returns {{ history: number, parse: (v: unknown) => number, trends: boolean } | null}
 */
function historyKind(valueType) {
  const v = Number(valueType)
  if (v === 0) return { history: 0, parse: (x) => Number(x), trends: true }
  if (v === 3) return { history: 3, parse: (x) => Number(x), trends: true }
  if (v === 1) return { history: 1, parse: parseLooseNumber, trends: false }
  if (v === 4) return { history: 4, parse: parseLooseNumber, trends: false }
  return null
}

function downsamplePoints(points, maxPoints) {
  if (!points?.length || points.length <= maxPoints) return points
  const out = []
  const step = points.length / maxPoints
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * step)
    const end = Math.min(points.length, Math.floor((i + 1) * step))
    const chunk = points.slice(start, end)
    if (!chunk.length) continue
    let sum = 0
    for (const p of chunk) sum += Number(p.value)
    const mid = chunk[Math.floor(chunk.length / 2)]
    out.push({ clock: mid.clock, value: sum / chunk.length })
  }
  return out
}

/** Single latest row from `item.get` metadata (enabled item with a last value). */
function latestRowFromMeta(meta, colorByItem = {}) {
  if (!meta) return null
  if (String(meta.status) !== '0') return null
  const itemid = String(meta.itemid)
  const raw = meta.lastvalue
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const num = parseLooseNumber(raw)
  return {
    itemid,
    name: meta.name || meta.key_ || itemid,
    key: meta.key_,
    units: meta.units || '',
    lastclock: meta.lastclock != null && meta.lastclock !== '' ? Number(meta.lastclock) : null,
    value: Number.isFinite(num) ? num : null,
    rawValue: String(raw),
    numeric: Number.isFinite(num),
    valueType: Number(meta.value_type),
    color: colorByItem[itemid] || null,
  }
}

/** One row per graph item using Zabbix `lastvalue` (VMware / thin history / pie graphs). */
function buildLatestRows(itemids, itemMap, colorByItem) {
  const latest = []
  for (const itemid of itemids) {
    const row = latestRowFromMeta(itemMap[String(itemid)], colorByItem)
    if (row) latest.push(row)
  }
  return latest
}

/** Latest rows for all matching items on a host (no Zabbix graph required). */
function buildLatestRowsFromHostItems(metas) {
  const latest = []
  for (const meta of metas || []) {
    const row = latestRowFromMeta(meta, {})
    if (row) latest.push(row)
  }
  latest.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
  return latest
}

async function graphGetDetail(graphids) {
  try {
    return await zabbixRpc('graph.get', {
      graphids,
      output: ['graphid', 'name', 'graphtype', 'width', 'height'],
      selectGraphItems: ['itemid', 'color', 'calc_fnc', 'sortorder', 'drawtype', 'yaxisside'],
    })
  } catch (e) {
    if (e.code !== 'ZABBIX_API_ERROR') throw e
    return zabbixRpc('graph.get', {
      graphids,
      output: 'extend',
    })
  }
}

async function graphItemsForGraph(graphId) {
  const graphs = await graphGetDetail([graphId])
  const g = (graphs || [])[0]
  if (!g) return { graph: null, gitems: [] }
  let gitems = graphItemRows(g)
  if (!gitems.length) {
    try {
      const rows = await zabbixRpc('graphitem.get', {
        graphids: [graphId],
        output: ['itemid', 'color', 'calc_fnc', 'sortorder', 'drawtype', 'yaxisside'],
      })
      gitems = rows || []
    } catch {
      /* older Zabbix may lack graphitem.get */
    }
  }
  return { graph: g, gitems }
}

/**
 * Monitored items with lastvalue for hosts that have no graphs (e.g. VMware integration).
 * GET /api/zabbix/hosts/:hostId/items/latest?limit=60
 */
router.get('/hosts/:hostId/items/latest', async (req, res) => {
  try {
    if (!isZabbixConfigured()) {
      return res.status(503).json({ error: 'Zabbix not configured' })
    }
    const hostId = String(req.params.hostId || '').trim()
    if (!hostId) return res.status(400).json({ error: 'hostId required' })

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '80'), 10) || 80, 1), 250)

    const rows = await zabbixRpc('item.get', {
      hostids: [hostId],
      monitored: true,
      filter: { status: 0 },
      output: ['itemid', 'name', 'key_', 'value_type', 'units', 'status', 'lastvalue', 'lastclock'],
      sortfield: 'name',
      limit,
    })

    const latest = buildLatestRowsFromHostItems(rows || [])
    res.json({
      hostid: hostId,
      latest,
      totalItems: (rows || []).length,
      withValue: latest.length,
      displayMode: 'latest',
      note:
        'Built from monitored item last values — no Zabbix graph on this host (typical for some VMware / discovery hosts).',
    })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

router.get('/hosts/:hostId/graphs', async (req, res) => {
  try {
    if (!isZabbixConfigured()) {
      return res.status(503).json({ error: 'Zabbix not configured' })
    }
    const hostId = String(req.params.hostId || '').trim()
    if (!hostId) return res.status(400).json({ error: 'hostId required' })

    const rows = await zabbixRpc('graph.get', {
      hostids: [hostId],
      output: ['graphid', 'name', 'graphtype', 'width', 'height'],
      sortfield: 'name',
    })
    const graphs = (rows || []).map((g) => ({
      graphid: g.graphid,
      name: g.name,
      graphtype: Number(g.graphtype),
      width: g.width,
      height: g.height,
      /** 0–2: drawable as time-series; 2–3 pie/exploded — UI shows placeholder */
      drawable: Number(g.graphtype) === 0 || Number(g.graphtype) === 1,
    }))
    res.json({ graphs })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

router.get('/graphs/:graphId/series', async (req, res) => {
  try {
    if (!isZabbixConfigured()) {
      return res.status(503).json({ error: 'Zabbix not configured' })
    }
    const graphId = String(req.params.graphId || '').trim()
    if (!graphId) return res.status(400).json({ error: 'graphId required' })

    const now = Math.floor(Date.now() / 1000)
    let to = parseInt(String(req.query.to || ''), 10)
    let from = parseInt(String(req.query.from || ''), 10)
    if (!Number.isFinite(to)) to = now
    if (!Number.isFinite(from)) from = to - 3600
    const maxSpan = 86400 * 365
    if (to < from) [from, to] = [to, from]
    if (to - from > maxSpan) from = to - maxSpan

    const { graph: g, gitems } = await graphItemsForGraph(graphId)
    if (!g) return res.status(404).json({ error: 'Graph not found' })

    const gt = Number(g.graphtype)

    const itemids = [...new Set(gitems.map(itemIdFromGraphItem).filter(Boolean))]
    if (!itemids.length) {
      return res.json({
        graph: { graphid: g.graphid, name: g.name, graphtype: gt },
        series: [],
        latest: [],
        displayMode: 'empty',
        from,
        to,
        message: 'No graph items / item IDs on this graph (check Zabbix template / discovery).',
      })
    }

    const items = await zabbixRpc('item.get', {
      itemids,
      output: ['itemid', 'name', 'key_', 'value_type', 'units', 'status', 'lastvalue', 'lastclock'],
    })
    const itemMap = Object.fromEntries((items || []).map((it) => [String(it.itemid), it]))
    const colorByItem = Object.fromEntries(
      gitems.map((gi) => {
        const id = itemIdFromGraphItem(gi)
        return id ? [id, normalizeHexColor(gi.color)] : null
      }).filter(Boolean),
    )

    const latestOnly =
      String(req.query.mode || '').toLowerCase() === 'latest' ||
      req.query.latest === '1' ||
      req.query.latest === 'true'

    const latestForPie = buildLatestRows(itemids, itemMap, colorByItem)
    if (gt === 2 || gt === 3) {
      return res.json({
        graph: { graphid: g.graphid, name: g.name, graphtype: gt },
        unsupported: latestForPie.length
          ? null
          : 'Pie or exploded graphs: no last values on items. Open in Zabbix.',
        series: [],
        latest: latestForPie,
        displayMode: latestForPie.length ? 'latest' : 'empty',
        skipped: [],
        from,
        to,
        aggregated: false,
        note: latestForPie.length
          ? 'Latest values per graph item (template pie/exploded shown as horizontal bars).'
          : undefined,
      })
    }

    if (latestOnly) {
      const latest = buildLatestRows(itemids, itemMap, colorByItem)
      return res.json({
        graph: { graphid: g.graphid, name: g.name, graphtype: gt },
        series: [],
        latest,
        displayMode: latest.length ? 'latest' : 'empty',
        skipped: [],
        from,
        to,
        aggregated: false,
        note: latest.length
          ? 'Latest values only (no history/trend queries). Use for VMware and similar integrations.'
          : 'No last values on graph items.',
      })
    }

    const span = to - from
    const useTrend = span > 2 * 86400
    const maxPoints = Math.min(Math.max(parseInt(String(req.query.maxPoints || '400'), 10) || 400, 50), 2000)

    const series = []
    const skipped = []
    let anySeriesUsedTrend = false
    for (const itemid of itemids) {
      const meta = itemMap[String(itemid)]
      if (!meta) {
        skipped.push({ itemid, reason: 'item.get returned no row (permissions or invalid id)' })
        continue
      }
      if (String(meta.status) !== '0') {
        skipped.push({ itemid, reason: 'item disabled in Zabbix' })
        continue
      }
      const hk = historyKind(meta.value_type)
      if (hk == null) {
        skipped.push({ itemid, reason: `value_type ${meta.value_type} not plottable (use float, uint, char, or text)` })
        continue
      }

      let points = []
      const wantTrend = useTrend && hk.trends
      if (wantTrend) {
        const tr = await zabbixRpc('trend.get', {
          itemids: [itemid],
          time_from: from,
          time_till: to,
          output: ['itemid', 'clock', 'value_avg'],
          sortfield: 'clock',
          sortorder: 'ASC',
          limit: 5000,
        })
        points = (tr || [])
          .map((row) => ({
            clock: Number(row.clock),
            value: Number(row.value_avg),
          }))
          .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
        if (points.length) anySeriesUsedTrend = true
      }
      if (!points.length) {
        const hist = await zabbixRpc('history.get', {
          history: hk.history,
          itemids: [itemid],
          time_from: from,
          time_till: to,
          output: ['clock', 'value'],
          sortfield: 'clock',
          sortorder: 'ASC',
          limit: 15000,
        })
        points = (hist || [])
          .map((row) => ({
            clock: Number(row.clock),
            value: hk.parse(row.value),
          }))
          .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
      }

      points = downsamplePoints(points, maxPoints)
      if (!points.length) {
        skipped.push({
          itemid,
          reason: wantTrend
            ? 'no trend or history in range (new host / short retention / non-numeric values)'
            : 'no history in range',
        })
        continue
      }
      series.push({
        itemid,
        name: meta.name || meta.key_ || itemid,
        key: meta.key_,
        units: meta.units || '',
        valueType: Number(meta.value_type),
        color: colorByItem[String(itemid)] || null,
        points,
      })
    }

    let latest = []
    let displayMode = series.length > 0 ? 'timeseries' : 'empty'
    let outSkipped = skipped
    if (series.length === 0) {
      latest = buildLatestRows(itemids, itemMap, colorByItem)
      if (latest.length > 0) {
        displayMode = 'latest'
        outSkipped = []
      }
    }

    res.json({
      graph: { graphid: g.graphid, name: g.name, graphtype: gt },
      series,
      latest,
      displayMode,
      skipped: outSkipped,
      from,
      to,
      aggregated: anySeriesUsedTrend,
      note:
        displayMode === 'latest' && series.length === 0
          ? 'No history in range; showing Zabbix last values (common for VMware-integrated hosts).'
          : undefined,
    })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

/**
 * GET /api/zabbix/items/:itemId/history?from=&to=&maxPoints=500
 * Fetch history (or trends for long ranges) for a single item.
 * Works for any item — VMware integration, Linux agents, SNMP, etc.
 */
router.get('/items/:itemId/history', async (req, res) => {
  try {
    if (!isZabbixConfigured()) return res.status(503).json({ error: 'Zabbix not configured' })
    const itemId = String(req.params.itemId || '').trim()
    if (!itemId) return res.status(400).json({ error: 'itemId required' })

    const now = Math.floor(Date.now() / 1000)
    const to = parseInt(String(req.query.to || now), 10) || now
    const from = parseInt(String(req.query.from || (now - 3600)), 10) || (now - 3600)
    const maxPoints = Math.min(Math.max(parseInt(String(req.query.maxPoints || '500'), 10) || 500, 50), 3000)

    const metaRows = await zabbixRpc('item.get', {
      itemids: [itemId],
      output: ['itemid', 'name', 'key_', 'value_type', 'units', 'status', 'lastvalue', 'lastclock'],
    })
    const meta = (metaRows || [])[0]
    if (!meta) return res.status(404).json({ error: 'Item not found or no permission' })

    const hk = historyKind(meta.value_type)
    if (!hk) return res.json({
      item: { itemid: meta.itemid, name: meta.name, key: meta.key_, units: meta.units || '', valueType: Number(meta.value_type) },
      points: [], displayMode: 'unsupported',
      note: `value_type ${meta.value_type} is not plottable`,
    })

    const span = to - from
    /**
     * Source priority:
     *   - Long span (> 2d): try trends first, then history.
     *   - Short span: try history first, then trends (trends are kept ~1 yr,
     *     history often only 24h-7d, so old short windows must fall back to trends).
     */
    const preferTrend = span > 2 * 86400 && hk.trends
    let points = []
    let usedSource = null

    async function fetchTrends() {
      if (!hk.trends) return []
      const tr = await zabbixRpc('trend.get', {
        itemids: [itemId], time_from: from, time_till: to,
        output: ['itemid', 'clock', 'value_avg', 'value_min', 'value_max'],
        sortfield: 'clock', sortorder: 'ASC', limit: 5000,
      })
      return (tr || []).map((r) => ({ clock: Number(r.clock), value: Number(r.value_avg) }))
        .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
    }

    async function fetchHistory() {
      const hist = await zabbixRpc('history.get', {
        history: hk.history, itemids: [itemId], time_from: from, time_till: to,
        output: ['clock', 'value'], sortfield: 'clock', sortorder: 'ASC', limit: 15000,
      })
      return (hist || []).map((r) => ({ clock: Number(r.clock), value: hk.parse(r.value) }))
        .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
    }

    if (preferTrend) {
      points = await fetchTrends()
      if (points.length) usedSource = 'trend'
      if (!points.length) {
        points = await fetchHistory()
        if (points.length) usedSource = 'history'
      }
    } else {
      points = await fetchHistory()
      if (points.length) usedSource = 'history'
      if (!points.length && hk.trends) {
        points = await fetchTrends()
        if (points.length) usedSource = 'trend'
      }
    }

    points = downsamplePoints(points, maxPoints)

    res.json({
      item: { itemid: meta.itemid, name: meta.name, key: meta.key_, units: meta.units || '', valueType: Number(meta.value_type) },
      points,
      from, to,
      aggregated: usedSource === 'trend',
      source: usedSource,
      displayMode: points.length > 0 ? 'timeseries' : 'empty',
      lastvalue: meta.lastvalue,
      lastclock: meta.lastclock,
      note: points.length === 0
        ? 'No history or trend data in this range. Item may not have been collected during this window, or retention has expired.'
        : undefined,
    })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

router.get('/problems', async (req, res) => {
  try {
    if (!isZabbixConfigured()) {
      return res.status(503).json({ error: 'Zabbix not configured' })
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '150'), 10) || 150, 1), 500)
    const sevRaw = req.query.severity
    const sevNum =
      sevRaw != null && String(sevRaw).trim() !== '' && !Number.isNaN(Number(sevRaw)) ? Number(sevRaw) : null
    const filter = sevNum != null && sevNum >= 0 && sevNum <= 5 ? { severity: sevNum } : undefined

    const groupF = String(req.query.group || '').trim()
    const qF = String(req.query.q || '').trim()
    let hostids
    if (groupF || qF) {
      let selectGroupsKey = 'selectGroups'
      try {
        await zabbixRpc('hostgroup.get', { output: ['groupid'], limit: 1 })
        selectGroupsKey = 'selectHostGroups'
      } catch { /* keep */ }
      const { rows: raw } = await fetchAllMonitoredHosts({
        output: ['hostid', 'host', 'name'],
        [selectGroupsKey]: ['groupid', 'name'],
      })
      const mapped = (raw || []).map((h) => ({
        ...h,
        groups: h.hostgroups || h.groups || [],
        hostgroups: h.hostgroups || h.groups || [],
      }))
      const filtered = filterOverviewHosts(mapped, groupF, qF)
      hostids = filtered.map((h) => String(h.hostid))
      if (!hostids.length) return res.json({ problems: [], totalReturned: 0 })
    }

    const rows = await problemGet({
      sortfield: ['eventid'],
      sortorder: 'DESC',
      limit,
      output: ['eventid', 'name', 'severity', 'clock', 'r_clock', 'objectid', 'acknowledged'],
      selectHosts: ['hostid', 'host', 'name'],
      ...(filter ? { filter } : {}),
      ...(hostids ? { hostids } : {}),
    })
    res.json({ problems: mapProblems(rows), totalReturned: (rows || []).length })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

/**
 * Acknowledge or manually close Zabbix problems (same as UI: event.acknowledge).
 * POST body: { eventids: string[], message?: string, acknowledge?: boolean (default true), close?: boolean }
 */
router.post('/problems/acknowledge', async (req, res) => {
  try {
    if (!isZabbixConfigured()) {
      return res.status(503).json({ error: 'Zabbix not configured' })
    }
    const rawIds = req.body?.eventids
    const ids = (Array.isArray(rawIds) ? rawIds : [rawIds])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 100)
    if (!ids.length) return res.status(400).json({ error: 'eventids required' })

    const message = String(req.body?.message || '').trim()
    const close = Boolean(req.body?.close)
    const doAck = req.body?.acknowledge !== false

    let action = 0
    if (close) action |= 1
    if (doAck) action |= 2
    if (message) action |= 4
    if (action === 0) action = 2

    const params = { eventids: ids, action }
    if (message) params.message = message

    await zabbixRpc('event.acknowledge', params)
    res.json({ ok: true, eventids: ids })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

router.get('/events', async (req, res) => {
  try {
    if (!isZabbixConfigured()) {
      return res.status(503).json({ error: 'Zabbix not configured' })
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '500'), 10) || 500, 1), 10000)

    const timeFrom = (() => {
      const raw = req.query.time_from
      if (raw != null && String(raw).trim()) {
        const n = parseInt(String(raw), 10)
        if (Number.isFinite(n) && n > 0) return n
      }
      return undefined
    })()

    const baseOutput = ['eventid', 'source', 'object', 'clock', 'name', 'severity', 'value', 'acknowledged', 'r_eventid']
    const baseParams = {
      output: baseOutput,
      sortfield: ['clock'],
      sortorder: 'DESC',
      limit,
      ...(timeFrom ? { time_from: timeFrom } : {}),
    }

    const attempts = [
      { ...baseParams, source: 0, object: 0, selectHosts: ['hostid', 'host', 'name'], selectAcknowledges: ['alias', 'message', 'clock'] },
      { ...baseParams, source: 0, object: 0, selectHosts: ['hostid', 'host', 'name'] },
      { ...baseParams, source: 0, selectHosts: ['hostid', 'host', 'name'] },
      { ...baseParams, selectHosts: ['hostid', 'host', 'name'] },
      { ...baseParams },
      { output: 'extend', sortfield: ['clock'], sortorder: 'DESC', limit, ...(timeFrom ? { time_from: timeFrom } : {}) },
    ]

    let rows = null
    let attemptUsed = -1
    for (let i = 0; i < attempts.length; i++) {
      try {
        rows = await zabbixRpc('event.get', attempts[i])
        attemptUsed = i
        break
      } catch (e) {
        if (e.code !== 'ZABBIX_API_ERROR') throw e
      }
    }
    if (rows == null) rows = []

    const events = (rows || []).map((ev) => ({
      eventid: ev.eventid,
      clock: ev.clock,
      name: ev.name || '',
      severity: ev.severity,
      severityLabel: SEVERITY_LABEL[ev.severity] || 'Unknown',
      source: ev.source,
      object: ev.object,
      value: ev.value,
      status: String(ev.value) === '1' ? 'PROBLEM' : 'RESOLVED',
      acknowledged: String(ev.acknowledged) === '1',
      rEventid: ev.r_eventid,
      hosts: (ev.hosts || []).map((h) => ({
        hostid: h.hostid,
        host: h.host,
        name: h.name,
      })),
      acks: (ev.acknowledges || []).slice(0, 3).map((a) => ({
        user: a.alias || a.username || '',
        message: a.message || '',
        clock: a.clock,
      })),
    }))
    res.json({ events, totalReturned: events.length, attemptUsed })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

/* ─────────────────────────────────────────────────────────────────────────────
 * Top utilization (CPU / Memory / Disk)
 * GET /api/zabbix/top-utilization?limit=10
 * Returns the top-N monitored hosts for each metric, sorted desc by % used.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Item key patterns for each metric. Order = priority (first match wins per host).
 * IMPORTANT: We additionally require the item's `units` to be `%` (or contain `%`)
 * so we never include items reporting Hz/bytes/MB and accidentally treat them as a percentage.
 */
const TOP_METRIC_KEYS = {
  cpu: [
    // Linux / Windows agent + SNMP — these report units `%`
    /^system\.cpu\.util(\b|\[)/i,
    /^system\.cpu\.utilization(\b|\[)/i,
    /^perf_counter\[.*Processor.*Time/i,
    // VMware — only `.perf` variants are %; raw `vmware.*.cpu.usage` is in Hz
    /^vmware\.vm\.cpu\.usage\.perf/i,
    /^vmware\.hv\.cpu\.usage\.perf/i,
    /^vmware\.vm\.cpu\.utilization/i,
    /^vmware\.hv\.cpu\.utilization/i,
  ],
  memory: [
    // Direct utilization (already %)
    /^vm\.memory\.utilization(\b|\[)/i,
    /^vm\.memory\.util(\b|\[)/i,
    /^vm\.memory\.size\[pused/i,
    /^vmware\.vm\.memory\.usage/i,
    /^vmware\.hv\.memory\.usage/i,
    /^vmware\.vm\.memory\.utilization/i,
    /^vmware\.hv\.memory\.utilization/i,
    // Inverted (free / available %)
    /^vm\.memory\.size\[pavailable/i,
  ],
  disk: [
    /^vfs\.fs\.size\[.*pused/i,
    /^vfs\.fs\.dependent\.size\[.*pused/i,
    // Inverted
    /^vfs\.fs\.size\[.*pfree/i,
    /^vfs\.fs\.dependent\.size\[.*pfree/i,
  ],
}

const INVERT_KEY_RE = /pavailable|pfree/i

/** Skip Zabbix infrastructure hosts from store/agent top-N lists. */
const SKIP_TOP_HOST_RE = /^zabbix server$/i

function isSkipTopHost(h) {
  const n = String(h?.name || h?.host || '').trim()
  return SKIP_TOP_HOST_RE.test(n)
}

const TOP_NETWORK_KEY_RES = {
  latency: /^custom\.ping\.ms(\b|\[)/i,
  packetLoss: /^custom\.ping\.loss(\b|\[)/i,
}

function pickBestNetworkItem(items, hostids) {
  const picked = {}
  for (const it of items) {
    const hid = String(it.hostid)
    if (!hostids.includes(hid)) continue
    const v = parseFloat(it.lastvalue)
    if (!Number.isFinite(v) || v < 0) continue
    const key = String(it.key_ || '')
    const clock = Number(it.lastclock) || 0
    const isExact = /\[8\.8\.8\.8\]/.test(key)
    const prev = picked[hid]
    if (!prev) { picked[hid] = { item: it, value: v, clock }; continue }
    const prevExact = /\[8\.8\.8\.8\]/.test(String(prev.item.key_ || ''))
    if (isExact && !prevExact) picked[hid] = { item: it, value: v, clock }
    else if (isExact === prevExact && clock >= (prev.clock || 0)) picked[hid] = { item: it, value: v, clock }
  }
  return picked
}

function topNetworkRows(metric, hostMap, itemRows, limit, { staleAfterSec = NET_HEALTH_STALE_DEFAULT_SEC, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const pattern = TOP_NETWORK_KEY_RES[metric]
  const filteredItems = (itemRows || []).filter((it) => pattern.test(String(it.key_ || '')))
  const hostids = Object.keys(hostMap)
  const picked = pickBestNetworkItem(filteredItems, hostids)
  const out = []
  for (const [hid, e] of Object.entries(picked)) {
    const h = hostMap[hid]
    if (!h || isSkipTopHost(h)) continue
    const clock = e.clock > 0 ? e.clock : null
    const stale = clock == null || (nowSec - clock) > staleAfterSec
    if (stale) continue
    out.push({
      hostid: hid,
      host: h.host,
      name: h.name,
      itemid: String(e.item.itemid),
      itemName: e.item.name || e.item.key_,
      key: e.item.key_,
      units: metric === 'latency' ? 'ms' : '%',
      value: Math.round(e.value * 10) / 10,
      percent: metric === 'packetLoss' ? Math.min(100, e.value) : e.value,
      lastclock: clock,
    })
  }
  out.sort((a, b) => b.value - a.value)
  const top = out.slice(0, limit)
  if (metric === 'latency' && top.length) {
    const maxVal = top[0].value || 1
    for (const r of top) r.percent = Math.round((r.value / maxVal) * 1000) / 10
  }
  return top
}

/** True if Zabbix item units indicate a percentage. */
function isPercentUnits(units) {
  if (units == null) return false
  const u = String(units).trim()
  return u === '%' || /(^|[^a-z])%([^a-z]|$)/i.test(u)
}

/** Resolve monitored hosts, optionally scoped to a Zabbix host group. */
async function resolveMonitoredHostsForGroup(groupFilter = '') {
  const gf = String(groupFilter || '').trim()
  let groupHostids = null
  const allGroupsRaw = await (async () => {
    try { return await zabbixRpc('hostgroup.get', { output: ['groupid', 'name'] }) } catch { return [] }
  })()
  const allGroups = (allGroupsRaw || []).sort((a, b) => a.name.localeCompare(b.name))

  if (gf) {
    const gobj = allGroups.find((g) => g.name === gf)
    if (gobj) {
      const hrows = await zabbixRpc('host.get', {
        groupids: [gobj.groupid], monitored_hosts: true,
        output: ['hostid'], limit: HOST_FETCH_MAX,
      })
      groupHostids = (hrows || []).map((h) => String(h.hostid))
    } else {
      groupHostids = []
    }
  }

  const { rows: hostRows } = await fetchAllMonitoredHosts({ output: ['hostid', 'host', 'name'] })
  const hosts = groupHostids
    ? hostRows.filter((h) => groupHostids.includes(String(h.hostid)))
    : hostRows

  const hostMap = {}
  for (const h of hosts) {
    if (isSkipTopHost(h)) continue
    hostMap[String(h.hostid)] = { hostid: String(h.hostid), host: h.host, name: h.name || h.host }
  }

  return {
    allGroups: allGroups.map((g) => g.name),
    groupFilter: gf || null,
    hostMap,
    hostids: Object.keys(hostMap),
  }
}

async function fetchUtilizationItems(hostids) {
  if (!hostids.length) return []
  const out = []
  const CHUNK = 400
  for (let i = 0; i < hostids.length; i += CHUNK) {
    const batch = await zabbixRpc('item.get', {
      hostids: hostids.slice(i, i + CHUNK),
      monitored: true,
      filter: { status: 0, value_type: [0, 3] },
      output: ['itemid', 'hostid', 'name', 'key_', 'value_type', 'units', 'lastvalue', 'lastclock'],
      limit: 5000,
    })
    out.push(...(batch || []))
  }
  return out
}

/** Convert lastvalue → number in 0..100, ASSUMING the item is already a percentage. */
function readPercent(it) {
  const v = parseLooseNumber(it.lastvalue)
  if (!Number.isFinite(v)) return null
  // Trust Zabbix: item is in `%`. Just clamp.
  if (v < 0) return 0
  if (v > 100) return 100
  return Math.round(v * 10) / 10
}

router.get('/top-utilization', async (req, res) => {
  try {
    if (!isZabbixConfigured()) {
      return res.status(503).json({ error: 'Zabbix not configured' })
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 50)
    const groupFilter = String(req.query.group || '').trim()
    const nowSec = Math.floor(Date.now() / 1000)
    const staleAfterSec = parseNetHealthStaleAfter(req.query)

    const { allGroups, groupFilter: resolvedGroup, hostMap, hostids } = await resolveMonitoredHostsForGroup(groupFilter)

    if (!hostids.length) {
      return res.json({
        allGroups,
        groupFilter: resolvedGroup,
        cpu: [], memory: [], disk: [], latency: [], packetLoss: [],
        summary: {
          monitoredHosts: 0, withCpu: 0, withMemory: 0, withDisk: 0, withLatency: 0, withPacketLoss: 0,
          cpuCritical: 0, cpuHigh: 0, memoryCritical: 0, memoryHigh: 0, diskCritical: 0, diskHigh: 0,
          latencyCritical: 0, latencyWarning: 0, packetLossIssues: 0, avgLatency: null,
        },
        distributions: {
          cpu: { total: 0, buckets: [] },
          memory: { total: 0, buckets: [] },
          disk: { total: 0, buckets: [] },
          latency: { total: 0, buckets: [] },
          packetLoss: { total: 0, buckets: [] },
        },
        limit, staleAfterSec, sampledAt: nowSec,
      })
    }

    const itemRows = await fetchUtilizationItems(hostids)

    function extractMount(key) {
      const m = key.match(/\[\s*([^,\]]+)/)
      return m ? m[1].replace(/^"|"$/g, '') : ''
    }

    /** Extract the mode argument of vfs.fs.size[mount,MODE] (or `dependent.size`). Returns lowercased mode or ''. */
    function extractFsMode(key) {
      const m = key.match(/\[[^,]*,\s*([^\]]+)\]/)
      return m ? m[1].trim().replace(/^"|"$/g, '').toLowerCase() : ''
    }

    /** Convert a Zabbix item lastvalue + units into bytes when possible. */
    function readBytes(it) {
      const v = parseLooseNumber(it.lastvalue)
      if (!Number.isFinite(v) || v < 0) return null
      const u = String(it.units || '').trim().toUpperCase()
      const mul = ({ B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 })[u]
      if (mul) return v * mul
      // Default to bytes when units is empty or unrecognized.
      return v
    }

    /**
     * Build per-host map of filesystem byte items keyed by `${mount}|${mode}`,
     * where mode ∈ { used, total, free }. Used to enrich disk rows with real space.
     */
    const fsByteIndex = {}
    for (const it of itemRows || []) {
      const key = String(it.key_ || '')
      if (!/^vfs\.fs(?:\.dependent)?\.size\[/i.test(key)) continue
      const mode = extractFsMode(key)
      if (!['used', 'total', 'free'].includes(mode)) continue
      // Only items that report bytes (units B/KB/MB/GB/TB/PB or empty).
      const u = String(it.units || '').trim().toUpperCase()
      if (u && !['B', 'KB', 'MB', 'GB', 'TB', 'PB'].includes(u)) continue
      const hostid = String(it.hostid)
      const mount = extractMount(key)
      if (!hostid || !mount) continue
      const k = `${hostid}|${mount}|${mode}`
      // Prefer items with a non-empty lastvalue.
      if (!fsByteIndex[k] || (it.lastvalue !== '' && it.lastvalue != null)) {
        fsByteIndex[k] = it
      }
    }

    function lookupFsBytes(hostid, mount, mode) {
      const it = fsByteIndex[`${hostid}|${mount}|${mode}`]
      return it ? readBytes(it) : null
    }

    /** For each metric, pick the best item per host (must report `%` units). */
    function pickPerHost(metric) {
      const patterns = TOP_METRIC_KEYS[metric]
      const perHost = {}
      for (const it of itemRows || []) {
        const key = String(it.key_ || '')
        const idx = patterns.findIndex((re) => re.test(key))
        if (idx === -1) continue
        // Strict: only accept items whose units = `%`. Avoids Hz / bytes mis-reads.
        if (!isPercentUnits(it.units)) continue
        const hostid = String(it.hostid)
        if (!hostMap[hostid]) continue
        if (isSkipTopHost(hostMap[hostid])) continue
        const pct = readPercent(it)
        if (pct == null) continue
        const inverted = INVERT_KEY_RE.test(key)
        const valuePct = inverted ? Math.max(0, Math.round((100 - pct) * 10) / 10) : pct

        if (metric === 'disk') {
          // Disk: keep the highest-utilized filesystem per host.
          const cur = perHost[hostid]
          if (!cur || valuePct > cur.valuePct) {
            perHost[hostid] = { item: it, patternIdx: idx, valuePct, mountKey: extractMount(key) }
          }
        } else {
          // CPU / Memory: prefer higher-priority pattern (lower idx).
          const cur = perHost[hostid]
          if (!cur || idx < cur.patternIdx) {
            perHost[hostid] = { item: it, patternIdx: idx, valuePct }
          }
        }
      }
      return perHost
    }

    function rowsFor(metric) {
      const perHost = pickPerHost(metric)
      const out = []
      for (const hid of Object.keys(perHost)) {
        const h = hostMap[hid]
        const e = perHost[hid]
        const row = {
          hostid: hid,
          host: h.host,
          name: h.name,
          itemid: String(e.item.itemid),
          itemName: e.item.name || e.item.key_,
          key: e.item.key_,
          units: '%',
          percent: e.valuePct,
          lastclock: e.item.lastclock != null && e.item.lastclock !== '' ? Number(e.item.lastclock) : null,
        }
        if (metric === 'disk') {
          row.mount = e.mountKey || ''
          // Try to enrich with real bytes from sibling fs items.
          const used = lookupFsBytes(hid, row.mount, 'used')
          const total = lookupFsBytes(hid, row.mount, 'total')
          const free = lookupFsBytes(hid, row.mount, 'free')
          let usedBytes = used
          let totalBytes = total
          if (usedBytes == null && total != null && free != null) usedBytes = Math.max(0, total - free)
          if (totalBytes == null && used != null && free != null) totalBytes = used + free
          if (usedBytes == null && totalBytes != null) usedBytes = totalBytes * (e.valuePct / 100)
          if (totalBytes == null && usedBytes != null && e.valuePct > 0) totalBytes = usedBytes / (e.valuePct / 100)
          if (usedBytes != null) row.usedBytes = Math.round(usedBytes)
          if (totalBytes != null) row.totalBytes = Math.round(totalBytes)
          if (free != null) row.freeBytes = Math.round(free)
        }
        out.push(row)
      }
      out.sort((a, b) => b.percent - a.percent)
      return out.slice(0, limit)
    }

    function countInRange(perHost, min, max) {
      let n = 0
      for (const hid of Object.keys(perHost)) {
        const v = perHost[hid].valuePct
        if (v >= min && v < max) n++
      }
      return n
    }

    function countAtLeast(perHost, threshold) {
      let n = 0
      for (const hid of Object.keys(perHost)) {
        if (perHost[hid].valuePct >= threshold) n++
      }
      return n
    }

    function buildPctDistribution(perHost, buckets) {
      const out = buckets.map((b) => ({ label: b.label, color: b.color, count: 0 }))
      let total = 0
      for (const hid of Object.keys(perHost)) {
        total++
        const v = perHost[hid].valuePct
        for (let i = 0; i < buckets.length; i++) {
          if (v >= buckets[i].min && v < buckets[i].max) { out[i].count++; break }
        }
      }
      return { total, buckets: out }
    }

    const cpuPerHost = pickPerHost('cpu')
    const memPerHost = pickPerHost('memory')
    const diskPerHost = pickPerHost('disk')

    const latPicked = pickBestNetworkItem(
      (itemRows || []).filter((it) => TOP_NETWORK_KEY_RES.latency.test(String(it.key_ || ''))),
      Object.keys(hostMap),
    )
    const lossPicked = pickBestNetworkItem(
      (itemRows || []).filter((it) => TOP_NETWORK_KEY_RES.packetLoss.test(String(it.key_ || ''))),
      Object.keys(hostMap),
    )

    const latBuckets = [
      { label: 'Good (<50 ms)', color: '#22c55e', count: 0 },
      { label: 'Warning (50–150 ms)', color: '#f59e0b', count: 0 },
      { label: 'Critical (>150 ms)', color: '#ef4444', count: 0 },
    ]
    const lossBuckets = [
      { label: '0% Perfect', color: '#22c55e', count: 0 },
      { label: '<5% Warning', color: '#f59e0b', count: 0 },
      { label: '5–99% Critical', color: '#f97316', count: 0 },
      { label: '100% Dead', color: '#ef4444', count: 0 },
    ]
    let latencyHosts = 0
    let lossHosts = 0
    let avgLatency = null
    const latVals = []

    for (const hid of Object.keys(hostMap)) {
      if (isSkipTopHost(hostMap[hid])) continue
      const le = latPicked[hid]
      if (le) {
        const clock = le.clock > 0 ? le.clock : null
        const stale = clock == null || (nowSec - clock) > staleAfterSec
        if (!stale) {
          latencyHosts++
          latVals.push(le.value)
          if (le.value < 50) latBuckets[0].count++
          else if (le.value < 150) latBuckets[1].count++
          else latBuckets[2].count++
        }
      }
      const lo = lossPicked[hid]
      if (lo) {
        const clock = lo.clock > 0 ? lo.clock : null
        const stale = clock == null || (nowSec - clock) > staleAfterSec
        if (!stale) {
          lossHosts++
          const v = lo.value
          if (v === 0) lossBuckets[0].count++
          else if (v < 5) lossBuckets[1].count++
          else if (v < 100) lossBuckets[2].count++
          else lossBuckets[3].count++
        }
      }
    }
    if (latVals.length) avgLatency = Math.round(latVals.reduce((a, b) => a + b, 0) / latVals.length * 10) / 10

    const pctBucketsStd = [
      { label: 'Normal (0–50%)', min: 0, max: 50, color: '#22c55e' },
      { label: 'Elevated (50–75%)', min: 50, max: 75, color: '#eab308' },
      { label: 'High (75–90%)', min: 75, max: 90, color: '#f59e0b' },
      { label: 'Critical (90%+)', min: 90, max: 101, color: '#ef4444' },
    ]

    const monitoredHosts = Object.keys(hostMap).filter((h) => !isSkipTopHost(hostMap[h])).length
    const summary = {
      monitoredHosts,
      withCpu: Object.keys(cpuPerHost).length,
      withMemory: Object.keys(memPerHost).length,
      withDisk: Object.keys(diskPerHost).length,
      withLatency: latencyHosts,
      withPacketLoss: lossHosts,
      cpuCritical: countAtLeast(cpuPerHost, 90),
      cpuHigh: countInRange(cpuPerHost, 75, 90),
      memoryCritical: countAtLeast(memPerHost, 90),
      memoryHigh: countInRange(memPerHost, 75, 90),
      diskCritical: countAtLeast(diskPerHost, 90),
      diskHigh: countInRange(diskPerHost, 75, 90),
      latencyCritical: latBuckets[2].count,
      latencyWarning: latBuckets[1].count,
      packetLossIssues: lossBuckets[1].count + lossBuckets[2].count + lossBuckets[3].count,
      avgLatency,
    }

    const distributions = {
      cpu: buildPctDistribution(cpuPerHost, pctBucketsStd),
      memory: buildPctDistribution(memPerHost, pctBucketsStd),
      disk: buildPctDistribution(diskPerHost, pctBucketsStd),
      latency: { total: latencyHosts, buckets: latBuckets },
      packetLoss: { total: lossHosts, buckets: lossBuckets },
    }

    res.json({
      allGroups,
      groupFilter: resolvedGroup,
      cpu: rowsFor('cpu'),
      memory: rowsFor('memory'),
      disk: rowsFor('disk'),
      latency: topNetworkRows('latency', hostMap, itemRows, limit, { staleAfterSec, nowSec }),
      packetLoss: topNetworkRows('packetLoss', hostMap, itemRows, limit, { staleAfterSec, nowSec }),
      summary,
      distributions,
      limit,
      staleAfterSec,
      sampledAt: nowSec,
    })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

/**
 * Custom top-N widget by Zabbix item key pattern.
 * GET /api/zabbix/top-items?key=custom.ping.ms*&limit=10&sort=desc
 */
router.get('/top-items', async (req, res) => {
  try {
    if (!isZabbixConfigured()) return res.status(503).json({ error: 'Zabbix not configured' })

    const keyPattern = String(req.query.key || req.query.keyPattern || '').trim()
    if (!keyPattern) return res.status(400).json({ error: 'key query parameter is required (e.g. custom.ping.ms*)' })

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 50)
    const sort = String(req.query.sort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'
    const staleAfterSec = parseNetHealthStaleAfter(req.query)
    const nowSec = Math.floor(Date.now() / 1000)
    const groupFilter = String(req.query.group || '').trim()
    const searchKey = keyPattern.endsWith('*') ? keyPattern : `${keyPattern}*`

    const { allGroups, groupFilter: resolvedGroup, hostMap, hostids } = await resolveMonitoredHostsForGroup(groupFilter)
    if (!hostids.length) {
      return res.json({ rows: [], key: searchKey, limit, sort, staleAfterSec, allGroups, groupFilter: resolvedGroup, sampledAt: nowSec })
    }

    const items = []
    const HOST_CHUNK = 400
    for (let i = 0; i < hostids.length; i += HOST_CHUNK) {
      const batch = await zabbixRpc('item.get', {
        hostids: hostids.slice(i, i + HOST_CHUNK),
        monitored: true,
        filter: { status: 0 },
        output: ['itemid', 'hostid', 'name', 'key_', 'units', 'lastvalue', 'lastclock'],
        search: { key_: searchKey },
        searchWildcardsEnabled: true,
        limit: 5000,
      })
      items.push(...(batch || []))
    }

    const picked = pickBestNetworkItem(items, hostids)
    const out = []
    for (const [hid, e] of Object.entries(picked)) {
      const h = hostMap[hid]
      if (!h) continue
      const clock = e.clock > 0 ? e.clock : null
      const stale = clock == null || (nowSec - clock) > staleAfterSec
      if (stale) continue
      const units = String(e.item.units || '').trim()
      const isPct = units === '%' || /%/.test(units)
      out.push({
        hostid: hid,
        host: h.host,
        name: h.name,
        itemid: String(e.item.itemid),
        itemName: e.item.name || e.item.key_,
        key: e.item.key_,
        units: units || '',
        value: Math.round(e.value * 10) / 10,
        percent: isPct ? Math.min(100, Math.max(0, e.value)) : e.value,
        lastclock: clock,
      })
    }

    out.sort((a, b) => sort === 'asc' ? a.value - b.value : b.value - a.value)
    const top = out.slice(0, limit)
    if (top.length && !top.every((r) => String(r.units).includes('%'))) {
      const maxVal = Math.max(...top.map((r) => r.value), 1)
      for (const r of top) {
        if (!String(r.units).includes('%')) r.percent = Math.round((r.value / maxVal) * 1000) / 10
      }
    }

    res.json({ rows: top, key: searchKey, limit, sort, staleAfterSec, allGroups, groupFilter: resolvedGroup, sampledAt: nowSec })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

/* ═══════════ NETWORK HEALTH ═══════════ */
router.get('/network-health', async (req, res) => {
  try {
    if (!isZabbixConfigured()) return res.status(503).json({ error: 'Zabbix not configured' })

    const groupFilter = String(req.query.group || '').trim()
    const bizStart   = parseInt(req.query.bizStart || '9',  10) || 9
    const bizEnd     = parseInt(req.query.bizEnd   || '18', 10) || 18
    const staleAfterSec = parseNetHealthStaleAfter(req.query)
    const nowSec = Math.floor(Date.now() / 1000)

    /* ── resolve host group → hostids ── */
    let groupHostids = null
    const allGroupsRaw = await (async () => {
      try { return await zabbixRpc('hostgroup.get', { output: ['groupid', 'name'] }) } catch { return [] }
    })()
    const allGroups = (allGroupsRaw || []).sort((a, b) => a.name.localeCompare(b.name))

    if (groupFilter) {
      const gobj = allGroups.find((g) => g.name === groupFilter)
      if (gobj) {
        const hrows = await zabbixRpc('host.get', {
          groupids: [gobj.groupid], monitored_hosts: true,
          output: ['hostid'], limit: HOST_FETCH_MAX,
        })
        groupHostids = (hrows || []).map((h) => String(h.hostid))
      } else {
        groupHostids = []
      }
    }

    /* ── fetch monitored hosts with availability ── */
    const { rows: hostRows } = await fetchAllMonitoredHosts({
      output: ['hostid', 'host', 'name', 'status', 'available', 'active_available'],
      selectInterfaces: ['interfaceid', 'available', 'type', 'main'],
    })
    const hosts = groupHostids
      ? hostRows.filter((h) => groupHostids.includes(String(h.hostid)))
      : hostRows

    const hostids = hosts.map((h) => String(h.hostid))
    const hostMap = {}
    for (const h of hosts) hostMap[String(h.hostid)] = h

    if (!hostids.length) {
      return res.json({
        allGroups: allGroups.map((g) => g.name),
        groupFilter: groupFilter || null,
        bizStart, bizEnd,
        totals: { total: 0, online: 0, offline: 0, unknown: 0 },
        connectivity: { wifi: 0, lan: 0, both: 0, unknown: 0 },
        ping: { reachable: 0, unreachable: 0, noData: 0, stale: 0 },
        packetLoss: { p0: 0, p1: 0, p5: 0, p100: 0, noData: 0, stale: 0 },
        pingMs: { avg: null, max: null, p95: null, count: 0, good: 0, warn: 0, critical: 0, noData: 0, stale: 0 },
        freshness: { staleAfterSec, queriedAt: nowSec, packetLoss: { fresh: 0, stale: 0, noData: 0, oldestPoll: null, newestPoll: null }, latency: { fresh: 0, stale: 0, noData: 0, oldestPoll: null, newestPoll: null }, agentPing: { fresh: 0, stale: 0, noData: 0, oldestPoll: null, newestPoll: null } },
        uptime: { avg: null, median: null, min: null, max: null, count: 0, distribution: [] },
        bizHours: { online: 0, offline: 0, noData: 0, totalHosts: 0, inBizHours: false },
        worstHosts: [],
        sampledAt: Math.floor(Date.now() / 1000),
      })
    }

    /* ── fetch items in batches ── */
    async function fetchItemsChunked(hids, searchKey, searchName = null, { hostChunk = 400, pageLimit = 5000 } = {}) {
      const out = []
      for (let i = 0; i < hids.length; i += hostChunk) {
        const chunkHids = hids.slice(i, i + hostChunk)
        const searchObj = searchName
          ? { name: searchName + '*' }
          : { key_: searchKey + '*' }
        const batch = await zabbixRpc('item.get', {
          hostids: chunkHids,
          output: ['itemid', 'hostid', 'name', 'key_', 'lastvalue', 'units', 'lastclock'],
          search: searchObj,
          searchWildcardsEnabled: true,
          limit: pageLimit,
        })
        out.push(...(batch || []))
      }
      return out
    }

    /** One value + lastclock per host — prefer exact 8.8.8.8 key, then newest lastclock. */
    function buildHostMetricMap(items, hostids) {
      const picked = {}
      for (const it of items) {
        const hid = String(it.hostid)
        const v = parseFloat(it.lastvalue)
        if (!Number.isFinite(v)) continue
        const key = String(it.key_ || '')
        const clock = Number(it.lastclock) || 0
        const prevKey = picked[hid]?.key ?? ''
        const isExact = /\[8\.8\.8\.8\]/.test(key)
        const prevIsExact = /\[8\.8\.8\.8\]/.test(prevKey)
        const prevClock = picked[hid]?.clock ?? -1
        const take =
          picked[hid] == null
          || (isExact && !prevIsExact)
          || (isExact === prevIsExact && clock >= prevClock)
        if (take) picked[hid] = { value: v, key, clock }
      }
      const valueByHost = {}
      const clockByHost = {}
      for (const hid of hostids) {
        valueByHost[hid] = picked[hid]?.value ?? null
        clockByHost[hid] = picked[hid]?.clock > 0 ? picked[hid].clock : null
      }
      return { valueByHost, clockByHost }
    }

    function isMetricStale(clock) {
      if (clock == null || clock <= 0) return true
      return (nowSec - clock) > staleAfterSec
    }

    function classifyMetrics(valueByHost, clockByHost, hostids) {
      const fresh = {}
      const staleFlags = {}
      let freshN = 0
      let staleN = 0
      let noDataN = 0
      for (const hid of hostids) {
        const v = valueByHost[hid]
        const clock = clockByHost[hid]
        if (v == null) {
          fresh[hid] = null
          staleFlags[hid] = false
          noDataN++
        } else if (isMetricStale(clock)) {
          fresh[hid] = null
          staleFlags[hid] = true
          staleN++
        } else {
          fresh[hid] = v
          staleFlags[hid] = false
          freshN++
        }
      }
      return { fresh, staleFlags, freshN, staleN, noDataN, ...pollAgeBounds(hostids.map((hid) => clockByHost[hid])) }
    }

    const [agentPingItems, pingLossItems, pingMsItems, uptimeItems, netIfInItems, netIfOutItems] = await Promise.all([
      fetchItemsChunked(hostids, 'agent.ping', null, { hostChunk: 400, pageLimit: 500 }),
      fetchItemsChunked(hostids, 'custom.ping.loss', null, { hostChunk: 400, pageLimit: 500 }),
      fetchItemsChunked(hostids, 'custom.ping.ms', null, { hostChunk: 400, pageLimit: 500 }),
      fetchItemsChunked(hostids, 'system.uptime', null, { hostChunk: 400, pageLimit: 500 }),
      fetchItemsChunked(hostids, 'net.if.in', null, { hostChunk: 120, pageLimit: 5000 }),
      fetchItemsChunked(hostids, 'net.if.out', null, { hostChunk: 120, pageLimit: 5000 }),
    ])
    const netIfItems = [...netIfInItems, ...netIfOutItems]

    /* ── availability totals ── */
    const totals = { total: hosts.length, online: 0, offline: 0, unknown: 0 }
    for (const h of hosts) {
      const a = deriveHostAvail(h)
      if (a === '1') totals.online++
      else if (a === '2') totals.offline++
      else totals.unknown++
    }

    /* ── connectivity: WiFi vs LAN based on ACTIVE TRAFFIC on each adapter ──
     * WiFi   = net.if item name matches Wi-Fi/wireless AND lastvalue > 0
     * LAN    = net.if item name matches Ethernet AND lastvalue > 0
     * Bluetooth, VPN, TAP, virtual adapters are excluded.
     */
    const SKIP_IFACE_RE = /bluetooth|vpn\s*(connect|dco|data)|tap-windows|tunnel|virtual|loopback|teredo|isatap|6to4|pseudo|miniport/i
    const WIFI_IFACE_RE = /wi-fi|wifi|wireless|802\.11/i
    const ETH_IFACE_RE  = /ethernet|realtek pcie|gbe|local area connection\b/i
    const hostConnType = {}
    for (const it of netIfItems) {
      const n = String(it.name || '')
      const hid = String(it.hostid)
      if (SKIP_IFACE_RE.test(n)) continue
      if (!hostConnType[hid]) hostConnType[hid] = { wifi: false, eth: false }
      const clock = Number(it.lastclock) || 0
      const fresh = clock > 0 && (nowSec - clock) <= staleAfterSec
      const hasTraffic = fresh && Number(it.lastvalue) > 0
      if (hasTraffic && WIFI_IFACE_RE.test(n)) hostConnType[hid].wifi = true
      if (hasTraffic && ETH_IFACE_RE.test(n))  hostConnType[hid].eth  = true
    }
    const connectivity = { wifi: 0, lan: 0, both: 0, unknown: 0 }
    for (const hid of hostids) {
      const ct = hostConnType[hid]
      if (!ct)                    connectivity.unknown++
      else if (ct.wifi && ct.eth) connectivity.both++
      else if (ct.wifi)           connectivity.wifi++
      else if (ct.eth)            connectivity.lan++
      else                        connectivity.unknown++
    }

    /* ── agent.ping reachability (fresh polls only) ── */
    const { valueByHost: agentPingRaw, clockByHost: agentPingClock } = buildHostMetricMap(agentPingItems, hostids)
    const agentPingCls = classifyMetrics(agentPingRaw, agentPingClock, hostids)
    const ping = { reachable: 0, unreachable: 0, noData: 0, stale: 0 }
    for (const hid of hostids) {
      if (agentPingCls.staleFlags[hid]) { ping.stale++; continue }
      const v = agentPingCls.fresh[hid]
      if (v == null)    ping.noData++
      else if (v === 1) ping.reachable++
      else              ping.unreachable++
    }

    /* ── packet loss (ignore stale lastvalue — host may be down since last poll) ── */
    const { valueByHost: lossRaw, clockByHost: lossClock } = buildHostMetricMap(pingLossItems, hostids)
    const lossCls = classifyMetrics(lossRaw, lossClock, hostids)
    const pktLoss = { p0: 0, p1: 0, p5: 0, p100: 0, noData: 0, stale: 0 }
    for (const hid of hostids) {
      if (lossCls.staleFlags[hid]) { pktLoss.stale++; continue }
      const v = lossCls.fresh[hid]
      if (v == null)    pktLoss.noData++
      else if (v === 0)  pktLoss.p0++
      else if (v < 5)    pktLoss.p1++
      else if (v < 100)  pktLoss.p5++
      else               pktLoss.p100++
    }

    /* ── ping response time (fresh polls only) ── */
    const { valueByHost: msRaw, clockByHost: msClock } = buildHostMetricMap(pingMsItems, hostids)
    const msCls = classifyMetrics(msRaw, msClock, hostids)
    const msVals = hostids
      .map((hid) => msCls.fresh[hid])
      .filter((v) => v != null && v >= 0)
      .sort((a, b) => a - b)
    const msDist = { good: 0, warn: 0, critical: 0, noData: 0, stale: 0 }
    for (const hid of hostids) {
      if (msCls.staleFlags[hid]) { msDist.stale++; continue }
      const v = msCls.fresh[hid]
      if (v == null)       msDist.noData++
      else if (v < 50)     msDist.good++
      else if (v < 150)    msDist.warn++
      else                 msDist.critical++
    }
    const pingMs = {
      avg:   msVals.length ? Math.round(msVals.reduce((a, b) => a + b, 0) / msVals.length * 10) / 10 : null,
      max:   msVals.length ? msVals[msVals.length - 1] : null,
      p95:   msVals.length ? msVals[Math.floor(msVals.length * 0.95)] ?? msVals[msVals.length - 1] : null,
      count: msVals.length,
      ...msDist,
    }

    const freshness = {
      staleAfterSec,
      queriedAt: nowSec,
      packetLoss: {
        fresh: lossCls.freshN,
        stale: lossCls.staleN,
        noData: lossCls.noDataN,
        oldestPoll: lossCls.oldestPoll,
        newestPoll: lossCls.newestPoll,
      },
      latency: {
        fresh: msCls.freshN,
        stale: msCls.staleN,
        noData: msCls.noDataN,
        oldestPoll: msCls.oldestPoll,
        newestPoll: msCls.newestPoll,
      },
      agentPing: {
        fresh: agentPingCls.freshN,
        stale: agentPingCls.staleN,
        noData: agentPingCls.noDataN,
        oldestPoll: agentPingCls.oldestPoll,
        newestPoll: agentPingCls.newestPoll,
      },
    }

    /* ── uptime ── */
    const uptimeByHost = {}
    for (const it of uptimeItems) {
      const v = Number(it.lastvalue)
      if (Number.isFinite(v) && v > 0) uptimeByHost[String(it.hostid)] = v
    }
    const upVals = Object.values(uptimeByHost).sort((a, b) => a - b)
    function fmtUpBucket(v) {
      if (v < 3600)           return '< 1 h'
      if (v < 86400)          return '1 – 24 h'
      if (v < 7 * 86400)      return '1 – 7 d'
      if (v < 30 * 86400)     return '7 – 30 d'
      return '> 30 d'
    }
    const uptime = {
      avg:    upVals.length ? Math.round(upVals.reduce((a, b) => a + b, 0) / upVals.length) : null,
      median: upVals.length ? upVals[Math.floor(upVals.length / 2)] : null,
      min:    upVals.length ? upVals[0] : null,
      max:    upVals.length ? upVals[upVals.length - 1] : null,
      count:  upVals.length,
      distribution: [
        { label: '< 1 h',    count: upVals.filter((v) => v < 3600).length },
        { label: '1 – 24 h', count: upVals.filter((v) => v >= 3600 && v < 86400).length },
        { label: '1 – 7 d',  count: upVals.filter((v) => v >= 86400 && v < 7 * 86400).length },
        { label: '7 – 30 d', count: upVals.filter((v) => v >= 7 * 86400 && v < 30 * 86400).length },
        { label: '> 30 d',   count: upVals.filter((v) => v >= 30 * 86400).length },
      ],
    }

    /* ── business hours ── */
    const nowHour = new Date().getHours()
    const inBizHours = nowHour >= bizStart && nowHour < bizEnd
    const bizHours = { online: 0, offline: 0, noData: 0, stale: 0, totalHosts: hostids.length, inBizHours, nowHour, bizStart, bizEnd }
    for (const hid of hostids) {
      if (agentPingCls.staleFlags[hid]) { bizHours.stale++; continue }
      const v = agentPingCls.fresh[hid]
      if (v == null)    bizHours.noData++
      else if (v === 1) bizHours.online++
      else              bizHours.offline++
    }

    /* ── worst hosts ── */
    const worstHosts = hosts
      .map((h) => {
        const hid = String(h.hostid)
        const avail  = deriveHostAvail(h)
        const agPing = agentPingCls.staleFlags[hid] ? null : agentPingCls.fresh[hid]
        const agStale = agentPingCls.staleFlags[hid]
        const loss   = lossCls.staleFlags[hid] ? null : lossCls.fresh[hid]
        const lossStale = lossCls.staleFlags[hid]
        const ms     = msCls.staleFlags[hid] ? null : msCls.fresh[hid]
        const msStale = msCls.staleFlags[hid]
        const up     = uptimeByHost[hid] ?? null
        const ct     = hostConnType[hid]
        const staleScore = (agStale ? 40 : 0) + (lossStale ? 30 : 0) + (msStale ? 20 : 0)
        const score  = staleScore + (avail === '2' ? 100 : 0) + (agPing === 0 ? 50 : 0) + (loss ?? 0)
        return {
          hostid: hid, name: h.name || h.host, score,
          availability: avail === '1' ? 'Available' : avail === '2' ? 'Unavailable' : 'Unknown',
          agentPing: agPing ?? null, agentPingStale: agStale, agentPingPoll: agentPingClock[hid],
          packetLoss: loss, packetLossStale: lossStale, packetLossPoll: lossClock[hid],
          pingMs: ms, pingMsStale: msStale, pingMsPoll: msClock[hid],
          uptime: up,
          connType: !ct ? 'Unknown' : (ct.wifi && ct.eth) ? 'Both' : ct.wifi ? 'Wi-Fi' : ct.eth ? 'LAN' : 'Unknown',
        }
      })
      .filter((h) => h.score > 0 || h.availability === 'Unavailable')
      .sort((a, b) => b.score - a.score)
      .slice(0, 100)

    res.json({
      allGroups: allGroups.map((g) => g.name),
      groupFilter: groupFilter || null,
      bizStart, bizEnd,
      totals, connectivity, ping,
      packetLoss: pktLoss,
      pingMs, uptime, bizHours, worstHosts, freshness,
      sampledAt: nowSec,
    })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

/* ═══════════ ROP DASHBOARD ═══════════
 * Per-host uptime / downtime view for any host group (defaults to "RP").
 * Returns every monitored host in the group (no worst-N cap), with live
 * availability + ping + system.uptime so the dashboard can render a full
 * sortable table of all ROP systems.
 */
router.get('/rop-dashboard', async (req, res) => {
  try {
    if (!isZabbixConfigured()) return res.status(503).json({ error: 'Zabbix not configured' })

    const groupFilter = String(req.query.group || 'RP').trim() || 'RP'
    const staleAfterSec = parseNetHealthStaleAfter(req.query)
    const nowSec = Math.floor(Date.now() / 1000)

    const allGroupsRaw = await (async () => {
      try { return await zabbixRpc('hostgroup.get', { output: ['groupid', 'name'] }) } catch { return [] }
    })()
    const allGroups = (allGroupsRaw || []).sort((a, b) => a.name.localeCompare(b.name))
    const gobj = allGroups.find((g) => g.name === groupFilter)

    if (!gobj) {
      return res.json({
        allGroups: allGroups.map((g) => g.name),
        groupFilter,
        groupExists: false,
        totals: { total: 0, online: 0, offline: 0, unknown: 0 },
        uptime: { avg: null, median: null, min: null, max: null, count: 0, distribution: [] },
        rows: [],
        sampledAt: nowSec,
        staleAfterSec,
      })
    }

    const rawHosts = await zabbixRpc('host.get', {
      groupids: [gobj.groupid],
      monitored_hosts: true,
      output: ['hostid', 'host', 'name', 'status', 'available', 'active_available'],
      selectInterfaces: ['interfaceid', 'available', 'type', 'ip', 'dns', 'main'],
      sortfield: 'name',
      limit: HOST_FETCH_MAX,
    })
    const hosts = rawHosts || []
    const hostids = hosts.map((h) => String(h.hostid))

    if (!hostids.length) {
      return res.json({
        allGroups: allGroups.map((g) => g.name),
        groupFilter,
        groupExists: true,
        totals: { total: 0, online: 0, offline: 0, unknown: 0 },
        uptime: { avg: null, median: null, min: null, max: null, count: 0, distribution: [] },
        rows: [],
        sampledAt: nowSec,
        staleAfterSec,
      })
    }

    async function fetchItemsChunked(hids, searchKey, { hostChunk = 400, pageLimit = 500 } = {}) {
      const out = []
      for (let i = 0; i < hids.length; i += hostChunk) {
        const chunkHids = hids.slice(i, i + hostChunk)
        const batch = await zabbixRpc('item.get', {
          hostids: chunkHids,
          output: ['itemid', 'hostid', 'name', 'key_', 'lastvalue', 'units', 'lastclock'],
          search: { key_: searchKey + '*' },
          searchWildcardsEnabled: true,
          limit: pageLimit,
        })
        out.push(...(batch || []))
      }
      return out
    }

    function pickPerHost(items, preferExactKey = null) {
      const picked = {}
      for (const it of items) {
        const hid = String(it.hostid)
        const v = parseFloat(it.lastvalue)
        if (!Number.isFinite(v)) continue
        const clock = Number(it.lastclock) || 0
        const key = String(it.key_ || '')
        const prev = picked[hid]
        const isExact = preferExactKey ? key.includes(preferExactKey) : false
        const prevIsExact = prev ? (preferExactKey ? String(prev.key).includes(preferExactKey) : false) : false
        const take = !prev || (isExact && !prevIsExact) || (isExact === prevIsExact && clock >= (prev.clock || -1))
        if (take) picked[hid] = { value: v, clock, key }
      }
      return picked
    }

    const [agentPingItems, pingLossItems, pingMsItems, uptimeItems] = await Promise.all([
      fetchItemsChunked(hostids, 'agent.ping'),
      fetchItemsChunked(hostids, 'custom.ping.loss'),
      fetchItemsChunked(hostids, 'custom.ping.ms'),
      fetchItemsChunked(hostids, 'system.uptime'),
    ])

    const agentPingMap = pickPerHost(agentPingItems)
    const pingLossMap  = pickPerHost(pingLossItems, '8.8.8.8')
    const pingMsMap    = pickPerHost(pingMsItems, '8.8.8.8')
    const uptimeMap    = pickPerHost(uptimeItems)

    const totals = { total: hosts.length, online: 0, offline: 0, unknown: 0 }
    const uptimeVals = []

    const rows = hosts.map((h) => {
      const hid = String(h.hostid)
      const ifaces = Array.isArray(h.interfaces) ? h.interfaces : []
      const primary = ifaces.find((i) => String(i.main) === '1') || ifaces[0]
      const ip = primary?.ip || primary?.dns || ''
      const availCode = deriveHostAvail(h)
      const availability = availLabel(availCode)
      if (availCode === '1') totals.online++
      else if (availCode === '2') totals.offline++
      else totals.unknown++

      const apEntry = agentPingMap[hid]
      const apStale = !apEntry || (nowSec - apEntry.clock) > staleAfterSec
      const agentPing = apStale ? null : apEntry.value

      const lossEntry = pingLossMap[hid]
      const lossStale = !lossEntry || (nowSec - lossEntry.clock) > staleAfterSec
      const packetLoss = lossStale ? null : lossEntry.value

      const msEntry = pingMsMap[hid]
      const msStale = !msEntry || (nowSec - msEntry.clock) > staleAfterSec
      const pingMs = msStale ? null : msEntry.value

      const upEntry = uptimeMap[hid]
      const uptime = upEntry && Number.isFinite(upEntry.value) && upEntry.value > 0 ? upEntry.value : null
      if (uptime != null) uptimeVals.push(uptime)

      let downSince = null
      if (availCode === '2' && uptime == null && upEntry?.clock > 0) {
        downSince = upEntry.clock
      }

      return {
        hostid: hid,
        name: h.name || h.host,
        host: h.host,
        ip,
        availability,
        availabilityCode: availCode,
        agentPing,
        agentPingStale: apStale,
        agentPingPoll: apEntry?.clock || null,
        packetLoss,
        packetLossStale: lossStale,
        packetLossPoll: lossEntry?.clock || null,
        pingMs,
        pingMsStale: msStale,
        pingMsPoll: msEntry?.clock || null,
        uptime,
        uptimePoll: upEntry?.clock || null,
        downSince,
      }
    })

    const sortedUp = [...uptimeVals].sort((a, b) => a - b)
    const uptimeSummary = {
      avg:    sortedUp.length ? Math.round(sortedUp.reduce((a, b) => a + b, 0) / sortedUp.length) : null,
      median: sortedUp.length ? sortedUp[Math.floor(sortedUp.length / 2)] : null,
      min:    sortedUp.length ? sortedUp[0] : null,
      max:    sortedUp.length ? sortedUp[sortedUp.length - 1] : null,
      count:  sortedUp.length,
      distribution: [
        { label: '< 1 h',    count: sortedUp.filter((v) => v < 3600).length },
        { label: '1 – 24 h', count: sortedUp.filter((v) => v >= 3600 && v < 86400).length },
        { label: '1 – 7 d',  count: sortedUp.filter((v) => v >= 86400 && v < 7 * 86400).length },
        { label: '7 – 30 d', count: sortedUp.filter((v) => v >= 7 * 86400 && v < 30 * 86400).length },
        { label: '> 30 d',   count: sortedUp.filter((v) => v >= 30 * 86400).length },
      ],
    }

    res.json({
      allGroups: allGroups.map((g) => g.name),
      groupFilter,
      groupExists: true,
      totals,
      uptime: uptimeSummary,
      rows,
      sampledAt: nowSec,
      staleAfterSec,
    })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

/* ═══════════ ROP UPTIME (business-hours aware) ═══════════
 * Per-store uptime / downtime / disconnect / SLA report driven by
 * StoreProblemHistory (MongoDB). Designed for the "ROP Dashboard" tab —
 * supports business-hours masking, configurable date ranges, SLA targets,
 * heatmap, daily trend, and top-offender ranking.
 */
router.get('/rop-uptime', async (req, res) => {
  try {
    const nowMs = Date.now()
    const range = String(req.query.range || '7d').toLowerCase()
    const customFromSec = parseInt(String(req.query.from || ''), 10)
    const customToSec = parseInt(String(req.query.to || ''), 10)

    let fromMs, toMs
    if (range === 'custom' && Number.isFinite(customFromSec) && Number.isFinite(customToSec) && customToSec > customFromSec) {
      fromMs = customFromSec * 1000
      toMs = customToSec * 1000
    } else {
      const span = ({
        '24h': 86_400_000,
        '1d':  86_400_000,
        'today': 86_400_000,
        '7d': 7 * 86_400_000,
        '14d': 14 * 86_400_000,
        '30d': 30 * 86_400_000,
        '60d': 60 * 86_400_000,
      })[range] || 7 * 86_400_000
      toMs = nowMs
      fromMs = nowMs - span
    }

    const bizStart = parseInt(String(req.query.bizStart ?? '9'),  10)
    const bizEnd   = parseInt(String(req.query.bizEnd   ?? '18'), 10)
    const bizDaysRaw = String(req.query.bizDays ?? '0,1,2,3,4,5,6')
    const weekdays = bizDaysRaw.split(',')
      .map((d) => parseInt(d.trim(), 10))
      .filter((d) => Number.isFinite(d) && d >= 0 && d <= 6)
    const tzOffsetMinutes = parseInt(String(req.query.tzOffset ?? '0'), 10) || 0

    const slaTarget = parseFloat(String(req.query.sla ?? '99.5'))
    const groupKey = String(req.query.groupKey || 'rp').toLowerCase()
    const topN = parseInt(String(req.query.topN || '10'), 10)

    const data = await fetchRopUptimeReport({
      fromMs,
      toMs,
      groupKey,
      slaTarget,
      topN,
      businessHours: { startHour: bizStart, endHour: bizEnd, weekdays, tzOffsetMinutes },
    })
    res.json(data)
  } catch (e) {
    if (e.code === 'MISSING_INFLUX' || e.code === 'INFLUX_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Store snapshot source not configured', code: e.code })
    }
    return res.status(500).json({ error: e.message || 'Failed to compute ROP uptime', code: e.code })
  }
})

  return router
}

export default createZabbixRouter(createZabbixClient('ZABBIX'))
