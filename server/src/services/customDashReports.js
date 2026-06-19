/**
 * Custom Dashboard reports — per-day fleet health + high-latency episode
 * detection for an arbitrary list of selected Zabbix hosts.
 *
 * Inputs:
 *   - hostids[]: Zabbix host ids selected in the Custom Dashboard
 *   - fromSec, toSec: window in unix seconds (full range covering N days)
 *   - bh: { enabled, start, end, days[] } — business-hours window applied to
 *     the per-day stats (NOT used to clip the raw history fetch).
 *   - latencyThresholdMs: latency >threshold counts as a breach (default 150ms)
 *   - gapToleranceSec: episode merge tolerance (default 120s)
 *   - latencyTopN, peakTopN: caps for the report 2 / report 3 lists per day
 *
 * Outputs the per-day breakdown matching the user's sample reports:
 *   - perDay[].reboots — host reboots detected from system.uptime drops in BH
 *   - perDay[].latencyHigh — latency >threshold sorted by avg, with episodes
 *   - perDay[].networkNoReboot — hosts with high peak but no reboot, sorted by peak
 *   - perDay[].summary — counts + worst host snapshots
 *
 * Data sources:
 *   - history.get / trend.get for `system.uptime` (per host) — reboot detection
 *   - history.get / trend.get for `custom.ping.ms[*]`, `icmppingsec`, or
 *     `net.tcp.service.perf` (whichever item the host has) — latency series
 */
import { ZABBIX_HOST_FETCH_MAX } from './zabbixHostFetch.js'

const HOST_LIMIT = 1000
const ITEM_CHUNK = 200
const HISTORY_CHUNK = 60
const HISTORY_CONCURRENCY = 10
const TREND_CHUNK = 200
const TREND_CONCURRENCY = 8
const REBOOT_DROP_SEC = 300
const REPORT_CACHE_MS = 30_000
const _cache = new Map()

const LATENCY_KEY_PATTERNS = [
  'custom.ping.ms',
  'icmppingsec',
  'net.tcp.service.perf',
]

/* ────────────────────────────────────────────────────────────────────
   helpers
   ──────────────────────────────────────────────────────────────────── */

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

function cacheKey(opts) {
  return JSON.stringify({
    h: (opts.hostids || []).slice().sort(),
    f: opts.fromSec,
    t: opts.toSec,
    bh: opts.bh,
    l: opts.latencyThresholdMs,
    g: opts.gapToleranceSec,
    n: opts.latencyTopN,
    p: opts.peakTopN,
  })
}

function isLatencyKey(key = '') {
  const k = String(key).toLowerCase()
  return LATENCY_KEY_PATTERNS.some((p) => k.includes(p))
}

function scoreLatencyItem(item) {
  const k = String(item?.key_ || '').toLowerCase()
  if (k.includes('custom.ping.ms')) return 0
  if (k.includes('icmppingsec')) return 1
  if (k.includes('net.tcp.service.perf')) return 2
  return 9
}

/** Convert seconds → ms for items reported in seconds. */
function normalizeLatencyValue(value, item) {
  const u = String(item?.units || '').toLowerCase().trim()
  const k = String(item?.key_ || '').toLowerCase()
  const isSec =
    u === 's' || u === 'sec' || u === 'seconds'
    || k.includes('icmppingsec') || k.includes('net.tcp.service.perf')
  return isSec ? Number(value) * 1000 : Number(value)
}

function historyKind(valueType) {
  const v = Number(valueType)
  if (v === 0) return { history: 0, trends: true }
  if (v === 3) return { history: 3, trends: true }
  return null
}

async function mapConcurrent(items, fn, concurrency = HISTORY_CONCURRENCY) {
  const results = new Array(items.length)
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i], i)
    }
  }
  const workers = Math.min(concurrency, Math.max(1, items.length))
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

/* ────────────────────────────────────────────────────────────────────
   item lookup
   ──────────────────────────────────────────────────────────────────── */

