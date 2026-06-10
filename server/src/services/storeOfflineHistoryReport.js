/**
 * Group-wise offline reporting backed by StoreProblemHistory (MongoDB).
 *
 * This is the canonical source of truth — the same `code: 'offline'` records
 * that drive Slack alerts, written every 2 min by storeProblemSnapshotter.
 * Each record has firstSeenAt / resolvedAt / durationMs and is naturally
 * deduped by the state machine, so we don't need to derive disconnect counts
 * from heartbeat gaps.
 *
 * Functions:
 *   - fetchGroupOfflineSummary(rangeSec, fromSec, toSec, opts)
 *       Day-wise per-group disconnect count + offline minutes (drives the
 *       "Group Internet Disconnections & Offline Time" widget).
 *   - fetchGroupOfflineEventsList(rangeSec, fromSec, toSec, opts)
 *       Per-store event list for one group (drives the "Store Disconnect
 *       Events Timeline" widget).
 *
 * Both functions accept the same opts as the legacy fetchGroupDisconnectDaily:
 *   { bucketMin, customGroups, businessHours, groupName }
 */
import StoreProblemHistory from '../models/StoreProblemHistory.js'
import {
  getAnyCachedStoreSnapshot,
  fetchStoreSnapshot,
  vendorIsFortinet,
} from './influxStore.js'

const OFFLINE_CODE = 'offline'
const SUMMARY_CACHE_MS = 60_000
const EVENTS_CACHE_MS = 60_000

// Records shorter than this are filtered out as snapshotter blips/jitter. The
// snapshotter ticks every 2 min; a single missed snapshot for a fast-recovering
// store should not appear as a "store down" event. Configurable via env.
const MIN_OFFLINE_MIN = (() => {
  const n = parseInt(process.env.STORE_OFFLINE_MIN_DURATION_MIN || '5', 10)
  return Number.isFinite(n) && n >= 0 ? n : 5
})()
const MIN_OFFLINE_MS = MIN_OFFLINE_MIN * 60_000
const FLAP_GAP_MS = 30 * 60_000

function recordIsBlip(rec, nowMs) {
  const startMs = new Date(rec.firstSeenAt).getTime()
  const endMs = rec.resolvedAt ? new Date(rec.resolvedAt).getTime() : nowMs
  return (endMs - startMs) < MIN_OFFLINE_MS
}
const _summaryCache = new Map()
const _eventsCache = new Map()

/* ───────────── group resolution ─────────────────────────────────────── */

function buildBuiltinDefs(snapshot) {
  const rpTags = []
  const posTags = []
  const sdwanTags = []
  for (const s of snapshot || []) {
    if (!s?.storeTag) continue
    const h = String(s.hostname || '').toUpperCase()
    if (h.startsWith('RP')) rpTags.push(s.storeTag)
    else if (h.startsWith('LK')) posTags.push(s.storeTag)
    if (
      vendorIsFortinet(s.gatewayVendor, s.isFortinet)
      || vendorIsFortinet(s.lastGatewayVendor, s.lastIsFortinet)
    ) sdwanTags.push(s.storeTag)
  }
  return {
    rp: [...new Set(rpTags)],
    pos: [...new Set(posTags)],
    sdwan: [...new Set(sdwanTags)],
  }
}

function buildGroupDefs(snapshot, customGroups = [], onlyName = null) {
  const builtins = buildBuiltinDefs(snapshot)
  const defs = []
  if (builtins.rp.length) defs.push({ name: 'RP Group', tags: builtins.rp })
  if (builtins.pos.length) defs.push({ name: 'POS System Group', tags: builtins.pos })
  if (builtins.sdwan.length) defs.push({ name: 'SD-WAN Group', tags: builtins.sdwan })
  for (const g of customGroups) {
    const name = String(g?.name || '').trim()
    const tags = Array.isArray(g?.storeTags)
      ? [...new Set(g.storeTags.map((t) => String(t || '').trim()).filter(Boolean))]
      : []
    if (name && tags.length) defs.push({ name, tags })
  }
  if (onlyName) return defs.filter((d) => d.name === onlyName)
  return defs
}

