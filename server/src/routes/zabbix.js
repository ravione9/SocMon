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
  try {
    return await zabbixRpc('problem.get', { recent: true, ...params })
  } catch (e) {
    if (e.code !== 'ZABBIX_API_ERROR') throw e
    return zabbixRpc('problem.get', { ...params })
  }
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

router.get('/overview', async (req, res) => {
  try {
    if (!isZabbixConfigured()) {
      return res.status(503).json({
        error: 'Zabbix not configured',
        hint: 'Set ZABBIX_URL and ZABBIX_API_TOKEN (see server/.env.example and GET /api/zabbix/diagnostic)',
      })
    }

    const [version, hostCount, problemCount, problems, sevRows] = await Promise.all([
      zabbixRpc('apiinfo.version', {}),
      zabbixRpc('host.get', { monitored_hosts: true, countOutput: true }),
      problemCountParams(),
      problemGet({
        sortfield: ['eventid'],
        sortorder: 'DESC',
        limit: 12,
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

    res.json({
      version: String(version || ''),
      monitoredHosts: Number(hostCount) || 0,
      activeProblems: Number(problemCount) || 0,
      severityCounts: aggregateSeverity(sevRows),
      problems: mapProblems(problems),
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
    const raw = await zabbixRpc('host.get', {
      monitored_hosts: true,
      output: ['hostid', 'host', 'name', 'status', 'available'],
      selectGroups: ['groupid', 'name'],
      sortfield: 'name',
      limit,
      ...hostSearchParams(req.query.q),
    })
    const hosts = (raw || []).map((h) => ({
      hostid: h.hostid,
      host: h.host,
      name: h.name,
      monitored: String(h.status) === '0',
      availability: availLabel(h.available),
      availabilityCode: h.available,
      groups: (h.groups || []).map((g) => g.name).filter(Boolean),
    }))
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
    const maxSpan = 86400 * 31
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
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '120'), 10) || 120, 1), 500)
    const base = {
      output: ['eventid', 'source', 'object', 'clock', 'name', 'severity', 'r_eventid'],
      selectHosts: ['hostid', 'host', 'name'],
      sortfield: ['clock'],
      sortorder: 'DESC',
      limit,
    }
    let rows
    try {
      rows = await zabbixRpc('event.get', { source: 0, ...base })
    } catch (e) {
      if (e.code !== 'ZABBIX_API_ERROR') throw e
      rows = await zabbixRpc('event.get', base)
    }
    const events = (rows || []).map((ev) => ({
      eventid: ev.eventid,
      clock: ev.clock,
      name: ev.name,
      severity: ev.severity,
      severityLabel: SEVERITY_LABEL[ev.severity] || 'Unknown',
      source: ev.source,
      object: ev.object,
      rEventid: ev.r_eventid,
      hosts: (ev.hosts || []).map((h) => ({
        hostid: h.hostid,
        host: h.host,
        name: h.name,
      })),
    }))
    res.json({ events, totalReturned: events.length })
  } catch (e) {
    return sendZabbixError(res, e)
  }
})

export default router
