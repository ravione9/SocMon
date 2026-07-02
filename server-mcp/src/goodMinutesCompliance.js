/**
 * Good-Minutes connectivity compliance — minute-based scoring from Store Zabbix ping history.
 *
 * Fetches per-store history via netpulse_query, parses large JSON from temp files,
 * and computes strict/covered compliance percentages without returning raw payloads.
 */
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { resolveComplianceWindow, formatWindowInputHelp } from './resolveComplianceWindow.js'
import {
  normalizeStoreCode,
  normalizeStoreCodes,
  resolveStoreIdentity,
  hostMatchesStoreCode,
  STORE_DISPLAY_PREFIX,
} from './storeCodeAlias.js'
import {
  buildEffectiveBhMinutes,
  extractUptimePoints,
  extractCrashEventTimes,
} from './storeOperatingWindow.js'

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
const PING_CADENCE_TARGET_SEC = 60
const PING_CADENCE_WARN_LOW = 45
const PING_CADENCE_WARN_HIGH = 90

/** Ensure store code carries LKST prefix — re-exported from storeCodeAlias. */
export { normalizeStoreCode, normalizeStoreCodes, resolveStoreIdentity, extractNumericStoreCode } from './storeCodeAlias.js'

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
      signal: 'Good-Minutes %',
      source:
        'Minute-based BH score — one bad sample fails the entire minute (not averaged like uptime metrics)',
      threshold: `≥ ${complianceTargetPct}%`,
      value: `${storeRow.goodMinutesPct ?? storeRow.goodPctStrict}% (${storeRow.goodMin}/${storeRow.expectedMin} good minutes)`,
      prefix: matrixPrefix(storeRow.compliant ?? storeRow.compliantStrict),
    },
  ]

  const allPass = rows.every((r) => r.prefix === 'PASS')
  const anyFail = rows.some((r) => r.prefix === 'FAIL')

  return {
    store,
    prefix: STORE_DISPLAY_PREFIX,
    zabbixHostPrefix: storeRow.zabbixHostPrefix || null,
    queryAliases: storeRow.queryAliases || [],
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

/** Build netpulse_query question — includes LKST→RP aliases so Zabbix host resolves. */
export function buildStoreHistoryQuestion(storeIdentity) {
  const id = typeof storeIdentity === 'string' ? resolveStoreIdentity(storeIdentity) : storeIdentity
  const aliasNote =
    id.numericCode != null
      ? `Store ${id.displayCode} — Zabbix workstation host is usually ${id.zabbixPrimary}-* ` +
        `(match aliases: ${id.queryTerms.join(', ')}). `
      : `For store ${id.displayCode}. `
  return (
    aliasNote +
    'Return time-series history of the Store Zabbix connectivity metrics over this window — ' +
    'ping packet loss %, ping average RTT (ms), ping max RTT (ms), and jitter / std-dev of ping RTT. ' +
    'I need per-sample values with timestamps (not just the latest snapshot). ' +
    'Also return app crash event log with timestamps (Influx crashEvents), ' +
    'system.uptime Zabbix history points (for boot/reboot detection), ' +
    'BH-filtered disconnect events, and storeMonitor speedtest upload/download Mbps.'
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
export function extractLatestUploadMbps(root, storeIdentity) {
  const id = typeof storeIdentity === 'string' ? resolveStoreIdentity(storeIdentity) : storeIdentity
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
    ].filter(Boolean)
    if (id.numericCode != null) {
      return candidates.some((c) => hostMatchesStoreCode(c, id.numericCode))
    }
    const code = id.displayCode
    return candidates.some((c) => String(c).toUpperCase().includes(code))
  }

  function walk(node) {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node.uploadMbps != null && Number.isFinite(Number(node.uploadMbps))) {
      if (matchesStore(node)) {
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
    /** Primary metric: minutes passing ALL gates ÷ expected BH minutes. One bad sample fails the whole minute. */
    goodMinutesPct: roundPct(goodPctStrict),
    /** Diagnostic: good minutes ÷ only minutes with any ping sample (ignores missing as loss). */
    goodMinutesPctCovered: roundPct(goodPctCovered),
    goodPctStrict: roundPct(goodPctStrict),
    goodPctCovered: roundPct(goodPctCovered),
    compliant: compliantStrict,
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

/** CEO one-liner: "2,640 / 3,000 stores met the connectivity standard this month — target 99%." */
export function formatCeoOneLiner(storesCompliant, total, complianceTargetPct, periodLabel = 'this period') {
  const fmt = (n) => Number(n).toLocaleString('en-US')
  return `${fmt(storesCompliant)} / ${fmt(total)} stores met the connectivity standard ${periodLabel} — target ${complianceTargetPct}%.`
}

export const GOOD_MINUTES_DEFINITIONS = {
  perStore: {
    goodMinutesPct:
      'Share of business-hour monitoring minutes where the store passed ALL quality gates simultaneously. ' +
      'Formula: goodMinutesPct = goodMin ÷ expectedMin. Any single bad latency/jitter sample fails the entire minute ' +
      '(highlights minor fluctuations vs averaging).',
    gates:
      'Packet loss <1% (missing ping = loss), latency < threshold, jitter < threshold. Bandwidth is reported separately (snapshot only).',
  },
  fleet: {
    pctStoresCompliant:
      'CEO metric — share of stores whose Good-Minutes % is at or above the compliance target (default 99%). ' +
      'Formula: storesCompliant ÷ totalStores.',
    oneLineSummary: 'Reads as: "N / M stores met the connectivity standard this month — target 99%."',
  },
  roFleet: {
    description:
      'Same fleet metrics filtered to Remote-Optometry stores (~1,000 stores). Pass roStoreCodes to compute this view.',
  },
  operatingWindow: {
    adjustBhForStoreHours:
      'When enabled (default): expected minutes per store/day start at boot (system.uptime reboot or first crash in BH) and end at early shutdown (no pings for 30+ min before BH close). Example: BH 10–10, store up 11am → count from 11am only.',
  },
}

export function computeFleetSummary(perStore, complianceTargetPct, { periodLabel = 'this period', label = 'Fleet' } = {}) {
  const total = perStore.length
  const storesCompliant = perStore.filter((s) => s.compliant ?? s.compliantStrict).length
  const storesCompliantCovered = perStore.filter((s) => s.compliantCovered).length
  const pctStoresCompliant = total > 0 ? roundPct((storesCompliant / total) * 100) : 0
  const pctStoresCompliantCovered = total > 0 ? roundPct((storesCompliantCovered / total) * 100) : 0
  const oneLineSummary = formatCeoOneLiner(storesCompliant, total, complianceTargetPct, periodLabel)

  return {
    label,
    storesCompliant,
    storesCompliantStrict: storesCompliant,
    storesCompliantCovered,
    total,
    totalStores: total,
    pctStoresCompliant,
    pctStoresCompliantStrict: pctStoresCompliant,
    pctStoresCompliantCovered,
    complianceTargetPct,
    oneLineSummary,
  }
}

export function buildHumanSummary(result) {
  const lines = []

  lines.push('=== CEO — % Stores Compliant ===', result.fleet.oneLineSummary)
  if (result.fleet.pctStoresCompliant != null) {
    lines.push(`Fleet Good-Minutes compliance rate: ${result.fleet.pctStoresCompliant}% of stores at target.`)
  }
  if (result.roFleet) {
    lines.push('', '=== Remote-Optometry — % Stores Compliant ===', result.roFleet.oneLineSummary)
  }

  if (result.internetMatrix?.length) {
    lines.push('', '=== Internet Matrix ===', '', buildInternetMatrixSummary(result.internetMatrix))
  }

  lines.push(
    '',
    `Window: ${result.window.fromDate} – ${result.window.toDate} (${result.window.periodLabel})`,
    `Business hours: ${result.businessHours.label || formatBusinessHoursLabel(result.businessHours)}.`,
    '',
    'Per store — Good-Minutes % (minutes passing ALL gates ÷ expected BH minutes):',
  )
  for (const s of result.perStore) {
    const store = normalizeStoreCode(s.store)
    const pct = s.goodMinutesPct ?? s.goodPctStrict
    const status = (s.compliant ?? s.compliantStrict) ? 'COMPLIANT' : 'NON-COMPLIANT'
    lines.push(
      `  ${store}: ${pct}% Good-Minutes (${s.goodMin}/${s.expectedMin} minutes) — ${status}` +
        (s.expectedMinNominal != null && s.expectedMinNominal !== s.expectedMin
          ? ` · BH adjusted ${s.expectedMinNominal}→${s.expectedMin} min`
          : '') +
        (s.goodMinutesPctCovered != null && s.goodMinutesPctCovered !== pct
          ? ` · covered-only ${s.goodMinutesPctCovered}%`
          : '') +
        (s.dataQualityFlag !== 'ok' ? ` · data=${s.dataQualityFlag}` : '') +
        (s.latestUploadMbps != null ? ` · upload ${s.latestUploadMbps} Mbps` : ''),
    )
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
export async function fetchStorePingHistory(netpulse, storeInput, fromUnix, toUnix) {
  const storeIdentity = resolveStoreIdentity(storeInput)
  const question = buildStoreHistoryQuestion(storeIdentity)
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
    `netpulse-gmc-${sanitizeFilename(storeIdentity.displayCode)}-${Date.now()}.json`,
  )
  try {
    await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf8')
    const raw = await fs.readFile(tmpPath, 'utf8')
    const data = JSON.parse(raw)
    const samples = extractPingSamples(data)
    const latestUploadMbps = extractLatestUploadMbps(data, storeIdentity)
    const uptimePoints = extractUptimePoints(data)
    const crashTimes = extractCrashEventTimes(data, storeIdentity)
    return { samples, latestUploadMbps, uptimePoints, crashTimes, storeIdentity, fetchError: null }
  } catch (err) {
    return {
      samples: { latency: [], jitter: [] },
      latestUploadMbps: null,
      uptimePoints: [],
      crashTimes: [],
      storeIdentity,
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
    businessHours: businessHoursOverride,
    thresholds = DEFAULT_THRESHOLDS,
    roStoreCodes,
    periodLabel,
    adjustBhForStoreHours = true,
  } = args

  if (!Array.isArray(storeCodes) || storeCodes.length === 0) {
    throw new Error('storeCodes must be a non-empty string array')
  }

  const mergedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
  const mergedBh = resolveBusinessHours(businessHoursOverride)
  const window = resolveComplianceWindow({ ...args, businessHours: mergedBh, periodLabel })
  const { fromUnix, toUnix } = window
  const resolvedPeriodLabel = window.periodLabel

  const bhMinutesNominal = enumerateBhMinutes(fromUnix, toUnix, mergedBh)

  const perStore = []
  const internetMatrix = []
  for (const storeInput of storeCodes) {
    const storeIdentity = resolveStoreIdentity(storeInput)
    const { samples, latestUploadMbps, uptimePoints, crashTimes, fetchError } =
      await fetchStorePingHistory(netpulse, storeInput, fromUnix, toUnix)

    const operatingWindow = buildEffectiveBhMinutes({
      businessHours: mergedBh,
      nominalBhMinutes: bhMinutesNominal,
      latencySamples: samples.latency,
      uptimePoints,
      crashTimes,
      enabled: adjustBhForStoreHours,
    })
    const bhMinutes = operatingWindow.minutes

    const sampleStats = aggregateBhSampleStats(samples.latency, samples.jitter, bhMinutes)
    const row = scoreStoreCompliance({
      store: storeIdentity.displayCode,
      bhMinutes,
      latencySamples: samples.latency,
      jitterSamples: samples.jitter,
      thresholds: mergedThresholds,
      latestUploadMbps,
    })
    if (fetchError) row.warnings = [...(row.warnings || []), `Fetch/parse error: ${fetchError}`]
    row.store = storeIdentity.displayCode
    row.numericCode = storeIdentity.numericCode
    row.zabbixHostPrefix = storeIdentity.zabbixPrimary
    row.queryAliases = storeIdentity.queryTerms
    row.expectedMinNominal = operatingWindow.nominalExpectedMin
    row.operatingWindow = operatingWindow
    row.internetMatrix = buildInternetMatrix(row, sampleStats, mergedThresholds)
    perStore.push(row)
    internetMatrix.push(row.internetMatrix)
  }

  const fleet = computeFleetSummary(perStore, mergedThresholds.complianceTargetPct, {
    periodLabel: resolvedPeriodLabel,
    label: 'Fleet',
  })

  let roFleet = null
  if (Array.isArray(roStoreCodes) && roStoreCodes.length > 0) {
    const roSet = new Set(normalizeStoreCodes(roStoreCodes))
    const roRows = perStore.filter((s) => roSet.has(normalizeStoreCode(s.store)))
    roFleet = computeFleetSummary(roRows, mergedThresholds.complianceTargetPct, {
      periodLabel: resolvedPeriodLabel,
      label: 'Remote-Optometry',
    })
  }

  const result = {
    definitions: GOOD_MINUTES_DEFINITIONS,
    windowInputHelp: formatWindowInputHelp(),
    window,
    businessHours: mergedBh,
    thresholds: mergedThresholds,
    storeCodePrefix: STORE_DISPLAY_PREFIX,
    storeAliasNote: 'LKST<code> queries resolve to Zabbix RP<code>-* hosts (e.g. LKST336 → RP336).',
    internetMatrix,
    perStore,
    fleet,
    roFleet,
    limitations: [
      'Disconnect events track store-PC agent heartbeat, not WAN outages — excluded from gates.',
      'Missing ping in a BH minute counts as packet loss on the strict basis (60s cadence).',
      'Bandwidth gate uses latest speedtest upload snapshot only; excluded from per-minute scoring.',
      'When adjustBhForStoreHours is true (default): expected minutes start at store boot (system.uptime / crash log) and end at early shutdown (no pings before BH close).',
    ],
  }

  return {
    structured: result,
    summary: buildHumanSummary(result),
  }
}
