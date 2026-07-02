/**
 * Good-Minutes connectivity compliance — minute-based scoring from Store Zabbix ping history.
 *
 * Fetches per-store history via netpulse_query, parses large JSON from temp files,
 * and computes strict/covered compliance percentages without returning raw payloads.
 */
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

/** Default BH window: 10am–10pm local (endHour 22 = exclusive, last minute 21:59). */
export const DEFAULT_BUSINESS_HOURS = {
  startHour: 10,
  endHour: 22,
  tzOffsetMinutes: 330,
  label: '10am–10pm IST',
}

/** Merge caller overrides onto defaults; validates start < end. */
export function resolveBusinessHours(overrides = {}) {
  const { label: _drop, ...defaults } = DEFAULT_BUSINESS_HOURS
  const merged = { ...defaults, ...overrides }
  if (merged.startHour >= merged.endHour) {
    throw new Error(
      `businessHours: startHour (${merged.startHour}) must be less than endHour (${merged.endHour})`,
    )
  }
  merged.label = overrides.label || formatBusinessHoursLabel(merged)
  return merged
}

/** Human label e.g. "10am–10pm IST". */
export function formatBusinessHoursLabel({ startHour, endHour, tzOffsetMinutes }) {
  const fmt = (h) => {
    if (h === 0 || h === 24) return '12am'
    if (h === 12) return '12pm'
    return h < 12 ? `${h}am` : `${h - 12}pm`
  }
  const tz =
    tzOffsetMinutes === 330
      ? ' IST'
      : tzOffsetMinutes === 0
        ? ' UTC'
        : ` UTC${tzOffsetMinutes >= 0 ? '+' : ''}${tzOffsetMinutes / 60}h`
  return `${fmt(startHour)}–${fmt(endHour)}${tz}`
}
export const DEFAULT_THRESHOLDS = {
  latencyMaxMs: 60,
  jitterMaxMs: 30,
  uploadMinMbps: 10,
  complianceTargetPct: 99,
}

const LATENCY_KEY = 'custom.ping.ms[8.8.8.8]'
const JITTER_KEY = 'custom.ping.jitter[8.8.8.8]'
const STORE_CODE_PREFIX = 'LKST'
const PING_CADENCE_TARGET_SEC = 60
const PING_CADENCE_WARN_LOW = 45
const PING_CADENCE_WARN_HIGH = 90

/** Ensure store code carries LKST prefix (e.g. "1514" → "LKST1514"). */
export function normalizeStoreCode(code) {
  const raw = String(code || '').trim().toUpperCase()
  if (!raw) return raw
  if (raw.startsWith(STORE_CODE_PREFIX)) return raw
  return `${STORE_CODE_PREFIX}${raw}`
}

export function normalizeStoreCodes(codes) {
  return (codes || []).map(normalizeStoreCode)
}

