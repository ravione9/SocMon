/**
 * SentinelOne Management REST API (v2.1) — server-side only.
 * Paths align with official integrations (e.g. Demisto Cortex XSOAR SentinelOne v2).
 */

import { existsSync, readFileSync } from 'node:fs'

function cfgError() {
  const e = new Error(
    'SentinelOne API is not configured. Set console URL + token (e.g. SENTINEL_ONE_BASE_URL and SENTINEL_ONE_API_TOKEN, or SENTINEL_ONE_API_TOKEN_FILE pointing at a secret file).',
  )
  e.code = 'S1_NOT_CONFIGURED'
  return e
}

/** Console origin only — strips trailing `/web/api/v2.x` if present. */
export function resolveSentinelOneConsoleBase() {
  let raw = String(
    process.env.SENTINEL_ONE_BASE_URL ||
      process.env.SENTINELONE_BASE_URL ||
      process.env.SENTINELONE_API_BASE_URL ||
      '',
  )
    .trim()
    .replace(/\/+$/, '')
  if (!raw) return ''
  for (const suf of ['/web/api/v2.1', '/web/api/v2.0']) {
    if (raw.toLowerCase().endsWith(suf.toLowerCase())) {
      raw = raw.slice(0, -suf.length).replace(/\/+$/, '')
      break
    }
  }
  return raw
}

/**
 * Singularity Data Lake (XDR) base URL — separate hostname from the Management Console
 * (e.g. console `apse1-2001.sentinelone.net` vs Data Lake `xdr.ap1.sentinelone.net`).
 * Env override (preferred): SENTINEL_ONE_XDR_BASE_URL. Falls back to the same family using
 * region inference, then to the Management Console URL itself (works on some tenants).
 */
export function resolveSentinelOneXdrBase() {
  const explicit = String(
    process.env.SENTINEL_ONE_XDR_BASE_URL ||
      process.env.SENTINELONE_XDR_BASE_URL ||
      process.env.SENTINEL_ONE_DATA_LAKE_URL ||
      '',
  )
    .trim()
    .replace(/\/+$/, '')
  if (explicit) return explicit
  const console = resolveSentinelOneConsoleBase()
  if (!console) return ''
  // Try a couple of well-known patterns so the feature works out-of-the-box when an admin
  // forgets to set the new var (apse1-2001.sentinelone.net → xdr.ap1.sentinelone.net).
  try {
    const u = new URL(console)
    const host = u.hostname.toLowerCase()
    // apse1, apse2, … (Asia Pacific Southeast) → ap1, ap2
    const apse = /^apse(\d+)(?:-\d+)?\./.exec(host)
    if (apse) return `https://xdr.ap${apse[1]}.sentinelone.net`
    // usea1 / use2 / use1 → us1 / us2
    const use = /^use(?:a)?(\d+)(?:-\d+)?\./.exec(host)
    if (use) return `https://xdr.us${use[1]}.sentinelone.net`
    // euw1 / eu1 / euc1 / etc. — `eu1` already matches the xdr prefix
    const eu = /^eu(?:w|c)?(\d+)(?:-\d+)?\./.exec(host)
    if (eu) return `https://xdr.eu${eu[1]}.sentinelone.net`
    // Fallback: bolt `xdr.` on the front of the management host.
    return `${u.protocol}//xdr.${host}`
  } catch {
    return console
  }
}

/** Optional separate API token for the XDR Data Lake (Log Read Access). Falls back to the management token. */
export function resolveSentinelOneXdrToken() {
  const direct = normalizeApiTokenString(
    process.env.SENTINEL_ONE_XDR_API_TOKEN ||
      process.env.SENTINELONE_XDR_API_TOKEN ||
      process.env.SENTINEL_ONE_XDR_TOKEN ||
      '',
  )
  if (direct) return direct
  return resolveSentinelOneApiToken()
}

export function isSentinelOneXdrConfigured() {
  return !!(resolveSentinelOneXdrBase() && resolveSentinelOneXdrToken())
}

function normalizeApiTokenString(raw) {
  let t = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r|\n|\u0000/g, '')
    .trim()
  // Common copy-paste mistakes: surrounding quotes or angle-bracket placeholders.
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('<') && t.endsWith('>')) ||
    (t.startsWith('`') && t.endsWith('`'))
  ) {
    t = t.slice(1, -1).trim()
  }
  return t
}

