/**
 * InfluxDB client for store network monitoring (PowerShell store-monitor.ps1 → store-monitoring bucket).
 */

import http from 'http'
import https from 'https'

const URL_ENV = 'INFLUX_URL'
const TOKEN_ENV = 'INFLUX_TOKEN'
const ORG_ENV = 'INFLUX_ORG'
const BUCKET_ENV = 'INFLUX_BUCKET'
const ROLLUPS_BUCKET_ENV = 'INFLUX_ROLLUPS_BUCKET'
const TLS_ENV = 'INFLUX_TLS_INSECURE'
const QUERY_TIMEOUT_ENV = 'INFLUX_QUERY_TIMEOUT_MS'

function queryTimeoutMs() {
  const n = parseInt(process.env[QUERY_TIMEOUT_ENV] || '180000', 10)
  return Number.isFinite(n) && n >= 30000 ? n : 180000
}

function cfg() {
  return {
    url: String(process.env[URL_ENV] || '').trim().replace(/\/+$/, ''),
    token: String(process.env[TOKEN_ENV] || process.env.INFLUXDB_TOKEN || '').trim(),
    org: String(process.env[ORG_ENV] || 'lenskart').trim(),
    bucket: String(process.env[BUCKET_ENV] || 'store-monitoring').trim(),
    rollupsBucket: String(process.env[ROLLUPS_BUCKET_ENV] || '').trim(),
    tlsInsecure: ['1', 'true', 'yes'].includes(String(process.env[TLS_ENV] || '').toLowerCase()),
    queryTimeoutMs: queryTimeoutMs(),
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
    rollupsBucket: c.rollupsBucket || null,
    urlEnv: URL_ENV,
    tokenEnv: TOKEN_ENV,
    orgEnv: ORG_ENV,
    bucketEnv: BUCKET_ENV,
    rollupsBucketEnv: ROLLUPS_BUCKET_ENV,
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
  const timeoutMs = cfg().queryTimeoutMs
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
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
    req.on('timeout', () => req.destroy(new Error(`InfluxDB query timeout after ${timeoutMs}ms`)))
    req.write(body)
    req.end()
  })
}