/** Aggregate latency/jitter stats over BH samples only. */
export function aggregateBhSampleStats(latencySamples, jitterSamples, bhMinutes) {
  const bhSet = new Set(bhMinutes)
  const latVals = []
  const jitVals = []
  for (const s of latencySamples) {
    const minTs = Math.floor(s.clock / 60) * 60
    if (bhSet.has(minTs)) latVals.push(s.ms)
  }
  for (const s of jitterSamples) {
    const minTs = Math.floor(s.clock / 60) * 60
    if (bhSet.has(minTs)) jitVals.push(s.ms)
  }
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
  return {
    avgLatencyMs: latVals.length ? round1(avg(latVals)) : null,
    maxLatencyMs: latVals.length ? round1(Math.max(...latVals)) : null,
    avgJitterMs: jitVals.length ? round1(avg(jitVals)) : null,
    maxJitterMs: jitVals.length ? round1(Math.max(...jitVals)) : null,
    sampleCount: latVals.length,
  }
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function matrixPrefix(pass) {
  if (pass === null) return 'N/A'
  return pass ? 'PASS' : 'FAIL'
}

/**
 * Internet matrix per store — matches fleet connectivity standard table.
 * Each row: signal, source, threshold, measured value, prefix (PASS/FAIL/N/A).
 */
export function buildInternetMatrix(storeRow, sampleStats, thresholds = DEFAULT_THRESHOLDS) {
  const store = normalizeStoreCode(storeRow.store)
  const { latencyMaxMs, jitterMaxMs, uploadMinMbps, complianceTargetPct } = thresholds

  const packetLossPct =
    storeRow.expectedMin > 0 ? roundPct((storeRow.lossMin / storeRow.expectedMin) * 100) : null
  const linkUp = storeRow.coveredMin > 0
  const uploadMbps = storeRow.latestUploadMbps

  const rows = [
    {
      signal: 'Reachable / link up',
      source: 'ICMP ping; WAN interface status',
      threshold: 'Up',
      value: linkUp ? 'Up' : 'Down',
      prefix: matrixPrefix(linkUp),
    },
    {
      signal: 'Packet loss',
      source: 'Ping loss % (missing ping = loss, strict BH basis)',
      threshold: '< 1%',
      value: packetLossPct != null ? `${packetLossPct}%` : null,
      prefix: matrixPrefix(packetLossPct != null ? packetLossPct < 1 : null),
    },
    {
      signal: 'Latency',
      source: 'Ping avg / max RTT',
      threshold: `< ${latencyMaxMs} ms`,
      value:
        sampleStats.maxLatencyMs != null
          ? `avg ${sampleStats.avgLatencyMs ?? '—'} ms · max ${sampleStats.maxLatencyMs} ms`
          : null,
      prefix: matrixPrefix(
        sampleStats.maxLatencyMs != null ? sampleStats.maxLatencyMs < latencyMaxMs : null,
      ),
    },
    {
      signal: 'Jitter',
      source: 'Std-dev of ping RTT (calculated item)',
      threshold: `< ${jitterMaxMs} ms`,
      value:
        sampleStats.maxJitterMs != null
          ? `avg ${sampleStats.avgJitterMs ?? '—'} ms · max ${sampleStats.maxJitterMs} ms`
          : null,
      prefix: matrixPrefix(
        sampleStats.maxJitterMs != null ? sampleStats.maxJitterMs < jitterMaxMs : null,
      ),
    },
    {
      signal: 'Usable bandwidth (upload)',
      source: 'Scheduled speedtest snapshot (3–4×/day, not per-minute history)',
      threshold: `≥ ${uploadMinMbps} Mbps upload`,
      value: uploadMbps != null ? `${uploadMbps} Mbps upload` : null,
      prefix: matrixPrefix(uploadMbps != null ? uploadMbps >= uploadMinMbps : null),
    },
    {
      signal: 'Good-minutes compliance',
      source: 'Minute-based BH score (latency + jitter gates)',
      threshold: `≥ ${complianceTargetPct}%`,
      value: `${storeRow.goodPctStrict}% strict · ${storeRow.goodPctCovered}% covered`,
      prefix: matrixPrefix(storeRow.compliantStrict),
    },
  ]

  const allPass = rows.every((r) => r.prefix === 'PASS')
  const anyFail = rows.some((r) => r.prefix === 'FAIL')

  return {
    store,
    prefix: STORE_CODE_PREFIX,
    overallPrefix: allPass ? 'PASS' : anyFail ? 'FAIL' : 'PARTIAL',
    rows,
  }
}

export function formatInternetMatrixText(matrix) {
  const lines = [
    `${matrix.store} — Internet Matrix [${matrix.overallPrefix}]`,
    '',
    'Signal | Value | Threshold | Status',
    '--- | --- | --- | ---',
  ]
  for (const r of matrix.rows) {
    const val = r.value != null ? `${r.prefix} ${r.value}` : `${r.prefix} —`
    lines.push(`${r.signal} | ${val} | ${r.threshold} | ${r.prefix}`)
  }
  return lines.join('\n')
}

export function buildInternetMatrixSummary(perStoreMatrices) {
  return perStoreMatrices.map(formatInternetMatrixText).join('\n\n')
}

/** Build the natural-language question that triggers per-sample Zabbix history (not null). */
export function buildStoreHistoryQuestion(storeCode) {
  return (
    `For store ${storeCode}, return time-series history of the Store Zabbix connectivity ` +
    'metrics over this window — ping packet loss %, ping average RTT (ms), ping max RTT (ms), ' +
    'and jitter / std-dev of ping RTT. I need per-sample values with timestamps ' +
    '(not just the latest snapshot). Also return BH-filtered disconnect events and ' +
    'storeMonitor speedtest upload/download Mbps.'
  )
}

/** Enumerate every business-hours minute in [fromUnix, toUnix). */
export function enumerateBhMinutes(fromUnix, toUnix, businessHours = DEFAULT_BUSINESS_HOURS) {
  const { startHour, endHour, tzOffsetMinutes } = businessHours
  const minutes = []
  let t = Math.floor(fromUnix / 60) * 60
  if (t < fromUnix) t += 60

  while (t < toUnix) {
    const localMs = t * 1000 + tzOffsetMinutes * 60 * 1000
    const localHour = new Date(localMs).getUTCHours()
    if (localHour >= startHour && localHour < endHour) minutes.push(t)
    t += 60
  }
  return minutes
}

/** Recursively walk JSON and collect latency/jitter samples keyed by clock. */
export function extractPingSamples(root) {
  const latencyByClock = new Map()
  const jitterByClock = new Map()

  function ingestPoints(points, targetMap) {
    if (!Array.isArray(points)) return
    for (const p of points) {
      const clock = Number(p?.clock)
      const ms = Number(p?.ms ?? p?.value)
      if (!Number.isFinite(clock) || !Number.isFinite(ms)) continue
      const prev = targetMap.get(clock)
      if (prev == null || ms > prev) targetMap.set(clock, ms)
    }
  }

  function walk(node) {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const key = node.key
    if (key === LATENCY_KEY && node.points) ingestPoints(node.points, latencyByClock)
    if (key === JITTER_KEY && node.points) ingestPoints(node.points, jitterByClock)
    for (const v of Object.values(node)) walk(v)
  }

  walk(root)
  return {
    latency: [...latencyByClock.entries()].map(([clock, ms]) => ({ clock, ms })),
    jitter: [...jitterByClock.entries()].map(([clock, ms]) => ({ clock, ms })),
  }
}

/** Find latest uploadMbps from storeMonitor context (snapshot only — not per-minute). */
export function extractLatestUploadMbps(root, storeCode) {
  const code = String(storeCode || '').toUpperCase()
  let best = null

  function matchesStore(obj) {
    if (!obj || typeof obj !== 'object') return false
    const candidates = [
      obj.storeTag,
      obj.hostname,
      obj.store,
      obj.storeCode,
      obj.host,
      obj.name,
    ].filter(Boolean).map((s) => String(s).toUpperCase())
    return candidates.some((c) => c.includes(code))
  }

  function walk(node) {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node.uploadMbps != null && Number.isFinite(Number(node.uploadMbps))) {
      if (!code || matchesStore(node)) {
        const val = Number(node.uploadMbps)
        if (best == null || val > best) best = val
      }
    }
    for (const v of Object.values(node)) walk(v)
  }

  walk(root)
  return best
}