async function fetchUptimeItems(zabbixRpc, hostids) {
  const out = []
  for (let i = 0; i < hostids.length; i += ITEM_CHUNK) {
    const chunk = hostids.slice(i, i + ITEM_CHUNK)
    const rows = await zabbixRpc('item.get', {
      hostids: chunk,
      output: ['itemid', 'hostid', 'name', 'key_', 'value_type', 'lastclock'],
      search: { key_: 'system.uptime' },
      searchWildcardsEnabled: true,
      limit: ZABBIX_HOST_FETCH_MAX,
    }).catch(() => [])
    out.push(...(rows || []))
  }
  return out
}

async function fetchLatencyItems(zabbixRpc, hostids) {
  const out = []
  for (const pat of LATENCY_KEY_PATTERNS) {
    for (let i = 0; i < hostids.length; i += ITEM_CHUNK) {
      const chunk = hostids.slice(i, i + ITEM_CHUNK)
      const rows = await zabbixRpc('item.get', {
        hostids: chunk,
        output: ['itemid', 'hostid', 'name', 'key_', 'value_type', 'lastclock', 'units'],
        search: { key_: pat },
        searchWildcardsEnabled: true,
        limit: ZABBIX_HOST_FETCH_MAX,
      }).catch(() => [])
      out.push(...(rows || []))
    }
  }
  return out
}

/** Pick best uptime item per host (prefer exact `system.uptime`). */
function pickUptimeByHost(items) {
  const map = {}
  for (const it of items || []) {
    const hid = String(it.hostid)
    const k = String(it.key_ || '').toLowerCase()
    if (!k.includes('system.uptime')) continue
    const isExact = k === 'system.uptime'
    const prev = map[hid]
    if (!prev) { map[hid] = { ...it, _exact: isExact }; continue }
    if (isExact && !prev._exact) map[hid] = { ...it, _exact: true }
  }
  return map
}

/** Pick best latency item per host. */
function pickLatencyByHost(items) {
  const map = {}
  for (const it of items || []) {
    const hid = String(it.hostid)
    if (!isLatencyKey(it.key_)) continue
    const prev = map[hid]
    const score = scoreLatencyItem(it)
    if (!prev || score < prev._score) {
      map[hid] = { ...it, _score: score }
    }
  }
  return map
}

/* ────────────────────────────────────────────────────────────────────
   history fetch
   ──────────────────────────────────────────────────────────────────── */

async function fetchHistoryByItems(zabbixRpc, items, fromSec, toSec) {
  const byKind = new Map()
  for (const e of items) {
    const hk = historyKind(e.value_type)
    if (!hk) continue
    if (!byKind.has(hk.history)) byKind.set(hk.history, [])
    byKind.get(hk.history).push(e)
  }
  const byItem = {}
  for (const [historyType, entries] of byKind) {
    const chunks = []
    for (let i = 0; i < entries.length; i += HISTORY_CHUNK) {
      chunks.push(entries.slice(i, i + HISTORY_CHUNK))
    }
    await mapConcurrent(chunks, async (chunk) => {
      const itemids = chunk.map((e) => String(e.itemid))
      const rows = await zabbixRpc('history.get', {
        history: historyType,
        itemids,
        time_from: fromSec,
        time_till: toSec,
        output: ['itemid', 'clock', 'value'],
        sortfield: 'clock',
        sortorder: 'ASC',
        limit: 50000,
      }).catch(() => [])
      for (const r of rows || []) {
        const iid = String(r.itemid)
        if (!byItem[iid]) byItem[iid] = []
        byItem[iid].push({ clock: Number(r.clock), value: Number(r.value) })
      }
    }, HISTORY_CONCURRENCY)
  }
  return byItem
}

/**
 * Fetch trend.get for items — returns hourly { value_avg, value_min, value_max }
 * bins. Use this as a fast screen so we only fetch per-minute history.get for
 * hosts that actually breach the threshold or reboot in the window.
 */
