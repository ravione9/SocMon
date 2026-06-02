/**
 * InfluxDB client for store network monitoring (PowerShell store-monitor.ps1 → store-monitoring bucket).
 */

import http from 'http'
import https from 'https'

const URL_ENV = 'INFLUX_URL'
const TOKEN_ENV = 'INFLUX_TOKEN'
const ORG_ENV = 'INFLUX_ORG'
const BUCKET_ENV = 'INFLUX_BUCKET'
const TLS_ENV = 'INFLUX_TLS_INSECURE'

function cfg() {
  return {
    url: String(process.env[URL_ENV] || '').trim().replace(/\/+$/, ''),
    token: String(process.env[TOKEN_ENV] || process.env.INFLUXDB_TOKEN || '').trim(),
    org: String(process.env[ORG_ENV] || 'lenskart').trim(),
    bucket: String(process.env[BUCKET_ENV] || 'store-monitoring').trim(),
    tlsInsecure: ['1', 'true', 'yes'].includes(String(process.env[TLS_ENV] || '').toLowerCase()),
  }
}

export function isInfluxStoreConfigured() {
  const c = cfg()
  return Boolean(c.url && c.token && c.org && c.bucket)
}

export function getInfluxStoreMeta() {
  const c = cfg()
  return {
    configured: isInfluxStoreConfigured(),
    url: c.url || null,
    org: c.org,
    bucket: c.bucket,
    urlEnv: URL_ENV,
    tokenEnv: TOKEN_ENV,
    orgEnv: ORG_ENV,
    bucketEnv: BUCKET_ENV,
    tlsEnv: TLS_ENV,
  }
}

function fluxEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Parse InfluxDB 2.x Flux CSV.
 * The format uses annotation rows (#datatype, #group, #default) followed by
 * a header row that starts with ",result,table,...". Multiple tables are
 * separated by blank lines and repeated annotation blocks.
 *
 * This parser is tolerant of:
 *  - Multiple tables (re-reads headers per table)
 *  - CSV-quoted fields (values wrapped in double-quotes)
 *  - Trailing empty rows
 */
export function parseFluxCsv(text) {
  const lines = String(text || '').split(/\r?\n/)
  const rows = []
  let headers = null

  function splitCsvLine(line) {
    const cols = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
        else if (ch === '"') { inQ = false }
        else { cur += ch }
      } else if (ch === '"') {
        inQ = true
      } else if (ch === ',') {
        cols.push(cur); cur = ''
      } else {
        cur += ch
      }
    }
    cols.push(cur)
    return cols
  }

  for (const line of lines) {
    if (line.startsWith('#')) continue          // annotation row
    if (!line.trim()) { headers = null; continue } // blank = table boundary

    const cols = splitCsvLine(line)
    // Header rows can be either:
    //   ",result,table,..."
    // or "result,table,..."
    if (cols[0] === 'result' || cols[1] === 'result' || (cols[0] === '' && cols[1] === 'result')) {
      headers = cols
      continue
    }
    if (!headers) continue
    if (cols.length < 2) continue

    const row = {}
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = cols[i] ?? ''
    }
    // Skip annotation data rows (cols[0] matches '#datatype' etc already caught above)
    rows.push(row)
  }
  return rows
}

function httpPost(url, headers, body, tlsInsecure) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 90000,
    }
    if (tlsInsecure && u.protocol === 'https:') {
      opts.rejectUnauthorized = false
    }
    const req = lib.request(opts, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode >= 400) {
          const err = new Error(text.slice(0, 500) || `InfluxDB HTTP ${res.statusCode}`)
          err.status = res.statusCode
          reject(err)
          return
        }
        resolve(text)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('InfluxDB query timeout')))
    req.write(body)
    req.end()
  })
}

