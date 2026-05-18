import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import {
  isSentinelOneConfigured,
  isSentinelOneXdrConfigured,
  resolveSentinelOneXdrBase,
  fetchThreatsList,
  fetchThreatsCount,
  fetchThreatDetail,
  fetchTokenOwnerSummary,
  mitigateThreats,
  markThreatsResolved,
  sentinelOneTokenMeta,
  updateThreatAnalystVerdict,
  runSentinelOnePowerQuery,
  callSentinelOneXdr,
} from '../utils/sentinelOneApi.js'
import {
  ALL_EXPORT_COLUMNS,
  INSPECT_LOG_COLUMNS,
  buildPowerQueryText,
  formatPowerQueryCsvValue,
} from '../utils/xdrPowerQuery.js'
import {
  PQ_OPERATORS,
  PQ_TEMPLATES,
  buildPowerQuerySuggestions,
  getXdrFieldCatalog,
} from '../utils/xdrFieldCatalog.js'

const router = Router()

function sendS1Error(res, err, fallbackMessage) {
  const upstreamStatus =
    err.status != null && Number.isFinite(Number(err.status)) ? Number(err.status) : null

  let status =
    err.code === 'S1_NETWORK_ERROR'
      ? 502
      : upstreamStatus != null && upstreamStatus >= 400
        ? upstreamStatus
        : 502

  // SentinelOne 401/403 must not be forwarded as HTTP 401 — the SPA axios interceptor logs out on any 401.
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    status = 502
  }

  const hint = buildSentinelOneAuthHint(upstreamStatus, err.body)

  const payload = {
    error: err.message || fallbackMessage,
    ...(err.code ? { code: err.code } : {}),
    ...(upstreamStatus != null ? { upstreamStatus } : {}),
    ...(err.body && typeof err.body === 'object' ? { upstream: err.body } : {}),
    // attempts[] is populated by runSentinelOnePowerQuery — let the UI render exactly which URLs failed.
    ...(Array.isArray(err.body?.attempts) ? { attempts: err.body.attempts } : {}),
    ...(hint ? { hint } : {}),
  }
  res.status(status).json(payload)
}

/** Actionable copy when SentinelOne rejects credentials */
function buildSentinelOneAuthHint(upstreamStatus, body) {
  const errors = body?.errors
  const codes = Array.isArray(errors) ? errors.map(e => e?.code).filter(c => c != null) : []
  const titles = Array.isArray(errors)
    ? errors.map(e => String(e?.title || ''))
    : []
  const authLike =
    upstreamStatus === 401 ||
    codes.includes(4010010) ||
    titles.some(t => /authentication failed/i.test(t))
  if (!authLike) return undefined
  return (
    'Regenerate an API token in SentinelOne (Settings → Users → open your user or a Service User → API Token). ' +
    'Use the same console hostname for SENTINEL_ONE_BASE_URL as in your browser (correct region/tenant). ' +
    'If you store the token in Docker Compose `.env`, escape `$` as `$$` or use single-quoted values — Compose otherwise corrupts JWT-shaped tokens. ' +
    'Alternatively use SENTINEL_ONE_API_TOKEN_FILE=/path/to/secret (raw token, one line) so Compose never interpolates the JWT.'
  )
}

router.use(authenticate)

router.get('/configured', (req, res) => {
  res.json({ configured: isSentinelOneConfigured() })
})

/** Safe token diagnostics — set SENTINEL_ONE_DEBUG_META=1 on the server (still requires Netpulse JWT). */
router.get('/meta', (req, res) => {
  if (String(process.env.SENTINEL_ONE_DEBUG_META || '').trim() !== '1') {
    return res.status(404).json({ error: 'Not found' })
  }
  res.json(sentinelOneTokenMeta())
})

router.get('/whoami', async (req, res) => {
  try {
    if (!isSentinelOneConfigured()) {
      return res.status(503).json({
        error: 'SentinelOne API is not configured (SENTINEL_ONE_BASE_URL + SENTINEL_ONE_API_TOKEN).',
      })
    }
    const summary = await fetchTokenOwnerSummary()
    res.json({ ok: true, sentinelOneUser: summary })
  } catch (err) {
    sendS1Error(res, err, 'SentinelOne authentication failed')
  }
})