async function httpPostFetch(url, headers, body, tlsInsecure) {
  const timeoutMs = cfg().queryTimeoutMs
  const doHttp = () => httpPost(url, headers, body, tlsInsecure)

  if (typeof fetch !== 'function') return doHttp()

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
      ...(tlsInsecure && url.startsWith('https:') ? { dispatcher: undefined } : {}),
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(text.slice(0, 500) || `InfluxDB HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return text
  } catch (e) {
    const detail = e.cause?.code || e.cause?.message || e.message || 'unknown'
    const connErr = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|ENETUNREACH/i.test(String(detail))
    if (connErr) {
      try {
        console.warn('[influxStore] fetch() failed, retrying via http/https:', detail)
        return await doHttp()
      } catch (e2) {
        const c = cfg()
        throw new Error(
          `Cannot connect to InfluxDB at ${c.url} (${e2.message || detail}). ` +
          'Verify INFLUX_URL is reachable from the Netpulse server and port 8086 is open.',
        )
      }
    }
    throw e
  }
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

/** One lightweight identity query — last row per store for a single measurement. */
async function fetchStoreIdentityByMeasurement(measurement, range) {
  const flux = `
from(bucket: "${fluxEscape(cfg().bucket)}")
  |> range(start: ${range})
  |> filter(fn: (r) => r._measurement == "${fluxEscape(measurement)}")
  |> filter(fn: (r) => exists r.store_tag or exists r.hostname or exists r.serial)
  |> group(columns: ["store_tag", "hostname", "serial"])
  |> last()
`
  try { return await queryFlux(flux) } catch (e) {
    console.warn(`[influxStore] fetchStoreIdentityByMeasurement(${measurement}) failed:`, e.message)
    return []
  }
}

/**
 * Discover all known stores for the dashboard total.
 *
 * Uses two fast parallel queries instead of one heavy multi-measurement scan:
 *   1. heartbeat  → 7-day catalog (~3000 stores; primary source)
 *   2. connectivity → 24h supplement (agents without heartbeat module)
 *
 * `_measurement` is tagged on each row so the merge loop sets `hadHeartbeat`
 * only for genuine heartbeat rows (offline alert rule).
 */
async function fetchStoreIdentityLatest(supplementRange = '-24h') {
  const [heartbeatRows, connectivityRows] = await Promise.all([
    fetchStoreIdentityByMeasurement('heartbeat', '-7d'),
    fetchStoreIdentityByMeasurement('connectivity', supplementRange),
  ])
  if (heartbeatRows.length < 500) {
    console.warn(
      `[influxStore] heartbeat identity returned only ${heartbeatRows.length} stores (7d window) — ` +
      `connectivity supplement: ${connectivityRows.length}`,
    )
  }
  return [
    ...heartbeatRows.map((r) => ({ ...r, _measurement: 'heartbeat' })),
    ...connectivityRows.map((r) => ({ ...r, _measurement: 'connectivity' })),
  ]
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
const VENDOR_FALLBACKS = new Set(['unknown', 'unidentified', '', 'n/a', 'none'])
/** Lookback for last-known gateway vendor (SD-WAN classification for offline stores). */
const LAST_GATEWAY_RANGE = '-7d'

function isMeaningfulVendor(v) {
  return v && !VENDOR_FALLBACKS.has(String(v).toLowerCase().trim())
}

/** True when vendor name or is_fortinet flag indicates Fortinet / FortiGate. */
export function vendorIsFortinet(vendor, flag = false) {
  return flag === true || /fortinet|fortigate/i.test(String(vendor || ''))
}

/** Merge one connectivity row into last-known gateway fields (7d lookback). */
function mergeLastGatewayRow(s, row) {
  if (row._field === 'is_fortinet' && String(row._value).toLowerCase() === 'true') {
    s.lastIsFortinet = true
  }
  const rowVendor = row.gateway_vendor
  if (vendorIsFortinet(rowVendor)) s.lastIsFortinet = true
  if (!isMeaningfulVendor(rowVendor)) return
  const t = row._time ? new Date(row._time).getTime() : 0
  if (t > 0 && t >= (s._lastGwTsMs || 0)) {
    s._lastGwTsMs = t
    if (vendorIsFortinet(rowVendor) || !vendorIsFortinet(s.lastGatewayVendor)) {
      s.lastGatewayVendor = rowVendor
    }
  }
}

/**
 * SD-WAN group = current gateway is Fortinet OR last-known gateway (7d) was Fortinet.
 * Offline stores keep SD-WAN membership via lastGatewayVendor / lastIsFortinet.
 */
function applySdWanClassification(s) {
  const currentFortinet = vendorIsFortinet(s.gatewayVendor, s.isFortinet)
  const lastFortinet = vendorIsFortinet(s.lastGatewayVendor, s.lastIsFortinet)
  s.isFortinet = currentFortinet || lastFortinet
  if (!isMeaningfulVendor(s.gatewayVendor) && isMeaningfulVendor(s.lastGatewayVendor)) {
    s.gatewayVendor = s.lastGatewayVendor
  }
}

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
      heartbeatOnline: null,
      heartbeatValue: null,
      lastHeartbeatAt: null,
      connState: 'unknown',
      activeInterface: '',
      activeSsid: '',
      gatewayIp: '',
      gatewayVendor: '',
      lastGatewayVendor: '',
      isHotspot: false,
      isFortinet: false,
      lastIsFortinet: false,
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

/** True when a store should trigger an offline alert (stricter than dashboard display online). */
export function isStoreOfflineForAlert(store) {
  // Agent explicitly reported offline (heartbeat field = 0) — alert even if metrics still flowing
  if (store.heartbeatValue === 0 && store.heartbeatOnline === false) return true
  // Dashboard offline (not rescued by activity heuristic)
  if (!store.online && store.onlineReason !== 'activity') return true
  // Stale heartbeat with no recent agent contact at all
  if (store.hadHeartbeat && store.heartbeatOnline === false && !store._latestActivityTs) return true
  return false
}

function detectIssues(store, staleMinutes = 15) {
  const issues = []
  // Only flag offline if the store has no recent activity at all.
  // onlineReason='activity' means heartbeat is stale but other metrics are live — not truly offline.
  if (!store.online && store.onlineReason !== 'activity') {
    if (store.hadHeartbeat) {
      const staleLabel = staleMinutes >= 60 ? `${Math.round(staleMinutes / 60)} hour` : `${staleMinutes} min`
      issues.push({ severity: 'critical', code: 'offline', message: `No heartbeat in last ${staleLabel}` })
    }
  }
  // Detect if internet is actually reachable via HTTP/DNS probes.
  // If HTTP returns 200 or DNS resolves, ICMP block is the likely cause of
  // ping/isp_down failures — treat those as lower-severity ICMP-filtered events.
  const httpWorks = Object.values(store.http).some((h) => h.success === true || (h.statusCode != null && h.statusCode >= 200 && h.statusCode < 400))
  const dnsWorks  = Object.values(store.dns).some((d) => d.success === true)
  const internetReachable = httpWorks || dnsWorks

  if (store.connState === 'isp_down') {
    if (internetReachable) {
      // ICMP is blocked/filtered but HTTP/DNS confirm internet is up — downgrade
      issues.push({ severity: 'warning', code: 'isp_down', message: 'Ping fails (ICMP blocked?) but HTTP & DNS reachable — likely ICMP filtering by ISP/router' })
    } else {
      issues.push({ severity: 'critical', code: 'isp_down', message: 'ISP / internet down' })
    }
  }
  if (store.connState === 'hotspot' || store.isHotspot) issues.push({ severity: 'high', code: 'hotspot', message: 'Running on mobile hotspot' })
  if (store.connState === 'no_connectivity') issues.push({ severity: 'high', code: 'no_connectivity', message: 'No network connectivity' })

  // Ping: only flag if ALL targets with data show the problem (one healthy target = no issue)
  const pingEntries = Object.entries(store.ping)
  if (pingEntries.length) {
    const lossEntries = pingEntries.filter(([, p]) => p.packetLossPct != null)
    if (lossEntries.length && lossEntries.every(([, p]) => p.packetLossPct >= 5)) {
      const worst = lossEntries.reduce((a, b) => b[1].packetLossPct > a[1].packetLossPct ? b : a)
      if (internetReachable) {
        // 100% ICMP loss but HTTP/DNS work → ICMP filtered, not real packet loss
        issues.push({ severity: 'warning', code: 'packet_loss', message: `ICMP filtered by ISP/router (${worst[0]}: ${worst[1].packetLossPct}% loss, but HTTP & DNS are healthy)` })
      } else {
        issues.push({ severity: 'high', code: 'packet_loss', message: `High packet loss to all targets (worst: ${worst[0]} ${worst[1].packetLossPct}%)` })
      }
    }
    const latEntries = pingEntries.filter(([, p]) => p.avgMs != null && p.avgMs > 0)
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
/** Live store snapshot always reads recent data — never widen with UI chart range (6h/24h). */
const SNAPSHOT_LIVE_RANGE = '-15m'

function _snapshotCacheKey(fromTs, toTs, lite = false) {
  const liteSuffix = lite ? '|lite' : ''
  if (fromTs && Number.isFinite(Number(fromTs))) {
    return `custom|${fromTs}|${toTs ?? ''}${liteSuffix}`
  }
  return `live${liteSuffix}`
}

function _getCachedSnapshot(key) {
  const entry = _snapshotCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > entry.ttl) { _snapshotCache.delete(key); return null }
  return entry.data
}

function _setCachedSnapshot(key, data, isCustom) {
  // Never cache an empty snapshot — a partial Influx timeout can otherwise serve 0 stores for 90s.
  if (!Array.isArray(data) || data.length === 0) return
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
export async function fetchStoreSnapshot(staleMinutes = 15, metricRange = '-24h', fromTs, toTs, options = {}) {
  const skipCache = options?.skipCache === true
  const lite = options?.lite === true
  const cacheKey = _snapshotCacheKey(fromTs, toTs, lite)
  if (!skipCache) {
    const cached = _getCachedSnapshot(cacheKey)
    if (cached) return cached
  }

  // If a fetch for the same key is already in-flight, wait for it instead of
  // launching a duplicate set of 8 parallel Influx queries.
  const inflightKey = `inflight:${cacheKey}`
  if (!skipCache && _snapshotCache.has(inflightKey)) {
    return _snapshotCache.get(inflightKey)
  }

  const discoveryRange = '-24h'

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

  const fetchPromise = _doFetchStoreSnapshot(staleMinutes, discoveryRange, rangeClause, isCustom, bucket, { lite })
  if (!skipCache) _snapshotCache.set(inflightKey, fetchPromise)
  try {
    const result = await fetchPromise
    // Avoid caching partial snapshots (identity query failed → only ~15m live stores).
    const minCache = parseInt(process.env.STORE_SNAPSHOT_MIN_CACHE || '1500', 10)
    if (!skipCache && Array.isArray(result) && result.length >= minCache) {
      _setCachedSnapshot(cacheKey, result, isCustom)
    } else if (!skipCache && Array.isArray(result) && result.length > 0 && result.length < minCache) {
      console.warn(`[influxStore] snapshot has only ${result.length} stores (< ${minCache}) — not caching partial result`)
    }
    return result
  } finally {
    if (!skipCache) _snapshotCache.delete(inflightKey)
  }
}

async function _doFetchStoreSnapshot(staleMinutes, discoveryRange, rangeClause, isCustom, bucket, opts = {}) {
  const lite = opts?.lite === true
  const liveRange = SNAPSHOT_LIVE_RANGE

  /* Run a tagged-latest or measurement-latest query using the resolved range clause */
  async function runTagged(measurement, tagColumns) {
    if (!isCustom) return fetchTaggedLatest(measurement, tagColumns, liveRange)
    const cols = ['store_tag', 'hostname', 'serial', ...tagColumns, '_field'].map((c) => `"${c}"`).join(', ')
    const flux = `from(bucket: "${bucket}") |> range(${rangeClause}) |> filter(fn: (r) => r._measurement == "${fluxEscape(measurement)}") |> group(columns: [${cols}]) |> last()`
    try { return await queryFlux(flux) } catch (e) { console.warn(`[influxStore] runTagged(${measurement}):`, e.message); return [] }
  }

  async function runMeasurement(measurement) {
    if (!isCustom) return fetchMeasurementLatest(measurement, liveRange)
    const flux = `from(bucket: "${bucket}") |> range(${rangeClause}) |> filter(fn: (r) => r._measurement == "${fluxEscape(measurement)}") |> group(columns: ["store_tag", "hostname", "serial", "_field"]) |> last()`
    try { return await queryFlux(flux) } catch (e) { console.warn(`[influxStore] runMeasurement(${measurement}):`, e.message); return [] }
  }

  async function runHeartbeats() {
    if (!isCustom) return fetchHeartbeats(liveRange)
    const flux = `from(bucket: "${bucket}") |> range(${rangeClause}) |> filter(fn: (r) => r._measurement == "heartbeat" and r._field == "online") |> group(columns: ["store_tag", "hostname", "serial"]) |> last()`
    try { return await queryFlux(flux) } catch (e) { console.warn('[influxStore] runHeartbeats:', e.message); return [] }
  }

  const speedRange = '-24h'
  // Lite overview skips ping/dns/http/speedtest — 4 fewer heavy Influx queries (~3k stores).
  const [identityRows, heartbeats, connectivity, connectivity7d, systemRows, pingRows, dnsRows, httpRows, speedRows] = await Promise.all([
    fetchStoreIdentityLatest(discoveryRange),
    runHeartbeats(),
    runTagged('connectivity', ['conn_state', 'active_interface', 'active_ssid', 'gateway_ip', 'gateway_vendor']),
    fetchTaggedLatest('connectivity', ['gateway_vendor'], LAST_GATEWAY_RANGE),
    runMeasurement('system'),
    lite ? Promise.resolve([]) : runTagged('ping', ['target']),
    lite ? Promise.resolve([]) : runTagged('dns_query', ['domain']),
    lite ? Promise.resolve([]) : runTagged('http_response', ['url']),
    lite ? Promise.resolve([]) : (isCustom ? runMeasurement('speedtest') : fetchMeasurementLatest('speedtest', speedRange)),
  ])

  const stores = new Map()
  const now = Date.now()
  const staleMs = staleMinutes * 60 * 1000

  for (const row of identityRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    const t = row._time ? new Date(row._time).getTime() : 0
    if (t > 0) {
      // Multiple identity rows per store (one per measurement) — keep the newest.
      const prevT = s.lastSeen ? new Date(s.lastSeen).getTime() : 0
      if (t > prevT) {
        s.lastSeen = rowTime(row)
        // Fallback online heuristic when heartbeat is unavailable.
        s.online = now - t <= staleMs
      }
    }
    // hadHeartbeat must reflect actual heartbeat presence — used by the offline
    // alert rule. Stores discovered via connectivity/system/ping etc. should not
    // raise a "no heartbeat" alert just because the discovery query found them.
    if (row._measurement === 'heartbeat') s.hadHeartbeat = true
    s.hostname = row.hostname || s.hostname
    s.serial = row.serial || s.serial
  }

  for (const row of heartbeats) {
    const s = ensureStore(stores, row)
    if (!s) continue
    const t = row._time ? new Date(row._time).getTime() : 0
    s.lastSeen = rowTime(row)
    const hbVal = num(row._value)
    s.heartbeatValue = hbVal
    s.lastHeartbeatAt = rowTime(row)
    s.heartbeatOnline = hbVal === 1 && t > 0 && now - t <= staleMs
    s.online = s.heartbeatOnline
    s.hadHeartbeat = true
    s.hostname = row.hostname || s.hostname
    s.serial = row.serial || s.serial
    // A heartbeat (even with value=0) proves the PS agent is running — count as activity.
    if (t > 0 && (!s._latestActivityTs || t > s._latestActivityTs)) s._latestActivityTs = t
  }

  for (const [, s] of stores) {
    if (s.heartbeatOnline == null) s.heartbeatOnline = false
  }

  // Helper: bump the "latest any-data" timestamp for a store.
  // Used below so a store is considered online if ANY metric arrived within staleMs,
  // even if its heartbeat is stale (e.g. heartbeat module crashed but other probes run fine).
  function bumpActivity(s, row) {
    if (!row._time) return
    const t = new Date(row._time).getTime()
    if (t > 0 && (!s._latestActivityTs || t > s._latestActivityTs)) s._latestActivityTs = t
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

    // Prefer any known vendor over "unknown"/"unidentified".
    // SD-WAN stickiness: once Fortinet/FortiGate is detected within the lookback
    // window, never downgrade to a different vendor — a transient non-Fortinet
    // reading (failover to backup uplink, ARP-detection miss) must not flip the
    // store out of the SD-WAN group.
    const rowVendor = row.gateway_vendor
    const currentIsFortinet =
      s.isFortinet === true ||
      /fortinet|fortigate/.test(String(s.gatewayVendor || '').toLowerCase())
    const rowIsFortinet = /fortinet|fortigate/.test(String(rowVendor || '').toLowerCase())
    if (isMeaningfulVendor(rowVendor)) {
      if (rowIsFortinet || !currentIsFortinet) {
        s.gatewayVendor = rowVendor
      }
    } else if (!isMeaningfulVendor(s.gatewayVendor)) {
      s.gatewayVendor = rowVendor || s.gatewayVendor
    }

    if (row._field === 'is_hotspot') s.isHotspot = String(row._value).toLowerCase() === 'true'
    // Sticky SD-WAN flag: any positive Fortinet reading in the window keeps the
    // store classified as SD-WAN. Only a complete absence of positive readings
    // demotes it (the flag stays at its initial `false` from ensureStore).
    if (row._field === 'is_fortinet') {
      if (String(row._value).toLowerCase() === 'true') s.isFortinet = true
    }
    if (rowIsFortinet) s.isFortinet = true
    if (!s.lastSeen && row._time) s.lastSeen = rowTime(row)
    bumpActivity(s, row)
  }

  // Last-known gateway (7d) — classifies offline stores into SD-WAN when last gateway was Fortinet.
  for (const row of connectivity7d) {
    const s = ensureStore(stores, row)
    if (!s) continue
    mergeLastGatewayRow(s, row)
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
    bumpActivity(s, row)
  }

  for (const row of dnsRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    const domain = row.domain || 'unknown'
    if (!s.dns[domain]) s.dns[domain] = {}
    if (row._field === 'response_ms') s.dns[domain].responseMs = num(row._value)
    if (row._field === 'success') s.dns[domain].success = bool(row._value)
    bumpActivity(s, row)
  }

  for (const row of httpRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    const url = row.url || 'unknown'
    if (!s.http[url]) s.http[url] = {}
    if (row._field === 'response_ms') s.http[url].responseMs = num(row._value)
    if (row._field === 'status_code') s.http[url].statusCode = num(row._value)
    if (row._field === 'success') s.http[url].success = bool(row._value)
    bumpActivity(s, row)
  }

  for (const row of systemRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    if (row._field === 'cpu_usage_pct') s.cpuPct = num(row._value)
    if (row._field === 'mem_used_pct') s.memPct = num(row._value)
    bumpActivity(s, row)
  }

  for (const row of speedRows) {
    const s = ensureStore(stores, row)
    if (!s) continue
    if (row._field === 'download_mbps') s.downloadMbps = num(row._value)
    if (row._field === 'upload_mbps') s.uploadMbps = num(row._value)
    bumpActivity(s, row)
  }

  // Secondary online heuristic: if heartbeat is stale but ANY other metric arrived
  // within activityMs, the PS agent is clearly running — treat the store as online.
  // activityMs is 2× the stale window (min 30 min) because the PS agent writes all
  // measurements together; if even heartbeat is a few cycles late the other data is
  // also the same age, so we need a wider window to rescue it from false-OFFLINE.
  const activityMs = Math.max(staleMs * 2, 30 * 60 * 1000)
  for (const [, s] of stores) {
    if (!s.online && s._latestActivityTs && now - s._latestActivityTs <= activityMs) {
      s.online = true
      s.onlineReason = 'activity'  // heartbeat stale but metrics active within activityMs
    }
    applySdWanClassification(s)
    delete s._lastGwTsMs
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

/** Return the best non-empty cached snapshot when a fresh fetch fails or times out. */
export function getAnyCachedStoreSnapshot(maxAgeMs = CACHE_TTL_DEFAULT_MS) {
  let best = null
  for (const [key, entry] of _snapshotCache.entries()) {
    if (key.startsWith('inflight:')) continue
    if (Date.now() - entry.ts > Math.min(entry.ttl, maxAgeMs)) continue
    if (!Array.isArray(entry.data) || entry.data.length === 0) continue
    // Prefer the largest snapshot so a partial ~900-store fetch doesn't mask a full ~3000-store cache.
    if (!best || entry.data.length > best.data.length || (entry.data.length === best.data.length && entry.ts > best.ts)) {
      best = { data: entry.data, ts: entry.ts }
    }
  }
  return best?.data || null
}

/**
 * Lightweight store list for issue ranking — heartbeats + connectivity only (2 Influx queries).
 * Used when the full 8-query snapshot times out under load.
 */
export async function fetchStoreIssuesLite(staleMinutes = 15, metricRange = '-12h') {
  const now = Date.now()
  const staleMs = staleMinutes * 60 * 1000
  const [heartbeats, connectivity, connectivity7d] = await Promise.all([
    fetchHeartbeats(metricRange),
    fetchTaggedLatest('connectivity', ['conn_state', 'active_interface', 'active_ssid', 'gateway_ip', 'gateway_vendor'], metricRange),
    fetchTaggedLatest('connectivity', ['gateway_vendor'], LAST_GATEWAY_RANGE),
  ])

  const stores = new Map()
  for (const row of heartbeats) {
    const s = ensureStore(stores, row)
    if (!s) continue
    const t = row._time ? new Date(row._time).getTime() : 0
    s.lastSeen = rowTime(row)
    s.online = num(row._value) === 1 && t > 0 && now - t <= staleMs
    s.hadHeartbeat = true
    s.hostname = row.hostname || s.hostname
    s.serial = row.serial || s.serial
    if (t > 0 && (!s._latestActivityTs || t > s._latestActivityTs)) s._latestActivityTs = t
  }

  for (const row of connectivity) {
    const s = ensureStore(stores, row)
    if (!s) continue
    if (row.conn_state && row.conn_state !== 'unknown') s.connState = row.conn_state
    else if (!s.connState || s.connState === 'unknown') s.connState = row.conn_state || s.connState
    if (row.active_interface) s.activeInterface = row.active_interface
    if (row.active_ssid && row.active_ssid !== 'n/a') s.activeSsid = row.active_ssid
    if (row.gateway_ip && row.gateway_ip !== 'n/a') s.gatewayIp = row.gateway_ip
    // SD-WAN stickiness — see _doFetchStoreSnapshot for the rationale.
    const rowVendor = row.gateway_vendor
    const currentIsFortinet =
      s.isFortinet === true ||
      /fortinet|fortigate/.test(String(s.gatewayVendor || '').toLowerCase())
    const rowIsFortinet = /fortinet|fortigate/.test(String(rowVendor || '').toLowerCase())
    if (isMeaningfulVendor(rowVendor)) {
      if (rowIsFortinet || !currentIsFortinet) s.gatewayVendor = rowVendor
    } else if (!isMeaningfulVendor(s.gatewayVendor)) {
      s.gatewayVendor = rowVendor || s.gatewayVendor
    }
    if (row._field === 'is_hotspot') s.isHotspot = String(row._value).toLowerCase() === 'true'
    if (row._field === 'is_fortinet') {
      if (String(row._value).toLowerCase() === 'true') s.isFortinet = true
    }
    if (rowIsFortinet) s.isFortinet = true
    if (!s.lastSeen && row._time) s.lastSeen = rowTime(row)
    // Track latest connectivity data time for activity heuristic
    if (row._time) {
      const t = new Date(row._time).getTime()
      if (t > 0 && (!s._latestActivityTs || t > s._latestActivityTs)) s._latestActivityTs = t
    }
  }

  for (const row of connectivity7d) {
    const s = ensureStore(stores, row)
    if (!s) continue
    mergeLastGatewayRow(s, row)
  }

  // Secondary online heuristic: recent connectivity data → store is alive
  const activityMs = Math.max(staleMs * 2, 30 * 60 * 1000)
  for (const [, s] of stores) {
    if (!s.online && s._latestActivityTs && now - s._latestActivityTs <= activityMs) {
      s.online = true
      s.onlineReason = 'activity'
    }
    applySdWanClassification(s)
    delete s._lastGwTsMs
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
 * @param {string} metricRange
 * @param {number} [fromTs]
 * @param {number} [toTs]
 */
function buildFluxRangeClause(metricRange = '-24h', fromTs, toTs) {
  if (fromTs && Number.isFinite(Number(fromTs))) {
    const startISO = new Date(Number(fromTs) * 1000).toISOString()
    const stopISO = toTs && Number.isFinite(Number(toTs))
      ? new Date(Number(toTs) * 1000).toISOString()
      : new Date().toISOString()
    return `start: ${startISO}, stop: ${stopISO}`
  }
  return `start: ${metricRange}`
}

function isWifiInterfaceTag(value) {
  const iface = String(value || '').toLowerCase()
  return iface === 'wi-fi' || iface === 'wifi' || iface.includes('wireless')
}

/**
 * Unique stores that reported Wi-Fi connectivity at least once in the Flux window.
 * Uses grouped count queries — the naive "pull all points" query exceeds Node string limits on 24h windows.
 * @param {string} metricRange e.g. '-24h'
 * @param {number} [fromTs]
 * @param {number} [toTs]
 */
const _wifiHistoryCache = new Map()
const WIFI_HISTORY_CACHE_MS = 60_000

async function fetchConnectivityStoreCounts(rangeClause, extraFilter = '') {
  const bucket = fluxEscape(cfg().bucket)
  const filterExtra = extraFilter ? ` and ${extraFilter}` : ''
  const flux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "connectivity"${filterExtra})
  |> group(columns: ["store_tag", "hostname", "serial"])
  |> count()
`
  return queryFlux(flux).catch((e) => {
    console.warn('[influxStore] fetchConnectivityStoreCounts failed:', e.message)
    return []
  })
}

function upsertWifiHistoryStore(map, row, patch) {
  const tag = row.store_tag || buildSyntheticStoreTag(row.hostname, row.serial)
  if (!tag) return
  const prev = map.get(tag) || {
    storeTag: tag,
    hostname: row.hostname || '',
    serial: row.serial || '',
    wifiHealthySamples: 0,
    wifiInterfaceSamples: 0,
    totalSamples: 0,
  }
  if (row.hostname) prev.hostname = row.hostname
  if (row.serial) prev.serial = row.serial
  map.set(tag, { ...prev, ...patch })
}

export async function fetchWifiConnectivityHistory(metricRange = '-24h', fromTs, toTs) {
  const cacheKey = `${metricRange}|${fromTs ?? ''}|${toTs ?? ''}`
  const cached = _wifiHistoryCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < WIFI_HISTORY_CACHE_MS) return cached.data

  const rangeClause = buildFluxRangeClause(metricRange, fromTs, toTs)
  const wifiIfaceFilter = 'r.active_interface =~ /(?i)(wi-?fi|wireless)/'

  const [allRows, healthyRows, ifaceRows] = await Promise.all([
    fetchConnectivityStoreCounts(rangeClause),
    fetchConnectivityStoreCounts(rangeClause, 'r.conn_state == "wifi_healthy"'),
    fetchConnectivityStoreCounts(rangeClause, wifiIfaceFilter),
  ])

  const byStore = new Map()
  for (const row of allRows) {
    upsertWifiHistoryStore(byStore, row, { totalSamples: num(row._value) || 0 })
  }
  for (const row of healthyRows) {
    upsertWifiHistoryStore(byStore, row, { wifiHealthySamples: num(row._value) || 1 })
  }
  for (const row of ifaceRows) {
    upsertWifiHistoryStore(byStore, row, { wifiInterfaceSamples: num(row._value) || 1 })
  }

  const stores = [...byStore.values()]
  const result = {
    metricRange,
    stores,
    storesWithData: stores.length,
    uniqueWifiHealthy: stores.filter(s => s.wifiHealthySamples > 0).length,
    uniqueWifiInterface: stores.filter(s => s.wifiInterfaceSamples > 0).length,
  }
  _wifiHistoryCache.set(cacheKey, { data: result, ts: Date.now() })
  if (_wifiHistoryCache.size > 8) {
    const oldest = [..._wifiHistoryCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) _wifiHistoryCache.delete(oldest[0])
  }
  return result
}

