/**
 * Per-store business-hours uptime report for the ROP Dashboard.
 *
 * Source of truth: StoreProblemHistory (MongoDB) — the same `code: 'offline'`
 * records that drive Slack alerts, written every 2 min by storeProblemSnapshotter.
 * That collection has firstSeenAt / resolvedAt / durationMs and is naturally
 * deduped by the state machine (see also storeOfflineHistoryReport.js).
 *
 * Public function:
 *   fetchRopUptimeReport({ groupKey, fromMs, toMs, businessHours, slaTarget, topN })
 *
 * Returns a payload tailored for a Datadog/StatusPage-style dashboard:
 *   - summary: total stores, avg BH uptime %, stores above/below SLA, total
 *     downtime + disconnects, MTTR.
 *   - trend[]: per-day rollup (avg uptime %, downtime, impacted stores).
 *   - heatmap[]: per-store-per-day uptime % cells for the day×store grid.
 *   - topOffenders[]: worst-uptime stores ranked by BH downtime.
 *   - perStore[]: full sortable table data (uptime %, downtime, longest
 *     outage, last offline, current status, last-7-day sparkline).
 */
import StoreProblemHistory from '../models/StoreProblemHistory.js'
import {
  getAnyCachedStoreSnapshot,
  fetchStoreSnapshot,
} from './influxStore.js'
import { getManualRopCodeList } from '../utils/manualRopStoreCodes.js'
import {
  classifyRpSegment,
  partitionRpStores,
  buildRpOutageSummary,
  buildRpSegmentBhSummary,
  resolveGroupTags,
  buildRopGroupBuckets,
  isRpGroupKey,
} from '../utils/storeRopGrouping.js'

const OFFLINE_CODE = 'offline'
const REPORT_CACHE_MS = 60_000
const _reportCache = new Map()

/* Drop sub-5-minute blips so a single missed snapshot doesn't show as an outage. */
const MIN_OFFLINE_MIN = (() => {
  const n = parseInt(process.env.STORE_OFFLINE_MIN_DURATION_MIN || '5', 10)
  return Number.isFinite(n) && n >= 0 ? n : 5
})()
const MIN_OFFLINE_MS = MIN_OFFLINE_MIN * 60_000

function isBlip(rec, nowMs) {
  const startMs = new Date(rec.firstSeenAt).getTime()
  const endMs = rec.resolvedAt ? new Date(rec.resolvedAt).getTime() : nowMs
  return (endMs - startMs) < MIN_OFFLINE_MS
}

/* ─── group resolution ─────────────────────────────────────────────── */

function snapshotIndex(snapshot) {
  const byTag = new Map()
  for (const s of snapshot || []) {
    if (s?.storeTag) byTag.set(s.storeTag, s)
  }
  return byTag
}

async function ensureSnapshot() {
  let snap = getAnyCachedStoreSnapshot(15 * 60 * 1000)
  if (!snap) {
    try { snap = await fetchStoreSnapshot(15, '-24h') } catch { snap = null }
  }
  return Array.isArray(snap) ? snap : []
}

async function fetchOfflineRecords(allTags, fromMs, toMs) {
  if (!allTags.length) return []
  return StoreProblemHistory.find({
    code: OFFLINE_CODE,
    storeTag: { $in: allTags },
    firstSeenAt: { $lt: new Date(toMs) },
    $or: [{ resolvedAt: null }, { resolvedAt: { $gt: new Date(fromMs) } }],
  }).lean()
}

/** Active outages only — indexed query, cheap for dashboard refresh. */
async function fetchActiveOfflineRecords(storeTags) {
  if (!storeTags?.length) return []
  return StoreProblemHistory.find({
    code: OFFLINE_CODE,
    status: 'active',
    storeTag: { $in: storeTags },
  }).select('storeTag hostname serial firstSeenAt lastSeenAt').lean()
}

/* ─── BH minute math ───────────────────────────────────────────────── */