async function httpPostFetch(url, headers, body, tlsInsecure) {
  if (typeof fetch === 'function') {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(90000),
      ...(tlsInsecure && url.startsWith('https:') ? { dispatcher: undefined } : {}),
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(text.slice(0, 500) || `InfluxDB HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return text
  }
  return httpPost(url, headers, body, tlsInsecure)
}

export async function queryFluxRaw(flux) {
  const c = cfg()
  if (!isInfluxStoreConfigured()) {
    const err = new Error('InfluxDB not configured')
    err.code = 'INFLUX_NOT_CONFIGURED'
    throw err
  }
  const url = `${c.url}/api/v2/query?org=${encodeURIComponent(c.org)}`
  const headers = {
    Authorization: `Token ${c.token}`,
    Accept: 'application/csv',
    'Content-Type': 'application/vnd.flux',
  }
  return httpPostFetch(url, headers, flux, c.tlsInsecure)
}

export async function queryFlux(flux) {
  const text = await queryFluxRaw(flux)
  return parseFluxCsv(text)
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function bool(v) {
  if (v === true || v === 'true' || v === '1') return true
  if (v === false || v === 'false' || v === '0') return false
  return null
}

function rowTime(row) {
  const t = row._time
  if (!t) return null
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function buildSyntheticStoreTag(hostname, serial) {
  return `hs:${String(hostname || 'unknown')}|${String(serial || 'unknown')}`
}

function parseSyntheticStoreTag(tag) {
  const s = String(tag || '')
  if (!s.startsWith('hs:')) return null
  const body = s.slice(3)
  const idx = body.indexOf('|')
  if (idx < 0) return { hostname: body || 'unknown', serial: 'unknown' }
  return {
    hostname: body.slice(0, idx) || 'unknown',
    serial: body.slice(idx + 1) || 'unknown',
  }
}

/** Latest heartbeat per store → online + lastSeen. */
async function fetchHeartbeats(range = '-15m') {
  const flux = `
from(bucket: "${fluxEscape(cfg().bucket)}")
  |> range(start: ${range})
  |> filter(fn: (r) => r._measurement == "heartbeat" and r._field == "online")
  |> group(columns: ["store_tag", "hostname", "serial"])
  |> last()
`
  try { return await queryFlux(flux) } catch (e) {
    console.warn('[influxStore] fetchHeartbeats failed:', e.message)
    return []
  }
}

/** Latest row per store tag from any measurement (fallback discovery). */
async function fetchStoreIdentityLatest(range = '-7d') {
  const flux = `
from(bucket: "${fluxEscape(cfg().bucket)}")
  |> range(start: ${range})
  |> filter(fn: (r) => exists r.store_tag or exists r.hostname or exists r.serial)
  |> keep(columns: ["_time", "store_tag", "hostname", "serial"])
  |> group(columns: ["store_tag", "hostname", "serial"])
  |> max(column: "_time")
`
  try { return await queryFlux(flux) } catch (e) {
    console.warn('[influxStore] fetchStoreIdentityLatest failed:', e.message)
    return []
  }
}

async function fetchMeasurementLatest(measurement, range = '-15m', extraFilter = '') {
  const filter = extraFilter ? ` and ${extraFilter}` : ''
  const flux = `
from(bucket: "${fluxEscape(cfg().bucket)}")
  |> range(start: ${range})
  |> filter(fn: (r) => r._measurement == "${fluxEscape(measurement)}"${filter})
  |> group(columns: ["store_tag", "hostname", "serial", "_field"])
  |> last()
`
  try { return await queryFlux(flux) } catch (e) {
    console.warn(`[influxStore] fetchMeasurementLatest(${measurement}) failed:`, e.message)
    return []
  }
}

/**
 * Get the LATEST row per store for a measurement that uses extra tag columns.
 * Groups by all tag columns so every unique tag combination is a separate row.
 * The caller merges multiple rows per store — this lets the JS layer prefer
 * the most-meaningful value (e.g. non-"unknown" gateway_vendor).
 */
async function fetchTaggedLatest(measurement, tagColumns, range = '-15m') {
  const cols = ['store_tag', 'hostname', 'serial', ...tagColumns, '_field'].map((c) => `"${c}"`).join(', ')
  const flux = `
from(bucket: "${fluxEscape(cfg().bucket)}")
  |> range(start: ${range})
  |> filter(fn: (r) => r._measurement == "${fluxEscape(measurement)}")
  |> group(columns: [${cols}])
  |> last()
`
  try { return await queryFlux(flux) } catch (e) {
    console.warn(`[influxStore] fetchTaggedLatest(${measurement}) failed:`, e.message)
    return []
  }
}

function ensureStore(map, row) {
  const hostname = row.hostname || ''
  const serial = row.serial || ''
  const storeTag = row.store_tag || buildSyntheticStoreTag(hostname, serial)
  if (!storeTag) return null
  if (!map.has(storeTag)) {
    map.set(storeTag, {
      storeTag,
      hostname: hostname,
      serial: serial,
      online: false,
      lastSeen: null,
      connState: 'unknown',
      activeInterface: '',
      activeSsid: '',
      gatewayIp: '',
      gatewayVendor: '',
      isHotspot: false,
      isFortinet: false,
      ping: {},
      dns: {},
      http: {},
      cpuPct: null,
      memPct: null,
      downloadMbps: null,
      uploadMbps: null,
      issues: [],
    })
  }
  return map.get(storeTag)
}

function detectIssues(store, staleMinutes = 10) {
  const issues = []
  // Only flag offline if we have never seen a heartbeat in the stale window.
  // Don't penalise stores that simply haven't been discovered via heartbeat yet.
  if (store.hadHeartbeat && !store.online) {
    const staleLabel = staleMinutes >= 60 ? `${Math.round(staleMinutes / 60)} hour` : `${staleMinutes} min`
    issues.push({ severity: 'critical', code: 'offline', message: `No heartbeat in last ${staleLabel}` })
  }
  if (store.connState === 'isp_down') issues.push({ severity: 'critical', code: 'isp_down', message: 'ISP / internet down' })
  if (store.connState === 'hotspot' || store.isHotspot) issues.push({ severity: 'high', code: 'hotspot', message: 'Running on mobile hotspot' })
  if (store.connState === 'no_connectivity') issues.push({ severity: 'high', code: 'no_connectivity', message: 'No network connectivity' })

  // Ping: only flag if ALL targets with data show the problem (one healthy target = no issue)
  const pingEntries = Object.entries(store.ping)
  if (pingEntries.length) {
    const lossEntries = pingEntries.filter(([, p]) => p.packetLossPct != null)
    if (lossEntries.length && lossEntries.every(([, p]) => p.packetLossPct >= 5)) {
      const worst = lossEntries.reduce((a, b) => b[1].packetLossPct > a[1].packetLossPct ? b : a)
      issues.push({ severity: 'high', code: 'packet_loss', message: `High packet loss to all targets (worst: ${worst[0]} ${worst[1].packetLossPct}%)` })
    }
    const latEntries = pingEntries.filter(([, p]) => p.avgMs != null)
    if (latEntries.length && latEntries.every(([, p]) => p.avgMs >= 200)) {
      const worst = latEntries.reduce((a, b) => b[1].avgMs > a[1].avgMs ? b : a)
      issues.push({ severity: 'warning', code: 'latency', message: `High latency to all targets (worst: ${worst[0]} ${worst[1].avgMs} ms)` })
    }
  }

  if (store.cpuPct != null && store.cpuPct >= 90) issues.push({ severity: 'warning', code: 'cpu', message: `High CPU (${store.cpuPct}%)` })
  if (store.memPct != null && store.memPct >= 90) issues.push({ severity: 'warning', code: 'memory', message: `High memory (${store.memPct}%)` })

  // DNS: only flag if ALL domains fail (one passing domain = no issue)
  const dnsEntries = Object.entries(store.dns)
  if (dnsEntries.length) {
    const withResult = dnsEntries.filter(([, d]) => d.success != null)
    if (withResult.length && withResult.every(([, d]) => d.success === false)) {
      issues.push({ severity: 'high', code: 'dns', message: `DNS failure on all checks (${withResult.map(([d]) => d).join(', ')})` })
    }
  }

  // HTTP: only flag if ALL URLs fail (one passing URL = no issue)
  const httpEntries = Object.entries(store.http)
  if (httpEntries.length) {
    const withResult = httpEntries.filter(([, h]) => h.success != null || h.statusCode != null)
    if (withResult.length && withResult.every(([, h]) => h.success === false || (h.statusCode != null && h.statusCode >= 500))) {
      issues.push({ severity: 'high', code: 'http', message: `HTTP check failed on all URLs (${withResult.map(([u]) => u).join(', ')})` })
    }
  }

  if (store.downloadMbps === 0 || store.uploadMbps === 0) {
    issues.push({ severity: 'warning', code: 'speedtest', message: 'Speedtest download/upload reported 0 Mbps' })
  }
  store.issues = issues
  store.issueCount = issues.length
  store.severity = issues.some((i) => i.severity === 'critical')
    ? 'critical'
    : issues.some((i) => i.severity === 'high')
      ? 'high'
      : issues.some((i) => i.severity === 'warning')
        ? 'warning'
        : 'ok'
}

/* ── Snapshot cache ──────────────────────────────────────────────────────────
 * Caches the last fetchStoreSnapshot result keyed by (metricRange, fromTs, toTs).
 * Default TTL = 90 s — prevents concurrent requests and the alert-engine poll
 * from each firing 8 parallel Influx queries.
 * Custom time-range results are cached for only 30 s.
 * ─────────────────────────────────────────────────────────────────────────── */
const _snapshotCache = new Map()
const CACHE_TTL_DEFAULT_MS = 90_000
const CACHE_TTL_CUSTOM_MS  = 30_000

function _snapshotCacheKey(metricRange, fromTs, toTs) {
  return `${metricRange}|${fromTs ?? ''}|${toTs ?? ''}`
}

function _getCachedSnapshot(key) {
  const entry = _snapshotCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > entry.ttl) { _snapshotCache.delete(key); return null }
  return entry.data
}

function _setCachedSnapshot(key, data, isCustom) {
  _snapshotCache.set(key, { data, ts: Date.now(), ttl: isCustom ? CACHE_TTL_CUSTOM_MS : CACHE_TTL_DEFAULT_MS })
  // Keep map small — evict oldest entries beyond 10 slots
  if (_snapshotCache.size > 10) {
    const oldest = [..._snapshotCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) _snapshotCache.delete(oldest[0])
  }
}

/**
 * @param {number}  staleMinutes
 * @param {string}  metricRange   Flux relative range e.g. '-24h'
 * @param {number}  [fromTs]      Custom window start (Unix sec) — overrides metricRange
 * @param {number}  [toTs]        Custom window end   (Unix sec)
 */
export async function fetchStoreSnapshot(staleMinutes = 10, metricRange = '-24h', fromTs, toTs) {
  const cacheKey = _snapshotCacheKey(metricRange, fromTs, toTs)
  const cached = _getCachedSnapshot(cacheKey)
  if (cached) return cached

  // If a fetch for the same key is already in-flight, wait for it instead of
  // launching a duplicate set of 8 parallel Influx queries.
  if (_snapshotCache.has(`inflight:${cacheKey}`)) {
    return _snapshotCache.get(`inflight:${cacheKey}`)
  }

  const discoveryRange = '-7d'

  // When custom from/to is provided build an explicit Flux range clause
  let rangeClause
  if (fromTs && Number.isFinite(Number(fromTs))) {
    const startISO = new Date(Number(fromTs) * 1000).toISOString()
    const stopISO  = toTs && Number.isFinite(Number(toTs))
      ? new Date(Number(toTs) * 1000).toISOString()
      : new Date().toISOString()
    rangeClause = `start: ${startISO}, stop: ${stopISO}`
  } else {
    rangeClause = `start: ${metricRange}`
  }

  const isCustom = rangeClause !== `start: ${metricRange}`
  const bucket = fluxEscape(cfg().bucket)

  const fetchPromise = _doFetchStoreSnapshot(staleMinutes, metricRange, discoveryRange, rangeClause, isCustom, bucket)
  _snapshotCache.set(`inflight:${cacheKey}`, fetchPromise)
  try {
    const result = await fetchPromise
    _setCachedSnapshot(cacheKey, result, isCustom)
    return result
  } finally {
    _snapshotCache.delete(`inflight:${cacheKey}`)
  }
}

async function _doFetchStoreSnapshot(staleMinutes, metricRange, discoveryRange, rangeClause, isCustom, bucket) {

  /* Run a tagged-latest or measurement-latest query using the resolved range clause */
  async function runTagged(measurement, tagColumns) {
    if (!isCustom) return fetchTaggedLatest(measurement, tagColumns, metricRange)
    const cols = ['store_tag', 'hostname', 'serial', ...tagColumns, '_field'].map((c) => `"${c}"`).join(', ')
    const flux = `from(bucket: "${bucket}") |> range(${rangeClause}) |> filter(fn: (r) => r._measurement == "${fluxEscape(measurement)}") |> group(columns: [${cols}]) |> last()`
    try { return await queryFlux(flux) } catch (e) { console.warn(`[influxStore] runTagged(${measurement}):`, e.message); return [] }
  }

  async function runMeasurement(measurement) {
    if (!isCustom) return fetchMeasurementLatest(measurement, metricRange)
    const flux = `from(bucket: "${bucket}") |> range(${rangeClause}) |> filter(fn: (r) => r._measurement == "${fluxEscape(measurement)}") |> group(columns: ["store_tag", "hostname", "serial", "_field"]) |> last()`
    try { return await queryFlux(flux) } catch (e) { console.warn(`[influxStore] runMeasurement(${measurement}):`, e.message); return [] }
  }

  async function runHeartbeats() {
    if (!isCustom) return fetchHeartbeats(metricRange)
    const flux = `from(bucket: "${bucket}") |> range(${rangeClause}) |> filter(fn: (r) => r._measurement == "heartbeat" and r._field == "online") |> group(columns: ["store_tag", "hostname", "serial"]) |> last()`
    try { return await queryFlux(flux) } catch (e) { console.warn('[influxStore] runHeartbeats:', e.message); return [] }
  }

  const speedRange = metricRange === '-7d' ? '-7d' : '-24h'
  const [identityRows, heartbeats, connectivity, pingRows, dnsRows, httpRows, systemRows, speedRows] = await Promise.all([
    fetchStoreIdentityLatest(discoveryRange),
    runHeartbeats(),
    runTagged('connectivity', ['conn_state', 'active_interface', 'active_ssid', 'gateway_ip', 'gateway_vendor']),
    runTagged('ping', ['target']),
    runTagged('dns_query', ['domain']),
    runTagged('http_response', ['url']),
    runMeasurement('system'),
    isCustom ? runMeasurement('speedtest') : fetchMeasurementLatest('speedtest', speedRange),
  ])

  const stores = new Map()
  const now = Date.now()
  const staleMs = staleMinutes * 60 * 1000

  for (const row of identityRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    const t = row._time ? new Date(row._time).getTime() : 0
    if (t > 0) {
      s.lastSeen = rowTime(row)
      // Fallback online heuristic when heartbeat is unavailable.
      s.online = now - t <= staleMs
    }
    s.hostname = row.hostname || s.hostname
    s.serial = row.serial || s.serial
  }

  for (const row of heartbeats) {
    const s = ensureStore(stores, row)
    if (!s) continue
    const t = row._time ? new Date(row._time).getTime() : 0
    s.lastSeen = rowTime(row)
    s.online = num(row._value) === 1 && t > 0 && now - t <= staleMs
    s.hadHeartbeat = true
    s.hostname = row.hostname || s.hostname
    s.serial = row.serial || s.serial
  }

  // Placeholder values written by the PS agent when detection fails — not real vendors
  const VENDOR_FALLBACKS = new Set(['unknown', 'unidentified', '', 'n/a', 'none'])

  function isMeaningfulVendor(v) {
    return v && !VENDOR_FALLBACKS.has(String(v).toLowerCase().trim())
  }

  for (const row of connectivity) {
    const s = ensureStore(stores, row)
    if (!s) continue

    // Prefer non-fallback connectivity values; only overwrite if the new value is better
    if (row.conn_state && row.conn_state !== 'unknown') s.connState = row.conn_state
    else if (!s.connState || s.connState === 'unknown') s.connState = row.conn_state || s.connState

    if (row.active_interface) s.activeInterface = row.active_interface
    if (row.active_ssid && row.active_ssid !== 'n/a') s.activeSsid = row.active_ssid

    if (row.gateway_ip && row.gateway_ip !== 'n/a') s.gatewayIp = row.gateway_ip

    // Prefer any known vendor over "unknown"/"unidentified"
    const rowVendor = row.gateway_vendor
    if (isMeaningfulVendor(rowVendor)) {
      s.gatewayVendor = rowVendor
    } else if (!isMeaningfulVendor(s.gatewayVendor)) {
      s.gatewayVendor = rowVendor || s.gatewayVendor
    }

    if (row._field === 'is_hotspot') s.isHotspot = String(row._value).toLowerCase() === 'true'
    if (row._field === 'is_fortinet') s.isFortinet = String(row._value).toLowerCase() === 'true'
    if (!s.lastSeen && row._time) s.lastSeen = rowTime(row)
  }

  for (const row of pingRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    const target = row.target || 'unknown'
    if (!s.ping[target]) s.ping[target] = {}
    if (row._field === 'average_response_ms') s.ping[target].avgMs = num(row._value)
    if (row._field === 'packet_loss_pct') s.ping[target].packetLossPct = num(row._value)
    if (row._field === 'min_ms') s.ping[target].minMs = num(row._value)
    if (row._field === 'max_ms') s.ping[target].maxMs = num(row._value)
  }

  for (const row of dnsRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    const domain = row.domain || 'unknown'
    if (!s.dns[domain]) s.dns[domain] = {}
    if (row._field === 'response_ms') s.dns[domain].responseMs = num(row._value)
    if (row._field === 'success') s.dns[domain].success = bool(row._value)
  }

  for (const row of httpRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    const url = row.url || 'unknown'
    if (!s.http[url]) s.http[url] = {}
    if (row._field === 'response_ms') s.http[url].responseMs = num(row._value)
    if (row._field === 'status_code') s.http[url].statusCode = num(row._value)
    if (row._field === 'success') s.http[url].success = bool(row._value)
  }

  for (const row of systemRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    if (row._field === 'cpu_usage_pct') s.cpuPct = num(row._value)
    if (row._field === 'mem_used_pct') s.memPct = num(row._value)
  }

  for (const row of speedRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    if (row._field === 'download_mbps') s.downloadMbps = num(row._value)
    if (row._field === 'upload_mbps') s.uploadMbps = num(row._value)
  }

  const list = [...stores.values()]
  for (const s of list) detectIssues(s, staleMinutes)
  list.sort((a, b) => {
    const sev = { critical: 0, high: 1, warning: 2, ok: 3 }
    const d = (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9)
    if (d !== 0) return d
    return String(a.hostname).localeCompare(String(b.hostname))
  })
  return list
}

/**
 * @param {string}  storeTag
 * @param {number}  rangeSec   - relative seconds back from now (used when fromSec/toSec absent)
 * @param {number}  [fromSec]  - Unix epoch seconds (custom range start)
 * @param {number}  [toSec]    - Unix epoch seconds (custom range stop)
 */
export async function fetchStoreHistory(storeTag, rangeSec = 3600, fromSec, toSec) {
  const tag = fluxEscape(storeTag)
  const synthetic = parseSyntheticStoreTag(storeTag)
  const filterExpr = synthetic
    ? `r.hostname == "${fluxEscape(synthetic.hostname)}" and r.serial == "${fluxEscape(synthetic.serial)}"`
    : `r.store_tag == "${tag}"`

  let rangeClause
  if (fromSec && Number.isFinite(Number(fromSec))) {
    const startISO = new Date(Number(fromSec) * 1000).toISOString()
    const stopISO  = toSec && Number.isFinite(Number(toSec))
      ? new Date(Number(toSec) * 1000).toISOString()
      : new Date().toISOString()
    rangeClause = `start: ${startISO}, stop: ${stopISO}`
  } else {
    const start = rangeSec >= 86400 ? `-${Math.ceil(rangeSec / 86400)}d` : `-${rangeSec}s`
    rangeClause = `start: ${start}`
  }

  const flux = `
from(bucket: "${fluxEscape(cfg().bucket)}")
  |> range(${rangeClause})
  |> filter(fn: (r) => ${filterExpr})
  |> filter(fn: (r) => r._measurement == "ping" or r._measurement == "system" or r._measurement == "speedtest" or r._measurement == "connectivity")
  |> group(columns: ["_measurement", "_field", "target"])
  |> sort(columns: ["_time"])
`
  const rows = await queryFlux(flux)
  const seriesMap = new Map()

  for (const row of rows) {
    const meas = row._measurement
    const field = row._field
    const target = row.target || ''
    const key = `${meas}|${field}|${target}`
    if (!seriesMap.has(key)) {
      seriesMap.set(key, {
        measurement: meas,
        field,
        target: target || undefined,
        name: target ? `${meas}.${field} (${target})` : `${meas}.${field}`,
        points: [],
      })
    }
    const ts = row._time ? Math.floor(new Date(row._time).getTime() / 1000) : null
    const val = num(row._value)
    if (ts != null && val != null) {
      seriesMap.get(key).points.push({ clock: ts, value: val })
    }
  }

  const allPoints = [...seriesMap.values()].flatMap((s) => s.points.map((p) => p.clock))
  const minClock = allPoints.length ? Math.min(...allPoints) : null
  const maxClock = allPoints.length ? Math.max(...allPoints) : null

  // Compute the actual requested window so the client can anchor the chart axes
  const nowSec = Math.floor(Date.now() / 1000)
  const requestedFromSec = fromSec ? Number(fromSec) : nowSec - rangeSec
  const requestedToSec   = toSec   ? Number(toSec)   : nowSec

  return {
    storeTag,
    rangeSec,
    requestedFrom: new Date(requestedFromSec * 1000).toISOString(),
    requestedTo:   new Date(requestedToSec   * 1000).toISOString(),
    dataFrom:   minClock ? new Date(minClock * 1000).toISOString() : null,
    dataTo:     maxClock ? new Date(maxClock * 1000).toISOString() : null,
    pointCount: allPoints.length,
    series:     [...seriesMap.values()],
  }
}

function parseInfluxErrorMessage(err) {
  const raw = String(err?.message || err || '')
  try {
    const j = JSON.parse(raw)
    if (j?.message) return j.message
  } catch {
    /* plain text */
  }
  return raw
}

async function testInfluxWriteAccess() {
  const c = cfg()
  const url = `${c.url}/api/v2/write?org=${encodeURIComponent(c.org)}&bucket=${encodeURIComponent(c.bucket)}&precision=ns`
  const headers = {
    Authorization: `Token ${c.token}`,
    'Content-Type': 'text/plain; charset=utf-8',
  }
  const body = `netpulse_probe,source=netpulse value=1i ${Date.now()}000000`
  try {
    if (typeof fetch === 'function') {
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) })
      return res.status === 204
    }
    await httpPost(url, headers, body, c.tlsInsecure)
    return true
  } catch {
    return false
  }
}

export async function pingInflux() {
  if (!isInfluxStoreConfigured()) {
    return { ok: false, configured: false, message: 'InfluxDB env vars not set' }
  }
  const meta = getInfluxStoreMeta()
  try {
    const flux = `
from(bucket: "${fluxEscape(cfg().bucket)}")
  |> range(start: -30d)
  |> limit(n: 1)
`
    const rows = await queryFlux(flux)
    return { ok: true, configured: true, readAccess: true, hasData: rows.length > 0, ...meta }
  } catch (e) {
    const msg = parseInfluxErrorMessage(e)
    const bucketMissing = /could not find bucket/i.test(msg)
    let hint = msg
    if (bucketMissing) {
      const canWrite = await testInfluxWriteAccess()
      if (canWrite) {
        hint =
          `Bucket "${meta.bucket}" exists and the token can WRITE, but Flux queries fail (read denied). ` +
          'In InfluxDB → Data → API Tokens, grant this token Read (or Read/Write) on the store-monitoring bucket, then update INFLUX_TOKEN.'
      } else {
        hint =
          `Bucket "${meta.bucket}" was not found for org "${meta.org}". ` +
          'Confirm INFLUX_ORG and INFLUX_BUCKET match the bucket shown in the InfluxDB UI.'
      }
    }
    return { ok: false, configured: true, readAccess: false, hasData: false, error: hint, rawError: msg, ...meta }
  }
}

export function buildOverviewSummary(stores) {
  const total = stores.length
  const online = stores.filter((s) => s.online).length
  const offline = total - online
  const withIssues = stores.filter((s) => s.issueCount > 0).length
  const connBreakdown = {}
  const vendorBreakdown = {}
  let avgPing = 0
  let pingCount = 0
  let avgDownload = 0
  let dlCount = 0

  for (const s of stores) {
    connBreakdown[s.connState] = (connBreakdown[s.connState] || 0) + 1
    const v = s.gatewayVendor || 'unknown'
    vendorBreakdown[v] = (vendorBreakdown[v] || 0) + 1
    const p = s.ping['8.8.8.8'] || s.ping['google.com'] || Object.values(s.ping)[0]
    if (p?.avgMs != null) {
      avgPing += p.avgMs
      pingCount++
    }
    if (s.downloadMbps != null && s.downloadMbps > 0) {
      avgDownload += s.downloadMbps
      dlCount++
    }
  }

  return {
    total,
    online,
    offline,
    withIssues,
    connBreakdown,
    vendorBreakdown,
    avgPingMs: pingCount ? Math.round((avgPing / pingCount) * 10) / 10 : null,
    avgDownloadMbps: dlCount ? Math.round((avgDownload / dlCount) * 10) / 10 : null,
  }
}

/* ═══════════════════════════════════════════════════════════
   CRASH EVENTS — all crash-type measurements:
     app_crash, app_wer_report, app_hang, dotnet_crash,
     app_critical, service_crash, unexpected_shutdown,
     bsod_kernel_power, app_crash_wer
   Tags:   store_tag, hostname, serial, app_name, app_version
   Fields: count, event_id, message
   ═══════════════════════════════════════════════════════════ */

export const CRASH_MEASUREMENTS = [
  'app_crash', 'app_wer_report', 'app_hang', 'dotnet_crash',
  'app_critical', 'service_crash', 'unexpected_shutdown',
  'bsod_kernel_power', 'app_crash_wer',
]

/** Derive display severity from measurement name */
export function crashSeverity(meas) {
  return ['app_critical', 'bsod_kernel_power'].includes(meas) ? 'critical' : 'error'
}

/** Human-readable crash type label */
export function crashTypeLabel(meas) {
  const MAP = {
    app_crash:            'App Crash (1000)',
    app_wer_report:       'WER Report (1001)',
    app_hang:             'App Hang (1002)',
    dotnet_crash:         '.NET Crash (1026)',
    app_critical:         'App Critical',
    service_crash:        'Service Crash (7031/7034)',
    unexpected_shutdown:  'Unexpected Shutdown (6008)',
    bsod_kernel_power:    'BSOD / Kernel Power (41)',
    app_crash_wer:        'WER Folder Crash',
  }
  return MAP[meas] || meas
}

/**
 * Fetch raw crash event rows within a time range.
 * Returns all fields grouped by store + app + crash type.
 */
export async function fetchCrashEvents(rangeParam = '-24h', fromSec, toSec) {
  const bucket = fluxEscape(cfg().bucket)
  let rangeClause
  if (fromSec && Number.isFinite(Number(fromSec))) {
    const startISO = new Date(Number(fromSec) * 1000).toISOString()
    const stopISO  = toSec && Number.isFinite(Number(toSec))
      ? new Date(Number(toSec) * 1000).toISOString()
      : new Date().toISOString()
    rangeClause = `start: ${startISO}, stop: ${stopISO}`
  } else {
    rangeClause = `start: ${rangeParam}`
  }

  const measureFilter = CRASH_MEASUREMENTS.map(m => `r._measurement == "${m}"`).join(' or ')
  const flux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => ${measureFilter})
  |> group(columns: ["_measurement", "store_tag", "hostname", "serial", "app_name", "app_version", "_field"])
  |> sort(columns: ["_time"], desc: true)
`
  try {
    return await queryFlux(flux)
  } catch (e) {
    console.warn('[influxStore] fetchCrashEvents failed:', e.message)
    return []
  }
}

/**
 * Aggregate crash events into a summary per store + app.
 * Returns: [ { hostname, serial, storeTag, appName, appVersion,
 *              totalCrashes, lastEventId, lastMessage, lastSeen } ]
 */
export async function fetchCrashSummary(rangeParam = '-24h', fromSec, toSec) {
  const rows = await fetchCrashEvents(rangeParam, fromSec, toSec)
  const map  = new Map()

  for (const row of rows) {
    const crashType = row._measurement || 'app_crash'
    const key = `${row.store_tag||row.hostname}||${row.app_name||''}||${row.app_version||''}||${crashType}`
    if (!map.has(key)) {
      map.set(key, {
        storeTag:     row.store_tag || '',
        hostname:     row.hostname  || '',
        serial:       row.serial    || '',
        appName:      row.app_name  || null,
        appVersion:   row.app_version || '',
        crashType,
        crashSeverity: crashSeverity(crashType),
        totalCrashes: 0,
        lastEventId:  null,
        lastMessage:  null,
        lastSeen:     null,
      })
    }
    const s = map.get(key)
    if (row._field === 'count')    s.totalCrashes += num(row._value) || 1
    if (row._field === 'event_id') s.lastEventId  = row._value
    if (row._field === 'message')  s.lastMessage  = row._value
    if (row._time && (!s.lastSeen || row._time > s.lastSeen)) s.lastSeen = row._time
  }

  const BLANK_APP = new Set(['none', 'null', 'n/a', '', 'undefined', 'unknown'])
  const normalizeApp = (v) => (!v || BLANK_APP.has(String(v).toLowerCase().trim())) ? null : v

  const normalized = [...map.values()].map((s) => ({
    ...s,
    appName: normalizeApp(s.appName),
  }))
  normalized.sort((a, b) => b.totalCrashes - a.totalCrashes)
  return normalized
}

/**
 * Per-store crash count in the last N minutes — used by the alert engine.
 */
export async function fetchCrashCountsPerStore(rangeParam = '-15m') {
  const rows = await fetchCrashEvents(rangeParam)
  const counts = new Map()
  for (const row of rows) {
    if (row._field !== 'count') continue
    const key = row.store_tag || row.hostname
    counts.set(key, (counts.get(key) || 0) + (num(row._value) || 1))
  }
  return counts
}
