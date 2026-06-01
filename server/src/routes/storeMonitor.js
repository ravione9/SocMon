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
} from '../services/influxStore.js'
import {
  buildStoreInventoryReport,
  buildUptimeReport,
  buildIssuesReport,
  buildConnectivityReport,
  buildSpeedtestReport,
} from '../services/storeReports.js'

const router = Router()
router.use(authenticate, requireAppPage('storeMonitor'))

router.get('/meta', async (_req, res, next) => {
  try {
    const meta = getInfluxStoreMeta()
    if (!meta.configured) {
      return res.json({
        configured: false,
        connected: false,
        message: `Set ${meta.urlEnv}, ${meta.tokenEnv}, ${meta.orgEnv}, ${meta.bucketEnv} in server env`,
        ...meta,
      })
    }
    const ping = await pingInflux()
    res.json({
      ...meta,
      connected: ping.ok,
      hasData: ping.hasData ?? null,
      error: ping.error || null,
    })
  } catch (e) {
    next(e)
  }
})

const VALID_RANGES = new Set(['-1h', '-3h', '-6h', '-12h', '-24h', '-2d', '-7d'])

router.get('/overview', async (req, res, next) => {
  try {
    if (!isInfluxStoreConfigured()) {
      return res.status(503).json({ error: 'InfluxDB not configured', ...getInfluxStoreMeta() })
    }
    const staleMinutes = Math.min(Math.max(parseInt(String(req.query.staleMinutes || '10'), 10) || 10, 2), 60)
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
    const staleMinutes = Math.min(Math.max(parseInt(String(req.query.staleMinutes || '10'), 10) || 10, 2), 60)
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
    const staleMinutes = Math.min(Math.max(parseInt(String(req.query.staleMinutes || '10'), 10) || 10, 2), 60)
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
    const staleMinutes = Math.min(Math.max(parseInt(String(req.query.staleMinutes || '10'), 10) || 10, 2), 60)
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

export default router