const HEARTBEAT_BUCKET_MIN = 5
// heartbeat.online may be bool or int in the same bucket; never compare bool to int directly.
const FLUX_HEARTBEAT_IS_OFFLINE = `  |> map(fn: (r) => ({ r with isOffline:
      string(v: r._value) == "false" or string(v: r._value) == "0" or string(v: r._value) == "0.0"
    }))
  |> filter(fn: (r) => r.isOffline)
`
const FLUX_HEARTBEAT_DISCONNECT_STEPS = `  |> map(fn: (r) => ({ r with onlineNum:
      if string(v: r._value) == "true" or string(v: r._value) == "1" or string(v: r._value) == "1.0" then 1
      else 0
    }))
  |> difference(columns: ["onlineNum"], keepFirst: false)
  |> filter(fn: (r) => r.onlineNum < 0)
`
const _downtimeCache = new Map()
const DOWNTIME_CACHE_MS = 120_000

function rollupRowsHaveSignal(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false
  return rows.some((r) => (num(r._value) || 0) > 0)
}

async function fetchHeartbeatBucketCounts(rangeClause, bucketEvery, offlineOnly) {
  const bucket = fluxEscape(cfg().bucket)
  let flux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "heartbeat" and r._field == "online")
  |> aggregateWindow(every: ${bucketEvery}, fn: last, createEmpty: false)
`
  if (offlineOnly) {
    flux += FLUX_HEARTBEAT_IS_OFFLINE
  }
  flux += `  |> group(columns: ["store_tag", "hostname", "serial"])
  |> count()
