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
  vendorIsFortinet,
} from './influxStore.js'

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

function buildGroupTags(snapshot, groupKey) {
  const rp = []
  const pos = []
  const sdwan = []
  for (const s of snapshot || []) {
    if (!s?.storeTag) continue
    const h = String(s.hostname || '').toUpperCase()
    if (h.startsWith('RP')) rp.push(s.storeTag)
    else if (h.startsWith('LK')) pos.push(s.storeTag)
    if (
      vendorIsFortinet(s.gatewayVendor, s.isFortinet)
      || vendorIsFortinet(s.lastGatewayVendor, s.lastIsFortinet)
    ) sdwan.push(s.storeTag)
  }
  const buckets = {
    rp:    [...new Set(rp)],
    pos:   [...new Set(pos)],
    sdwan: [...new Set(sdwan)],
    all:   [...new Set([...rp, ...pos, ...sdwan])],
  }
  return buckets[groupKey] || buckets.rp
}

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

/* ─── day list builder (local-midnight aligned) ───────────────────── */

function buildDayList(fromMs, toMs) {
  const days = []
  const start = new Date(fromMs); start.setHours(0, 0, 0, 0)
  const end = new Date(toMs); end.setHours(0, 0, 0, 0)
  for (let d = start.getTime(); d <= end.getTime(); d += 86_400_000) {
    days.push({ dayMs: d, label: new Date(d).toISOString().slice(0, 10) })
  }
  return days
}

/* ─── normalise inputs ─────────────────────────────────────────────── */

function normaliseBh(bh) {
  const def = { startHour: 9, endHour: 22, weekdays: [0, 1, 2, 3, 4, 5, 6], tzOffsetMinutes: 0 }
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
  const tagsInGroup = buildGroupTags(snapshot, groupKey)
  const tagsSet = new Set(tagsInGroup)
  const totalStores = tagsInGroup.length

  const days = buildDayList(fromMs, cappedTo)
  const dayMsList = days.map((d) => d.dayMs)
  const bhMinPerDay = new Map()
  for (const d of dayMsList) bhMinPerDay.set(d, bhMinutesForDay(d, isBh, cappedTo))
  const bhMinutesPerStore = [...bhMinPerDay.values()].reduce((s, n) => s + n, 0)

  /* ── pull offline records for every store in group ── */
  const allRecordsRaw = await fetchOfflineRecords(tagsInGroup, fromMs, cappedTo)
  const records = allRecordsRaw.filter((r) => !isBlip(r, nowMs))
  const blipsFiltered = allRecordsRaw.length - records.length

  /* ── per-store rollup ── */
  const perStore = new Map()
  for (const tag of tagsInGroup) {
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
  for (const tag of tagsInGroup) {
    const s = tagIdx.get(tag)
    if (s?.online === false || s?.lastOnline === false) {
      // best-effort: snapshotter keeps online state; if explicit false, mark live offline
      const ps = perStore.get(tag)
      if (ps) ps.currentlyOffline = true
    }
  }

  for (const rec of records) {
    if (!tagsSet.has(rec.storeTag)) continue
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
      const d = new Date(ev.startMs); d.setHours(0, 0, 0, 0)
      const key = d.getTime()
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
  const perStoreList = [...perStore.values()].map((ps) => {
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

  /* ── summary KPIs ── */
  const reportingStores = perStoreList.filter((s) => s.uptimePct != null)
  const avgUptimePct = reportingStores.length
    ? Math.round(
        reportingStores.reduce((sum, s) => sum + s.uptimePct, 0) / reportingStores.length * 100,
      ) / 100
    : null
  const totalDowntimeMin = perStoreList.reduce((s, x) => s + x.bizDownMin, 0)
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
      totalDisconnects,
      mttrMin,
      bhMinutesPerStore,
    },
    trend,
    heatmap,
    topOffenders,
    perStore: perStoreList,
    meta: {
      recordsConsidered: records.length,
      blipsFiltered,
      minDurationMin: MIN_OFFLINE_MIN,
      flapGapMin: FLAP_GAP_MS / 60_000,
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