function makeBhChecker(bh) {
  if (!bh || !bh.weekdays?.length) return null
  const weekdays = new Set(bh.weekdays.map(Number))
  const startH = bh.startHour
  const endH = bh.endHour
  const tzOff = (bh.tzOffsetMinutes || 0) * 60_000
  return (tsMs) => {
    const local = new Date(tsMs + tzOff)
    const day = local.getUTCDay()
    if (!weekdays.has(day)) return false
    const hour = local.getUTCHours()
    if (startH <= endH) return hour >= startH && hour < endH
    return hour >= startH || hour < endH
  }
}

/** BH minutes inside a half-open interval [aMs, bMs). */
function bhMinutesInInterval(aMs, bMs, isBh) {
  if (bMs <= aMs) return 0
  if (!isBh) return Math.floor((bMs - aMs) / 60_000)
  let total = 0
  let cursor = aMs
  while (cursor < bMs) {
    const hourStart = Math.floor(cursor / 3_600_000) * 3_600_000
    const hourEnd = hourStart + 3_600_000
    const segEnd = Math.min(bMs, hourEnd)
    if (isBh(cursor)) total += Math.floor((segEnd - cursor) / 60_000)
    cursor = segEnd
  }
  return total
}

/** BH minutes in a single calendar day [dayMs, dayMs+86400000), capped by `nowMs`. */
function bhMinutesForDay(dayMs, isBh, nowMs) {
  const dayEnd = Math.min(dayMs + 86_400_000, nowMs)
  if (dayEnd <= dayMs) return 0
  return bhMinutesInInterval(dayMs, dayEnd, isBh)
}

/** YYYY-MM-DD for a UTC epoch in the given timezone offset (minutes east of UTC). */
function dayLabelInTz(tsMs, tzMinutes) {
  return new Date(tsMs + tzMinutes * 60_000).toISOString().slice(0, 10)
}

/** UTC ms of local midnight for YYYY-MM-DD in tz. */
function localMidnightMs(label, tzMinutes) {
  const [y, m, d] = label.split('-').map(Number)
  return Date.UTC(y, m - 1, d) - tzMinutes * 60_000
}