export function resolveSentinelOneApiToken() {
  const fp = String(
    process.env.SENTINEL_ONE_API_TOKEN_FILE || process.env.SENTINELONE_API_TOKEN_FILE || '',
  ).trim()
  if (fp) {
    try {
      if (existsSync(fp)) {
        const fromFile = normalizeApiTokenString(readFileSync(fp, 'utf8'))
        if (fromFile) return fromFile
      }
    } catch {
      /* fall through to env var */
    }
  }

  return normalizeApiTokenString(
    process.env.SENTINEL_ONE_API_TOKEN ||
      process.env.SENTINELONE_API_TOKEN ||
      process.env.SENTINEL_ONE_TOKEN ||
      process.env.SENTINELONE_TOKEN ||
      '',
  )
}

/**
 * Official Management API auth is `Authorization: ApiToken <token>` (even if the token string looks like a JWT).
 * Optional: SENTINEL_ONE_AUTH_SCHEME=bearer | apitoken — on 401 we retry with the other scheme once.
 */
export function sentinelAuthorizationHeaders(token) {
  const forced = String(process.env.SENTINEL_ONE_AUTH_SCHEME || '').trim().toLowerCase()
  if (forced === 'bearer') return [`Bearer ${token}`]
  if (forced === 'apitoken' || forced === 'api_token') return [`ApiToken ${token}`]

  return [`ApiToken ${token}`, `Bearer ${token}`]
}

export function isSentinelOneConfigured() {
  return !!(resolveSentinelOneConsoleBase() && resolveSentinelOneApiToken())
}

/** Parse preset like 30d / 12h / 15m into milliseconds duration ending at now. */
export function presetToMillis(rangeStr) {
  const m = /^(\d+)([smhd])$/i.exec(String(rangeStr || '').trim())
  if (!m) return 30 * 24 * 60 * 60 * 1000
  const n = parseInt(m[1], 10)
  const u = m[2].toLowerCase()
  const mult = u === 's' ? 1000 : u === 'm' ? 60000 : u === 'h' ? 3600000 : 86400000
  return n * mult
}

/** Express: repeated keys → string[]; axios often sends CSV — normalize before splitting. */
function queryToCsvPieces(val, fallbackCsv) {
  if (val == null || val === '') return fallbackCsv
  if (Array.isArray(val))
    return val
      .map(v => String(v).trim())
      .filter(Boolean)
      .join(',')
  return String(val).trim() || fallbackCsv
}