`
  return queryFlux(flux).catch((e) => {
    console.warn('[influxStore] fetchHeartbeatBucketCounts failed:', e.message)
    return []
  })
}

/**
 * Aggregate offline machine-hours from Influx heartbeat history for an absolute window.
 * @param {number} fromTs Unix seconds
 * @param {number} toTs Unix seconds
 */
export async function fetchStoreDowntimeSummary(fromTs, toTs, bucketMin = HEARTBEAT_BUCKET_MIN) {
  const cacheKey = `${fromTs}|${toTs}|${bucketMin}`
  const cached = _downtimeCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < DOWNTIME_CACHE_MS) return cached.data

  const rangeClause = buildFluxRangeClause(null, fromTs, toTs)
  const bucketEvery = `${bucketMin}m`
  const [offlineRows, sampleRows] = await Promise.all([
    fetchHeartbeatBucketCounts(rangeClause, bucketEvery, true),
    fetchHeartbeatBucketCounts(rangeClause, bucketEvery, false),
  ])

  const samplesByTag = new Map()
  for (const row of sampleRows) {
    const tag = row.store_tag || buildSyntheticStoreTag(row.hostname, row.serial)
    if (!tag) continue
    samplesByTag.set(tag, {
      storeTag: tag,
      hostname: row.hostname || '',
      serial: row.serial || '',
      sampleBuckets: num(row._value) || 0,
    })
  }

  const storeOffline = []
  let totalOfflineMinutes = 0
  for (const row of offlineRows) {
    const tag = row.store_tag || buildSyntheticStoreTag(row.hostname, row.serial)
    if (!tag) continue
    const offlineBuckets = num(row._value) || 0
    const offlineMinutes = offlineBuckets * bucketMin
    if (offlineMinutes <= 0) continue
    totalOfflineMinutes += offlineMinutes
    const meta = samplesByTag.get(tag)
    storeOffline.push({
      storeTag: tag,
      hostname: row.hostname || meta?.hostname || '',
      serial: row.serial || meta?.serial || '',
      offlineMinutes,
      offlineHours: Math.round((offlineMinutes / 60) * 100) / 100,
      sampleBuckets: meta?.sampleBuckets || 0,
    })
  }

  storeOffline.sort((a, b) => b.offlineMinutes - a.offlineMinutes)
  const windowMinutes = Math.max(1, Math.round((toTs - fromTs) / 60))
  const windowHours = Math.round((windowMinutes / 60) * 100) / 100
  const storesReporting = samplesByTag.size
  const storesWithOffline = storeOffline.length
  const totalOfflineHours = Math.round((totalOfflineMinutes / 60) * 100) / 100
  const avgOfflineHoursAffected = storesWithOffline
    ? Math.round((totalOfflineHours / storesWithOffline) * 100) / 100
    : 0
  const maxPossibleHours = storesReporting * windowHours
  const downtimePct = maxPossibleHours > 0
    ? Math.round((totalOfflineHours / maxPossibleHours) * 10000) / 100
    : null

  const result = {
    fromTs,
    toTs,
    windowHours,
    windowMinutes,
    bucketMin,
    storesReporting,
    storesWithOffline,
    totalOfflineMinutes,
    totalOfflineHours,
    avgOfflineHoursAffected,
    downtimePct,
    topOffline: storeOffline.slice(0, 15),
  }
  _downtimeCache.set(cacheKey, { data: result, ts: Date.now() })
  if (_downtimeCache.size > 8) {
    const oldest = [..._downtimeCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) _downtimeCache.delete(oldest[0])
  }
  return result
}

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

/**
 * Auto-pick an aggregation bucket size based on window span.
 * Aim for ~80–200 points per series.
 */
function pickAggregateBucket(rangeSec) {
  if (rangeSec <= 6 * 3600)     return '5m'    // 6h → 72 pts
  if (rangeSec <= 24 * 3600)    return '15m'   // 24h → 96 pts
  if (rangeSec <= 3 * 86400)    return '30m'   // 3d → 144 pts
  if (rangeSec <= 7 * 86400)    return '1h'    // 7d → 168 pts
  if (rangeSec <= 30 * 86400)   return '6h'    // 30d → 120 pts
  return '1d'
}

/**
 * Aggregate network-health time series across the entire store fleet for the
 * requested window. Returns mean per (target, _field) at each bucket.
 *
 * Series:
 *  - ping latency  (measurement=ping, field=average_response_ms, group by target)
 *  - packet loss   (measurement=ping, field=packet_loss_pct,    group by target)
 *  - DNS success%  (measurement=dns,  field=success,            group by domain)
 *  - HTTP success% (measurement=http, field=success,            group by url)
 *
 * @param {number} rangeSec  fallback window in seconds when from/to omitted
 * @param {number} [fromSec] Unix seconds (inclusive)
 * @param {number} [toSec]   Unix seconds (exclusive)
 */
export async function fetchNetHealthHistory(rangeSec = 86400, fromSec, toSec) {
  const bucket = fluxEscape(cfg().bucket)
  let rangeClause
  let effectiveRangeSec = rangeSec
  if (fromSec && Number.isFinite(Number(fromSec))) {
    const startISO = new Date(Number(fromSec) * 1000).toISOString()
    const stopISO  = toSec && Number.isFinite(Number(toSec))
      ? new Date(Number(toSec) * 1000).toISOString()
      : new Date().toISOString()
    rangeClause = `start: ${startISO}, stop: ${stopISO}`
    effectiveRangeSec = toSec ? Number(toSec) - Number(fromSec) : Math.floor((Date.now() / 1000) - Number(fromSec))
  } else {
    rangeClause = `start: -${rangeSec}s`
  }

  const every = pickAggregateBucket(Math.max(effectiveRangeSec, 300))

  // One Flux per measurement; cheaper than a single mega-query, and lets each
  // group differ in tag column (target vs domain vs url).
  const pingFlux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "ping" and (r._field == "average_response_ms" or r._field == "packet_loss_pct"))
  |> filter(fn: (r) => exists r.target)
  |> group(columns: ["_field", "target"])
  |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value", "_field", "target"])
`

  const dnsFlux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "dns" and r._field == "success")
  |> filter(fn: (r) => exists r.domain)
  |> map(fn: (r) => ({ r with _value: if r._value == true or r._value == 1 or r._value == 1.0 then 1.0 else 0.0 }))
  |> group(columns: ["domain"])
  |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
  |> map(fn: (r) => ({ r with _value: r._value * 100.0 }))
  |> keep(columns: ["_time", "_value", "domain"])
`

  const httpFlux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "http" and r._field == "success")
  |> filter(fn: (r) => exists r.url)
  |> map(fn: (r) => ({ r with _value: if r._value == true or r._value == 1 or r._value == 1.0 then 1.0 else 0.0 }))
  |> group(columns: ["url"])
  |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
  |> map(fn: (r) => ({ r with _value: r._value * 100.0 }))
  |> keep(columns: ["_time", "_value", "url"])
`

  const [pingRows, dnsRows, httpRows] = await Promise.all([
    queryFlux(pingFlux).catch((e) => { console.warn('[influxStore] netHealth ping query failed:', e.message); return [] }),
    queryFlux(dnsFlux).catch((e) => { console.warn('[influxStore] netHealth dns query failed:',  e.message); return [] }),
    queryFlux(httpFlux).catch((e) => { console.warn('[influxStore] netHealth http query failed:', e.message); return [] }),
  ])

  function rowsToSeries(rows, tagKey, fieldOverride) {
    const map = new Map()
    for (const row of rows) {
      const tagVal = row[tagKey]
      const field  = fieldOverride || row._field
      if (!tagVal || !field) continue
      const key = `${field}|${tagVal}`
      if (!map.has(key)) {
        map.set(key, {
          measurement: tagKey === 'target' ? 'ping' : tagKey === 'domain' ? 'dns' : 'http',
          field,
          target: tagVal,
          name: `${field} (${tagVal})`,
          points: [],
        })
      }
      const ts = row._time ? Math.floor(new Date(row._time).getTime() / 1000) : null
      const val = num(row._value)
      if (ts != null && val != null) map.get(key).points.push({ clock: ts, value: val })
    }
    return [...map.values()]
  }

  const latencySeries = rowsToSeries(pingRows.filter((r) => r._field === 'average_response_ms'), 'target')
  const lossSeries    = rowsToSeries(pingRows.filter((r) => r._field === 'packet_loss_pct'),    'target')
  const dnsSeries     = rowsToSeries(dnsRows,  'domain', 'success_pct')
  const httpSeries    = rowsToSeries(httpRows, 'url',    'success_pct')

  const allClocks = [latencySeries, lossSeries, dnsSeries, httpSeries]
    .flat()
    .flatMap((s) => s.points.map((p) => p.clock))
  const minClock = allClocks.length ? Math.min(...allClocks) : null
  const maxClock = allClocks.length ? Math.max(...allClocks) : null

  const nowSec = Math.floor(Date.now() / 1000)
  const requestedFromSec = fromSec ? Number(fromSec) : nowSec - rangeSec
  const requestedToSec   = toSec   ? Number(toSec)   : nowSec

  return {
    rangeSec: effectiveRangeSec,
    aggregateEvery: every,
    requestedFrom: new Date(requestedFromSec * 1000).toISOString(),
    requestedTo:   new Date(requestedToSec   * 1000).toISOString(),
    dataFrom:   minClock ? new Date(minClock * 1000).toISOString() : null,
    dataTo:     maxClock ? new Date(maxClock * 1000).toISOString() : null,
    pointCount: allClocks.length,
    latencySeries,
    lossSeries,
    dnsSeries,
    httpSeries,
  }
}

/**
 * Aggregate per-group time series across the fleet for the requested window.
 * Groups are derived in Flux from the hostname tag using the same rules the
 * frontend uses (RP*, LK*, fallback to General).
 *
 * Returns ping latency + packet loss series per group. The client groups
 * these into per-day rollups + computes a health score so a multi-day matrix
 * (Group × Day) can be rendered.
 */
/**
 * @param {object} [opts]
 * @param {{name:string, storeTags:string[]}[]} [opts.customGroups]
 *        Extra ad-hoc groups defined by an explicit list of store_tags
 *        (e.g. "Manual ROP + SD-WAN"). Each becomes a separate row in the
 *        returned `groupSeries`.
 */
export async function fetchGroupHealthHistory(rangeSec = 86400, fromSec, toSec, opts = {}) {
  const bucket = fluxEscape(cfg().bucket)
  let rangeClause
  let effectiveRangeSec = rangeSec
  if (fromSec && Number.isFinite(Number(fromSec))) {
    const startISO = new Date(Number(fromSec) * 1000).toISOString()
    const stopISO  = toSec && Number.isFinite(Number(toSec))
      ? new Date(Number(toSec) * 1000).toISOString()
      : new Date().toISOString()
    rangeClause = `start: ${startISO}, stop: ${stopISO}`
    effectiveRangeSec = toSec ? Number(toSec) - Number(fromSec) : Math.floor((Date.now() / 1000) - Number(fromSec))
  } else {
    rangeClause = `start: -${rangeSec}s`
  }
  const every = pickAggregateBucket(Math.max(effectiveRangeSec, 300))

  // ── Identify SD-WAN store_tags from the most recent snapshot ────────────
  // SD-WAN classification is vendor-based (Fortinet) not hostname-based, so
  // we look it up from the latest cached store snapshot (which already has
  // isFortinet / gatewayVendor populated). Falls back to running a fresh
  // snapshot fetch if no cache is available.
  let cached = getAnyCachedStoreSnapshot(15 * 60 * 1000) // 15 min tolerance
  if (!cached) {
    try { cached = await fetchStoreSnapshot(15, '-24h') } catch { cached = null }
  }
  const sdwanTags = []
  const rpTags = []
  const posTags = []
  if (Array.isArray(cached)) {
    for (const s of cached) {
      if (s.storeTag) {
        const h = String(s.hostname || '').toUpperCase()
        if (h.startsWith('RP')) rpTags.push(s.storeTag)
        else if (h.startsWith('LK')) posTags.push(s.storeTag)
      }
      if (
        vendorIsFortinet(s.gatewayVendor, s.isFortinet) ||
        vendorIsFortinet(s.lastGatewayVendor, s.lastIsFortinet)
      ) {
        if (s.storeTag) sdwanTags.push(s.storeTag)
      }
    }
  }

  // ── Query 1: hostname-based groups (RP / POS System / General) ──────────
  const hostnameFlux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "ping" and (r._field == "average_response_ms" or r._field == "packet_loss_pct"))
  |> filter(fn: (r) => exists r.hostname)
  |> map(fn: (r) => ({ r with grp:
       if r.hostname =~ /^[Rr][Pp]/ then "RP Group"
       else if r.hostname =~ /^[Ll][Kk]/ then "POS System Group"
       else "General Group"
     }))
  |> group(columns: ["_field", "grp"])
  |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value", "_field", "grp"])
