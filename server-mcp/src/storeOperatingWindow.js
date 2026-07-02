/**
 * Adjust expected BH minutes per store/day using boot (uptime/crash) and shutdown (ping end).
 */
import { hostMatchesStoreCode } from './storeCodeAlias.js'

const REBOOT_DROP_SEC = 300
/** Minutes without ping after last sample → treat as end-of-day shutdown. */
export const SHUTDOWN_GAP_MINUTES = 30

export function floorToMinute(clock) {
  return Math.floor(clock / 60) * 60
}

/** Detect Zabbix system.uptime reboots (counter drop). */
export function detectBootEvents(points) {
  const sorted = [...(points || [])].sort((a, b) => a.clock - b.clock)
  const events = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const dropped = cur.value < prev.value
    const sigDrop = prev.value - cur.value > REBOOT_DROP_SEC
    if (!dropped && !sigDrop) continue
    const bootEst = Math.max(prev.clock + 1, Math.floor(cur.clock - cur.value))
    events.push({ at: bootEst, source: 'uptime' })
  }
  return events
}

function parseEventUnix(ts) {
  if (ts == null) return null
  if (typeof ts === 'number' && Number.isFinite(ts)) return Math.floor(ts)
  const ms = Date.parse(String(ts))
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** Walk JSON for system.uptime history points. */
export function extractUptimePoints(root) {
  const points = []
  function ingest(list) {
    if (!Array.isArray(list)) return
    for (const p of list) {
      const clock = Number(p?.clock)
      const value = Number(p?.seconds ?? p?.value ?? p?.percent)
      if (Number.isFinite(clock) && Number.isFinite(value)) {
        points.push({ clock, value })
      }
    }
  }
  function walk(node) {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const key = String(node.key || node.itemKey || '')
    if (/system\.uptime|sysuptime|hrsystemuptime/i.test(key) && node.points) {
      ingest(node.points)
    }
    if (node.uptime?.points) ingest(node.uptime.points)
    for (const v of Object.values(node)) walk(v)
  }
  walk(root)
  const byClock = new Map()
  for (const p of points) byClock.set(p.clock, p.value)
  return [...byClock.entries()].map(([clock, value]) => ({ clock, value }))
}

/** Walk JSON for Influx crashEvents with timestamps. */
export function extractCrashEventTimes(root, storeIdentity = null) {
  const times = []
  function maybeAdd(obj) {
    if (!obj || typeof obj !== 'object') return
    const ts = parseEventUnix(obj.ts ?? obj.timestamp ?? obj.clock)
    if (ts == null) return
    if (storeIdentity?.numericCode != null) {
      const host = obj.hostname || obj.storeTag || obj.store || ''
      if (host && !hostMatchesStoreCode(host, storeIdentity.numericCode)) return
    }
    times.push(ts)
  }
  function walk(node) {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      if (node.length && node[0]?.ts != null && (node[0].hostname || node[0].crashType)) {
        for (const ev of node) maybeAdd(ev)
        return
      }
      for (const item of node) walk(item)
      return
    }
    if (Array.isArray(node.crashEvents)) {
      for (const ev of node.crashEvents) maybeAdd(ev)
    }
    for (const v of Object.values(node)) walk(v)
  }
  walk(root)
  return [...new Set(times)].sort((a, b) => a - b)
}

