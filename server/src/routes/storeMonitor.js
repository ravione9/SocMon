import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAppPage } from '../middleware/requireAppPage.js'
import {
  isInfluxStoreConfigured,
  getInfluxStoreMeta,
  pingInflux,
  fetchStoreSnapshot,
  fetchStoreHistory,
  buildOverviewSummary,
  queryFlux,
  queryFluxRaw,
  parseFluxCsv,
  fetchCrashSummary,
  fetchCrashEvents,
  crashTypeLabel,
  crashSeverity,
} from '../services/influxStore.js'
import {
  buildStoreInventoryReport,
  buildUptimeReport,
  buildIssuesReport,
  buildConnectivityReport,
  buildSpeedtestReport,
} from '../services/storeReports.js'
import { getManualRopSdwanStoreCodes } from '../utils/manualRopStoreCodes.js'
import StoreMonitorSetting from '../models/StoreMonitorSetting.js'
import StoreProblemHistory from '../models/StoreProblemHistory.js'
import { requirePageWrite } from '../middleware/requireAppPage.js'
import { runProblemSnapshot, getProblemSnapshotStatus } from '../services/storeProblemSnapshotter.js'
import { buildStoreMonitorFull } from '../services/storeMonitorBundle.js'

const router = Router()
router.use(authenticate, requireAppPage('storeMonitor'))

/**
 * GET /api/store-monitor/full — wide bundle: summary, all stores, problems, crashes, settings, alerts.
 * Query: same filters as /overview plus includeCrashes, includeAlerts, includeProblemHistory, includeSettings (bool).
 */
router.get('/full', async (req, res, next) => {
  try {
    const payload = await buildStoreMonitorFull(req.query)
    if (!payload.configured) return res.status(503).json(payload)
    res.json(payload)
  } catch (e) {
    next(e)
  }
})

router.get('/meta', async (_req, res, next) => {
  try {
    const meta = getInfluxStoreMeta()
    if (!meta.configured) {
      return res.json({
        configured: false,
        connected: false,
        message: `Set ${meta.urlEnv}, ${meta.tokenEnv}, ${meta.orgEnv}, ${meta.bucketEnv} in server env`,
        manualRopSdwanStoreCodes: getManualRopSdwanStoreCodes(),
        ...meta,
      })
    }
    const ping = await pingInflux()
    res.json({
      ...meta,
      connected: ping.ok,
      hasData: ping.hasData ?? null,
      error: ping.error || null,
      manualRopSdwanStoreCodes: getManualRopSdwanStoreCodes(),
    })
  } catch (e) {
    next(e)
  }
})

const VALID_RANGES = new Set(['-15m', '-1h', '-3h', '-6h', '-12h', '-24h', '-2d', '-7d'])