/* ───────────── BH / day windowing helpers ───────────────────────────── */

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

/** BH minutes for the calendar day containing `dayMs` (local midnight start). */
function bhMinutesForDay(dayMs, bh, nowMs) {
  if (!bh || !bh.weekdays?.length) {
    const dayEnd = dayMs + 86_400_000
    if (nowMs < dayMs) return 0
    if (nowMs >= dayEnd) return 1440
    return Math.max(0, Math.floor((nowMs - dayMs) / 60_000))
  }
  const tzOff = (bh.tzOffsetMinutes || 0) * 60_000
  const local = new Date(dayMs + tzOff)
  const dow = local.getUTCDay()
  if (!bh.weekdays.includes(dow)) return 0
  const startMs = dayMs + bh.startHour * 3_600_000
  const endMs = dayMs + bh.endHour * 3_600_000
  if (nowMs <= startMs) return 0
  const cap = Math.min(endMs, nowMs)
  return Math.max(0, Math.floor((cap - startMs) / 60_000))
}

/** Sum of minutes between [aMs,bMs) that fall inside the BH window (per-minute). */
function overlapMinutesWithBh(aMs, bMs, isBh) {
  if (bMs <= aMs) return 0
  if (!isBh) return Math.floor((bMs - aMs) / 60_000)
  // BH transitions only happen on the hour, so walk by-hour, count overlap.
  let total = 0
  let cursor = aMs
  const stop = bMs
  while (cursor < stop) {
    const hourStart = Math.floor(cursor / 3_600_000) * 3_600_000
    const hourEnd = hourStart + 3_600_000
    const segEnd = Math.min(stop, hourEnd)
    if (isBh(cursor)) total += Math.floor((segEnd - cursor) / 60_000)
    cursor = segEnd
  }
  return total
}

/* ───────────── snapshot loader (group resolution + lookup) ─────────── */

async function ensureSnapshot() {
  let snap = getAnyCachedStoreSnapshot(15 * 60 * 1000)
  if (!snap) {
    try { snap = await fetchStoreSnapshot(15, '-24h') } catch { snap = null }
  }
  return Array.isArray(snap) ? snap : []
}

function snapshotIndex(snapshot) {
  const byTag = new Map()
  for (const s of snapshot) {
    if (s?.storeTag) byTag.set(s.storeTag, s)
  }
  return byTag
}

/* ───────────── core: fetch overlapping offline records ──────────────── */

async function fetchOfflineRecords(allTags, fromMs, toMs) {
  if (!allTags.length) return []
  const fromDate = new Date(fromMs)
  const toDate = new Date(toMs)
  return StoreProblemHistory.find({
    code: OFFLINE_CODE,
    storeTag: { $in: allTags },
    firstSeenAt: { $lt: toDate },
    $or: [
      { resolvedAt: null },
      { resolvedAt: { $gt: fromDate } },
    ],
  }).lean()
}

/* ───────────── day list builder ─────────────────────────────────────── */

function buildDayList(fromMs, toMs) {
  const days = []
  const start = new Date(fromMs); start.setHours(0, 0, 0, 0)
  const end = new Date(toMs); end.setHours(0, 0, 0, 0)
  for (let d = start.getTime(); d <= end.getTime(); d += 86_400_000) {
    const dt = new Date(d)
    days.push({
      dayMs: d,
      label: dt.toISOString().slice(0, 10),
    })
  }
  return days
}

/* ───────────── public: day-wise per-group summary ───────────────────── */