/** SentinelOne expects array-style query params — repeat keys (e.g. `incidentStatuses=a&incidentStatuses=b`), not one comma-glued string (that validates as invalid per-character). */
function appendMultiParam(params, key, rawCsv) {
  const parts = String(rawCsv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  for (const p of parts) {
    params.append(key, p)
  }
}

/** Same sort fields SentinelOne expects when continuing cursor pagination (must match first page). */
function appendThreatListSortParams(params, query) {
  params.set('sortBy', String(query.sortBy || 'createdAt').trim() || 'createdAt')
  params.set('sortOrder', String(query.sortOrder || 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc')
}

/** True when query asks for every incident state (explicit incidents=all or all three statuses listed). */
function incidentStatusesCoverAll(val) {
  if (val == null || val === '') return false
  const pieces = Array.isArray(val)
    ? val.map(v => String(v).trim()).filter(Boolean)
    : String(val)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
  const set = new Set(pieces)
  const need = ['unresolved', 'in_progress', 'resolved']
  return need.every(s => set.has(s))
}

/** Query flags for GET /threats — uses createdAt window + optional cursor page. */
export function buildThreatListParams(query) {
  const params = new URLSearchParams()

  const rawLimit = parseInt(String(query.limit || '50'), 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50

  const cursor = String(query.cursor || '').trim()
  if (cursor) {
    params.set('cursor', cursor)
    params.set('limit', String(limit))
    appendThreatListSortParams(params, query)
    return params
  }

  const dateFrom = String(query.from || '').trim()
  const dateTo = String(query.to || '').trim()
  if (dateFrom && dateTo) {
    params.set('createdAt__gte', dateFrom)
    params.set('createdAt__lte', dateTo)
  } else {
    const preset = String(query.range || '30d').trim()
    const end = Date.now()
    const start = end - presetToMillis(preset)
    params.set('createdAt__gte', new Date(start).toISOString())
    params.set('createdAt__lte', new Date(end).toISOString())
  }

  params.set('limit', String(limit))
  appendThreatListSortParams(params, query)

  /** Client sends `mitigation=all` to omit mitigationStatuses — resolved incidents are usually mitigated, so intersecting resolved + not_mitigated often returns zero rows. */
  const mitigationAll = ['all', 'any', '1', 'true'].includes(
    String(query.mitigation || '').trim().toLowerCase(),
  )
  if (!mitigationAll) {
    const mit = queryToCsvPieces(query.mitigationStatuses, 'not_mitigated')
    appendMultiParam(params, 'mitigationStatuses', mit)
  }

  /** Omit incidentStatuses filter — full incident spectrum or incidents=all / equivalent triple selection. */
  const incidentsAll =
    ['all', 'any', '1', 'true'].includes(String(query.incidents || '').trim().toLowerCase()) ||
    incidentStatusesCoverAll(query.incidentStatuses)
  if (!incidentsAll) {
    const inc = queryToCsvPieces(query.incidentStatuses, 'unresolved,in_progress')
    appendMultiParam(params, 'incidentStatuses', inc)
  }

  const q = String(query.q || '').trim()
  if (q) params.set('query', q)

  /** SentinelOne supports countOnly — returns total matches without full threat objects (see GET threats). */
  const countOnlyFlag = ['true', '1', 'yes'].includes(String(query.countOnly || '').trim().toLowerCase())
  if (countOnlyFlag) {
    params.set('countOnly', 'true')
    params.set('limit', '1')
  }

  return params
}

function coercePositiveInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === 'string' && String(value).trim() !== '') {
    const x = Number(value)
    if (Number.isFinite(x)) return Math.max(0, Math.floor(x))
  }
  return null
}

/** Parse GET /threats total — integrations expose pagination.totalItems or total_items (snake_case). */
export function extractThreatCountFromJson(json) {
  if (!json || typeof json !== 'object') return null

  const fromPaginationBlock = block => {
    if (!block || typeof block !== 'object') return null
    return coercePositiveInt(
      block.totalItems ?? block.total_items ?? block.total ?? block.totalCount ?? block.count,
    )
  }

  const d = json.data
  const asNum = coercePositiveInt(d)
  if (asNum != null) return asNum

  if (d != null && typeof d === 'object' && !Array.isArray(d)) {
    const nestedPag = fromPaginationBlock(d.pagination)
    if (nestedPag != null) return nestedPag
    const n = coercePositiveInt(d.total ?? d.count ?? d.totalItems ?? d.total_items)
    if (n != null) return n
  }

  const topPag = fromPaginationBlock(json.pagination)
  if (topPag != null) return topPag

  const root = coercePositiveInt(json.total ?? json.totalItems ?? json.total_items ?? json.count)
  return root
}

/** Prefer countOnly (cheap); fallback to limit=1 page — some tenants omit totals when countOnly is set. */
export async function fetchThreatsCount(expressQuery) {
  const base = { ...(expressQuery || {}) }

  const jsonCount = await s1Json('GET', 'threats', {
    searchParams: buildThreatListParams({ ...base, countOnly: 'true' }),
  })
  let n = extractThreatCountFromJson(jsonCount)
  if (n != null) return n

  const { countOnly: _omitCountOnly, ...pageBase } = base
  const jsonPage = await s1Json('GET', 'threats', {
    searchParams: buildThreatListParams({ ...pageBase, limit: '1' }),
  })
  return extractThreatCountFromJson(jsonPage)
}

/** Uses global fetch, or undici + insecure TLS when SENTINEL_ONE_TLS_INSECURE=1 (corporate SSL inspection). */
async function s1Fetch(url, init) {
  const insecure = String(process.env.SENTINEL_ONE_TLS_INSECURE || '').trim() === '1'
  if (!insecure) {
    return fetch(url, init)
  }
  const { fetch: undiciFetch, Agent } = await import('undici')
  const dispatcher = new Agent({
    connect: {
      rejectUnauthorized: false,
    },
  })
  return undiciFetch(url, { ...init, dispatcher })
}

export function normalizeThreatForUi(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ti = raw.threatInfo || {}
  const ar = raw.agentRealtimeInfo || {}
  const engines = ti.engines
  let detecting = '—'
  if (Array.isArray(engines) && engines.length) detecting = engines.filter(Boolean).slice(0, 3).join(', ')
  else if (typeof engines === 'string' && engines) detecting = engines

  return {
    id: raw.id != null ? String(raw.id) : '',
    threatName: ti.threatName || ti.identifyingName || '—',
    agentComputerName: ar.agentComputerName || '—',
    mitigationStatus: ti.mitigationStatus || '—',
    incidentStatus: ti.incidentStatus || '—',
    analystVerdict: ti.analystVerdict != null ? String(ti.analystVerdict) : 'undefined',
    confidenceLevel: ti.confidenceLevel != null ? String(ti.confidenceLevel) : '—',
    classification: ti.classification != null ? String(ti.classification) : '—',
    createdAt: ti.createdAt || raw.createdAt || null,
    detectingEngine: detecting,
    agentId: ar.agentId != null ? String(ar.agentId) : '',
    siteName: ar.siteName || '—',
  }
}

async function s1Json(method, pathSuffix, { searchParams = null, bodyObj = undefined, apiVersion = '2.1' } = {}) {
  if (!isSentinelOneConfigured()) throw cfgError()

  const base = resolveSentinelOneConsoleBase()
  const token = resolveSentinelOneApiToken()

  const ver = String(apiVersion || '2.1').replace(/^v/i, '')
  let url = `${base}/web/api/v${ver}/${String(pathSuffix || '').replace(/^\//, '')}`
  const qs = searchParams != null ? String(searchParams) : ''
  if (qs.length) url += `?${qs}`

  const attempts = sentinelAuthorizationHeaders(token)
  let last401Detail = null

  for (let ai = 0; ai < attempts.length; ai++) {
    const authorization = attempts[ai]

    /** @type {RequestInit} */
    const init = {
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }
    if (bodyObj !== undefined) init.body = JSON.stringify(bodyObj)

    let res
    try {
      res = await s1Fetch(url, init)
    } catch (netErr) {
      let msg =
        netErr?.cause?.message ||
        netErr?.message ||
        'Cannot reach SentinelOne (TLS/DNS/network). From Docker: confirm outbound HTTPS is allowed.'
      if (/certificate|self-signed|certificate chain|unable to verify|TLS|SSL/i.test(msg)) {
        msg +=
          ' Prefer mounting your enterprise CA and setting NODE_EXTRA_CA_CERTS on the API container; for testing only set SENTINEL_ONE_TLS_INSECURE=1.'
      }
      const wrapped = new Error(msg)
      wrapped.code = 'S1_NETWORK_ERROR'
      wrapped.cause = netErr
      throw wrapped
    }

    let payload
    try {
      payload = await res.json()
    } catch {
      payload = {}
    }

    if (!res.ok) {
      const detail =
        payload?.errors?.[0]?.detail ||
        payload?.errors?.[0]?.title ||
        payload?.message ||
        res.statusText ||
        `HTTP ${res.status}`
      const msg = typeof detail === 'string' ? detail : JSON.stringify(detail)

      if (res.status === 401 && ai < attempts.length - 1) {
        last401Detail = msg
        continue
      }

      const err = new Error(last401Detail ? `${msg} (also tried alternate auth: ${last401Detail})` : msg)
      err.code = 'S1_HTTP_ERROR'
      err.status = res.status
      err.body = payload
      throw err
    }

    return payload
  }
}

function summaryFromLoginByTokenJson(json) {
  const d = json?.data || {}
  return {
    id: d.id != null ? String(d.id) : null,
    email: d.email ?? null,
    fullName: d.fullName ?? null,
    role: d.role ?? null,
    scope: d.scope ?? null,
    accountId: d.accountId != null ? String(d.accountId) : null,
  }
}

/**
 * Token probe — SentinelOne tenants vary: POST body `data.token`, GET `?token=`, or Authorization-only GET.
 * If any attempt returns 401, prefer that error over a later 400 "missing token" so messaging matches /threats.
 */
export async function fetchTokenOwnerSummary() {
  const token = resolveSentinelOneApiToken()
  if (!token) throw cfgError()

  const variants = [
    () => s1Json('POST', 'users/login/by-token', { bodyObj: { data: { token } } }),
    () => s1Json('POST', 'users/login/by-token', { bodyObj: { token } }),
    () =>
      s1Json('GET', 'users/login/by-token', {
        searchParams: new URLSearchParams({ token }),
      }),
    () => s1Json('GET', 'users/login/by-token'),
  ]

  let lastErr = null
  /** @type {Error|null} */
  let authErr = null
  for (const call of variants) {
    try {
      const json = await call()
      return summaryFromLoginByTokenJson(json)
    } catch (e) {
      lastErr = e
      if (e.status === 401) authErr = e
    }
  }
  throw authErr || lastErr || cfgError()
}

/** Safe diagnostics — enable with SENTINEL_ONE_DEBUG_META=1 on the server (never exposes full token). */
export function sentinelOneTokenMeta() {
  const t = resolveSentinelOneApiToken()
  const segs = t.split('.').length
  const fp = String(
    process.env.SENTINEL_ONE_API_TOKEN_FILE || process.env.SENTINELONE_API_TOKEN_FILE || '',
  ).trim()
  return {
    configured: isSentinelOneConfigured(),
    tokenLength: t.length,
    tokenLooksLikeJwt: segs === 3 && t.length > 40,
    tokenContainsDollar: t.includes('$'),
    consoleBaseUrl: resolveSentinelOneConsoleBase(),
    tokenFileEnvPath: fp || null,
    tokenFileReadable: Boolean(fp && existsSync(fp)),
  }
}

export async function fetchThreatsList(expressQuery) {
  const params = buildThreatListParams(expressQuery || {})
  const json = await s1Json('GET', 'threats', { searchParams: params })
  const data = json?.data
  const list = Array.isArray(data) ? data : []
  return {
    threats: list.map(normalizeThreatForUi).filter(Boolean),
    pagination: json?.pagination || null,
    errors: json?.errors || null,
  }
}

/** Minimal params to fetch threat(s) by id — avoids GET /threats/{id} (often 404 on v2.1) and avoids list defaults that hide threats. */
function buildThreatLookupByIdParams(threatId, idsQueryKey = 'ids') {
  const id = String(threatId || '').trim()
  const params = new URLSearchParams()
  params.append(idsQueryKey, id)
  const end = Date.now()
  const start = end - 10 * 365 * 86400000
  params.set('createdAt__gte', new Date(start).toISOString())
  params.set('createdAt__lte', new Date(end).toISOString())
  params.set('limit', '100')
  params.set('sortBy', 'createdAt')
  params.set('sortOrder', 'desc')
  return params
}

function threatRecordMatchesId(raw, id) {
  if (!raw || typeof raw !== 'object') return false
  const top = String(raw.id ?? '')
  const nested = String(raw.threatInfo?.threatId ?? '')
  return top === id || nested === id
}

function extractThreatFromGetThreatsJson(json, id) {
  const data = json?.data
  if (!Array.isArray(data) || !data.length) return null
  const hit = data.find(t => threatRecordMatchesId(t, id))
  return hit || null
}

/** Normalize GET /threats/{id} or single-resource payloads */
function extractThreatFromDetailJson(json, id) {
  const raw = json?.data
  if (Array.isArray(raw)) {
    const hit = raw.find(t => threatRecordMatchesId(t, id))
    return hit || raw[0] || null
  }
  if (raw && typeof raw === 'object') {
    return threatRecordMatchesId(raw, id) ? raw : null
  }
  return null
}

/**
 * Single threat document — tries GET /threats/{id}, then GET /threats with ids filter (tenant-compatible).
 */
export async function fetchThreatDetail(threatId) {
  const id = String(threatId || '').trim()
  if (!id) {
    const e = new Error('threat id required')
    e.code = 'S1_VALIDATION'
    throw e
  }

  try {
    const json = await s1Json('GET', `threats/${encodeURIComponent(id)}`)
    const parsed = extractThreatFromDetailJson(json, id)
    if (parsed && typeof parsed === 'object') return parsed
  } catch (e) {
    const st = Number(e.status)
    if (st !== 404 && st !== 405 && st !== 400) throw e
  }

  const idKeys = ['ids', 'threatIds']
  let lastErr = null
  for (const key of idKeys) {
    try {
      const params = buildThreatLookupByIdParams(id, key)
      const json = await s1Json('GET', 'threats', { searchParams: params })
      const hit = extractThreatFromGetThreatsJson(json, id)
      if (hit) return hit
    } catch (e) {
      lastErr = e
    }
  }

  if (lastErr && lastErr.status && ![404, 400].includes(Number(lastErr.status))) throw lastErr

  const e = new Error('Threat not found')
  e.code = 'S1_VALIDATION'
  throw e
}

export async function mitigateThreats(threatIds, action) {
  const ids = (threatIds || []).map(id => String(id).trim()).filter(Boolean)
  if (!ids.length) {
    const e = new Error('threat ids required')
    e.code = 'S1_VALIDATION'
    throw e
  }
  const act = String(action || '').trim()
  if (!act) {
    const e = new Error('mitigation action required')
    e.code = 'S1_VALIDATION'
    throw e
  }
  const path = `threats/mitigate/${encodeURIComponent(act)}`
  const json = await s1Json('POST', path, { bodyObj: { filter: { ids } } })
  return json?.data ?? json
}

/**
 * Close threats / set incident resolved. Tenants differ: some expose POST threats/mark-as-resolved,
 * others only POST threats/incident with incidentStatus (see Cortex XSOAR SentinelOne-V2).
 * On HTTP 404/405 we try the alternate route (and v2.0) before failing.
 */
export async function markThreatsResolved(threatIds) {
  const ids = (threatIds || []).map(id => String(id).trim()).filter(Boolean)
  if (!ids.length) {
    const e = new Error('threat ids required')
    e.code = 'S1_VALIDATION'
    throw e
  }

  const variants = [
    { apiVersion: '2.1', path: 'threats/mark-as-resolved', bodyObj: { filter: { ids } } },
    {
      apiVersion: '2.1',
      path: 'threats/incident',
      bodyObj: { data: { incidentStatus: 'resolved' }, filter: { ids } },
    },
    { apiVersion: '2.1', path: 'threats/mark-as-resolved', bodyObj: { filter: { ids, tenant: 'true' } } },
    {
      apiVersion: '2.1',
      path: 'threats/incident',
      bodyObj: { data: { incidentStatus: 'resolved' }, filter: { ids, tenant: 'true' } },
    },
    { apiVersion: '2.0', path: 'threats/mark-as-resolved', bodyObj: { filter: { ids } } },
    {
      apiVersion: '2.0',
      path: 'threats/incident',
      bodyObj: { data: { incidentStatus: 'resolved' }, filter: { ids } },
    },
  ]

  let lastErr = null
  for (const v of variants) {
    try {
      const json = await s1Json('POST', v.path, {
        bodyObj: v.bodyObj,
        apiVersion: v.apiVersion,
      })
      return json?.data ?? json
    } catch (e) {
      lastErr = e
      const st = Number(e.status)
      if (st === 404 || st === 405) continue
      throw e
    }
  }

  throw lastErr || new Error('SentinelOne could not resolve threats')
}

/**
 * Build the candidate (url, body) attempts for a PowerQuery. Tenants vary:
 *   • Newer Data Lake:  POST <xdrBase>/api/powerQuery  body { query, startTime, endTime, limit }
 *   • Some deployments: same path but ISO `start`/`end`
 *   • Legacy on management:  POST <console>/web/api/v2.1/dv/events/pq
 * We try them in order until one returns 2xx. Each attempt's URL/body/error is
 * collected so the failure response can show the operator exactly what was tried.
 */
function powerQueryAttempts({ query, start, end, limit, priority }) {
  const xdrBase = resolveSentinelOneXdrBase().replace(/\/+$/, '')
  const consoleBase = resolveSentinelOneConsoleBase().replace(/\/+$/, '')

  const epochMs = iso => {
    if (!iso) return null
    const n = Date.parse(iso)
    return Number.isFinite(n) ? n : null
  }
  const startMs = epochMs(start)
  const endMs = epochMs(end)

  const bodyEpoch = { query }
  if (startMs != null) bodyEpoch.startTime = startMs
  if (endMs != null) bodyEpoch.endTime = endMs
  if (limit != null) bodyEpoch.limit = limit
  if (priority) bodyEpoch.priority = priority

  const bodyIso = { query }
  if (start) bodyIso.start = start
  if (end) bodyIso.end = end
  if (limit != null) bodyIso.limit = limit
  if (priority) bodyIso.priority = priority

  const out = []
  if (xdrBase) {
    out.push({ url: `${xdrBase}/api/powerQuery`, body: bodyEpoch, label: 'xdr /api/powerQuery (epoch ms)' })
    out.push({ url: `${xdrBase}/api/powerQuery`, body: bodyIso, label: 'xdr /api/powerQuery (ISO time)' })
    out.push({ url: `${xdrBase}/api/v1/events`, body: bodyEpoch, label: 'xdr /api/v1/events (epoch ms)' })
    out.push({ url: `${xdrBase}/web/api/v2.1/dv/events/pq`, body: bodyIso, label: 'xdr legacy /dv/events/pq' })
  }
  if (consoleBase && consoleBase !== xdrBase) {
    out.push({ url: `${consoleBase}/web/api/v2.1/dv/events/pq`, body: bodyIso, label: 'console /dv/events/pq' })
  }
  return out
}

/** Single raw call to the XDR API — used by both PowerQuery and the /xdr/raw passthrough. */
export async function callSentinelOneXdr({ method = 'POST', url, body = null, authScheme = 'auto' } = {}) {
  const token = resolveSentinelOneXdrToken()
  if (!token) {
    const e = new Error('SentinelOne XDR token is not configured (SENTINEL_ONE_XDR_API_TOKEN or fallback SENTINEL_ONE_API_TOKEN).')
    e.code = 'S1_XDR_NOT_CONFIGURED'
    throw e
  }
  const schemes =
    authScheme === 'bearer'
      ? [`Bearer ${token}`]
      : authScheme === 'apitoken'
        ? [`ApiToken ${token}`]
        : authScheme === 'token'
          ? [`Token ${token}`]
          : [`Bearer ${token}`, `ApiToken ${token}`, `Token ${token}`]

  let lastErr = null
  for (let i = 0; i < schemes.length; i++) {
    const authorization = schemes[i]
    /** @type {RequestInit} */
    const init = {
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }
    if (body !== null) init.body = typeof body === 'string' ? body : JSON.stringify(body)

    let res
    try {
      res = await s1Fetch(url, init)
    } catch (netErr) {
      const wrapped = new Error(
        netErr?.cause?.message || netErr?.message || 'Cannot reach SentinelOne XDR Data Lake (TLS/DNS/network).',
      )
      wrapped.code = 'S1_NETWORK_ERROR'
      wrapped.cause = netErr
      throw wrapped
    }
    const rawText = await res.text().catch(() => '')
    let payload = null
    try {
      payload = rawText ? JSON.parse(rawText) : null
    } catch {
      payload = null
    }
    const result = {
      status: res.status,
      ok: res.ok,
      authScheme: authorization.split(' ')[0],
      url,
      body: payload != null ? payload : rawText,
      rawText,
    }
    if (res.ok) return result
    // 401/403 → try the next auth scheme; other status codes are returned to the caller.
    if ((res.status === 401 || res.status === 403) && i < schemes.length - 1) {
      lastErr = result
      continue
    }
    return result
  }
  return lastErr || { status: 0, ok: false, url, body: null, rawText: '' }
}

/**
 * Run a PowerQuery against the SentinelOne Singularity Data Lake (XDR).
 *
 * @returns {Promise<{ status, matchingEvents, omittedEvents, columns, rows, raw, attempt: { url, label, body } }>}
 */
export async function runSentinelOnePowerQuery({ query, start = null, end = null, limit = null, priority = 'low' } = {}) {
  const q = String(query || '').trim()
  if (!q) {
    const e = new Error('PowerQuery text required')
    e.code = 'S1_VALIDATION'
    throw e
  }
  const base = resolveSentinelOneXdrBase()
  const token = resolveSentinelOneXdrToken()
  if (!base || !token) {
    const e = new Error(
      'SentinelOne XDR Data Lake is not configured. Set SENTINEL_ONE_XDR_BASE_URL (e.g. https://xdr.ap1.sentinelone.net) and SENTINEL_ONE_XDR_API_TOKEN (Log Read Access).',
    )
    e.code = 'S1_XDR_NOT_CONFIGURED'
    throw e
  }

  const attempts = powerQueryAttempts({ query: q, start, end, limit, priority })
  const tried = []
  for (const att of attempts) {
    const r = await callSentinelOneXdr({ method: 'POST', url: att.url, body: att.body })
    tried.push({ url: att.url, label: att.label, status: r.status, body: trimPreview(r.rawText, 600) })
    if (r.ok) {
      let final = r.body
      // Some tenants reply with a queryId and require polling.
      const queryId =
        (final && typeof final === 'object' && (final.queryId || final.id || final.data?.queryId)) || null
      if (queryId && shouldPoll(final)) {
        try {
          const polled = await pollPowerQueryUntilReady({ base, queryId })
          if (polled) final = polled
        } catch {
          /* keep the initial response so the UI can still show partial info */
        }
      }
      const normalized = normalizePowerQueryResponse(final)
      normalized.attempt = { url: att.url, label: att.label }
      normalized.attempts = tried
      return normalized
    }
  }

  const last = tried[tried.length - 1] || { status: 0, body: '' }
  const err = new Error(
    `SentinelOne PowerQuery did not accept the request (HTTP ${last.status}). Last response: ${trimPreview(String(last.body || ''), 280) || 'no body'}.`,
  )
  err.code = 'S1_HTTP_ERROR'
  err.status = last.status || 502
  err.body = { attempts: tried }
  throw err
}

function shouldPoll(payload) {
  const status = String(payload?.status || payload?.queryStatus || payload?.state || '').toUpperCase()
  if (!status) return false
  return status !== 'SUCCESS' && status !== 'FINISHED' && status !== 'OK'
}

async function pollPowerQueryUntilReady({ base, queryId, timeoutMs = 60_000 }) {
  const xdrBase = base.replace(/\/+$/, '')
  const pingCandidates = [
    `${xdrBase}/api/powerQuery/ping/${encodeURIComponent(queryId)}`,
    `${xdrBase}/api/powerQuery?queryId=${encodeURIComponent(queryId)}`,
    `${xdrBase}/web/api/v2.1/dv/events/pq-ping?queryId=${encodeURIComponent(queryId)}`,
  ]
  const start = Date.now()
  let lastPayload = null
  while (Date.now() - start < timeoutMs) {
    for (const url of pingCandidates) {
      const r = await callSentinelOneXdr({ method: 'GET', url })
      if (r.ok && r.body) {
        lastPayload = r.body
        const stillRunning = shouldPoll(r.body)
        if (!stillRunning) return r.body
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  return lastPayload
}

function trimPreview(s, n) {
  const t = String(s || '')
  if (t.length <= n) return t
  return t.slice(0, n) + '…'
}

/**
 * SentinelOne returns either {data:{…}} or a flat top-level object depending on tenant.
 * We normalise to { status, matchingEvents, omittedEvents, columns[], rows[{…}], raw }.
 */
function normalizePowerQueryResponse(payload) {
  const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {}
  const status =
    root.status || root.queryStatus || root.state || (Array.isArray(root.results) ? 'SUCCESS' : 'UNKNOWN')

  // Result rows can arrive as:
  //   values:  [ [v1,v2,…], … ] with columns:[{name:'...'}] (current /api/powerQuery)
  //   results: [ {col:val,…}, … ]                            (XSOAR-like shape)
  //   results: [ [v1,v2,…], … ] with columns:[...]           (legacy /dv/events/pq)
  //   data|rows|events: [ … ]                                (older variants)
  const candidates = [root.values, root.results, root.data, root.rows, root.events].filter(Array.isArray)
  let rows = []
  let columns = []
  if (candidates.length) {
    const first = candidates[0]
    if (first.length === 0) {
      rows = []
      columns = Array.isArray(root.columns) ? root.columns.map(stringifyColumn) : []
    } else if (Array.isArray(first[0])) {
      const cols = Array.isArray(root.columns) ? root.columns.map(stringifyColumn) : first[0].map((_, i) => `col_${i}`)
      columns = cols
      rows = first.map(arr => {
        const o = {}
        for (let i = 0; i < cols.length; i++) o[cols[i]] = arr[i]
        return o
      })
    } else if (typeof first[0] === 'object' && first[0] !== null) {
      rows = first
      const set = new Set()
      for (const r of rows) for (const k of Object.keys(r)) set.add(k)
      columns = [...set]
    }
  }
  return {
    status,
    matchingEvents: numOrNull(root.matchingEvents ?? root.matching_events),
    omittedEvents: numOrNull(root.omittedEvents ?? root.omitted_events),
    columns,
    rows,
    raw: payload,
  }
}

function stringifyColumn(c) {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (typeof c === 'object') return c.name || c.field || c.title || JSON.stringify(c)
  return String(c)
}

function numOrNull(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** @param {string} verdict API values: undefined | false_positive | suspicious | true_positive */
export async function updateThreatAnalystVerdict(threatIds, verdict) {
  const ids = (threatIds || []).map(id => String(id).trim()).filter(Boolean)
  if (!ids.length) {
    const e = new Error('threat ids required')
    e.code = 'S1_VALIDATION'
    throw e
  }
  const v = String(verdict || '').trim()
  if (!v) {
    const e = new Error('analyst verdict required')
    e.code = 'S1_VALIDATION'
    throw e
  }
  const json = await s1Json('POST', 'threats/analyst-verdict', {
    bodyObj: {
      data: { analystVerdict: v },
      filter: { ids, tenant: 'true' },
    },
  })
  return json?.data ?? json
}