`

  // ── Query 2: SD-WAN — filter by the store_tag set, then aggregate ───────
  // Cap at 4000 tags to avoid pathological query sizes. (A few hundred
  // SD-WAN devices generate a ~15KB query, well within Influx limits.)
  let sdwanFlux = null
  if (sdwanTags.length > 0 && sdwanTags.length <= 4000) {
    const setLiteral = sdwanTags
      .map((t) => `"${fluxEscape(String(t))}"`)
      .join(', ')
    sdwanFlux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "ping" and (r._field == "average_response_ms" or r._field == "packet_loss_pct"))
  |> filter(fn: (r) => exists r.store_tag and contains(value: r.store_tag, set: [${setLiteral}]))
  |> group(columns: ["_field"])
  |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value", "_field"])
`
  }

  // ── Query 3..N: custom groups (Manual ROP + SD-WAN, Manual ROP w/o SD-WAN, …) ─
  const customGroups = Array.isArray(opts.customGroups) ? opts.customGroups : []
  const customQueries = customGroups
    .map((g) => {
      const tags = Array.isArray(g.storeTags) ? g.storeTags.filter(Boolean) : []
      if (!g.name || !tags.length || tags.length > 4000) return null
      const setLiteral = tags.map((t) => `"${fluxEscape(String(t))}"`).join(', ')
      const flux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "ping" and (r._field == "average_response_ms" or r._field == "packet_loss_pct"))
  |> filter(fn: (r) => exists r.store_tag and contains(value: r.store_tag, set: [${setLiteral}]))
  |> group(columns: ["_field"])
  |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value", "_field"])
`
      return { name: g.name, flux, storeCount: tags.length }
    })
    .filter(Boolean)

  const [hostRows, sdwanRows, ...customResults] = await Promise.all([
    queryFlux(hostnameFlux).catch((e) => { console.warn('[influxStore] groupHealth host query failed:', e.message); return [] }),
    sdwanFlux
      ? queryFlux(sdwanFlux).catch((e) => { console.warn('[influxStore] groupHealth sdwan query failed:', e.message); return [] })
      : Promise.resolve([]),
    ...customQueries.map((cq) =>
      queryFlux(cq.flux).catch((e) => { console.warn(`[influxStore] groupHealth custom "${cq.name}" failed:`, e.message); return [] })
    ),
  ])

  const seriesMap = new Map()

  // Merge hostname-based rows
  for (const row of hostRows) {
    const grp   = row.grp
    const field = row._field
    if (!grp || !field) continue
    const key = `${grp}|${field}`
    if (!seriesMap.has(key)) seriesMap.set(key, { group: grp, field, points: [] })
    const ts = row._time ? Math.floor(new Date(row._time).getTime() / 1000) : null
    const val = num(row._value)
    if (ts != null && val != null) seriesMap.get(key).points.push({ clock: ts, value: val })
  }

  // Merge SD-WAN rows (group = 'SD-WAN Group')
  for (const row of sdwanRows) {
    const field = row._field
    if (!field) continue
    const key = `SD-WAN Group|${field}`
    if (!seriesMap.has(key)) seriesMap.set(key, { group: 'SD-WAN Group', field, points: [] })
    const ts = row._time ? Math.floor(new Date(row._time).getTime() / 1000) : null
    const val = num(row._value)
    if (ts != null && val != null) seriesMap.get(key).points.push({ clock: ts, value: val })
  }

  // Merge custom-group rows
  for (let i = 0; i < customQueries.length; i++) {
    const cq = customQueries[i]
    const rows = customResults[i] || []
    for (const row of rows) {
      const field = row._field
      if (!field) continue
      const key = `${cq.name}|${field}`
      if (!seriesMap.has(key)) seriesMap.set(key, { group: cq.name, field, points: [] })
      const ts = row._time ? Math.floor(new Date(row._time).getTime() / 1000) : null
      const val = num(row._value)
      if (ts != null && val != null) seriesMap.get(key).points.push({ clock: ts, value: val })
    }
  }

  const allClocks = [...seriesMap.values()].flatMap((s) => s.points.map((p) => p.clock))
  const minClock = allClocks.length ? Math.min(...allClocks) : null
  const maxClock = allClocks.length ? Math.max(...allClocks) : null

  const nowSec = Math.floor(Date.now() / 1000)
  const requestedFromSec = fromSec ? Number(fromSec) : nowSec - rangeSec
  const requestedToSec   = toSec   ? Number(toSec)   : nowSec

  return {
    rangeSec: effectiveRangeSec,
    aggregateEvery: every,
    requestedFrom: new Date(requestedFromSec * 1000).toISOString(),
    requestedTo:   new Date(requestedToSec   * 1000).toISOString(),
    dataFrom:   minClock ? new Date(minClock * 1000).toISOString() : null,
    dataTo:     maxClock ? new Date(maxClock * 1000).toISOString() : null,
    pointCount: allClocks.length,
    sdwanStoreCount: sdwanTags.length,
    customGroupCounts: Object.fromEntries(customQueries.map((cq) => [cq.name, cq.storeCount])),
    groupSeries: [...seriesMap.values()],
  }
}

/** Flux filter line(s) restricting rows to an explicit store_tag set. */
function fluxStoreTagSetFilter(tags) {
  if (!Array.isArray(tags) || !tags.length) return ''
  const capped = tags.slice(0, 4000)
  const setLiteral = capped.map((t) => `"${fluxEscape(String(t))}"`).join(', ')
  return `  |> filter(fn: (r) => exists r.store_tag and contains(value: r.store_tag, set: [${setLiteral}]))`
}

/** Pick coarser heartbeat buckets for long windows / large fleets (fewer aggregateWindow steps). */
function pickDisconnectBucketMin(rangeSec, storeEstimate = 0, requested = HEARTBEAT_BUCKET_MIN) {
  const req = Math.min(Math.max(parseInt(String(requested || HEARTBEAT_BUCKET_MIN), 10) || HEARTBEAT_BUCKET_MIN, 1), 60)
  if (rangeSec > 14 * 86400) return Math.max(req, 60)
  if (rangeSec > 3 * 86400 || storeEstimate > 1200) return Math.max(req, 15)
  if (storeEstimate > 800) return Math.max(req, 10)
  return req
}

function offlineTruncateUnit(bh) {
  return bh ? '1h' : '1d'
}

/**
 * Run a filtered Flux fetch — one Influx query, no client-side chunking.
 * Influx handles `contains(set: [...])` with thousands of entries fine; chunking
 * into multiple sequential queries was actually *slower* because each query has
 * its own bucket scan + connection overhead.
 */
async function runFilteredDisconnectQuery(fetchFn, rangeClause, bucketEvery, groupDef, logLabel, truncateUnit) {
  const { filterLines, tags } = groupDef
  const filter = Array.isArray(tags) && tags.length
    ? fluxStoreTagSetFilter(tags)
    : (filterLines || '')
  return fetchFn(rangeClause, bucketEvery, filter, logLabel, truncateUnit)
}

async function fetchHeartbeatDisconnectByDayFiltered(rangeClause, bucketEvery, groupFilterLines = '', logLabel = '', truncateUnit = '1d') {
  const c = cfg()
  // Rollup path: pre-aggregated hourly disconnect counts written by the
  // `store_disconnect_hourly_rollup` Flux task. Avoids scanning every raw heartbeat.
  if (c.rollupsBucket) {
    const rollupBucket = fluxEscape(c.rollupsBucket)
    const flux = `
from(bucket: "${rollupBucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "store_disconnect_rollup" and r._field == "disconnect_count")
${groupFilterLines}
  |> truncateTimeColumn(unit: ${truncateUnit})
  |> group(columns: ["store_tag", "hostname", "_time"])
  |> sum()
  |> keep(columns: ["_time", "store_tag", "hostname", "_value"])
`
    try {
      const rollupRows = await queryFlux(flux)
      if (rollupRowsHaveSignal(rollupRows)) return { rows: rollupRows, fromRollups: true }
      console.warn(
        `[influxStore] disconnect rollups empty or all-zero${logLabel ? ` (${logLabel})` : ''}; `
        + 'falling back to raw heartbeat (check Influx tasks handle boolean online field)',
      )
    } catch (e) {
      console.warn(`[influxStore] fetchHeartbeatDisconnectByDay (rollups${logLabel ? `, ${logLabel}` : ''}) failed:`, e.message)
    }
  }

  const bucket = fluxEscape(c.bucket)
  const flux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "heartbeat" and r._field == "online")
${groupFilterLines}
  |> group(columns: ["store_tag", "hostname", "serial"])
  |> aggregateWindow(every: ${bucketEvery}, fn: last, createEmpty: false)
${FLUX_HEARTBEAT_DISCONNECT_STEPS}  |> truncateTimeColumn(unit: ${truncateUnit})
  |> group(columns: ["store_tag", "hostname", "_time"])
  |> count()
  |> keep(columns: ["_time", "store_tag", "hostname", "_value"])
`
  const rows = await queryFlux(flux).catch((e) => {
    console.warn(`[influxStore] fetchHeartbeatDisconnectByDay${logLabel ? ` (${logLabel})` : ''} failed:`, e.message)
    return []
  })
  return { rows, fromRollups: false }
}

async function fetchHeartbeatOfflineByDayFiltered(rangeClause, bucketEvery, groupFilterLines = '', logLabel = '', truncateUnit = '1d') {
  const c = cfg()
  // Rollup path: pre-aggregated hourly offline 5m-bucket counts written by the
  // `store_offline_hourly_rollup` Flux task. _value is already the count of 5m
  // windows where heartbeat.online == 0 within that hour.
  if (c.rollupsBucket) {
    const rollupBucket = fluxEscape(c.rollupsBucket)
    const flux = `
from(bucket: "${rollupBucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "store_offline_rollup" and r._field == "offline_5m_buckets")
${groupFilterLines}
  |> truncateTimeColumn(unit: ${truncateUnit})
  |> group(columns: ["store_tag", "hostname", "_time"])
  |> sum()
  |> keep(columns: ["_time", "store_tag", "hostname", "_value"])
`
    try {
      const rollupRows = await queryFlux(flux)
      if (rollupRowsHaveSignal(rollupRows)) return { rows: rollupRows, fromRollups: true }
      console.warn(
        `[influxStore] offline rollups empty or all-zero${logLabel ? ` (${logLabel})` : ''}; `
        + 'falling back to raw heartbeat (check Influx tasks handle boolean online field)',
      )
    } catch (e) {
      console.warn(`[influxStore] fetchHeartbeatOfflineByDay (rollups${logLabel ? `, ${logLabel}` : ''}) failed:`, e.message)
    }
  }

  const bucket = fluxEscape(c.bucket)
  const flux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "heartbeat" and r._field == "online")
${groupFilterLines}
  |> aggregateWindow(every: ${bucketEvery}, fn: last, createEmpty: false)
${FLUX_HEARTBEAT_IS_OFFLINE}  |> truncateTimeColumn(unit: ${truncateUnit})
  |> group(columns: ["store_tag", "hostname", "_time"])
  |> count()
  |> keep(columns: ["_time", "store_tag", "hostname", "_value"])
`
  const rows = await queryFlux(flux).catch((e) => {
    console.warn(`[influxStore] fetchHeartbeatOfflineByDay${logLabel ? ` (${logLabel})` : ''} failed:`, e.message)
    return []
  })
  return { rows, fromRollups: false }
}

async function fetchConnDownByDayFiltered(rangeClause, bucketEvery, groupFilterLines = '', logLabel = '', truncateUnit = '1d') {
  const bucket = fluxEscape(cfg().bucket)
  const flux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "connectivity" and (r.conn_state == "isp_down" or r.conn_state == "no_connectivity"))
${groupFilterLines}
  |> aggregateWindow(every: ${bucketEvery}, fn: count, createEmpty: false)
  |> truncateTimeColumn(unit: ${truncateUnit})
  |> group(columns: ["store_tag", "hostname", "_time"])
  |> count()
  |> keep(columns: ["_time", "store_tag", "hostname", "_value"])
`
  return queryFlux(flux).catch((e) => {
    console.warn(`[influxStore] fetchConnDownByDay${logLabel ? ` (${logLabel})` : ''} failed:`, e.message)
    return []
  })
}

/**
 * Day-wise store disconnections + offline duration per group.
 *
 * Uses the same heartbeat history approach as fetchStoreDowntimeSummary:
 * - Offline bucket  = heartbeat.online == 0 in a 5m window
 * - Disconnection   = heartbeat online value drops (1 → 0) within the window
 * - Internet down   = connectivity isp_down / no_connectivity buckets (merged)
 * - Silent stores   = currently offline in snapshot with stale lastSeen → offline
 *   duration since lastSeen (matches dashboard cards)
 *
 * @param {number} rangeSec
 * @param {number} [fromSec]
 * @param {number} [toSec]
 * @param {object} [opts]
 * @param {number} [opts.bucketMin=5]
 * @param {{name:string, storeTags:string[]}[]} [opts.customGroups]
 * @param {string} [opts.groupName]  When set, only run queries for this one group.
 */
const _groupDisconnectCache = new Map()
// Live windows: serve cached for up to ~10 min so polling clients hit cache
// even across users. Historical (custom from/to) windows are cached separately.
const GROUP_DISCONNECT_CACHE_MS = 600_000

