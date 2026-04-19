import { Router } from 'express'
import { isZabbixConfigured, zabbixRpc, zabbixPing, getZabbixToken } from '../services/zabbix.js'

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
    name: p.name,
    severity: p.severity,
    severityLabel: SEVERITY_LABEL[p.severity] || 'Unknown',
    clock: p.clock,
    r_clock: p.r_clock,
    hosts: (p.hosts || []).map((h) => ({
      hostid: h.hostid,
      host: h.host,
      name: h.name,
    })),
  }))
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
    e.code === 'ZABBIX_HTTP' || e.code === 'ZABBIX_FETCH' || e.code === 'ZABBIX_BAD_RESPONSE' ? 502 : 500
  return res.status(status).json({
    error: e.message,
    code: e.code,
    hint: e.hint,
    zabbixCode: e.zabbixCode,
  })
}

router.get('/config', (req, res) => {
  const url = process.env.ZABBIX_URL?.trim() || ''
  const token = getZabbixToken()
  res.json({
    configured: isZabbixConfigured(),
    zabbixUrl: url ? url.replace(/\/api_jsonrpc\.php.*$/i, '') : null,
    authMode: (process.env.ZABBIX_AUTH || 'auto').toLowerCase(),
    tokenPresent: Boolean(token),
    tokenSuffix: token ? `…${token.slice(-6)}` : null,
  })
})

router.get('/diagnostic', async (req, res) => {
  const ping = await zabbixPing()
  res.json({
    zabbixUrl: process.env.ZABBIX_URL?.trim() || null,
    tokenConfigured: Boolean(getZabbixToken()),
    ping,
    tips: [
      'Use the full URL ending in api_jsonrpc.php (often /zabbix/api_jsonrpc.php).',
      'Variable names: ZABBIX_URL and ZABBIX_API_TOKEN (or ZABBIX_TOKEN).',
      'Docker: put the same vars in project root .env (compose env_file) or server/.env inside the mounted server folder.',
      'HTTPS with self-signed: set ZABBIX_TLS_INSECURE=1 on the API server only for testing.',
      'Zabbix 7.4+: set ZABBIX_AUTH=bearer. Older: try ZABBIX_AUTH=body or leave auto.',
    ],
  })
})

/**
 * Zabbix 6.0+ removed `host.available` — availability lives on interfaces.
 * If host has `interfaces` array, derive from that; else fall back to `host.available`.
 */
/**
 * Derive availability for a host:
 *   '1' = Available, '2' = Unavailable, '0' = Unknown.
 *
 * Order of signals:
 *   1. Any interface explicitly Available (1) → Available.
 *   2. Any interface explicitly Unavailable (2) → Unavailable.
 *   3. Legacy host.available (Zabbix < 6.0) → use as-is when 1/2.
 *   4. Host enabled (status === '0') → Available (covers VMware/agentless hosts
 *      polled by the Zabbix server where no interface ever turns "1").
 *   5. Else Unknown.
 */