function nextDayLabel(label) {
  const [y, m, d] = label.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/* ─── day list builder (timezone-aligned local midnights) ─────────── */

function buildDayList(fromMs, toMs, tzMinutes = 0) {
  const days = []
  let label = dayLabelInTz(fromMs, tzMinutes)
  const endLabel = dayLabelInTz(toMs, tzMinutes)
  while (label <= endLabel) {
    const dayMs = localMidnightMs(label, tzMinutes)
    days.push({ dayMs, label })
    label = nextDayLabel(label)
  }
  return days
}

/* ─── normalise inputs ─────────────────────────────────────────────── */

function normaliseBh(bh) {
  const def = { startHour: 9, endHour: 18, weekdays: [0, 1, 2, 3, 4, 5, 6], tzOffsetMinutes: 0 }
  if (!bh || typeof bh !== 'object') return def
  const startHour = clampHour(bh.startHour ?? def.startHour)
  const endHour = clampHour(bh.endHour ?? def.endHour)
  let weekdays = Array.isArray(bh.weekdays)
    ? [...new Set(bh.weekdays.map((d) => Number(d)).filter((d) => Number.isFinite(d) && d >= 0 && d <= 6))]
    : def.weekdays.slice()
  if (!weekdays.length) weekdays = def.weekdays.slice()
  const tzOffsetMinutes = Number.isFinite(Number(bh.tzOffsetMinutes)) ? Number(bh.tzOffsetMinutes) : def.tzOffsetMinutes
  return { startHour, endHour, weekdays: weekdays.sort((a, b) => a - b), tzOffsetMinutes }
}
function clampHour(h) { const n = Number(h); return Number.isFinite(n) ? Math.max(0, Math.min(24, Math.round(n))) : 0 }

/* ─── public entry point ───────────────────────────────────────────── */

export async function fetchRopUptimeReport(opts = {}) {
  const nowMs = Date.now()
  const groupKey = String(opts.groupKey || 'rp').toLowerCase()
  const slaTarget = Number.isFinite(Number(opts.slaTarget)) ? Math.max(0, Math.min(100, Number(opts.slaTarget))) : 99.5
  const topN = Number.isFinite(Number(opts.topN)) ? Math.max(1, Math.min(50, Number(opts.topN))) : 10

  const fromMs = Number.isFinite(Number(opts.fromMs)) ? Number(opts.fromMs) : nowMs - 7 * 86_400_000
  const toMs = Number.isFinite(Number(opts.toMs)) ? Number(opts.toMs) : nowMs
  if (toMs <= fromMs) throw new Error('rop-uptime: toMs must be > fromMs')
  const cappedTo = Math.min(toMs, nowMs)

  const bh = normaliseBh(opts.businessHours)
  const isBh = makeBhChecker(bh)

  const cacheKey = JSON.stringify({ groupKey, fromMs, toMs, bh, slaTarget, topN })
  const cached = _reportCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < REPORT_CACHE_MS) return cached.data

  const snapshot = await ensureSnapshot()
  const tagIdx = snapshotIndex(snapshot)
  const manualCodes = await getManualRopCodeList()
  const rpPartition = partitionRpStores(snapshot, manualCodes)
  const rpGroupBuckets = buildRopGroupBuckets(snapshot, manualCodes)
  const allRpTags = [...rpPartition.sdwanTags, ...rpPartition.nonSdwanTags]

  const tagsInGroup = resolveGroupTags(snapshot, groupKey, manualCodes)
  const tagsSet = new Set(tagsInGroup)
  const totalStores = tagsInGroup.length
  const historyTags = [...new Set([...tagsInGroup, ...allRpTags])]

  const days = buildDayList(fromMs, cappedTo, bh.tzOffsetMinutes)
  const dayMsList = days.map((d) => d.dayMs)
  const bhMinPerDay = new Map()
  for (const d of dayMsList) bhMinPerDay.set(d, bhMinutesForDay(d, isBh, cappedTo))
  const bhMinutesPerStore = [...bhMinPerDay.values()].reduce((s, n) => s + n, 0)

  /* ── history window + active outages (parallel) ── */
  const [allRecordsRaw, activeOfflineRows] = await Promise.all([
    fetchOfflineRecords(historyTags, fromMs, cappedTo),
    fetchActiveOfflineRecords(allRpTags),
  ])
  const records = allRecordsRaw.filter((r) => !isBlip(r, nowMs))
  const blipsFiltered = allRecordsRaw.length - records.length

  /* ── per-store rollup (all RP tags for segment summary; filter list by group) ── */
  const rollupTags = [...new Set([...allRpTags, ...tagsInGroup])]
  const perStore = new Map()
  for (const tag of rollupTags) {
    perStore.set(tag, {
      storeTag: tag,
      hostname: tagIdx.get(tag)?.hostname || '',
      serial:   tagIdx.get(tag)?.serial || '',
      bizDownMin: 0,
      disconnects: 0,
      longestOutageMin: 0,
      lastOfflineMs: null,
      currentlyOffline: false,
      perDayDownMin: new Map(dayMsList.map((d) => [d, 0])),
      perDayDisc: new Map(dayMsList.map((d) => [d, 0])),
      sessions: [], // for flap-coalescing into "events"
    })
  }
  for (const tag of rollupTags) {
    const s = tagIdx.get(tag)
    if (s?.online === false || s?.lastOnline === false) {
      const ps = perStore.get(tag)
      if (ps) ps.currentlyOffline = true
    }
  }

  const rollupTagSet = new Set(rollupTags)
  for (const rec of records) {
    if (!rollupTagSet.has(rec.storeTag)) continue
    const ps = perStore.get(rec.storeTag)
    if (!ps) continue
    const startMs = new Date(rec.firstSeenAt).getTime()
    const endMs = rec.resolvedAt ? new Date(rec.resolvedAt).getTime() : cappedTo
    const segStart = Math.max(startMs, fromMs)
    const segEnd = Math.min(endMs, cappedTo)
    if (segEnd <= segStart) continue

    /* per-day BH downtime */
    for (const dayMs of dayMsList) {
      const dStart = Math.max(segStart, dayMs)
      const dEnd = Math.min(segEnd, dayMs + 86_400_000)
      if (dEnd <= dStart) continue
      const mins = bhMinutesInInterval(dStart, dEnd, isBh)
      if (mins <= 0) continue
      ps.perDayDownMin.set(dayMs, ps.perDayDownMin.get(dayMs) + mins)
      ps.bizDownMin += mins
    }

    if (rec.resolvedAt == null) {
      ps.currentlyOffline = true
      ps.lastOfflineMs = startMs
    } else if (ps.lastOfflineMs == null || startMs > ps.lastOfflineMs) {
      ps.lastOfflineMs = startMs
    }

    ps.sessions.push({ startMs, endMs, resolved: rec.resolvedAt != null })
  }

  /* coalesce flap sequences (≤30 min gap) into "events" for disconnect counts */
  const FLAP_GAP_MS = 30 * 60_000
  let totalMttrSamples = 0
  let totalMttrSum = 0
  for (const ps of perStore.values()) {
    ps.sessions.sort((a, b) => a.startMs - b.startMs)
    let cur = null
    let coalesced = []
    for (const sess of ps.sessions) {
      if (!cur) { cur = { ...sess, parts: 1 }; continue }
      if (cur.endMs == null) cur.endMs = sess.endMs
      const gap = sess.startMs - cur.endMs
      if (gap <= FLAP_GAP_MS) {
        cur.parts += 1
        cur.endMs = sess.endMs
        if (!sess.resolved) cur.resolved = false
      } else {
        coalesced.push(cur); cur = { ...sess, parts: 1 }
      }
    }
    if (cur) coalesced.push(cur)
    ps.disconnects = coalesced.length
    /* per-day disconnect counts based on coalesced session starts */
    for (const ev of coalesced) {
      if (ev.startMs < fromMs || ev.startMs >= cappedTo) continue
      const key = localMidnightMs(dayLabelInTz(ev.startMs, bh.tzOffsetMinutes), bh.tzOffsetMinutes)
      if (ps.perDayDisc.has(key)) ps.perDayDisc.set(key, ps.perDayDisc.get(key) + 1)
    }
    /* longest outage */
    let longest = 0
    for (const ev of coalesced) {
      const dur = ((ev.endMs ?? cappedTo) - ev.startMs)
      if (dur > longest) longest = dur
      if (ev.resolved) {
        totalMttrSum += dur
        totalMttrSamples += 1
      }
    }
    ps.longestOutageMin = Math.round(longest / 60_000)
    ps.sessions = undefined
  }

  /* ── per-store summaries ── */
  const allStoreMetrics = [...perStore.values()].map((ps) => ({
    storeTag: ps.storeTag,
    bizDownMin: ps.bizDownMin,
    disconnects: ps.disconnects,
  }))
  const segmentBhSummary = buildRpSegmentBhSummary({
    perStoreMetrics: allStoreMetrics,
    snapshot,
    manualCodes,
  })

  const perStoreList = [...perStore.values()]
    .filter((ps) => tagsSet.has(ps.storeTag))
    .map((ps) => {
    const storeSnap = tagIdx.get(ps.storeTag)
    const upMin = Math.max(0, bhMinutesPerStore - ps.bizDownMin)
    const uptimePct = bhMinutesPerStore > 0
      ? Math.round((upMin / bhMinutesPerStore) * 10000) / 100
      : null
    const dailyUptimePcts = dayMsList.map((d) => {
      const total = bhMinPerDay.get(d) || 0
      const down = ps.perDayDownMin.get(d) || 0
      const up = Math.max(0, total - down)
      return total > 0 ? Math.round((up / total) * 10000) / 100 : null
    })
    return {
      storeTag: ps.storeTag,
      hostname: ps.hostname,
      serial: ps.serial,
      rpSegment: storeSnap ? classifyRpSegment(storeSnap, manualCodes) : null,
      uptimePct,
      bizDownMin: ps.bizDownMin,
      bizUpMin: upMin,
      disconnects: ps.disconnects,
      longestOutageMin: ps.longestOutageMin,
      lastOfflineMs: ps.lastOfflineMs,
      currentlyOffline: ps.currentlyOffline,
      dailyUptimePcts,
      perDayDownMin: dayMsList.map((d) => ps.perDayDownMin.get(d) || 0),
      perDayDisconnects: dayMsList.map((d) => ps.perDayDisc.get(d) || 0),
    }
  })

  const activeOfflineTags = new Set(activeOfflineRows.map((r) => r.storeTag))
  const activeOfflineByTag = new Map(activeOfflineRows.map((r) => [r.storeTag, r]))
  const outageSummary = buildRpOutageSummary({
    snapshot,
    activeOfflineTags,
    activeOfflineByTag,
    manualCodes,
  })

  /* ── summary KPIs ── */
  const reportingStores = perStoreList.filter((s) => s.uptimePct != null)
  const avgUptimePct = reportingStores.length
    ? Math.round(
        reportingStores.reduce((sum, s) => sum + s.uptimePct, 0) / reportingStores.length * 100,
      ) / 100
    : null
  const totalDowntimeMin = perStoreList.reduce((s, x) => s + x.bizDownMin, 0)
  const avgDowntimeMin = totalStores > 0
    ? Math.round((totalDowntimeMin / totalStores) * 100) / 100
    : null
  const totalDisconnects = perStoreList.reduce((s, x) => s + x.disconnects, 0)
  const storesAboveSla = reportingStores.filter((s) => s.uptimePct >= slaTarget).length
  const storesBelowSla = reportingStores.filter((s) => s.uptimePct < slaTarget).length
  const storesCurrentlyOffline = perStoreList.filter((s) => s.currentlyOffline).length
  const mttrMin = totalMttrSamples > 0 ? Math.round((totalMttrSum / totalMttrSamples) / 60_000) : null

  /* ── per-day trend (group avg) ── */
  const trend = dayMsList.map((d, idx) => {
    const totalBhMin = bhMinPerDay.get(d) || 0
    let downSum = 0
    let discSum = 0
    let impacted = 0
    let storesReporting = 0
    let upSum = 0
    for (const s of perStoreList) {
      const down = s.perDayDownMin[idx] || 0
      const disc = s.perDayDisconnects[idx] || 0
      if (totalBhMin > 0) {
        storesReporting += 1
        upSum += Math.max(0, totalBhMin - down)
      }
      downSum += down
      discSum += disc
      if (down > 0) impacted += 1
    }
    const avgDayUptimePct = (storesReporting > 0 && totalBhMin > 0)
      ? Math.round((upSum / (storesReporting * totalBhMin)) * 10000) / 100
      : null
    return {
      dayMs: d,
      label: days[idx].label,
      avgUptimePct: avgDayUptimePct,
      totalDowntimeMin: downSum,
      totalDisconnects: discSum,
      storesImpacted: impacted,
      bhMinutes: totalBhMin,
    }
  })

  /* ── heatmap (per-store-per-day) — sorted by uptime asc so worst rows surface first ── */
  const heatmap = [...perStoreList]
    .filter((s) => s.uptimePct != null)
    .sort((a, b) => (a.uptimePct ?? 100) - (b.uptimePct ?? 100))
    .slice(0, 60)
    .map((s) => ({
      storeTag: s.storeTag,
      hostname: s.hostname,
      uptimePct: s.uptimePct,
      days: dayMsList.map((d, idx) => ({
        dayMs: d,
        uptimePct: s.dailyUptimePcts[idx],
        downtimeMin: s.perDayDownMin[idx],
      })),
    }))

  /* ── top offenders ── */
  const topOffenders = [...perStoreList]
    .filter((s) => s.uptimePct != null)
    .sort((a, b) => {
      if (a.uptimePct !== b.uptimePct) return a.uptimePct - b.uptimePct
      return b.bizDownMin - a.bizDownMin
    })
    .slice(0, topN)

  const data = {
    rangeFromMs: fromMs,
    rangeToMs: cappedTo,
    rangeFromIso: new Date(fromMs).toISOString(),
    rangeToIso: new Date(cappedTo).toISOString(),
    groupKey,
    businessHours: bh,
    slaTarget,
    days,
    bhMinutesPerStore,
    summary: {
      totalStores,
      reportingStores: reportingStores.length,
      avgUptimePct,
      slaTarget,
      storesAboveSla,
      storesBelowSla,
      storesCurrentlyOffline,
      totalDowntimeMin,
      avgDowntimeMin,
      totalDisconnects,
      mttrMin,
      bhMinutesPerStore,
    },
    trend,
    heatmap,
    topOffenders,
    perStore: perStoreList,
    outageSummary,
    segmentBhSummary,
    meta: {
      recordsConsidered: records.length,
      blipsFiltered,
      minDurationMin: MIN_OFFLINE_MIN,
      flapGapMin: FLAP_GAP_MS / 60_000,
      activeOutagesQueried: activeOfflineRows.length,
      rpSdwanStores: rpPartition.sdwan.length,
      rpNonSdwanStores: rpPartition.nonSdwan.length,
      manualRopCodes: manualCodes.length,
      groupCounts: rpGroupBuckets.counts,
      isRpGroup: isRpGroupKey(groupKey),
      source: `StoreProblemHistory (code='offline', MongoDB)`,
    },
  }

  _reportCache.set(cacheKey, { data, ts: Date.now() })
  if (_reportCache.size > 24) {
    const oldest = [..._reportCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) _reportCache.delete(oldest[0])
  }
  return data
}