/** Order matters: `/threats/count` before `/threats/:id` so `count` is not captured as an id. */
router.get('/threats/count', async (req, res) => {
  try {
    if (!isSentinelOneConfigured()) {
      return res.json({ configured: false, count: null })
    }
    const count = await fetchThreatsCount(req.query)
    res.json({ configured: true, count })
  } catch (err) {
    sendS1Error(res, err, 'SentinelOne threat count failed')
  }
})

router.get('/threats/:threatId', async (req, res) => {
  try {
    if (!isSentinelOneConfigured()) {
      return res.status(503).json({
        error: 'SentinelOne API is not configured (SENTINEL_ONE_BASE_URL + SENTINEL_ONE_API_TOKEN).',
      })
    }
    const threat = await fetchThreatDetail(req.params.threatId)
    res.json({ threat })
  } catch (err) {
    if (err.code === 'S1_VALIDATION') return res.status(404).json({ error: err.message })
    sendS1Error(res, err, 'SentinelOne threat detail failed')
  }
})

router.get('/threats', async (req, res) => {
  try {
    if (!isSentinelOneConfigured()) {
      return res.status(503).json({
        error: 'SentinelOne API is not configured (SENTINEL_ONE_BASE_URL + SENTINEL_ONE_API_TOKEN).',
      })
    }
    const result = await fetchThreatsList(req.query)
    res.json(result)
  } catch (err) {
    sendS1Error(res, err, 'SentinelOne request failed')
  }
})

router.post('/threats/mitigate', async (req, res) => {
  try {
    if (!isSentinelOneConfigured()) {
      return res.status(503).json({
        error: 'SentinelOne API is not configured (SENTINEL_ONE_BASE_URL + SENTINEL_ONE_API_TOKEN).',
      })
    }
    const ids = req.body?.ids
    const action = req.body?.action
    if (!Array.isArray(ids) || ids.length === 0 || typeof action !== 'string' || !action.trim()) {
      return res.status(400).json({ error: 'Body must include ids (non-empty array) and action (string).' })
    }
    const data = await mitigateThreats(ids, action.trim())
    res.json({ ok: true, data })
  } catch (err) {
    if (err.code === 'S1_VALIDATION') return res.status(400).json({ error: err.message })
    sendS1Error(res, err, 'Mitigation failed')
  }
})