/** Bucket samples into BH minutes — O(samples). */
export function bucketSamplesByMinute(latencySamples, jitterSamples, bhMinutes) {
  const bhSet = new Set(bhMinutes)
  const buckets = new Map()

  function ensure(minTs) {
    if (!buckets.has(minTs)) buckets.set(minTs, { latency: [], jitter: [] })
    return buckets.get(minTs)
  }

  for (const s of latencySamples) {
    const minTs = Math.floor(s.clock / 60) * 60
    if (!bhSet.has(minTs)) continue
    ensure(minTs).latency.push(s.ms)
  }
  for (const s of jitterSamples) {
    const minTs = Math.floor(s.clock / 60) * 60
    if (!bhSet.has(minTs)) continue
    ensure(minTs).jitter.push(s.ms)
  }
  return { buckets, bhSet }
}

function classifyDataQuality(expectedMin, coveredMin, biggestGapMin) {
  const lossMin = expectedMin - coveredMin
  if (lossMin <= 0) return 'ok'
  const lowCoverage = coveredMin / expectedMin < 0.95
  const deficit = lossMin
  if (lowCoverage && biggestGapMin >= deficit * 0.7 && biggestGapMin >= 30) return 'monitoring_gap'
  if (lossMin > 0) return 'intermittent_loss'
  return 'ok'
}