router.get('/overview', async (req, res, next) => {
  try {
    if (!isInfluxStoreConfigured()) {
      return res.status(503).json({ error: 'InfluxDB not configured', ...getInfluxStoreMeta() })
    }
    const staleMinutes = Math.min(Math.max(parseInt(String(req.query.staleMinutes || '15'), 10) || 15, 2), 60)
    const rawRange    = String(req.query.range || '-24h')
    const metricRange = VALID_RANGES.has(rawRange) ? rawRange : '-24h'
    const fromTs      = req.query.from ? parseInt(String(req.query.from), 10) : undefined
    const toTs        = req.query.to   ? parseInt(String(req.query.to),   10) : undefined
    let stores = await fetchStoreSnapshot(staleMinutes, metricRange, fromTs, toTs)
    const q = String(req.query.q || '').trim().toLowerCase()
    const conn = String(req.query.connState || '').trim()
    const issuesOnly = ['1', 'true', 'yes'].includes(String(req.query.issuesOnly || '').toLowerCase())
    if (q) {
      stores = stores.filter(
        (s) =>
          String(s.hostname).toLowerCase().includes(q) ||
          String(s.serial).toLowerCase().includes(q) ||
          String(s.storeTag).toLowerCase().includes(q) ||
          String(s.gatewayIp).toLowerCase().includes(q),
      )
    }
    if (conn) stores = stores.filter((s) => s.connState === conn)
    if (issuesOnly) stores = stores.filter((s) => s.issueCount > 0)
    const summary = buildOverviewSummary(stores)
    res.json({
      summary,
      stores,
      staleMinutes,
      metricRange,
      customFrom: fromTs ? new Date(fromTs * 1000).toISOString() : null,
      customTo:   toTs   ? new Date(toTs   * 1000).toISOString() : null,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    next(e)
  }
})

router.get('/stores', async (req, res, next) => {
  try {
    if (!isInfluxStoreConfigured()) {
      return res.status(503).json({ error: 'InfluxDB not configured' })
    }
    const staleMinutes = Math.min(Math.max(parseInt(String(req.query.staleMinutes || '15'), 10) || 15, 2), 60)
    const stores = await fetchStoreSnapshot(staleMinutes)
    const q = String(req.query.q || '').trim().toLowerCase()
    const conn = String(req.query.connState || '').trim()
    const issuesOnly = ['1', 'true', 'yes'].includes(String(req.query.issuesOnly || '').toLowerCase())

    let filtered = stores
    if (q) {
      filtered = filtered.filter(
        (s) =>
          String(s.hostname).toLowerCase().includes(q) ||
          String(s.serial).toLowerCase().includes(q) ||
          String(s.storeTag).toLowerCase().includes(q) ||
          String(s.gatewayIp).toLowerCase().includes(q),
      )
    }
    if (conn) filtered = filtered.filter((s) => s.connState === conn)
    if (issuesOnly) filtered = filtered.filter((s) => s.issueCount > 0)

    res.json({ stores: filtered, total: filtered.length, fetchedAt: new Date().toISOString() })
  } catch (e) {
    next(e)
  }
})

router.get('/stores/:storeTag/history', async (req, res, next) => {
  try {
    if (!isInfluxStoreConfigured()) {
      return res.status(503).json({ error: 'InfluxDB not configured' })
    }
    const storeTag = decodeURIComponent(req.params.storeTag)
    const fromSec  = req.query.from ? parseInt(String(req.query.from), 10) : undefined
    const toSec    = req.query.to   ? parseInt(String(req.query.to),   10) : undefined
    // rangeSec is a fallback when no custom from/to is supplied; allow up to 30d
    const rangeSec = Math.min(Math.max(parseInt(String(req.query.rangeSec || '3600'), 10) || 3600, 300), 30 * 86400)
    const payload = await fetchStoreHistory(storeTag, rangeSec, fromSec, toSec)
    res.json(payload)
  } catch (e) {
    next(e)
  }
})

router.get('/problems', async (req, res, next) => {
  try {
    if (!isInfluxStoreConfigured()) {
      return res.status(503).json({ error: 'InfluxDB not configured' })
    }
    const staleMinutes = Math.min(Math.max(parseInt(String(req.query.staleMinutes || '15'), 10) || 15, 2), 60)
    const rawRange    = String(req.query.range || '-24h')
    const metricRange = VALID_RANGES.has(rawRange) ? rawRange : '-24h'
    const stores = await fetchStoreSnapshot(staleMinutes, metricRange)
    const problems = []
    for (const s of stores) {
      for (const issue of s.issues) {
        problems.push({
          storeTag: s.storeTag,
          hostname: s.hostname,
          serial: s.serial,
          lastSeen: s.lastSeen,
          connState: s.connState,
          gatewayVendor: s.gatewayVendor,
          ...issue,
        })
      }
    }
    problems.sort((a, b) => {
      const sev = { critical: 0, high: 1, warning: 2 }
      return (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9)
    })
    res.json({ problems, total: problems.length, fetchedAt: new Date().toISOString() })
  } catch (e) {
    next(e)
  }
})

/** Debug endpoint — shows raw CSV + parsed rows from the bucket (last 2h). */
router.get('/debug', async (req, res, next) => {
  try {
    if (!isInfluxStoreConfigured()) {
      return res.status(503).json({ error: 'InfluxDB not configured' })
    }
    const { bucket, org } = getInfluxStoreMeta()
    const range = String(req.query.range || '-2h')
    const limitN = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100)

    // Simple unfiltered query — no grouping, just raw rows
    const simpleFlux = `
from(bucket: "${bucket}")
  |> range(start: ${range})
  |> limit(n: ${limitN})
`

    // Also try schema.measurements to list what's in the bucket
    const schemaFlux = `
import "influxdata/influxdb/schema"
schema.measurements(bucket: "${bucket}")
`

    const [rawCsv, schemaCsv] = await Promise.all([
      queryFluxRaw(simpleFlux).catch((e) => `ERROR: ${e.message}`),
      queryFluxRaw(schemaFlux).catch((e) => `ERROR: ${e.message}`),
    ])

    // Parse the simple query
    const parsedRows = typeof rawCsv === 'string' && !rawCsv.startsWith('ERROR')
      ? parseFluxCsv(rawCsv)
      : []

    // Parse schema
    const schemaRows = typeof schemaCsv === 'string' && !schemaCsv.startsWith('ERROR')
      ? parseFluxCsv(schemaCsv)
      : []

    const measurements = schemaRows
      .map((r) => r._value || r.value || Object.values(r).find(Boolean))
      .filter(Boolean)

    // Extract unique column names from parsed rows
    const colNames = parsedRows.length
      ? [...new Set(parsedRows.flatMap((r) => Object.keys(r)))]
      : []

    // Sample — first row per measurement
    const byMeasurement = {}
    for (const r of parsedRows) {
      const m = r._measurement || 'unknown'
      if (!byMeasurement[m]) byMeasurement[m] = r
    }

    res.json({
      org,
      bucket,
      range,
      measurements,
      sampleByMeasurement: byMeasurement,
      columnNames: colNames,
      parsedRowCount: parsedRows.length,
      rawCsvPreview: typeof rawCsv === 'string' ? rawCsv.slice(0, 3000) : rawCsv,
      schemaError: schemaCsv.startsWith?.('ERROR') ? schemaCsv : null,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    next(e)
  }
})

/* ── Crash Events ──────────────────────────────────────────── */
router.get('/crashes', async (req, res, next) => {
  try {
    if (!isInfluxStoreConfigured()) return res.status(503).json({ error: 'InfluxDB not configured' })
    const rawRange = String(req.query.range || '-24h')
    const metricRange = VALID_RANGES.has(rawRange) ? rawRange : '-24h'
    const fromSec = req.query.from ? parseInt(String(req.query.from), 10) : undefined
    const toSec   = req.query.to   ? parseInt(String(req.query.to),   10) : undefined
    const summary = await fetchCrashSummary(metricRange, fromSec, toSec)

    // Group by app for overview
    // By app
    const byApp = {}
    for (const s of summary) {
      if (!s.appName) continue
      if (!byApp[s.appName]) byApp[s.appName] = { appName: s.appName, totalCrashes: 0, affectedStores: 0 }
      byApp[s.appName].totalCrashes   += s.totalCrashes
      byApp[s.appName].affectedStores += 1
    }
    // By crash type
    const byType = {}
    for (const s of summary) {
      const t = s.crashType || 'app_crash'
      if (!byType[t]) byType[t] = { crashType: t, label: crashTypeLabel(t), severity: crashSeverity(t), totalCrashes: 0, affectedStores: 0 }
      byType[t].totalCrashes   += s.totalCrashes
      byType[t].affectedStores += 1
    }
    res.json({
      summary,
      byApp:  Object.values(byApp).sort((a, b) => b.totalCrashes - a.totalCrashes),
      byType: Object.values(byType).sort((a, b) => b.totalCrashes - a.totalCrashes),
      totalEvents:    summary.reduce((acc, s) => acc + s.totalCrashes, 0),
      criticalEvents: summary.filter(s => s.crashSeverity === 'critical').reduce((acc, s) => acc + s.totalCrashes, 0),
      affectedStores: new Set(summary.map(s => s.storeTag || s.hostname)).size,
      range:     metricRange,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) { next(e) }
})

router.get('/crashes/raw', async (req, res, next) => {
  try {
    if (!isInfluxStoreConfigured()) return res.status(503).json({ error: 'InfluxDB not configured' })
    const rawRange = String(req.query.range || '-24h')
    const metricRange = VALID_RANGES.has(rawRange) ? rawRange : '-24h'
    const fromSec = req.query.from ? parseInt(String(req.query.from), 10) : undefined
    const toSec   = req.query.to   ? parseInt(String(req.query.to),   10) : undefined
    const storeTag = req.query.storeTag ? String(req.query.storeTag) : null
    const appName  = req.query.appName  ? String(req.query.appName)  : null
    let rows = await fetchCrashEvents(metricRange, fromSec, toSec)
    if (storeTag) rows = rows.filter(r => (r.store_tag || r.hostname) === storeTag)
    if (appName)  rows = rows.filter(r => r.app_name === appName)
    res.json({ rows: rows.slice(0, 1000), total: rows.length, fetchedAt: new Date().toISOString() })
  } catch (e) { next(e) }
})

/* ── Excel Reports ─────────────────────────────────────────── */
const REPORT_BUILDERS = {
  inventory:    buildStoreInventoryReport,
  uptime:       buildUptimeReport,
  issues:       buildIssuesReport,
  connectivity: buildConnectivityReport,
  speedtest:    buildSpeedtestReport,
}
const REPORT_NAMES = {
  inventory:    'Store_Inventory',
  uptime:       'Uptime_Report',
  issues:       'Issues_Report',
  connectivity: 'Connectivity_Report',
  speedtest:    'Speedtest_Report',
}

router.get('/reports/:type', async (req, res, next) => {
  try {
    if (!isInfluxStoreConfigured()) {
      return res.status(503).json({ error: 'InfluxDB not configured' })
    }
    const type = req.params.type
    if (!REPORT_BUILDERS[type]) {
      return res.status(400).json({ error: `Unknown report type "${type}". Valid: ${Object.keys(REPORT_BUILDERS).join(', ')}` })
    }
    const rawRange = String(req.query.range || '-24h')
    const metricRange = VALID_RANGES.has(rawRange) ? rawRange : '-24h'
    const staleMinutes = Math.min(Math.max(parseInt(String(req.query.staleMinutes || '15'), 10) || 15, 2), 60)
    const groupFilter = String(req.query.group || '').trim()
    let stores = await fetchStoreSnapshot(staleMinutes, metricRange)
    if (groupFilter) {
      stores = stores.filter((s) => {
        const h = String(s.hostname || '').toUpperCase()
        const v = String(s.gatewayVendor || '').toLowerCase()
        let grp = 'General Group'
        if (s.isFortinet || v.includes('fortinet')) grp = 'SD-WAN Group'
        else if (h.startsWith('RP')) grp = 'RP Group'
        else if (h.startsWith('LK')) grp = 'POS System Group'
        return grp === groupFilter
      })
    }

    const wb = await REPORT_BUILDERS[type](stores, metricRange)
    const filename = `${REPORT_NAMES[type]}_${new Date().toISOString().slice(0, 10)}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    await wb.xlsx.write(res)
    res.end()
  } catch (e) {
    next(e)
  }
})

/* ── Problem History ────────────────────────────────────── */

/** GET /api/store-monitor/problem-history
 *  Query params:
 *    range    — '1h' | '6h' | '24h' | '7d' | '30d'  (default '24h')
 *    from     — Unix seconds (overrides range)
 *    to       — Unix seconds
 *    status   — 'active' | 'resolved' | '' (default = both)
 *    severity — 'critical' | 'high' | 'warning'
 *    q        — search in hostname / storeTag / code / message
 *    page     — page number (default 1)
 *    limit    — page size (default 200, max 1000)
 */
router.get('/problem-history', async (req, res, next) => {
  try {
    const RANGE_MAP = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 30 * 86400 }
    const rangeSec = RANGE_MAP[String(req.query.range || '24h')] ?? 86400

    let fromDate, toDate
    if (req.query.from) {
      fromDate = new Date(parseInt(String(req.query.from), 10) * 1000)
      toDate   = req.query.to ? new Date(parseInt(String(req.query.to), 10) * 1000) : new Date()
    } else {
      toDate   = new Date()
      fromDate = new Date(toDate.getTime() - rangeSec * 1000)
    }

    const statusFilter = String(req.query.status || '')
    // Match records that were active at any point in the requested window:
    // firstSeenAt <= toDate AND (resolvedAt >= fromDate OR status='active')
    const filter = {
      firstSeenAt: { $lte: toDate },
      $or: [
        { status: 'active' },
        { resolvedAt: { $gte: fromDate } },
      ],
    }
    if (statusFilter === 'active')   { delete filter.$or; filter.status = 'active' }
    if (statusFilter === 'resolved') { delete filter.$or; filter.status = 'resolved'; filter.resolvedAt = { $gte: fromDate, $lte: toDate } }
    if (req.query.severity) filter.severity = String(req.query.severity)
    const q = String(req.query.q || '').trim()
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$and = [{ $or: [{ hostname: re }, { storeTag: re }, { serial: re }, { code: re }, { message: re }] }]
      if (filter.$or) { filter.$and.push({ $or: filter.$or }); delete filter.$or }
    }

    const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 1000)
    const page  = Math.max(parseInt(String(req.query.page  || '1'),   10) || 1,   1)
    const skip  = (page - 1) * limit

    const [records, total, activeCount] = await Promise.all([
      StoreProblemHistory.find(filter).sort({ firstSeenAt: -1 }).skip(skip).limit(limit).lean(),
      StoreProblemHistory.countDocuments(filter),
      StoreProblemHistory.countDocuments({ status: 'active' }),
    ])

    // Trend: bucket records by hour (firstSeenAt) for the chart
    const allForTrend = await StoreProblemHistory.find(
      { firstSeenAt: { $gte: fromDate, $lte: toDate } },
      { firstSeenAt: 1, severity: 1, status: 1 },
    ).lean()

    // Build hourly buckets
    const bucketMs = rangeSec <= 3600 ? 5 * 60_000        // 5-min buckets for 1h
                   : rangeSec <= 86400 ? 30 * 60_000       // 30-min buckets for ≤24h
                   : 4 * 3600_000                          // 4-hour buckets for multi-day
    const trendMap = new Map()
    for (const r of allForTrend) {
      const ts = Math.floor(new Date(r.firstSeenAt).getTime() / bucketMs) * bucketMs
      if (!trendMap.has(ts)) trendMap.set(ts, { ts: new Date(ts).toISOString(), critical: 0, high: 0, warning: 0, resolved: 0 })
      const b = trendMap.get(ts)
      b[r.severity] = (b[r.severity] || 0) + 1
      if (r.status === 'resolved') b.resolved++
    }
    const trend = [...trendMap.values()].sort((a, b) => new Date(a.ts) - new Date(b.ts))

    // Top problem codes in window
    const codeCount = {}
    for (const r of allForTrend) codeCount[r.code] = (codeCount[r.code] || 0) + 1
    const topCodes = Object.entries(codeCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([code, count]) => ({ code, count }))

    res.json({
      records,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      activeCount,
      fromDate: fromDate.toISOString(),
      toDate:   toDate.toISOString(),
      trend,
      topCodes,
      snapshotStatus: getProblemSnapshotStatus(),
    })
  } catch (e) { next(e) }
})

/** POST /api/store-monitor/problem-history/snapshot — trigger an immediate tracking run */
router.post('/problem-history/snapshot', requirePageWrite('storeMonitor'), async (_req, res, next) => {
  try {
    const result = await runProblemSnapshot()
    res.json(result)
  } catch (e) { next(e) }
})

/** DELETE /api/store-monitor/problem-history — clear all history */
router.delete('/problem-history', requirePageWrite('storeMonitor'), async (_req, res, next) => {
  try {
    const result = await StoreProblemHistory.deleteMany({})
    res.json({ deleted: result.deletedCount })
  } catch (e) { next(e) }
})

/* ── Store Monitor Settings ─────────────────────────────── */

/** GET /api/store-monitor/settings — readable by any authorised store-monitor user */
router.get('/settings', async (_req, res, next) => {
  try {
    const doc = await StoreMonitorSetting.findOne().lean()
    const envCodes = getManualRopSdwanStoreCodes()
    const rawText = doc?.manualRopSdwanCodes ?? ''
    const codes = rawText.trim()
      ? [...new Set(rawText.split(/[\n,;|\t]+/).map((c) => c.trim().toUpperCase().replace(/^STORE[-_\s]*/i, '')).filter(Boolean))]
      : envCodes
    res.json({
      manualRopSdwanCodes: rawText,
      manualRopSdwanCodeList: codes,
      updatedBy: doc?.updatedBy ?? null,
      updatedAt: doc?.updatedAt ?? null,
    })
  } catch (e) { next(e) }
})

/** PUT /api/store-monitor/settings — requires write access or admin */
router.put('/settings', requirePageWrite('storeMonitor'), async (req, res, next) => {
  try {
    const raw = String(req.body.manualRopSdwanCodes ?? '').trim()
    const doc = await StoreMonitorSetting.findOneAndUpdate(
      {},
      { manualRopSdwanCodes: raw, updatedBy: req.user?._id },
      { new: true, upsert: true, runValidators: true },
    ).lean()
    const codes = raw
      ? [...new Set(raw.split(/[\n,;|\t]+/).map((c) => c.trim().toUpperCase().replace(/^STORE[-_\s]*/i, '')).filter(Boolean))]
      : []
    res.json({
      ok: true,
      manualRopSdwanCodes: doc.manualRopSdwanCodes,
      manualRopSdwanCodeList: codes,
      updatedAt: doc.updatedAt,
    })
  } catch (e) { next(e) }
})

export default router