export async function fetchGroupDisconnectDaily(rangeSec = 86400, fromSec, toSec, opts = {}) {
  const nowSec = Math.floor(Date.now() / 1000)
  const requestedFromSec = fromSec && Number.isFinite(Number(fromSec)) ? Number(fromSec) : nowSec - rangeSec
  const requestedToSec   = toSec && Number.isFinite(Number(toSec))     ? Number(toSec)   : nowSec
  const effectiveRangeSec = requestedToSec - requestedFromSec
  const rangeClause = buildFluxRangeClause(null, requestedFromSec, requestedToSec)
  const requestedBucketMin = opts.bucketMin

  // Business Hours filter — applied at bucket level after data is loaded.
  // tzOffsetMinutes lets us convert UTC bucket timestamps to the user's
  // local clock before checking the hour/weekday.
  const bh = opts.businessHours && typeof opts.businessHours === 'object'
    ? {
        startHour: opts.businessHours.startHour,
        endHour: opts.businessHours.endHour,
        weekdays: new Set((opts.businessHours.weekdays || []).map(Number)),
        tzOffsetMinutes: Number(opts.businessHours.tzOffsetMinutes) || 0,
      }
    : null
  function inBusinessHours(tsSec) {
    if (!bh) return true
    const localMs = (tsSec * 1000) + (bh.tzOffsetMinutes * 60 * 1000)
    const d = new Date(localMs)
    const day = d.getUTCDay()
    if (!bh.weekdays.has(day)) return false
    const hour = d.getUTCHours()
    if (bh.startHour <= bh.endHour) return hour >= bh.startHour && hour < bh.endHour
    return hour >= bh.startHour || hour < bh.endHour
  }

  // Bucket the "to" timestamp by the cache TTL so live windows still hit cache
  // for repeated polls but don't go stale.
  const customGroupKey = Array.isArray(opts.customGroups)
    ? opts.customGroups
        .map((g) => `${g.name}=${(g.storeTags || []).slice().sort().join(',')}`)
        .sort()
        .join('|')
    : ''
  const onlyGroup = opts.groupName ? String(opts.groupName).trim().slice(0, 80) : ''
  const bhKey = bh
    ? `bh:${bh.startHour}-${bh.endHour}|${[...bh.weekdays].sort().join(',')}|${bh.tzOffsetMinutes}`
    : ''
  const liveWindow = !(fromSec && toSec)
  const cacheBucket = liveWindow
    ? Math.floor(nowSec / Math.floor(GROUP_DISCONNECT_CACHE_MS / 1000))
    : `${requestedFromSec}:${requestedToSec}`
  // Actual bucketMin is picked inside work() based on fleet size, so key on the requested value (or 'auto').
  const bucketKeyPart = requestedBucketMin ? `b${requestedBucketMin}` : 'bauto'
  const cacheKey = `${effectiveRangeSec}|${bucketKeyPart}|${cacheBucket}|${customGroupKey}|${bhKey}|${onlyGroup || 'all'}`
  const cachedEntry = _groupDisconnectCache.get(cacheKey)
  if (cachedEntry && Date.now() - cachedEntry.ts < GROUP_DISCONNECT_CACHE_MS) return cachedEntry.data
  const inflightKey = `inflight:${cacheKey}`
  if (_groupDisconnectCache.has(inflightKey)) {
    return _groupDisconnectCache.get(inflightKey)
  }

  const work = (async () => {

  // Snapshot for SD-WAN/custom membership + silent-offline overlay (shared across groups).
  let cached = getAnyCachedStoreSnapshot(15 * 60 * 1000)
  if (!cached) {
    try { cached = await fetchStoreSnapshot(15, '-24h') } catch { cached = null }
  }

  const sdwanTags = []
  const rpTags = []
  const posTags = []
  if (Array.isArray(cached)) {
    for (const s of cached) {
      if (!s?.storeTag) continue
      const h = String(s.hostname || '').toUpperCase()
      if (h.startsWith('RP')) rpTags.push(s.storeTag)
      else if (h.startsWith('LK')) posTags.push(s.storeTag)
      if (
        vendorIsFortinet(s.gatewayVendor, s.isFortinet) ||
        vendorIsFortinet(s.lastGatewayVendor, s.lastIsFortinet)
      ) {
        sdwanTags.push(s.storeTag)
      }
    }
  }
  const rpUniqueTags = [...new Set(rpTags)]
  const posUniqueTags = [...new Set(posTags)]
  const sdwanUniqueTags = [...new Set(sdwanTags)]
  const sdwanTagSet = new Set(sdwanUniqueTags)
  // Very large contains(set:[...]) filters can become slower/fragile in Influx.
  // Use tag-set filtering only for moderate lists; fallback to hostname prefix regex
  // for large RP/POS groups.
  const rpUseTagSet = rpUniqueTags.length > 0 && rpUniqueTags.length <= 800
  const posUseTagSet = posUniqueTags.length > 0 && posUniqueTags.length <= 800

  const customGroups = Array.isArray(opts.customGroups) ? opts.customGroups : []
  const customGroupTagSets = new Map()
  for (const g of customGroups) {
    const name = String(g?.name || '').trim()
    const tags = Array.isArray(g?.storeTags) ? g.storeTags.map((t) => String(t || '').trim()).filter(Boolean) : []
    if (!name || !tags.length) continue
    customGroupTagSets.set(name, new Set(tags))
  }

  function estimateGroupStores(belongs) {
    if (!Array.isArray(cached)) return 0
    let n = 0
    for (const s of cached) {
      if (s?.storeTag && belongs(s.storeTag, s)) n++
    }
    return n
  }

  /** Per-group Flux queries (hostname, SD-WAN tag-set, or custom tag-set). */
  const groupDefs = [
    {
      name: 'RP Group',
      filterLines: rpUseTagSet ? null : '  |> filter(fn: (r) => exists r.hostname and r.hostname =~ /^[Rr][Pp]/)',
      tags: rpUseTagSet ? rpUniqueTags : null,
      belongs: (tag, snap) => String(snap?.hostname || '').toUpperCase().startsWith('RP'),
    },
    {
      name: 'POS System Group',
      filterLines: posUseTagSet ? null : '  |> filter(fn: (r) => exists r.hostname and r.hostname =~ /^[Ll][Kk]/)',
      tags: posUseTagSet ? posUniqueTags : null,
      belongs: (tag, snap) => String(snap?.hostname || '').toUpperCase().startsWith('LK'),
    },
  ]
  if (sdwanUniqueTags.length > 0 && sdwanUniqueTags.length <= 4000) {
    groupDefs.push({
      name: 'SD-WAN Group',
      filterLines: null,
      tags: sdwanUniqueTags,
      belongs: (tag) => sdwanTagSet.has(tag),
    })
  }
  for (const [name, tagSet] of customGroupTagSets.entries()) {
    groupDefs.push({
      name,
      filterLines: null,
      tags: [...tagSet],
      belongs: (tag) => tagSet.has(tag),
    })
  }
  for (const gd of groupDefs) {
    gd.storeEstimate = estimateGroupStores(gd.belongs)
  }

  const maxStoreEstimate = groupDefs.reduce((m, g) => Math.max(m, g.storeEstimate || 0), 0)
  const bucketMin = pickDisconnectBucketMin(effectiveRangeSec, maxStoreEstimate, requestedBucketMin)
  const bucketEvery = `${bucketMin}m`
  const bucketSec = bucketMin * 60
  const truncateUnit = offlineTruncateUnit(bh)

  function dayMsFromTs(tsSec) {
    const d = new Date(tsSec * 1000)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  const start = new Date(requestedFromSec * 1000); start.setHours(0, 0, 0, 0)
  const end   = new Date(requestedToSec   * 1000); end.setHours(0, 0, 0, 0)
  const dayMsList = []
  for (let d = new Date(start); d.getTime() <= end.getTime(); d = new Date(d.getTime() + 86_400_000)) {
    dayMsList.push(d.getTime())
  }
  const dayStartLocalSec = dayMsList.map((dayMs) => Math.floor(dayMs / 1000))

  // Precompute BH minutes per (day-of-week × hour) since they're constant.
  const bhDayHourMinutes = bh ? new Array(7).fill(0).map(() => new Array(24).fill(0)) : null
  if (bh) {
    for (let dow = 0; dow < 7; dow++) {
      if (!bh.weekdays.has(dow)) continue
      for (let hour = 0; hour < 24; hour++) {
        const inHour = bh.startHour <= bh.endHour
          ? (hour >= bh.startHour && hour < bh.endHour)
          : (hour >= bh.startHour || hour < bh.endHour)
        if (inHour) bhDayHourMinutes[dow][hour] = 60
      }
    }
  }

  function overlapMinutes(startSec, endSec, dayStartLocalSecVal) {
    const dayEnd = dayStartLocalSecVal + 86400
    const a = Math.max(startSec, dayStartLocalSecVal)
    const b = Math.min(endSec, dayEnd)
    if (b <= a) return 0
    if (!bh) return Math.floor((b - a) / 60)

    const localOffsetMs = bh.tzOffsetMinutes * 60 * 1000
    const localA = (a * 1000) + localOffsetMs
    const localB = (b * 1000) + localOffsetMs
    const localDayStart = (dayStartLocalSecVal * 1000) + localOffsetMs
    const dow = new Date(localDayStart).getUTCDay()
    const dowRow = bhDayHourMinutes[dow]
    if (!dowRow.some((m) => m > 0)) return 0

    let mins = 0
    const firstHour = Math.floor((localA - localDayStart) / 3_600_000)
    const lastHour = Math.min(23, Math.floor((localB - localDayStart - 1) / 3_600_000))
    for (let h = Math.max(0, firstHour); h <= lastHour; h++) {
      const bhMins = dowRow[h]
      if (bhMins <= 0) continue
      const hourStart = localDayStart + h * 3_600_000
      const hourEnd = hourStart + 3_600_000
      const overlap = Math.min(localB, hourEnd) - Math.max(localA, hourStart)
      if (overlap <= 0) continue
      mins += Math.floor(overlap / 60_000)
    }
    return mins
  }

  const activeGroupDefs = onlyGroup
    ? groupDefs.filter((g) => g.name === onlyGroup)
    : groupDefs

  async function computeGroupDisconnectStats(groupDef) {
    const { name, belongs, storeEstimate = 0 } = groupDef
    const groupBucketMin = pickDisconnectBucketMin(effectiveRangeSec, storeEstimate, requestedBucketMin)
    const groupBucketEvery = `${groupBucketMin}m`
    const groupBucketSec = groupBucketMin * 60
    const skipConnDown = storeEstimate > 800
    const rollupsConfigured = Boolean(cfg().rollupsBucket)

    const dayMap = new Map()
    function ensureDay(dayMs) {
      if (!dayMap.has(dayMs)) dayMap.set(dayMs, { disconnections: 0, offlineBuckets: 0, offlineMinutes: 0 })
      return dayMap.get(dayMs)
    }
    function addOffline(dayMs, mins) {
      if (mins <= 0) return
      const s = ensureDay(dayMs)
      s.offlineMinutes += mins
      s.offlineBuckets += Math.round(mins / groupBucketMin)
    }

    const offlineBucketKeys = new Set()
    const disconnectKeys = new Set()
    const storesWithHbDisconnect = new Set()
    const reportingTags = new Set()

    const t0 = Date.now()
    // All sub-queries for this group fire in parallel.
    const [offlineResult, disconnectResult, connDownRows] = await Promise.all([
      runFilteredDisconnectQuery(
        fetchHeartbeatOfflineByDayFiltered, rangeClause, groupBucketEvery, groupDef, name, truncateUnit,
      ),
      runFilteredDisconnectQuery(
        fetchHeartbeatDisconnectByDayFiltered, rangeClause, groupBucketEvery, groupDef, name, truncateUnit,
      ),
      skipConnDown
        ? Promise.resolve([])
        : runFilteredDisconnectQuery(
            fetchConnDownByDayFiltered, rangeClause, groupBucketEvery, groupDef, name, truncateUnit,
          ),
    ])
    const offlineRows = offlineResult.rows
    const disconnectRows = disconnectResult.rows
    const offlineFromRollups = offlineResult.fromRollups
    const disconnectFromRollups = disconnectResult.fromRollups
    const offlineUnitMin = offlineFromRollups ? HEARTBEAT_BUCKET_MIN : groupBucketMin
    const queryMs = Date.now() - t0
    console.log(
      `[groupDisconnect] ${name}: queried ${queryMs}ms · `
      + `offline=${offlineRows.length} disconnects=${disconnectRows.length} connDown=${connDownRows.length} `
      + `· bucket=${groupBucketMin}m · estimate=${storeEstimate} stores`
    )

    for (const row of disconnectRows) {
      const tag = row.store_tag || buildSyntheticStoreTag(row.hostname, row.serial)
      if (!tag) continue
      reportingTags.add(tag)
      const ts = row._time ? Math.floor(new Date(row._time).getTime() / 1000) : null
      if (ts == null || !inBusinessHours(ts)) continue
      // Per-timestamp dedup so multiple hourly rows for the same (store, day)
      // are all counted (only true duplicates from the same time bucket are skipped).
      const key = `${tag}|${ts}`
      if (disconnectKeys.has(key)) continue
      disconnectKeys.add(key)
      storesWithHbDisconnect.add(tag)
      ensureDay(dayMsFromTs(ts)).disconnections += num(row._value) || 1
    }

    for (const row of offlineRows) {
      const tag = row.store_tag || buildSyntheticStoreTag(row.hostname, row.serial)
      if (!tag) continue
      reportingTags.add(tag)
      const ts = row._time ? Math.floor(new Date(row._time).getTime() / 1000) : null
      if (ts == null || !inBusinessHours(ts)) continue
      const buckets = num(row._value) || 0
      if (buckets <= 0) continue
      const mins = buckets * offlineUnitMin
      const key = `${tag}|${ts}`
      if (offlineBucketKeys.has(key)) continue
      offlineBucketKeys.add(key)
      addOffline(dayMsFromTs(ts), mins)
    }

    for (const row of connDownRows) {
      const tag = row.store_tag || buildSyntheticStoreTag(row.hostname, row.serial)
      if (!tag) continue
      reportingTags.add(tag)
      const ts = row._time ? Math.floor(new Date(row._time).getTime() / 1000) : null
      if (ts == null || !inBusinessHours(ts)) continue
      const buckets = num(row._value) || 0
      if (buckets <= 0) continue
      const mins = buckets * groupBucketMin
      const key = `${tag}|${ts}`
      if (offlineBucketKeys.has(key)) continue
      offlineBucketKeys.add(key)
      addOffline(dayMsFromTs(ts), mins)
    }

    if (Array.isArray(cached)) {
      for (const s of cached) {
        if (!s?.storeTag || s.online || s.onlineReason === 'activity') continue
        if (!belongs(s.storeTag, s)) continue
        const tag = s.storeTag
        reportingTags.add(tag)

        const lastSeenSec = s.lastSeen ? Math.floor(new Date(s.lastSeen).getTime() / 1000) : null
        if (!lastSeenSec || lastSeenSec >= requestedToSec) continue

        const silenceStart = Math.max(requestedFromSec, lastSeenSec + groupBucketSec)
        const silenceEnd = Math.min(requestedToSec, nowSec)
        if (silenceEnd <= silenceStart) continue

        const wentSilentInWindow = lastSeenSec >= requestedFromSec
        if (wentSilentInWindow && !storesWithHbDisconnect.has(tag)) {
          if (inBusinessHours(lastSeenSec)) {
            const dKey = `${tag}|${lastSeenSec}`
            if (!disconnectKeys.has(dKey)) {
              disconnectKeys.add(dKey)
              ensureDay(dayMsFromTs(lastSeenSec)).disconnections += 1
            }
          }
          storesWithHbDisconnect.add(tag)
        }

        for (let i = 0; i < dayStartLocalSec.length; i++) {
          const mins = overlapMinutes(silenceStart, silenceEnd, dayStartLocalSec[i])
          if (mins > 0) addOffline(dayMsList[i], mins)
        }
      }
    }

    const days = dayMsList.map((dayMs) => {
      const x = dayMap.get(dayMs) || { disconnections: 0, offlineBuckets: 0, offlineMinutes: 0 }
      return {
        dayMs,
        disconnections: x.disconnections,
        offlineBuckets: x.offlineBuckets,
        offlineMinutes: x.offlineMinutes,
        offlineHours: Math.round((x.offlineMinutes / 60) * 100) / 100,
      }
    })
    const totals = days.reduce((a, d) => ({
      disconnections: a.disconnections + d.disconnections,
      offlineMinutes: a.offlineMinutes + d.offlineMinutes,
    }), { disconnections: 0, offlineMinutes: 0 })
    totals.offlineHours = Math.round((totals.offlineMinutes / 60) * 100) / 100

    return {
      name,
      days,
      totals,
      storeCount: reportingTags.size,
      meta: {
        bucketMin: groupBucketMin,
        skipConnDown,
        rollupsConfigured,
        offlineFromRollups,
        disconnectFromRollups,
        rowCounts: {
          offline: offlineRows.length,
          disconnects: disconnectRows.length,
          connDown: connDownRows.length,
        },
        queryMs,
      },
    }
  }

  // When the request asks for a single group (the common path now — frontend fires one
  // request per group in parallel), there's only one entry in activeGroupDefs anyway.
  // For the full-fleet path, run all groups in parallel — Influx + the inflight cache
  // handle concurrency far better than us serialising on the Node side.
  const groupResults = activeGroupDefs.length
    ? await Promise.all(activeGroupDefs.map((gd) => computeGroupDisconnectStats(gd)))
    : onlyGroup
      ? [{
          name: onlyGroup,
          days: dayMsList.map((dayMs) => ({
            dayMs,
            disconnections: 0,
            offlineBuckets: 0,
            offlineMinutes: 0,
            offlineHours: 0,
          })),
          totals: { disconnections: 0, offlineMinutes: 0, offlineHours: 0 },
          storeCount: 0,
        }]
      : []

  const expectedOrder = [
    'SD-WAN Group',
    'RP Group',
    'POS System Group',
    ...customGroupTagSets.keys(),
  ]
  const byName = new Map(groupResults.map((g) => [g.name, g]))
  const groups = expectedOrder
    .map((n) => byName.get(n))
    .filter(Boolean)
    .concat(groupResults.filter((g) => !expectedOrder.includes(g.name)))

  const storesReporting = groupResults.reduce((sum, g) => sum + (g.storeCount || 0), 0)

    return {
      rangeSec: effectiveRangeSec,
      bucketMin,
      requestedFrom: new Date(requestedFromSec * 1000).toISOString(),
      requestedTo:   new Date(requestedToSec   * 1000).toISOString(),
      days: dayMsList.map((dayMs) => ({
        dayMs,
        label: new Date(dayMs).toISOString().slice(0, 10),
      })),
      source: cfg().rollupsBucket
        ? `${cfg().rollupsBucket} rollups (per-group queries)`
        : 'heartbeat.online + connectivity.conn_state (per-group queries)',
      storesReporting,
      groupQueryCount: activeGroupDefs.length,
      groupName: onlyGroup || null,
      sdwanStoreCount: sdwanUniqueTags.length,
      businessHours: bh ? {
        startHour: bh.startHour,
        endHour: bh.endHour,
        weekdays: [...bh.weekdays].sort(),
        tzOffsetMinutes: bh.tzOffsetMinutes,
      } : null,
      groups: groups.map(({ storeCount, ...g }) => ({ ...g, storeCount })),
    }
  })()

  _groupDisconnectCache.set(inflightKey, work)
  try {
    const result = await work
    _groupDisconnectCache.set(cacheKey, { data: result, ts: Date.now() })
    if (_groupDisconnectCache.size > 16) {
      const oldest = [..._groupDisconnectCache.entries()]
        .filter(([k]) => !k.startsWith('inflight:'))
        .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0))[0]
      if (oldest) _groupDisconnectCache.delete(oldest[0])
    }
    return result
  } finally {
    _groupDisconnectCache.delete(inflightKey)
  }
}