export async function fetchGroupOfflineSummary(rangeSec = 86400, fromSec, toSec, opts = {}) {
  const nowSec = Math.floor(Date.now() / 1000)
  const requestedFromSec = fromSec && Number.isFinite(Number(fromSec)) ? Number(fromSec) : nowSec - rangeSec
  const requestedToSec   = toSec && Number.isFinite(Number(toSec))     ? Number(toSec)   : nowSec
  const fromMs = requestedFromSec * 1000
  const toMs = requestedToSec * 1000
  const nowMs = Date.now()

  const customGroups = Array.isArray(opts.customGroups) ? opts.customGroups : []
  const onlyGroup = opts.groupName ? String(opts.groupName).trim().slice(0, 80) : ''
  const bh = opts.businessHours && typeof opts.businessHours === 'object' ? opts.businessHours : null

  const cacheKey = JSON.stringify({
    fromSec: requestedFromSec, toSec: requestedToSec,
    onlyGroup,
    customGroups: customGroups.map((g) => ({ name: g?.name, tags: (g?.storeTags || []).slice().sort() })),
    bh,
  })
  const cached = _summaryCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < SUMMARY_CACHE_MS) return cached.data

  const snapshot = await ensureSnapshot()
  const groupDefs = buildGroupDefs(snapshot, customGroups, onlyGroup || null)

  // Tag → array of group names (a store can belong to multiple groups, e.g. RP + SD-WAN)
  const tagToGroups = new Map()
  for (const def of groupDefs) {
    for (const tag of def.tags) {
      if (!tagToGroups.has(tag)) tagToGroups.set(tag, [])
      tagToGroups.get(tag).push(def.name)
    }
  }
  const allTags = [...tagToGroups.keys()]
  const allRecords = await fetchOfflineRecords(allTags, fromMs, toMs)
  // Drop short blips so brief monitoring hiccups don't inflate "Stores Down"
  // counts. Tunable via STORE_OFFLINE_MIN_DURATION_MIN (default 5 min).
  const records = allRecords.filter((r) => !recordIsBlip(r, nowMs))
  const blipCount = allRecords.length - records.length

  const isBh = makeBhChecker(bh)
  const days = buildDayList(fromMs, toMs)
  const dayMsList = days.map((d) => d.dayMs)

  // Per-group state:
  // - impactedTagsByDay: state view (stores with any offline overlap that day)
  // - newEventTagsByDay: event view (stores with >=1 new session that STARTED
  //   that day), flap-coalesced first; then de-duplicated per store per day.
  //   This keeps event semantics while preventing noisy >storeCount spikes.
  const perGroup = new Map()
  for (const def of groupDefs) {
    const dayStats = new Map()
    const impactedTagsByDay = new Map()
    const newEventTagsByDay = new Map()
    const rawEventsByDay = new Map()
    for (const d of dayMsList) {
      dayStats.set(d, { offlineMinutes: 0 })
      impactedTagsByDay.set(d, new Set())
      newEventTagsByDay.set(d, new Set())
      rawEventsByDay.set(d, 0)
    }
    perGroup.set(def.name, {
      name: def.name,
      tagsInGroup: new Set(def.tags),
      dayStats,
      impactedTagsByDay,
      newEventTagsByDay,
      rawEventsByDay,
      recordsByStore: new Map(),
      impactedTagsTotal: new Set(),
      newEventTagsTotal: new Set(),
      reportingTags: new Set(),
      totals: { offlineMinutes: 0, rawEvents: 0 },
    })
  }

  for (const rec of records) {
    const tag = rec.storeTag
    const groups = tagToGroups.get(tag)
    if (!groups) continue
    const startMs = new Date(rec.firstSeenAt).getTime()
    const endMs = rec.resolvedAt ? new Date(rec.resolvedAt).getTime() : nowMs
    const startInWin = Math.max(startMs, fromMs)
    const endInWin = Math.min(endMs, toMs)
    if (endInWin <= startInWin) continue

    for (const groupName of groups) {
      const g = perGroup.get(groupName)
      if (!g) continue
      g.reportingTags.add(tag)

      if (!g.recordsByStore.has(tag)) g.recordsByStore.set(tag, [])
      g.recordsByStore.get(tag).push({ startMs, endMs })

      let storeImpactedAnyDay = false
      for (const dayMs of dayMsList) {
        const dayStartMs = dayMs
        const dayEndMs = dayMs + 86_400_000
        const segStart = Math.max(startInWin, dayStartMs)
        const segEnd = Math.min(endInWin, dayEndMs)
        if (segEnd <= segStart) continue
        const mins = overlapMinutesWithBh(segStart, segEnd, isBh)
        if (mins <= 0) continue
        const stat = g.dayStats.get(dayMs)
        if (stat) stat.offlineMinutes += mins
        g.totals.offlineMinutes += mins
        g.impactedTagsByDay.get(dayMs).add(tag)
        storeImpactedAnyDay = true
      }
      if (storeImpactedAnyDay) g.impactedTagsTotal.add(tag)
    }
  }

  // Event view (new sessions/day): coalesce flap sequences per store so rapid
  // offline<->online oscillations count as one event.
  function dayMsContaining(tsMs) {
    const d = new Date(tsMs)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  function ensureEventShape(g) {
    if (!g) return
    if (!(g.newEventTagsByDay instanceof Map)) {
      g.newEventTagsByDay = new Map(dayMsList.map((d) => [d, new Set()]))
    }
    if (!(g.rawEventsByDay instanceof Map)) {
      g.rawEventsByDay = new Map(dayMsList.map((d) => [d, 0]))
    }
    if (!(g.newEventTagsTotal instanceof Set)) {
      g.newEventTagsTotal = new Set()
    }
  }
  for (const g of perGroup.values()) {
    ensureEventShape(g)
    const recordSessionStart = (storeTag, sessionStartMs) => {
      if (sessionStartMs == null || sessionStartMs < fromMs || sessionStartMs >= toMs) return
      const dayMs = dayMsContaining(sessionStartMs)
      if (!g.newEventTagsByDay.has(dayMs)) return
      g.newEventTagsByDay.get(dayMs).add(storeTag)
      g.newEventTagsTotal.add(storeTag)
      g.rawEventsByDay.set(dayMs, g.rawEventsByDay.get(dayMs) + 1)
      g.totals.rawEvents += 1
    }

    for (const [tag, recs] of g.recordsByStore.entries()) {
      recs.sort((a, b) => a.startMs - b.startMs)
      let sessionStart = null
      let sessionEnd = null
      for (const r of recs) {
        if (sessionStart == null) {
          sessionStart = r.startMs
          sessionEnd = r.endMs
          continue
        }
        const gapMs = (sessionEnd == null) ? 0 : (r.startMs - sessionEnd)
        if (gapMs <= FLAP_GAP_MS) {
          // Same outage chain; extend end.
          if (sessionEnd == null || r.endMs == null) sessionEnd = null
          else if (r.endMs > sessionEnd) sessionEnd = r.endMs
        } else {
          recordSessionStart(tag, sessionStart)
          sessionStart = r.startMs
          sessionEnd = r.endMs
        }
      }
      recordSessionStart(tag, sessionStart)
    }
  }

  // Also include tags from the snapshot that are currently online but in the
  // group — they count toward storeCount even though they have no offline records.
  for (const def of groupDefs) {
    const g = perGroup.get(def.name)
    if (!g) continue
    for (const tag of def.tags) g.reportingTags.add(tag)
  }

  const groupsPayload = groupDefs.map((def) => {
    const g = perGroup.get(def.name)
    ensureEventShape(g)
    const daysOut = dayMsList.map((dayMs) => {
      const s = g.dayStats?.get?.(dayMs) || { offlineMinutes: 0 }
      const impacted = g.impactedTagsByDay?.get?.(dayMs)?.size || 0
      const eventStores = g.newEventTagsByDay.get(dayMs)?.size || 0
      const rawEvents = g.rawEventsByDay.get(dayMs) || 0
      return {
        dayMs,
        // Event-based + per-store/day dedup: stores that had >=1 new session
        // starting this day.
        disconnections: eventStores,
        // Keep state-view value for diagnostics/tooltips.
        storesDown: impacted,
        rawEvents,
        offlineMinutes: s.offlineMinutes,
        offlineHours: Math.round((s.offlineMinutes / 60) * 100) / 100,
      }
    })
    const sumDisconnections = daysOut.reduce((sum, d) => sum + d.disconnections, 0)
    const sumRawEvents = daysOut.reduce((sum, d) => sum + (d.rawEvents || 0), 0)
    return {
      name: def.name,
      storeCount: g.reportingTags?.size || 0,
      days: daysOut,
      totals: {
        disconnections: sumDisconnections,
        rawEvents: sumRawEvents,
        uniqueStoresWithNewEvents: g.newEventTagsTotal?.size || 0,
        uniqueStoresImpacted: g.impactedTagsTotal?.size || 0,
        offlineMinutes: g.totals?.offlineMinutes || 0,
        offlineHours: Math.round((((g.totals?.offlineMinutes) || 0) / 60) * 100) / 100,
      },
    }
  })

  const data = {
    rangeSec: requestedToSec - requestedFromSec,
    bucketMin: 5,
    requestedFrom: new Date(fromMs).toISOString(),
    requestedTo: new Date(toMs).toISOString(),
    days,
    source: `StoreProblemHistory (code='offline', MongoDB)`,
    storesReporting: groupsPayload.reduce((sum, g) => sum + g.storeCount, 0),
    groupQueryCount: groupDefs.length,
    groupName: onlyGroup || null,
    sdwanStoreCount: groupDefs.find((d) => d.name === 'SD-WAN Group')?.tags.length || 0,
    businessHours: bh ? {
      startHour: bh.startHour,
      endHour: bh.endHour,
      weekdays: [...(bh.weekdays || [])].sort(),
      tzOffsetMinutes: bh.tzOffsetMinutes || 0,
    } : null,
    groups: groupsPayload,
    meta: {
      recordsConsidered: records.length,
      tagsQueried: allTags.length,
      blipsFiltered: blipCount,
      minDurationMin: MIN_OFFLINE_MIN,
    },
  }

  console.log(
    `[offlineHistorySummary] groups=${groupDefs.length} tags=${allTags.length} `
    + `records=${records.length} blipsFiltered=${blipCount} (<${MIN_OFFLINE_MIN}m) window=${fromMs}-${toMs}`,
  )

  _summaryCache.set(cacheKey, { data, ts: Date.now() })
  if (_summaryCache.size > 24) {
    const oldest = [..._summaryCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) _summaryCache.delete(oldest[0])
  }
  return data
}