function medianIntervalSec(samples) {
  if (!samples || samples.length < 2) return null
  const sorted = [...samples].map((s) => s.clock).sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1])
  gaps.sort((a, b) => a - b)
  const mid = Math.floor(gaps.length / 2)
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
}

/**
 * Score one store from parsed ping samples.
 * @returns per-store result object + internal validation warnings
 */
export function scoreStoreCompliance({
  store,
  bhMinutes,
  latencySamples,
  jitterSamples,
  thresholds = DEFAULT_THRESHOLDS,
  latestUploadMbps = null,
}) {
  const { latencyMaxMs, jitterMaxMs, complianceTargetPct } = thresholds
  const expectedMin = bhMinutes.length
  const { buckets } = bucketSamplesByMinute(latencySamples, jitterSamples, bhMinutes)

  let coveredMin = 0
  let goodMin = 0
  let lossMin = 0
  let latencyBadMin = 0
  let jitterBadMin = 0
  let currentGap = 0
  let biggestGapMin = 0

  // Independent reconciliation counters
  let reconcileLatencyBad = 0
  let reconcileJitterBad = 0

  for (const minTs of bhMinutes) {
    const bucket = buckets.get(minTs)
    const hasLat = bucket?.latency?.length > 0
    const hasJit = bucket?.jitter?.length > 0

    if (!hasLat && !hasJit) {
      lossMin++
      currentGap++
      continue
    }

    if (currentGap > biggestGapMin) biggestGapMin = currentGap
    currentGap = 0
    coveredMin++

    const maxLat = hasLat ? Math.max(...bucket.latency) : Infinity
    const maxJit = hasJit ? Math.max(...bucket.jitter) : Infinity

    const latPass = hasLat && maxLat < latencyMaxMs
    const jitPass = hasJit && maxJit < jitterMaxMs

    if (hasLat && maxLat >= latencyMaxMs) {
      latencyBadMin++
      reconcileLatencyBad++
    }
    if (hasJit && maxJit >= jitterMaxMs) {
      jitterBadMin++
      reconcileJitterBad++
    }

    if (latPass && jitPass) goodMin++
  }
  if (currentGap > biggestGapMin) biggestGapMin = currentGap

  const goodPctStrict = expectedMin > 0 ? (goodMin / expectedMin) * 100 : 0
  const goodPctCovered = coveredMin > 0 ? (goodMin / coveredMin) * 100 : 0
  const target = complianceTargetPct / 100
  const compliantStrict = goodPctStrict / 100 >= target
  const compliantCovered = goodPctCovered / 100 >= target
  const dataQualityFlag = classifyDataQuality(expectedMin, coveredMin, biggestGapMin)

  const medianCadence = medianIntervalSec(latencySamples.length ? latencySamples : jitterSamples)
  const warnings = []
  if (medianCadence != null && (medianCadence < PING_CADENCE_WARN_LOW || medianCadence > PING_CADENCE_WARN_HIGH)) {
    warnings.push(
      `Ping cadence median ${medianCadence.toFixed(0)}s deviates from expected ~${PING_CADENCE_TARGET_SEC}s`,
    )
  }
  if (reconcileLatencyBad !== latencyBadMin) {
    warnings.push(`Latency bad-minute reconciliation mismatch: ${latencyBadMin} vs ${reconcileLatencyBad}`)
  }
  if (reconcileJitterBad !== jitterBadMin) {
    warnings.push(`Jitter bad-minute reconciliation mismatch: ${jitterBadMin} vs ${reconcileJitterBad}`)
  }

  // Bandwidth gate: snapshot only — can only tighten compliance, not loosen
  let bandwidthNote = null
  if (latestUploadMbps != null) {
    if (latestUploadMbps < thresholds.uploadMinMbps) {
      bandwidthNote = `Latest speedtest upload ${latestUploadMbps} Mbps < ${thresholds.uploadMinMbps} Mbps threshold (not applied to minute score; would fail if enforced)`
    } else {
      bandwidthNote = `Latest speedtest upload ${latestUploadMbps} Mbps meets ${thresholds.uploadMinMbps} Mbps threshold`
    }
  } else {
    bandwidthNote = 'No speedtest upload snapshot in window — bandwidth gate excluded from minute scoring'
  }

  return {
    store,
    expectedMin,
    coveredMin,
    goodMin,
    lossMin,
    latencyBadMin,
    jitterBadMin,
    goodPctStrict: roundPct(goodPctStrict),
    goodPctCovered: roundPct(goodPctCovered),
    compliantStrict,
    compliantCovered,
    biggestGapMin,
    dataQualityFlag,
    latestUploadMbps,
    bandwidthNote,
    medianPingCadenceSec: medianCadence != null ? Math.round(medianCadence) : null,
    warnings,
  }
}

