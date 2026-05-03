import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import {
  isSentinelOneConfigured,
  fetchThreatsList,
  fetchThreatsCount,
  fetchThreatDetail,
  fetchTokenOwnerSummary,
  mitigateThreats,
  markThreatsResolved,
  sentinelOneTokenMeta,
  updateThreatAnalystVerdict,
} from '../utils/sentinelOneApi.js'

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