/** Per-store offline / disconnect timeline for ROP dashboard modal. */
export async function fetchRopStoreDisconnectEvents({ storeTag, fromMs, toMs, businessHours } = {}) {
  const tag = String(storeTag || '').trim()
  if (!tag) throw new Error('storeTag required')
  const from = new Date(Number(fromMs))
  const to = new Date(Number(toMs))
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
    throw new Error('invalid fromMs/toMs')
  }

  const bh = normaliseBh(businessHours)
  const isBh = makeBhChecker(bh)
  const bhActive = !!isBh && !(bh.startHour === 0 && bh.endHour === 24 && bh.weekdays.length === 7)

  const records = await StoreProblemHistory.find({
    storeTag: tag,
    code: OFFLINE_CODE,
    firstSeenAt: { $lt: to },
    $or: [{ resolvedAt: null }, { resolvedAt: { $gt: from } }],
  })
    .sort({ firstSeenAt: -1 })
    .limit(500)
    .lean()

  const nowMs = Date.now()
  const fromMsN = Number(fromMs)
  const toMsN = Number(toMs)

  const events = []
  for (const r of records) {
    const disconnectAtMs = new Date(r.firstSeenAt).getTime()
    const backUpAtMs = r.resolvedAt ? new Date(r.resolvedAt).getTime() : null
    const endMs = backUpAtMs != null
      ? backUpAtMs
      : (r.status === 'active' ? nowMs : disconnectAtMs)
    const durationMs = endMs - disconnectAtMs

    const segStart = Math.max(disconnectAtMs, fromMsN)
    const segEnd = Math.min(endMs, toMsN)
    const bhDurationMin = (segEnd > segStart && isBh)
      ? bhMinutesInInterval(segStart, segEnd, isBh)
      : 0

    if (bhActive && bhDurationMin <= 0) continue

    events.push({
      storeTag: r.storeTag,
      hostname: r.hostname || '',
      disconnectAt: r.firstSeenAt,
      disconnectAtMs,
      backUpAt: r.resolvedAt,
      backUpAtMs,
      durationMin: durationMs != null ? Math.round(durationMs / 60_000) : null,
      bhDurationMin,
      status: r.status,
      stillOffline: r.status === 'active',
    })
  }

  return {
    storeTag: tag,
    hostname: events[0]?.hostname || '',
    rangeFromIso: from.toISOString(),
    rangeToIso: to.toISOString(),
    businessHours: bh,
    bhApplied: bhActive,
    events,
    total: events.length,
    source: `StoreProblemHistory (code='${OFFLINE_CODE}', MongoDB)${bhActive ? ' · BH-filtered' : ''}`,
  }
}