function roundPct(n) {
  return Math.round(n * 100) / 100
}

export function computeFleetSummary(perStore, complianceTargetPct) {
  const total = perStore.length
  const storesCompliantStrict = perStore.filter((s) => s.compliantStrict).length
  const storesCompliantCovered = perStore.filter((s) => s.compliantCovered).length
  const pctStoresCompliantStrict = total > 0 ? roundPct((storesCompliantStrict / total) * 100) : 0
  const pctStoresCompliantCovered = total > 0 ? roundPct((storesCompliantCovered / total) * 100) : 0
  const oneLineSummary =
    `${storesCompliantStrict} / ${total} stores met the connectivity standard (strict) — target ${complianceTargetPct}%.`

  return {
    storesCompliantStrict,
    storesCompliantCovered,
    total,
    pctStoresCompliantStrict,
    pctStoresCompliantCovered,
    oneLineSummary,
  }
}

export function buildHumanSummary(result) {
  const lines = []
  if (result.internetMatrix?.length) {
    lines.push('=== Internet Matrix ===', '', buildInternetMatrixSummary(result.internetMatrix), '')
  }
  lines.push(
    result.fleet.oneLineSummary,
    `Covered basis: ${result.fleet.storesCompliantCovered} / ${result.fleet.total} stores (${result.fleet.pctStoresCompliantCovered}%).`,
    `Window: ${result.window.fromUnix} – ${result.window.toUnix} (${result.window.label}).`,
    `Business hours: ${result.businessHours.label || formatBusinessHoursLabel(result.businessHours)} (startHour=${result.businessHours.startHour}, endHour=${result.businessHours.endHour}, tzOffsetMinutes=${result.businessHours.tzOffsetMinutes}).`,
    '',
    'Per store (strict good-min %):',
  )
  for (const s of result.perStore) {
    const store = normalizeStoreCode(s.store)
    lines.push(
      `  ${store}: ${s.goodPctStrict}% strict / ${s.goodPctCovered}% covered` +
        ` (${s.goodMin}/${s.expectedMin} good min, flag=${s.dataQualityFlag})` +
        (s.latestUploadMbps != null ? ` · upload ${s.latestUploadMbps} Mbps` : ''),
    )
  }
  if (result.roFleet) {
    lines.push('', `Remote-Optometry fleet: ${result.roFleet.oneLineSummary}`)
  }
  const allWarnings = result.perStore.flatMap((s) => s.warnings || [])
  if (allWarnings.length) {
    lines.push('', 'Warnings:', ...allWarnings.map((w) => `  • ${w}`))
  }
  lines.push(
    '',
    'Note: disconnect events are agent heartbeat only — not used for connectivity gates.',
    'Bandwidth gate uses latest speedtest snapshot only (not per-minute history).',
  )
  return lines.join('\n')
}

/**
 * Fetch one store's history via netpulse_query, persist to temp file, parse samples only.
 */