function deriveHostAvail(h) {
  const ifaces = h.interfaces
  if (Array.isArray(ifaces) && ifaces.length > 0) {
    let any1 = false
    let any2 = false
    for (const iface of ifaces) {
      const a = String(iface.available ?? '')
      if (a === '1') any1 = true
      if (a === '2') any2 = true
    }
    if (any1) return '1'
    if (any2) return '2'
  }
  const legacy = String(h.available ?? '')
  if (legacy === '1' || legacy === '2') return legacy
  // VMware / agentless hosts: no interface ever flips to "1", but Zabbix is
  // still polling them via vCenter/scripts. Trust the host's enabled state.
  if (String(h.status ?? '') === '0') return '1'
  if (String(h.status ?? '') === '1') return '2'
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
        hint: 'Set ZABBIX_URL and ZABBIX_API_TOKEN (see server/.env.example and GET /api/zabbix/diagnostic)',
      })
    }

    let selectGroupsParam
    try {
      await zabbixRpc('hostgroup.get', { output: ['groupid'], limit: 1 })
      selectGroupsParam = { selectHostGroups: ['groupid', 'name'] }
    } catch {
      selectGroupsParam = { selectGroups: ['groupid', 'name'] }
    }

    const [version, hostRows, problemCount, problems, sevRows] = await Promise.all([
      zabbixRpc('apiinfo.version', {}),
      zabbixRpc('host.get', {
        monitored_hosts: true,
        output: ['hostid', 'host', 'name', 'status', 'available'],
        selectInterfaces: ['interfaceid', 'available', 'type'],
        ...selectGroupsParam,
        limit: 500,
      }),
      problemCountParams(),
      problemGet({
        sortfield: ['eventid'],
        sortorder: 'DESC',
        limit: 500,
        output: ['eventid', 'name', 'severity', 'clock', 'r_clock', 'objectid'],
        selectHosts: ['hostid', 'host', 'name'],
      }),
      problemGet({
        output: ['severity'],
        limit: 3000,
        sortfield: ['eventid'],
        sortorder: 'DESC',
      }),
    ])

    const hostsForGroups = (hostRows || []).map((h) => ({
      ...h,
      groups: h.hostgroups || h.groups || [],
    }))
    const avail = hostAvailability(hostRows)
    const topHosts = topProblemHosts(problems)
    const groupStats = hostGroupSummary(hostsForGroups)
    const healthPct = avail.total > 0 ? Math.round((avail.available / avail.total) * 1000) / 10 : 0
    const latestProblems = problems.slice(0, 50)

    res.json({
      version: String(version || ''),
      monitoredHosts: avail.total,
      activeProblems: Number(problemCount) || 0,
      severityCounts: aggregateSeverity(sevRows),
      problems: mapProblems(latestProblems),
      availability: avail,
      healthPercent: healthPct,
      topProblemHosts: topHosts,
      hostGroups: groupStats,
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
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '400'), 10) || 400, 1), 500)
    let selectGroupsKey = 'selectGroups'
    try {
      await zabbixRpc('hostgroup.get', { output: ['groupid'], limit: 1 })
      selectGroupsKey = 'selectHostGroups'
    } catch { /* keep selectGroups */ }
    const raw = await zabbixRpc('host.get', {
      monitored_hosts: true,
      output: ['hostid', 'host', 'name', 'status', 'available'],
      selectInterfaces: ['interfaceid', 'available', 'type', 'ip', 'dns', 'port', 'main'],
      [selectGroupsKey]: ['groupid', 'name'],
      sortfield: 'name',
      limit,
      ...hostSearchParams(req.query.q),
    })
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
    res.json({ hosts })
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
    const rows = await problemGet({
      sortfield: ['eventid'],
      sortorder: 'DESC',
      limit,
      output: ['eventid', 'name', 'severity', 'clock', 'r_clock', 'objectid'],
      selectHosts: ['hostid', 'host', 'name'],
      ...(filter ? { filter } : {}),
    })
    res.json({ problems: mapProblems(rows), totalReturned: (rows || []).length })
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
    /^vm\.memory\.size\[pused/i,
    /^vmware\.vm\.memory\.usage/i,           // returns %
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

/** True if Zabbix item units indicate a percentage. */
function isPercentUnits(units) {
  if (units == null) return false
  const u = String(units).trim()
  return u === '%' || /(^|[^a-z])%([^a-z]|$)/i.test(u)
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

    const hostRows = await zabbixRpc('host.get', {
      monitored_hosts: true,
      output: ['hostid', 'host', 'name'],
      limit: 1000,
    })
    const hostMap = {}
    for (const h of hostRows || []) {
      hostMap[String(h.hostid)] = { hostid: String(h.hostid), host: h.host, name: h.name || h.host }
    }

    const itemRows = await zabbixRpc('item.get', {
      monitored: true,
      filter: { status: 0, value_type: [0, 3] },
      output: ['itemid', 'hostid', 'name', 'key_', 'value_type', 'units', 'lastvalue', 'lastclock'],
      limit: 20000,
    })

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

    res.json({
      cpu: rowsFor('cpu'),
      memory: rowsFor('memory'),
      disk: rowsFor('disk'),
      limit,
      sampledAt: Math.floor(Date.now() / 1000),
    })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

export default router