router.post('/threats/resolve', async (req, res) => {
  try {
    if (!isSentinelOneConfigured()) {
      return res.status(503).json({
        error: 'SentinelOne API is not configured (SENTINEL_ONE_BASE_URL + SENTINEL_ONE_API_TOKEN).',
      })
    }
    const ids = req.body?.ids
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Body must include ids (non-empty array).' })
    }
    const data = await markThreatsResolved(ids)
    res.json({ ok: true, data })
  } catch (err) {
    if (err.code === 'S1_VALIDATION') return res.status(400).json({ error: err.message })
    sendS1Error(res, err, 'Resolve failed')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Singularity Data Lake / XDR — PowerQuery search
// ─────────────────────────────────────────────────────────────────────────────

function parsePqTimeRange(query) {
  const from = String(query.from || '').trim()
  const to = String(query.to || '').trim()
  if (from && to) return { start: from, end: to }
  const preset = String(query.range || '12h').trim()
  const m = /^(\d+)([smhd])$/i.exec(preset)
  if (!m) return { start: null, end: null }
  const mult = m[2].toLowerCase() === 's' ? 1000 : m[2].toLowerCase() === 'm' ? 60000 : m[2].toLowerCase() === 'h' ? 3600000 : 86400000
  const end = Date.now()
  const start = end - Number(m[1]) * mult
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() }
}

router.get('/xdr/configured', (_req, res) => {
  res.json({
    configured: isSentinelOneXdrConfigured(),
    xdrBaseUrl: resolveSentinelOneXdrBase() || null,
  })
})

router.get('/xdr/columns', (_req, res) => {
  const fields = getXdrFieldCatalog()
  res.json({
    columns: ALL_EXPORT_COLUMNS,
    inspectColumns: INSPECT_LOG_COLUMNS,
    fields: fields.map(f => f.name),
    fieldCatalog: fields,
  })
})

/** Full field catalog for query builder / sidebars. */
router.get('/xdr/fields', (req, res) => {
  const extra = String(req.query.extra || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const fields = getXdrFieldCatalog(extra)
  res.json({
    fields,
    operators: PQ_OPERATORS,
    templates: PQ_TEMPLATES,
    count: fields.length,
  })
})

/** Fetch one event with full field projection for the Inspect Log Line drawer. */
router.post('/xdr/powerQuery/event-detail', async (req, res) => {
  try {
    if (!isSentinelOneXdrConfigured()) {
      return res.status(503).json({ error: 'SentinelOne XDR Data Lake is not configured.' })
    }
    const ts = req.body?.timestamp ?? req.body?.ts
    const eventId = req.body?.eventId ?? req.body?.['event.id']
    const traceId = req.body?.traceId ?? req.body?.['trace.id']
    const extraCols = Array.isArray(req.body?.columns) ? req.body.columns.map(String).filter(Boolean) : []
    const cols = [...new Set([...INSPECT_LOG_COLUMNS, ...extraCols])]

    let filter = ''
    if (ts != null && String(ts).trim() !== '') {
      const n = Number(ts)
      if (Number.isFinite(n)) filter = `timestamp = ${Math.floor(n)}`
    }
    if (!filter && eventId) filter = `event.id = '${String(eventId).replace(/'/g, "\\'")}'`
    if (!filter && traceId) filter = `trace.id = '${String(traceId).replace(/'/g, "\\'")}'`
    if (!filter) return res.status(400).json({ error: 'timestamp, eventId, or traceId required' })

    const q = `${filter} | columns ${cols.join(',')} | limit 1`
    const { start, end } = parsePqTimeRange(req.body || {})
    const result = await runSentinelOnePowerQuery({ query: q, start, end, limit: 1 })
    const row = result.rows?.[0] || null
    res.json({ row, columns: result.columns || (row ? Object.keys(row) : []), query: q })
  } catch (err) {
    sendS1Error(res, err, 'SentinelOne event detail failed')
  }
})

router.get('/xdr/suggest', (req, res) => {
  const prefix = String(req.query.prefix || req.query.q || '').trim()
  const mode = String(req.query.mode || 'auto').trim()
  const field = String(req.query.field || '').trim()
  const limit = parseInt(req.query.limit, 10) || 40
  const extraFields = String(req.query.extraFields || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const suggestions = buildPowerQuerySuggestions({ prefix, mode, field, limit, extraFields })
  res.json({ suggestions, mode, field, prefix })
})

router.post('/xdr/powerQuery', async (req, res) => {
  try {
    if (!isSentinelOneXdrConfigured()) {
      return res.status(503).json({
        error:
          'SentinelOne XDR Data Lake is not configured. Set SENTINEL_ONE_XDR_BASE_URL (e.g. https://xdr.ap1.sentinelone.net) and SENTINEL_ONE_XDR_API_TOKEN.',
      })
    }
    const rawQ = String(req.body?.q || req.body?.query || '').trim()
    if (!rawQ) return res.status(400).json({ error: 'query text required (body.q)' })
    const limit = Math.min(Math.max(parseInt(req.body?.limit, 10) || 50000, 1), 200000)
    const userColumns = Array.isArray(req.body?.columns) ? req.body.columns.map(String).filter(Boolean) : null
    const project = req.body?.projectColumns !== false
    const q = project ? buildPowerQueryText(rawQ, userColumns, limit) : rawQ
    const { start, end } = parsePqTimeRange(req.body || {})
    const result = await runSentinelOnePowerQuery({ query: q, start, end, limit })
    res.json({
      status: result.status,
      matchingEvents: result.matchingEvents,
      omittedEvents: result.omittedEvents,
      columns: result.columns,
      rows: result.rows,
      query: rawQ,
      effectiveQuery: q,
      range: { start, end },
      attempt: result.attempt,
      attempts: result.attempts,
    })
  } catch (err) {
    sendS1Error(res, err, 'SentinelOne PowerQuery failed')
  }
})

/**
 * POST /api/sentinel-one/xdr/raw
 *   { method: 'POST'|'GET', path: '/api/powerQuery', body: { … }, authScheme: 'auto'|'bearer'|'apitoken' }
 *
 * Generic passthrough to the configured XDR base URL — used by the UI's Raw mode so operators
 * can probe alternate endpoints (e.g. /api/v1/events, /web/api/v2.1/dv/init-query) when the
 * tenant's PowerQuery shape differs. We never leak the token back, just the request URL / status / body.
 */
router.post('/xdr/raw', async (req, res) => {
  try {
    if (!isSentinelOneXdrConfigured()) {
      return res.status(503).json({
        error: 'SentinelOne XDR Data Lake is not configured.',
      })
    }
    const method = String(req.body?.method || 'POST').toUpperCase()
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
      return res.status(400).json({ error: `Unsupported method: ${method}` })
    }
    const base = resolveSentinelOneXdrBase().replace(/\/+$/, '')
    const pathOrUrl = String(req.body?.path || req.body?.url || '').trim()
    if (!pathOrUrl) return res.status(400).json({ error: 'path or url required (body.path)' })
    const isAbsolute = /^https?:\/\//i.test(pathOrUrl)
    const url = isAbsolute ? pathOrUrl : `${base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`

    const body = req.body?.body !== undefined ? req.body.body : null
    const authScheme = String(req.body?.authScheme || 'auto').toLowerCase()
    const result = await callSentinelOneXdr({ method, url, body, authScheme })
    res.json({
      url: result.url,
      status: result.status,
      ok: result.ok,
      authScheme: result.authScheme,
      body: result.body,
      // Include the original text only when JSON parsing failed so operators can still see the bytes.
      raw: result.body == null || typeof result.body === 'string' ? result.rawText : undefined,
    })
  } catch (err) {
    sendS1Error(res, err, 'SentinelOne XDR raw call failed')
  }
})

function csvEscapeHeader(val) {
  if (val == null || val === '') return ''
  const s = String(val)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

router.post('/xdr/powerQuery/export', async (req, res) => {
  try {
    if (!isSentinelOneXdrConfigured()) {
      return res.status(503).json({
        error:
          'SentinelOne XDR Data Lake is not configured. Set SENTINEL_ONE_XDR_BASE_URL (e.g. https://xdr.ap1.sentinelone.net) and SENTINEL_ONE_XDR_API_TOKEN.',
      })
    }
    const rawQ = String(req.body?.q || req.body?.query || '').trim()
    if (!rawQ) return res.status(400).json({ error: 'query text required (body.q)' })
    const maxRows = Math.min(Math.max(parseInt(req.body?.maxRows, 10) || 200000, 1), 200000)
    const userColumns = Array.isArray(req.body?.columns) ? req.body.columns.map(String).filter(Boolean) : null
    const q = buildPowerQueryText(rawQ, userColumns, maxRows)
    const { start, end } = parsePqTimeRange(req.body || {})

    // PowerQuery itself doesn't paginate — we ask for `limit` rows and stream what comes back.
    // If the result is truncated, the response carries omittedEvents > 0 (warn in CSV footer).
    const result = await runSentinelOnePowerQuery({ query: q, start, end, limit: maxRows })

    const resultCols =
      result.columns?.length ? result.columns : Array.from(new Set(result.rows.flatMap(r => Object.keys(r))))
    const cols =
      userColumns?.length
        ? [...userColumns.filter(c => resultCols.includes(c)), ...resultCols.filter(c => !userColumns.includes(c))]
        : resultCols
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="netpulse-xdr-powerquery-${Date.now()}.csv"`)
    res.write('\ufeff')
    res.write(cols.map(csvEscapeHeader).join(',') + '\n')

    for (const row of result.rows) {
      const line = cols.map(c => formatPowerQueryCsvValue(c, row[c])).join(',')
      res.write(line + '\n')
    }

    if (result.omittedEvents && Number(result.omittedEvents) > 0) {
      res.write('\n')
      res.write(`# SentinelOne reported ${result.omittedEvents.toLocaleString()} additional rows were omitted (PowerQuery memory limit). Narrow the query or shorten the range for more.\n`)
    }
    res.end()
  } catch (err) {
    if (!res.headersSent) sendS1Error(res, err, 'SentinelOne PowerQuery export failed')
    else res.end()
  }
})

router.post('/threats/analyst-verdict', async (req, res) => {
  try {
    if (!isSentinelOneConfigured()) {
      return res.status(503).json({
        error: 'SentinelOne API is not configured (SENTINEL_ONE_BASE_URL + SENTINEL_ONE_API_TOKEN).',
      })
    }
    const ids = req.body?.ids
    const verdict = req.body?.verdict
    if (!Array.isArray(ids) || ids.length === 0 || typeof verdict !== 'string' || !verdict.trim()) {
      return res.status(400).json({ error: 'Body must include ids (non-empty array) and verdict (string).' })
    }
    const data = await updateThreatAnalystVerdict(ids, verdict.trim())
    res.json({ ok: true, data })
  } catch (err) {
    if (err.code === 'S1_VALIDATION') return res.status(400).json({ error: err.message })
    sendS1Error(res, err, 'Analyst verdict update failed')
  }
})

export default router