export async function fetchStorePingHistory(netpulse, storeCode, fromUnix, toUnix) {
  const question = buildStoreHistoryQuestion(storeCode)
  const payload = await netpulse.query({
    question,
    modules: ['storeZabbix', 'storeMonitor'],
    autoModules: false,
    includeContext: true,
    historyFrom: fromUnix,
    historyTo: toUnix,
  })

  const tmpPath = path.join(
    os.tmpdir(),
    `netpulse-gmc-${sanitizeFilename(storeCode)}-${Date.now()}.json`,
  )
  try {
    await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf8')
    const raw = await fs.readFile(tmpPath, 'utf8')
    const data = JSON.parse(raw)
    const samples = extractPingSamples(data)
    const latestUploadMbps = extractLatestUploadMbps(data, storeCode)
    return { samples, latestUploadMbps, fetchError: null }
  } catch (err) {
    return {
      samples: { latency: [], jitter: [] },
      latestUploadMbps: null,
      fetchError: err?.message || String(err),
    }
  } finally {
    await fs.unlink(tmpPath).catch(() => {})
  }
}

function sanitizeFilename(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Main entry: compute good-minutes compliance for a fleet.
 */
export async function runGoodMinutesCompliance(netpulse, args) {
  const {
    storeCodes,
    fromUnix,
    toUnix,
    businessHours: businessHoursOverride,
    thresholds = DEFAULT_THRESHOLDS,
    roStoreCodes,
  } = args

  if (!Array.isArray(storeCodes) || storeCodes.length === 0) {
    throw new Error('storeCodes must be a non-empty string array')
  }
  if (!Number.isFinite(fromUnix) || !Number.isFinite(toUnix) || fromUnix >= toUnix) {
    throw new Error('fromUnix and toUnix must be valid unix seconds with fromUnix < toUnix')
  }

  const mergedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
  const mergedBh = resolveBusinessHours(businessHoursOverride)
  const bhMinutes = enumerateBhMinutes(fromUnix, toUnix, mergedBh)
  const normalizedStores = normalizeStoreCodes(storeCodes)

  const window = {
    fromUnix,
    toUnix,
    label: `${new Date(fromUnix * 1000).toISOString()} – ${new Date(toUnix * 1000).toISOString()}`,
  }

  const perStore = []
  const internetMatrix = []
  for (const store of normalizedStores) {
    const { samples, latestUploadMbps, fetchError } = await fetchStorePingHistory(
      netpulse,
      store,
      fromUnix,
      toUnix,
    )
    const sampleStats = aggregateBhSampleStats(samples.latency, samples.jitter, bhMinutes)
    const row = scoreStoreCompliance({
      store,
      bhMinutes,
      latencySamples: samples.latency,
      jitterSamples: samples.jitter,
      thresholds: mergedThresholds,
      latestUploadMbps,
    })
    if (fetchError) row.warnings = [...(row.warnings || []), `Fetch/parse error: ${fetchError}`]
    row.store = normalizeStoreCode(row.store)
    row.internetMatrix = buildInternetMatrix(row, sampleStats, mergedThresholds)
    perStore.push(row)
    internetMatrix.push(row.internetMatrix)
  }

  const fleet = computeFleetSummary(perStore, mergedThresholds.complianceTargetPct)

  let roFleet = null
  if (Array.isArray(roStoreCodes) && roStoreCodes.length > 0) {
    const roSet = new Set(normalizeStoreCodes(roStoreCodes))
    const roRows = perStore.filter((s) => roSet.has(normalizeStoreCode(s.store)))
    roFleet = computeFleetSummary(roRows, mergedThresholds.complianceTargetPct)
  }

  const result = {
    window,
    businessHours: mergedBh,
    thresholds: mergedThresholds,
    storeCodePrefix: STORE_CODE_PREFIX,
    internetMatrix,
    perStore,
    fleet,
    roFleet,
    limitations: [
      'Disconnect events track store-PC agent heartbeat, not WAN outages — excluded from gates.',
      'Missing ping in a BH minute counts as packet loss on the strict basis (60s cadence).',
      'Bandwidth gate uses latest speedtest upload snapshot only; excluded from per-minute scoring.',
    ],
  }

  return {
    structured: result,
    summary: buildHumanSummary(result),
  }
}