/**
 * Resolve a group name to a Flux filter spec (preferring tag-set for performance).
 * Used by the per-store disconnect events endpoint.
 */
function resolveGroupDefForName(groupName, snapshot, customGroups = []) {
  const name = String(groupName || '').trim()
  if (!name) return null

  const builtinMatchers = {
    'RP Group': {
      regexFilter: '  |> filter(fn: (r) => exists r.hostname and r.hostname =~ /^[Rr][Pp]/)',
      belongs: (_tag, snap) => String(snap?.hostname || '').toUpperCase().startsWith('RP'),
    },
    'POS System Group': {
      regexFilter: '  |> filter(fn: (r) => exists r.hostname and r.hostname =~ /^[Ll][Kk]/)',
      belongs: (_tag, snap) => String(snap?.hostname || '').toUpperCase().startsWith('LK'),
    },
  }

  if (name === 'SD-WAN Group' && Array.isArray(snapshot)) {
    const tags = []
    for (const s of snapshot) {
      if (!s?.storeTag) continue
      if (
        vendorIsFortinet(s.gatewayVendor, s.isFortinet)
        || vendorIsFortinet(s.lastGatewayVendor, s.lastIsFortinet)
      ) tags.push(s.storeTag)
    }
    const set = new Set(tags)
    if (!set.size) return null
    return { tags: [...set], belongs: (tag) => set.has(tag) }
  }

  if (builtinMatchers[name] && Array.isArray(snapshot)) {
    const tags = []
    for (const s of snapshot) {
      if (!s?.storeTag) continue
      if (builtinMatchers[name].belongs(s.storeTag, s)) tags.push(s.storeTag)
    }
    const set = new Set(tags)
    if (set.size && set.size <= 4000) {
      return { tags: [...set], belongs: (tag) => set.has(tag) }
    }
    return { filterLines: builtinMatchers[name].regexFilter, belongs: builtinMatchers[name].belongs }
  }

  for (const g of customGroups || []) {
    if (String(g?.name || '').trim() === name) {
      const tags = Array.isArray(g.storeTags)
        ? g.storeTags.map((t) => String(t || '').trim()).filter(Boolean)
        : []
      const set = new Set(tags)
      if (!set.size) return null
      return { tags: [...set], belongs: (tag) => set.has(tag) }
    }
  }

  return null
}

const GROUP_DISCONNECT_EVENTS_CACHE_MS = 60_000
const _groupDisconnectEventsCache = new Map()

/**
 * Per-store disconnect/reconnect events for a single group within a window.
 *
 * Uses 5-min gap detection on heartbeat.online (which production stores never set
 * to false — they just stop sending). Each transition where a window had a
 * heartbeat and the next one didn't = "disconnect"; reverse = "reconnect".
 *
 * Stores currently silent past the end of the window keep reconnectTs === null
 * and stillOffline === true. Stores already silent before the window starts are
 * back-filled from the snapshot using their lastSeen timestamp.
 *
 * @returns {Promise<{
 *   groupName: string,
 *   fromIso: string, toIso: string,
 *   bucketMin: number, storeCount: number, eventCount: number,
 *   stillOfflineCount: number, source: string,
 *   events: Array<{
 *     storeTag: string, hostname: string,
 *     disconnectTs: number, reconnectTs: number|null,
 *     durationMin: number|null, stillOffline: boolean,
 *   }>,
 * }>}
 */