async function fetchTrendsByItems(zabbixRpc, items, fromSec, toSec) {
  const byItem = {}
  const trendItems = items.filter((e) => historyKind(e.value_type)?.trends)
  const chunks = []
  for (let i = 0; i < trendItems.length; i += TREND_CHUNK) {
    chunks.push(trendItems.slice(i, i + TREND_CHUNK))
  }
  await mapConcurrent(chunks, async (chunk) => {
    const itemids = chunk.map((e) => String(e.itemid))
    const rows = await zabbixRpc('trend.get', {
      itemids,
      time_from: fromSec,
      time_till: toSec,
      output: ['itemid', 'clock', 'value_avg', 'value_min', 'value_max'],
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: 50000,
    }).catch(() => [])
    for (const r of rows || []) {
      const iid = String(r.itemid)
      if (!byItem[iid]) byItem[iid] = []
      byItem[iid].push({
        clock: Number(r.clock),
        avg: Number(r.value_avg),
        min: Number(r.value_min),
        max: Number(r.value_max),
      })
    }
  }, TREND_CONCURRENCY)
  return byItem
}

/* ────────────────────────────────────────────────────────────────────
   per-day windows + BH masking
   ──────────────────────────────────────────────────────────────────── */

/** IST is UTC+05:30. Use a fixed offset since the source reports timestamps in IST. */
const IST_OFFSET_MIN = 330

function dayBounds(epochSec, tzOffsetMin = IST_OFFSET_MIN) {
  /** Return [startSec, endSec] of the local day containing epochSec. */
  const offSec = tzOffsetMin * 60
  const local = epochSec + offSec
  const startLocal = Math.floor(local / 86400) * 86400
  return {
    start: startLocal - offSec,
    end: startLocal - offSec + 86400,
    localKey: new Date(startLocal * 1000).toISOString().slice(0, 10),
  }
}

function enumerateDays(fromSec, toSec, tzOffsetMin = IST_OFFSET_MIN) {
  const out = []
  const first = dayBounds(fromSec, tzOffsetMin)
  let cursor = first.start
  while (cursor < toSec) {
    const d = dayBounds(cursor, tzOffsetMin)
    out.push(d)
    cursor = d.end
  }
  return out
}

/** True when epochSec falls inside the BH window for the given day. */
function inBhDay(epochSec, dayStartSec, bh, tzOffsetMin = IST_OFFSET_MIN) {
  if (!bh?.enabled) return true
  const local = epochSec + tzOffsetMin * 60
  const dayLocal = dayStartSec + tzOffsetMin * 60
  const minutes = Math.floor((local - dayLocal) / 60)
  if (minutes < 0 || minutes >= 1440) return false
  const dayDate = new Date(dayLocal * 1000)
  const dow = dayDate.getUTCDay() /* day-of-week of the local day */
  const days = bh.days || []
  if (Array.isArray(days) && days.length && !days.includes(dow)) return false
  const startM = (Number(bh.start) || 0) * 60
  const endM = (Number(bh.end) || 0) * 60
  if (endM <= startM) return minutes >= startM || minutes < endM
  return minutes >= startM && minutes < endM
}