function localDayKey(unixSec, tzOffsetMinutes) {
  const localMs = unixSec * 1000 + tzOffsetMinutes * 60 * 1000
  const d = new Date(localMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function bhMinutesForDay(dayKey, nominalBhMinutes, tzOffsetMinutes) {
  return nominalBhMinutes.filter((m) => localDayKey(m, tzOffsetMinutes) === dayKey)
}

function effectiveStartForDay(bhMinutes, bootEvents, crashTimes) {
  if (!bhMinutes.length) return null
  const bhStart = bhMinutes[0]
  const bhEnd = bhMinutes[bhMinutes.length - 1] + 60

  const bootsDuring = bootEvents.filter((b) => b.at >= bhStart && b.at < bhEnd)
  if (bootsDuring.length) {
    return floorToMinute(Math.min(...bootsDuring.map((b) => b.at)))
  }

  const bootBefore = bootEvents.filter((b) => b.at < bhStart).sort((a, b) => b.at - a.at)[0]
  if (bootBefore) return bhStart

  const crashesInBh = crashTimes.filter((t) => t >= bhStart && t < bhEnd)
  if (crashesInBh.length) return floorToMinute(Math.min(...crashesInBh))

  return bhStart
}

function effectiveEndForDay(bhMinutes, effectiveStart, pingMinuteSet) {
  if (!bhMinutes.length) return null
  const bhEnd = bhMinutes[bhMinutes.length - 1] + 60
  const inRange = bhMinutes.filter((m) => m >= effectiveStart && pingMinuteSet.has(m))
  if (!inRange.length) return Math.min(bhEnd, effectiveStart + 60)

  const lastPing = inRange[inRange.length - 1]
  const trailing = bhMinutes.filter((m) => m > lastPing).length
  if (trailing >= SHUTDOWN_GAP_MINUTES) return lastPing + 60
  return bhEnd
}

/**
 * Build store-specific expected BH minutes adjusted for boot/shutdown.
 */
export function buildEffectiveBhMinutes({
  businessHours,
  nominalBhMinutes = [],
  latencySamples = [],
  uptimePoints = [],
  crashTimes = [],
  enabled = true,
}) {
  const nominalMinutes = [...nominalBhMinutes]
  if (!enabled) {
    return {
      minutes: nominalMinutes,
      nominalExpectedMin: nominalMinutes.length,
      adjustedExpectedMin: nominalMinutes.length,
      perDay: [],
      bootAdjusted: false,
    }
  }

  const bootEvents = detectBootEvents(uptimePoints)
  const pingMinuteSet = new Set(
    latencySamples.map((s) => floorToMinute(s.clock)),
  )

  const dayKeys = [...new Set(nominalMinutes.map((m) => localDayKey(m, businessHours.tzOffsetMinutes)))]
  const perDay = []
  const effectiveMinutes = []

  for (const dayKey of dayKeys.sort()) {
    const dayBh = bhMinutesForDay(dayKey, nominalMinutes, businessHours.tzOffsetMinutes)
    if (!dayBh.length) continue

    const nominalDayMin = dayBh.length
    const effectiveStart = effectiveStartForDay(dayBh, bootEvents, crashTimes)
    const effectiveEnd = effectiveEndForDay(dayBh, effectiveStart, pingMinuteSet)
    const dayEffective = dayBh.filter((m) => m >= effectiveStart && m < effectiveEnd)

    const bootDuring = bootEvents.find((b) => b.at >= dayBh[0] && b.at < dayBh[dayBh.length - 1] + 60)
    const startSource = bootDuring
      ? 'uptime_boot'
      : crashTimes.some((t) => t >= dayBh[0] && t < effectiveStart + 3600)
        ? 'crash_log'
        : effectiveStart > dayBh[0]
          ? 'ping_first_sample'
          : 'bh_open'

    perDay.push({
      date: dayKey,
      nominalExpectedMin: nominalDayMin,
      adjustedExpectedMin: dayEffective.length,
      effectiveStartUnix: effectiveStart,
      effectiveEndUnix: effectiveEnd,
      startSource,
      endSource: dayEffective.length < nominalDayMin && effectiveEnd < dayBh[dayBh.length - 1] + 60
        ? 'early_shutdown'
        : 'bh_close',
      trimmedStartMin: Math.max(0, Math.round((effectiveStart - dayBh[0]) / 60)),
      trimmedEndMin: Math.max(0, Math.round((dayBh[dayBh.length - 1] + 60 - effectiveEnd) / 60)),
    })

    effectiveMinutes.push(...dayEffective)
  }

  effectiveMinutes.sort((a, b) => a - b)

  return {
    minutes: effectiveMinutes,
    nominalExpectedMin: nominalMinutes.length,
    adjustedExpectedMin: effectiveMinutes.length,
    perDay,
    bootAdjusted: effectiveMinutes.length !== nominalMinutes.length,
    bootEvents: bootEvents.map((b) => ({ at: b.at, source: b.source })),
    crashEventCount: crashTimes.length,
  }
}