export async function fetchGroupDisconnectEvents(rangeSec = 86400, fromSec, toSec, opts = {}) {
  if (!isInfluxStoreConfigured()) {
    return { events: [], error: 'InfluxDB not configured' }
  }
  const groupName = String(opts.groupName || '').trim()
  if (!groupName) {
    return { events: [], error: 'groupName required' }
  }
  const customGroups = Array.isArray(opts.customGroups) ? opts.customGroups : []
  const nowSec = Math.floor(Date.now() / 1000)
  const requestedFromSec = fromSec && Number.isFinite(Number(fromSec)) ? Number(fromSec) : nowSec - rangeSec
  const requestedToSec   = toSec && Number.isFinite(Number(toSec))     ? Number(toSec)   : nowSec
  if (!(requestedToSec > requestedFromSec)) {
    return { events: [], error: 'invalid time window' }
  }
  const rangeClause = buildFluxRangeClause(null, requestedFromSec, requestedToSec)
  const bucketMin = HEARTBEAT_BUCKET_MIN
  const bucketEvery = `${bucketMin}m`

  const liveWindow = !(fromSec && toSec)
  const customGroupKey = customGroups
    .map((g) => `${g?.name || ''}=${(Array.isArray(g?.storeTags) ? g.storeTags : []).slice().sort().join(',')}`)
    .sort()
    .join('|')
  const cacheBucket = liveWindow
    ? Math.floor(nowSec / Math.floor(GROUP_DISCONNECT_EVENTS_CACHE_MS / 1000))
    : `${requestedFromSec}:${requestedToSec}`
  const cacheKey = `${groupName}|${cacheBucket}|${customGroupKey}`
  const cached = _groupDisconnectEventsCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < GROUP_DISCONNECT_EVENTS_CACHE_MS) return cached.data

  let snapshot = getAnyCachedStoreSnapshot(15 * 60 * 1000)
  if (!snapshot) {
    try { snapshot = await fetchStoreSnapshot(15, '-24h') } catch { snapshot = null }
  }
  const groupDef = resolveGroupDefForName(groupName, snapshot, customGroups)
  if (!groupDef) {
    return { events: [], error: `Unknown group: ${groupName}` }
  }

  const filterLine = Array.isArray(groupDef.tags) && groupDef.tags.length
    ? fluxStoreTagSetFilter(groupDef.tags)
    : (groupDef.filterLines || '')

  const bucket = fluxEscape(cfg().bucket)
  const flux = `
from(bucket: "${bucket}")
  |> range(${rangeClause})
  |> filter(fn: (r) => r._measurement == "heartbeat" and r._field == "online")
${filterLine}
  |> aggregateWindow(every: ${bucketEvery}, fn: count, createEmpty: true)
  |> map(fn: (r) => ({ r with seen: if r._value > 0 then 1 else 0 }))
  |> difference(columns: ["seen"], keepFirst: false)
  |> filter(fn: (r) => r.seen != 0)
  |> keep(columns: ["_time", "store_tag", "hostname", "seen"])
`
  const t0 = Date.now()
  let rows = []
  try {
    rows = await queryFlux(flux)
  } catch (e) {
    console.warn(`[influxStore] fetchGroupDisconnectEvents (${groupName}) failed:`, e.message)
    return { events: [], error: e.message }
  }
  const queryMs = Date.now() - t0

  const byStore = new Map()
  for (const r of rows) {
    const tag = r.store_tag || buildSyntheticStoreTag(r.hostname, r.serial)
    if (!tag) continue
    const ts = r._time ? Math.floor(new Date(r._time).getTime() / 1000) : null
    if (ts == null) continue
    const seen = num(r.seen) || 0
    if (!seen) continue
    if (!byStore.has(tag)) {
      byStore.set(tag, { storeTag: tag, hostname: r.hostname || '', edges: [] })
    }
    byStore.get(tag).edges.push({ ts, kind: seen < 0 ? 'down' : 'up' })
  }

  const events = []
  for (const store of byStore.values()) {
    store.edges.sort((a, b) => a.ts - b.ts)
    let pendingDown = null
    for (const edge of store.edges) {
      if (edge.kind === 'down') {
        if (pendingDown != null) {
          // Two downs in a row (shouldn't happen, but be defensive)
          events.push({
            storeTag: store.storeTag,
            hostname: store.hostname,
            disconnectTs: pendingDown,
            reconnectTs: edge.ts,
            durationMin: Math.round((edge.ts - pendingDown) / 60),
            stillOffline: false,
          })
        }
        pendingDown = edge.ts
      } else if (pendingDown != null) {
        events.push({
          storeTag: store.storeTag,
          hostname: store.hostname,
          disconnectTs: pendingDown,
          reconnectTs: edge.ts,
          durationMin: Math.round((edge.ts - pendingDown) / 60),
          stillOffline: false,
        })
        pendingDown = null
      }
    }
    if (pendingDown != null) {
      events.push({
        storeTag: store.storeTag,
        hostname: store.hostname,
        disconnectTs: pendingDown,
        reconnectTs: null,
        durationMin: Math.max(0, Math.round((requestedToSec - pendingDown) / 60)),
        stillOffline: true,
      })
    }
  }

  // Back-fill stores that were already silent before the window started.
  const sevenDaysSec = 7 * 86400
  if (Array.isArray(snapshot)) {
    for (const s of snapshot) {
      if (!s?.storeTag || s.online || s.onlineReason === 'activity') continue
      if (!groupDef.belongs(s.storeTag, s)) continue
      if (byStore.has(s.storeTag)) continue
      const lastSeenSec = s.lastSeen ? Math.floor(new Date(s.lastSeen).getTime() / 1000) : null
      if (!lastSeenSec) continue
      if (lastSeenSec < requestedFromSec - sevenDaysSec) continue
      events.push({
        storeTag: s.storeTag,
        hostname: s.hostname || '',
        disconnectTs: lastSeenSec,
        reconnectTs: null,
        durationMin: Math.max(0, Math.round((nowSec - lastSeenSec) / 60)),
        stillOffline: true,
      })
    }
  }

  events.sort((a, b) => (b.disconnectTs || 0) - (a.disconnectTs || 0))

  const data = {
    groupName,
    fromIso: new Date(requestedFromSec * 1000).toISOString(),
    toIso: new Date(requestedToSec * 1000).toISOString(),
    rangeSec: requestedToSec - requestedFromSec,
    bucketMin,
    storeCount: byStore.size,
    eventCount: events.length,
    stillOfflineCount: events.filter((e) => e.stillOffline).length,
    source: 'heartbeat gap detection (raw, 5m windows)',
    meta: { queryMs, edgeRowCount: rows.length },
    events,
  }

  console.log(
    `[groupDisconnectEvents] ${groupName}: ${rows.length} edges in ${queryMs}ms → `
    + `${events.length} events (${data.stillOfflineCount} still offline)`,
  )

  _groupDisconnectEventsCache.set(cacheKey, { data, ts: Date.now() })
  if (_groupDisconnectEventsCache.size > 32) {
    const oldest = [..._groupDisconnectEventsCache.entries()]
      .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0))[0]
    if (oldest) _groupDisconnectEventsCache.delete(oldest[0])
  }
  return data
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
  |> range(start: -15m)
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
  |> filter(fn: (r) =>
      not exists r.crash_type or
      (r.crash_type != "none" and r.crash_type != "" and r.crash_type != "null" and r.crash_type != "unknown"))
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

  const BLANK_CRASH_TYPE = new Set(['none', 'null', 'n/a', '', 'undefined', 'unknown'])
  for (const row of rows) {
    // Also skip if a crash_type tag is explicitly set to a blank value
    const rowCrashTypeTag = String(row.crash_type || '').toLowerCase().trim()
    if (rowCrashTypeTag && BLANK_CRASH_TYPE.has(rowCrashTypeTag)) continue

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
 * Pivot raw Flux crash rows into individual events (hostname + timestamp + app).
 * @param {object[]} rows from fetchCrashEvents
 * @returns {Array<{ ts: string, hostname: string, storeTag: string, appName: string|null, crashType: string, count: number, message: string|null, eventId: string|null }>}
 */
export function buildCrashEventList(rows) {
  const BLANK_APP = new Set(['none', 'null', 'n/a', '', 'undefined', 'unknown'])
  const BLANK_CRASH_TYPE = new Set(['none', 'null', 'n/a', '', 'undefined', 'unknown'])
  const byKey = new Map()

  for (const row of rows || []) {
    const rowCrashTypeTag = String(row.crash_type || '').toLowerCase().trim()
    if (rowCrashTypeTag && BLANK_CRASH_TYPE.has(rowCrashTypeTag)) continue

    const ts = row._time
    if (!ts) continue
    const storeTag = row.store_tag || row.hostname || ''
    const hostname = row.hostname || row.store_tag || ''
    const appRaw = row.app_name || ''
    const appName = (!appRaw || BLANK_APP.has(String(appRaw).toLowerCase().trim())) ? null : appRaw
    const crashType = row._measurement || 'app_crash'
    const key = `${ts}|${storeTag}|${hostname}|${appName || ''}|${crashType}`

    if (!byKey.has(key)) {
      byKey.set(key, {
        ts,
        hostname,
        storeTag,
        appName,
        crashType,
        count: 0,
        message: null,
        eventId: null,
      })
    }
    const ev = byKey.get(key)
    if (row._field === 'count') ev.count += num(row._value) || 1
    if (row._field === 'message') ev.message = row._value
    if (row._field === 'event_id') ev.eventId = row._value
    if (ev.count === 0 && row._field !== 'count') ev.count = 1
  }

  return [...byKey.values()]
    .filter(e => e.count > 0 || e.message || e.eventId)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
}

/**
 * Individual crash events with hostname and timestamp.
 */
export async function fetchCrashEventList(rangeParam = '-24h', fromSec, toSec, { appName, storeTag, hostname } = {}) {
  let rows = await fetchCrashEvents(rangeParam, fromSec, toSec)
  if (storeTag) {
    const tag = String(storeTag).toLowerCase()
    rows = rows.filter(r => String(r.store_tag || '').toLowerCase() === tag || String(r.hostname || '').toLowerCase() === tag)
  }
  if (hostname) {
    const h = String(hostname).toLowerCase()
    rows = rows.filter(r => String(r.hostname || '').toLowerCase().includes(h) || String(r.store_tag || '').toLowerCase().includes(h))
  }
  let events = buildCrashEventList(rows)
  if (appName) {
    const f = String(appName).toLowerCase()
    events = events.filter(e => {
      const a = String(e.appName || '').toLowerCase()
      const msg = String(e.message || '').toLowerCase()
      if (a) return a === f || a.includes(f) || f.includes(a)
      return msg.includes(f)
    })
  }
  return events
}

/**
 * Per-store crash counts in the last N minutes — used by the alert engine.
 * Returns Map< storeKey, Map<"appName||crashType", count> >
 */
export async function fetchCrashCountsPerStore(rangeParam = '-15m') {
  const rows = await fetchCrashEvents(rangeParam)
  // storeMap: storeKey → Map<"appName||crashType", count>
  const storeMap = new Map()
  for (const row of rows) {
    if (row._field !== 'count') continue
    const storeKey  = row.store_tag || row.hostname
    const appName   = (row.app_name   || '').toLowerCase()
    const crashType = (row._measurement || 'app_crash').toLowerCase()
    const subKey    = `${appName}||${crashType}`
    if (!storeMap.has(storeKey)) storeMap.set(storeKey, new Map())
    const sub = storeMap.get(storeKey)
    sub.set(subKey, (sub.get(subKey) || 0) + (num(row._value) || 1))
  }
  return storeMap
}