/** Format an epoch second as HH:MM in IST. */
function fmtTimeIst(epochSec, tzOffsetMin = IST_OFFSET_MIN) {
  const d = new Date((epochSec + tzOffsetMin * 60) * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function dayLabel(dayBoundsObj) {
  /** "13-Jun" style for matrix rows. */
  const d = new Date((dayBoundsObj.start + IST_OFFSET_MIN * 60) * 1000)
  const day = String(d.getUTCDate()).padStart(2, '0')
  const mon = d.toLocaleString('en-US', { month: 'short' })
  return `${day}-${mon}`
}

/* ────────────────────────────────────────────────────────────────────
   reboot detection
   ──────────────────────────────────────────────────────────────────── */

/**
 * Walk a sorted system.uptime series; emit one boot event per detected drop.
 * Boot time ≈ next-sample.clock − next-sample.value (clamped after the
 * previous sample). Treat counter resets and counter going down >300s as a
 * reboot (tolerates floating-point noise on Linux uptime fractional values).
 */
function detectBootEvents(points) {
  const sorted = [...(points || [])].sort((a, b) => a.clock - b.clock)
  const events = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const dropped = cur.value < prev.value
    const sigDrop = (prev.value - cur.value) > REBOOT_DROP_SEC
    if (!dropped && !sigDrop) continue
    const bootEst = Math.max(prev.clock + 1, Math.floor(cur.clock - cur.value))
    events.push({ at: bootEst, prevClock: prev.clock, sampleClock: cur.clock })
  }
  return events
}

/**
 * Approximate per-day reboot detection from trend bins (hourly).
 *
 * A reboot makes uptime collapse to ~0 within an hour. Detect that by spotting
 * trend bins where value_min is small AND lower than the previous bin's
 * value_max by > REBOOT_DROP_SEC. Returns true/false flag — used to flag hosts
 * that need a precise history pass.
 */
function trendsSuggestReboot(uptimeTrend, fromSec, toSec) {
  const bins = (uptimeTrend || [])
    .filter((b) => b.clock >= fromSec && b.clock < toSec)
    .sort((a, b) => a.clock - b.clock)
  if (bins.length < 2) return false
  for (let i = 1; i < bins.length; i++) {
    const prev = bins[i - 1]
    const cur = bins[i]
    if (!Number.isFinite(prev.max) || !Number.isFinite(cur.min)) continue
    if (cur.min < prev.max - REBOOT_DROP_SEC) return true
    if (cur.min < REBOOT_DROP_SEC * 2 && prev.avg > REBOOT_DROP_SEC * 4) return true
  }
  return false
}

/**
 * Per-day latency stats from trend bins (avg/max only — no episodes).
 * Used for non-flagged hosts where we skip the expensive history pass.
 */
function trendDayLatency(latencyTrend, day, item, bh) {
  const bins = (latencyTrend || [])
    .filter((b) => b.clock >= day.start && b.clock < day.end)
    .filter((b) => inBhDay(b.clock, day.start, bh))
  if (!bins.length) return { avgMs: null, maxMs: null, peakAt: null, breaches: 0, episodes: [] }
  let avgSum = 0
  let avgWeight = 0
  let max = -Infinity
  let peakAt = null
  for (const b of bins) {
    const av = normalizeLatencyValue(b.avg, item)
    const mx = normalizeLatencyValue(b.max, item)
    if (Number.isFinite(av)) { avgSum += av; avgWeight += 1 }
    if (Number.isFinite(mx) && mx > max) { max = mx; peakAt = b.clock }
  }
  return {
    avgMs: avgWeight ? Math.round((avgSum / avgWeight) * 10) / 10 : null,
    maxMs: max === -Infinity ? null : Math.round(max),
    peakAt,
    breaches: 0,
    episodes: [],
    fromTrend: true,
  }
}

/** True if trend bins indicate the host crossed the threshold any time in window. */
function trendsSuggestLatencyBreach(latencyTrend, fromSec, toSec, item, threshold) {
  const bins = (latencyTrend || [])
    .filter((b) => b.clock >= fromSec && b.clock < toSec)
  for (const b of bins) {
    const mx = normalizeLatencyValue(b.max, item)
    if (Number.isFinite(mx) && mx > threshold) return true
  }
  return false
}

/* ────────────────────────────────────────────────────────────────────
   latency stats + episodes
   ──────────────────────────────────────────────────────────────────── */

/**
 * Compute avg/max + episode list for a single day.
 *
 * Episode: contiguous run of points where ms > threshold; runs separated by
 * <= gapToleranceSec are merged into one episode. Each episode reports
 * { startSec, endSec, peakMs, peakAt }.
 */
function buildDayLatency(points, day, item, bh, threshold, gapTol) {
  const inDay = (points || []).filter((p) =>
    p.clock >= day.start && p.clock < day.end
  )
  const inBh = inDay.filter((p) => inBhDay(p.clock, day.start, bh))
  if (!inBh.length) {
    return { avgMs: null, maxMs: null, peakAt: null, breaches: 0, episodes: [] }
  }
  let sum = 0
  let max = -Infinity
  let peakAt = null
  const ms = []
  for (const p of inBh) {
    const v = normalizeLatencyValue(p.value, item)
    if (!Number.isFinite(v)) continue
    sum += v
    if (v > max) { max = v; peakAt = p.clock }
    ms.push({ at: p.clock, ms: v })
  }
  const avgMs = ms.length ? sum / ms.length : null
  /* Build episodes from the BH-only points. */
  const episodes = []
  let openEp = null
  ms.sort((a, b) => a.at - b.at)
  for (const point of ms) {
    if (point.ms <= threshold) {
      if (openEp) {
        episodes.push(openEp); openEp = null
      }
      continue
    }
    if (!openEp) {
      openEp = { startSec: point.at, endSec: point.at, peakMs: point.ms, peakAt: point.at }
      continue
    }
    /* Merge if within gap tolerance. */
    if (point.at - openEp.endSec <= gapTol) {
      openEp.endSec = point.at
      if (point.ms > openEp.peakMs) {
        openEp.peakMs = point.ms; openEp.peakAt = point.at
      }
    } else {
      episodes.push(openEp)
      openEp = { startSec: point.at, endSec: point.at, peakMs: point.ms, peakAt: point.at }
    }
  }
  if (openEp) episodes.push(openEp)

  return {
    avgMs: avgMs == null ? null : Math.round(avgMs * 10) / 10,
    maxMs: max === -Infinity ? null : Math.round(max),
    peakAt,
    breaches: episodes.length,
    episodes,
  }
}

/* ────────────────────────────────────────────────────────────────────
   main entry
   ──────────────────────────────────────────────────────────────────── */

/**
 * @param {object} opts
 * @param {Function} opts.zabbixRpc
 * @param {Array<{hostid: string|number, name?: string, host?: string, sdwan?: boolean, link?: string}>} opts.hosts
 * @param {number} opts.fromSec window start (epoch sec)
 * @param {number} opts.toSec window end (epoch sec)
 * @param {{enabled: boolean, start: number, end: number, days: number[]}} opts.bh
 * @param {number} [opts.latencyThresholdMs=150]
 * @param {number} [opts.gapToleranceSec=120]
 * @param {number} [opts.latencyTopN=20]
 * @param {number} [opts.peakTopN=20]
 */
export async function buildCustomDashReport(opts) {
  const fromSec = Math.floor(Number(opts.fromSec))
  const toSec = Math.floor(Number(opts.toSec))
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) {
    const err = new Error('Invalid from/to bounds'); err.code = 'INVALID_WINDOW'; throw err
  }
  const hostList = (opts.hosts || []).filter((h) => h?.hostid).slice(0, HOST_LIMIT)
  if (!hostList.length) {
    const err = new Error('No hosts selected'); err.code = 'NO_HOSTS'; throw err
  }
  const hostids = hostList.map((h) => String(h.hostid))
  const hostMap = Object.fromEntries(hostList.map((h) => [String(h.hostid), h]))

  const bh = {
    enabled: !!opts.bh?.enabled,
    start: clamp(opts.bh?.start, 0, 23),
    end: clamp(opts.bh?.end, 0, 24),
    days: Array.isArray(opts.bh?.days) ? opts.bh.days : [0, 1, 2, 3, 4, 5, 6],
  }
  const latencyThresholdMs = clamp(opts.latencyThresholdMs ?? 150, 1, 100000)
  const gapToleranceSec = clamp(opts.gapToleranceSec ?? 120, 0, 1800)
  const latencyTopN = clamp(opts.latencyTopN ?? 20, 1, 200)
  const peakTopN = clamp(opts.peakTopN ?? 20, 1, 200)

  const ck = cacheKey({
    hostids, fromSec, toSec, bh, latencyThresholdMs, gapToleranceSec,
    latencyTopN, peakTopN,
  })
  const hit = _cache.get(ck)
  if (hit && Date.now() - hit.at < REPORT_CACHE_MS) return hit.data

  /* Pull both item types in parallel. */
  const [uptimeItems, latencyItems] = await Promise.all([
    fetchUptimeItems(opts.zabbixRpc, hostids),
    fetchLatencyItems(opts.zabbixRpc, hostids),
  ])
  const uptimeByHost = pickUptimeByHost(uptimeItems)
  const latencyByHost = pickLatencyByHost(latencyItems)

  const uptimeEntries = Object.values(uptimeByHost)
  const latencyEntries = Object.values(latencyByHost)
  const uptimeIidByHost = Object.fromEntries(uptimeEntries.map((e) => [String(e.hostid), String(e.itemid)]))
  const latencyIidByHost = Object.fromEntries(latencyEntries.map((e) => [String(e.hostid), String(e.itemid)]))

  /**
   * PASS 1 — fast trend screen (hourly bins). Cheap even for 1000s of hosts.
   * Use to compute non-precise per-day stats AND flag hosts that need the
   * expensive per-minute history pass for episode/reboot detail.
   */
  const [uptimeTrend, latencyTrend] = await Promise.all([
    fetchTrendsByItems(opts.zabbixRpc, uptimeEntries, fromSec, toSec),
    fetchTrendsByItems(opts.zabbixRpc, latencyEntries, fromSec, toSec),
  ])

  const flaggedForHistory = new Set()
  for (const hid of hostids) {
    const upTrend = uptimeTrend[uptimeIidByHost[hid]] || []
    const latTrend = latencyTrend[latencyIidByHost[hid]] || []
    const item = latencyByHost[hid]
    if (trendsSuggestReboot(upTrend, fromSec, toSec)) flaggedForHistory.add(hid)
    if (trendsSuggestLatencyBreach(latTrend, fromSec, toSec, item, latencyThresholdMs)) flaggedForHistory.add(hid)
  }

  /**
   * PASS 2 — per-minute history ONLY for flagged hosts. This is the slow
   * call (history.get is expensive on the Zabbix DB). Restricting to
   * breaching hosts keeps fleet-wide reports under the 10-min frontend limit.
   */
  const flaggedUptime = uptimeEntries.filter((e) => flaggedForHistory.has(String(e.hostid)))
  const flaggedLatency = latencyEntries.filter((e) => flaggedForHistory.has(String(e.hostid)))
  const [uptimeHist, latencyHist] = await Promise.all([
    fetchHistoryByItems(opts.zabbixRpc, flaggedUptime, fromSec, toSec),
    fetchHistoryByItems(opts.zabbixRpc, flaggedLatency, fromSec, toSec),
  ])

  /* Boot events from history for flagged hosts; 0 otherwise. */
  const hostBootEvents = {}
  for (const e of flaggedUptime) {
    const iid = String(e.itemid)
    const series = uptimeHist[iid] || []
    hostBootEvents[String(e.hostid)] = detectBootEvents(series)
  }
  const hostLatencyPoints = {}
  const hostLatencyItem = {}
  for (const e of latencyEntries) {
    hostLatencyItem[String(e.hostid)] = e
    if (flaggedForHistory.has(String(e.hostid))) {
      hostLatencyPoints[String(e.hostid)] = latencyHist[String(e.itemid)] || []
    }
  }

  const days = enumerateDays(fromSec, toSec)
  const perDay = days.map((day) => {
    const dayHostStats = []
    let totalReboots = 0
    let rebootedHosts = 0
    let highestAvgRow = null
    let largestSpikeRow = null
    for (const hid of hostids) {
      const host = hostMap[hid]
      const hostname = host?.name || host?.host || hid
      /* Reboots for this day */
      const allBoots = hostBootEvents[hid] || []
      const dayBoots = allBoots.filter((b) => b.at >= day.start && b.at < day.end)
      const inBhBoots = dayBoots.filter((b) => inBhDay(b.at, day.start, bh))
      const rebootCount = dayBoots.length
      if (rebootCount > 0) { rebootedHosts += 1; totalReboots += rebootCount }

      /* Latency stats for this day (BH-aware). Flagged hosts get precise
         per-minute history; everyone else uses fast hourly trend stats. */
      const latencyItem = hostLatencyItem[hid]
      const isFlagged = flaggedForHistory.has(hid)
      let lat
      if (isFlagged) {
        const points = hostLatencyPoints[hid] || []
        lat = buildDayLatency(points, day, latencyItem, bh, latencyThresholdMs, gapToleranceSec)
      } else {
        lat = trendDayLatency(latencyTrend[latencyIidByHost[hid]], day, latencyItem, bh)
      }

      const sdwan = !!host?.sdwan
      const link = host?.link || (sdwan ? 'Dual' : 'Single')

      const row = {
        hostid: hid,
        hostname,
        host: host?.host || null,
        sdwan,
        link,
        rebootCount,
        bootTimesIst: inBhBoots.map((b) => fmtTimeIst(b.at)),
        rebootOutsideBh: rebootCount > 0 && inBhBoots.length === 0,
        avgMs: lat.avgMs,
        maxMs: lat.maxMs,
        peakAt: lat.peakAt,
        breaches: lat.breaches,
        episodes: lat.episodes.map((ep) => ({
          start: fmtTimeIst(ep.startSec),
          end: fmtTimeIst(ep.endSec),
          peakMs: Math.round(ep.peakMs),
          peakAt: fmtTimeIst(ep.peakAt),
        })),
      }
      dayHostStats.push(row)

      if (lat.avgMs != null && (!highestAvgRow || lat.avgMs > highestAvgRow.avgMs)) {
        highestAvgRow = { hostname, avgMs: lat.avgMs }
      }
      if (lat.maxMs != null && (!largestSpikeRow || lat.maxMs > largestSpikeRow.maxMs)) {
        largestSpikeRow = { hostname, maxMs: lat.maxMs }
      }
    }

    const reboots = dayHostStats
      .filter((r) => r.rebootCount > 0)
      .sort((a, b) => b.rebootCount - a.rebootCount || a.hostname.localeCompare(b.hostname))

    const latencyHigh = dayHostStats
      .filter((r) => (r.avgMs != null && r.avgMs > latencyThresholdMs)
        || (r.maxMs != null && r.maxMs > latencyThresholdMs))
      .sort((a, b) => (b.avgMs ?? 0) - (a.avgMs ?? 0))

    const networkNoReboot = dayHostStats
      .filter((r) => r.rebootCount === 0
        && ((r.avgMs != null && r.avgMs > latencyThresholdMs)
          || (r.maxMs != null && r.maxMs > latencyThresholdMs)))
      .sort((a, b) => (b.maxMs ?? 0) - (a.maxMs ?? 0))

    return {
      dayKey: day.localKey,
      dayLabel: dayLabel(day),
      bhFrom: day.start,
      bhTo: day.end,
      summary: {
        rebootedHosts,
        totalReboots,
        latencyHighCount: latencyHigh.length,
        networkIssueNoReboot: networkNoReboot.length,
        highestAvg: highestAvgRow,
        largestSpike: largestSpikeRow,
      },
      reboots,
      latencyHighTop: latencyHigh.slice(0, latencyTopN),
      networkNoRebootTop: networkNoReboot.slice(0, peakTopN),
      hosts: dayHostStats,
    }
  })

  const data = {
    range: { fromSec, toSec, days: perDay.length },
    bh,
    latencyThresholdMs,
    gapToleranceSec,
    latencyTopN,
    peakTopN,
    hosts: hostList.map((h) => ({
      hostid: String(h.hostid),
      name: h.name || h.host || String(h.hostid),
      host: h.host || null,
      sdwan: !!h.sdwan,
      link: h.link || (h.sdwan ? 'Dual' : 'Single'),
    })),
    perDay,
    diagnostics: {
      hostCount: hostids.length,
      uptimeItems: uptimeEntries.length,
      latencyItems: latencyEntries.length,
      latencyKeys: [...new Set(latencyEntries.map((e) => e.key_).filter(Boolean))].slice(0, 6),
      flaggedHosts: flaggedForHistory.size,
      mode: 'two-pass (trend screen + history for breaching hosts only)',
    },
  }

  _cache.set(ck, { at: Date.now(), data })
  return data
}

export const __test = {
  detectBootEvents,
  buildDayLatency,
  enumerateDays,
  inBhDay,
  fmtTimeIst,
}