/* ───────────── public: per-store event timeline (one group) ────────── */

export async function fetchGroupOfflineEventsList(rangeSec = 86400, fromSec, toSec, opts = {}) {
  const groupName = String(opts.groupName || '').trim()
  if (!groupName) return { events: [], error: 'groupName required' }

  const nowSec = Math.floor(Date.now() / 1000)
  const requestedFromSec = fromSec && Number.isFinite(Number(fromSec)) ? Number(fromSec) : nowSec - rangeSec
  const requestedToSec   = toSec && Number.isFinite(Number(toSec))     ? Number(toSec)   : nowSec
  const fromMs = requestedFromSec * 1000
  const toMs = requestedToSec * 1000
  const nowMs = Date.now()

  const customGroups = Array.isArray(opts.customGroups) ? opts.customGroups : []
  const cacheKey = JSON.stringify({
    groupName,
    fromSec: requestedFromSec,
    toSec: requestedToSec,
    customGroups: customGroups.map((g) => ({ name: g?.name, tags: (g?.storeTags || []).slice().sort() })),
  })
  const cached = _eventsCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < EVENTS_CACHE_MS) return cached.data

  const snapshot = await ensureSnapshot()
  const groupDefs = buildGroupDefs(snapshot, customGroups, groupName)
  if (!groupDefs.length) return { events: [], error: `Unknown group: ${groupName}` }
  const def = groupDefs[0]
  const tagSet = new Set(def.tags)
  const tagsArr = [...tagSet]

  const allRecordsRaw = await fetchOfflineRecords(tagsArr, fromMs, toMs)
  const records = allRecordsRaw.filter((r) => !recordIsBlip(r, nowMs))
  const blipCountEvents = allRecordsRaw.length - records.length
  const hostByTag = snapshotIndex(snapshot)

  // Coalesce short flap sequences per store so a 30-min "offline -> back -> offline
  // -> back" cycle shows up as ONE event with flapCount=2, not 4 separate rows.
  // Records are considered the same outage if the gap between the previous resolve
  // and the next firstSeenAt is <= FLAP_GAP_MS.
  const FLAP_GAP_MS = 30 * 60_000
  const recordsByStore = new Map()
  for (const rec of records) {
    const tag = rec.storeTag
    if (!recordsByStore.has(tag)) recordsByStore.set(tag, [])
    recordsByStore.get(tag).push(rec)
  }
  const events = []
  for (const [tag, recs] of recordsByStore) {
    recs.sort((a, b) => new Date(a.firstSeenAt) - new Date(b.firstSeenAt))
    let current = null
    for (const rec of recs) {
      const startMs = new Date(rec.firstSeenAt).getTime()
      const endMs = rec.resolvedAt ? new Date(rec.resolvedAt).getTime() : null
      if (current && current.lastResolvedMs != null && startMs - current.lastResolvedMs <= FLAP_GAP_MS) {
        // Same outage, merge.
        current.flapCount += 1
        current.lastResolvedMs = endMs // null wins (=> stillOffline)
        if (endMs === null) current.stillOffline = true
      } else {
        if (current) events.push(current)
        current = {
          storeTag: tag,
          hostname: rec.hostname || hostByTag.get(tag)?.hostname || '',
          firstStartMs: startMs,
          lastResolvedMs: endMs,
          stillOffline: endMs === null,
          flapCount: 1,
          connState: rec.connState || hostByTag.get(tag)?.connState || null,
          severity: rec.severity || null,
        }
      }
    }
    if (current) events.push(current)
  }

  const finalized = events.map((ev) => {
    const effectiveEndMs = ev.stillOffline ? nowMs : (ev.lastResolvedMs ?? nowMs)
    const durationMin = Math.max(1, Math.round((effectiveEndMs - ev.firstStartMs) / 60_000))
    return {
      storeTag: ev.storeTag,
      hostname: ev.hostname,
      disconnectTs: Math.floor(ev.firstStartMs / 1000),
      reconnectTs: ev.stillOffline ? null : Math.floor((ev.lastResolvedMs ?? nowMs) / 1000),
      durationMin,
      stillOffline: ev.stillOffline,
      flapCount: ev.flapCount,
      source: 'history',
      connState: ev.connState,
      severity: ev.severity,
    }
  }).sort((a, b) => (b.disconnectTs || 0) - (a.disconnectTs || 0))

  const data = {
    groupName,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    rangeSec: requestedToSec - requestedFromSec,
    bucketMin: 5,
    storeCount: new Set(finalized.map((e) => e.storeTag)).size,
    eventCount: finalized.length,
    stillOfflineCount: finalized.filter((e) => e.stillOffline).length,
    source: `StoreProblemHistory (code='offline', MongoDB) · ≥${MIN_OFFLINE_MIN}m + flap-coalesced (<=30m gap)`,
    meta: {
      recordsConsidered: records.length,
      tagsQueried: tagsArr.length,
      flapsCoalesced: records.length - finalized.length,
      blipsFiltered: blipCountEvents,
      minDurationMin: MIN_OFFLINE_MIN,
    },
    events: finalized,
  }

  _eventsCache.set(cacheKey, { data, ts: Date.now() })
  if (_eventsCache.size > 24) {
    const oldest = [..._eventsCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) _eventsCache.delete(oldest[0])
  }
  return data
}
