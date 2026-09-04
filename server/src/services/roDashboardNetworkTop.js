/**
 * Ro Dashboard — top-N mean latency / jitter from Store Zabbix history,
 * filtered to business hours (default 09:00–21:00 IST).
 */
import { formatPortalTimestamp } from '../utils/portalTimestamp.js'
import { __test as customDashTest } from './customDashReports.js'

const { inBhDay, enumerateDays } = customDashTest

const IST_OFFSET_MIN = 330
const REPORT_CACHE_MS = 90_000
const ITEM_CHUNK = 400
const HISTORY_CHUNK = 50
const HISTORY_CONCURRENCY = 6
const _cache = new Map()

function cacheKey(opts) {
  return JSON.stringify(opts)
}

function trendBounds(from, to) {
  const fromHour = Math.floor(Number(from) / 3600) * 3600
  const toHour = Math.ceil(Number(to) / 3600) * 3600
  return {
    from: Number.isFinite(fromHour) ? fromHour : from,
    to: Number.isFinite(toHour) && toHour > fromHour ? toHour : to,
  }
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

async function fetchItemsChunked(zabbixRpc, hostids, searchKey) {
  const out = []
  for (let i = 0; i < hostids.length; i += ITEM_CHUNK) {
    const chunk = hostids.slice(i, i + ITEM_CHUNK)
    const batch = await zabbixRpc('item.get', {
      hostids: chunk,
      output: ['itemid', 'hostid', 'name', 'key_', 'value_type', 'lastclock'],
      search: { key_: `${searchKey}*` },
      searchWildcardsEnabled: true,
      limit: 5000,
    }).catch(() => [])
    out.push(...(batch || []))
  }
  return out
}

function pickItemPerHost(items, preferExact = null) {
  const picked = {}
  for (const it of items || []) {
    const hid = String(it.hostid)
    const key = String(it.key_ || '')
    const clock = Number(it.lastclock) || 0
    const prev = picked[hid]
    const isExact = preferExact ? key.includes(preferExact) : false
    const prevExact = prev ? String(prev.key_ || '').includes(preferExact || '') : false
    const prevClock = Number(prev?.lastclock) || 0
    if (!prev || (isExact && !prevExact) || (isExact === prevExact && clock >= prevClock)) {
      picked[hid] = it
    }
  }
  return picked
}

async function fetchTrendSeries(zabbixRpc, itemEntries, from, to) {
  const byItem = {}
  const tb = trendBounds(from, to)
  const chunks = []
  for (let i = 0; i < itemEntries.length; i += HISTORY_CHUNK) {
    chunks.push(itemEntries.slice(i, i + HISTORY_CHUNK))
  }
  await mapConcurrent(chunks, async (chunk) => {
    const itemids = chunk.map((e) => String(e.itemid))
    const rows = await zabbixRpc('trend.get', {
      itemids,
      time_from: tb.from,
      time_till: tb.to,
      output: ['itemid', 'clock', 'value_avg'],
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: 5000,
    }).catch(() => [])
    for (const r of rows || []) {
      const iid = String(r.itemid)
      if (!byItem[iid]) byItem[iid] = []
      byItem[iid].push({ clock: Number(r.clock), value: Number(r.value_avg) })
    }
  })
  return byItem
}

async function fetchHistorySeries(zabbixRpc, itemEntries, from, to) {
  const byItem = {}
  const byKind = new Map()
  for (const e of itemEntries) {
    const hk = historyKind(e.value_type)
    if (!hk) continue
    if (!byKind.has(hk.history)) byKind.set(hk.history, [])
    byKind.get(hk.history).push(e)
  }
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
        time_from: from,
        time_till: to,
        output: ['itemid', 'clock', 'value'],
        sortfield: 'clock',
        sortorder: 'ASC',
        limit: 15000,
      }).catch(() => [])
      for (const r of rows || []) {
        const iid = String(r.itemid)
        if (!byItem[iid]) byItem[iid] = []
        byItem[iid].push({ clock: Number(r.clock), value: Number(r.value) })
      }
    })
  }
  return byItem
}

/** History-first for short spans, trend-first for long spans — with fallback per item. */
async function fetchSeriesForRange(zabbixRpc, itemEntries, fromSec, toSec, { historyOnly = false } = {}) {
  if (!itemEntries.length) return { byItem: {}, source: 'none' }
  if (historyOnly) {
    const byItem = await fetchHistoryDayChunked(zabbixRpc, itemEntries, fromSec, toSec)
    return { byItem, source: 'history' }
  }
  const span = toSec - fromSec
  const preferTrend = span > 2 * 86400
  const primary = preferTrend
    ? await fetchTrendSeries(zabbixRpc, itemEntries, fromSec, toSec)
    : await fetchHistorySeries(zabbixRpc, itemEntries, fromSec, toSec)
  const byItem = { ...primary }
  const missing = itemEntries.filter((e) => !(byItem[String(e.itemid)]?.length))
  if (missing.length) {
    const fallback = preferTrend
      ? await fetchHistorySeries(zabbixRpc, missing, fromSec, toSec)
      : await fetchTrendSeries(zabbixRpc, missing, fromSec, toSec)
    for (const [iid, pts] of Object.entries(fallback || {})) {
      if (!byItem[iid]?.length && pts?.length) byItem[iid] = pts
    }
  }
  const usedTrend = itemEntries.filter((e) => {
    const iid = String(e.itemid)
    const pts = byItem[iid]
    if (!pts?.length) return false
    if (preferTrend) return primary[iid]?.length > 0
    return !primary[iid]?.length
  }).length
  const source = usedTrend > itemEntries.length / 2 ? 'trend' : 'history'
  return { byItem, source }
}

/** Raw history only, day-chunked for full-range coverage (latency/jitter batches). */
async function fetchHistoryDayChunked(zabbixRpc, itemEntries, fromSec, toSec) {
  const byItem = {}
  const DAY_SEC = 86400
  const chunks = []
  for (let i = 0; i < itemEntries.length; i += HISTORY_CHUNK) {
    chunks.push(itemEntries.slice(i, i + HISTORY_CHUNK))
  }
  await mapConcurrent(chunks, async (entryChunk) => {
    const byKind = new Map()
    for (const e of entryChunk) {
      const hk = historyKind(e.value_type)
      if (!hk) continue
      if (!byKind.has(hk.history)) byKind.set(hk.history, [])
      byKind.get(hk.history).push(e)
    }
    for (const [historyType, entries] of byKind) {
      const itemids = entries.map((e) => String(e.itemid))
      for (let dayStart = fromSec; dayStart < toSec; dayStart += DAY_SEC) {
        const dayEnd = Math.min(dayStart + DAY_SEC, toSec)
        const rows = await zabbixRpc('history.get', {
          history: historyType,
          itemids,
          time_from: dayStart,
          time_till: dayEnd,
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
      }
    }
  })
  for (const pts of Object.values(byItem)) {
    pts.sort((a, b) => a.clock - b.clock)
  }
  return byItem
}

/** One item per request, day-chunked — avoids history.get truncation when batching many hosts. */
async function fetchUptimeHistoryPerItem(zabbixRpc, itemEntries, fromSec, toSec) {
  const byItem = {}
  const DAY_SEC = 86400
  const tasks = []
  for (const entry of itemEntries) {
    const hk = historyKind(entry.value_type)
    if (!hk) continue
    for (let dayStart = fromSec; dayStart < toSec; dayStart += DAY_SEC) {
      const dayEnd = Math.min(dayStart + DAY_SEC, toSec)
      tasks.push({ entry, hk, dayStart, dayEnd })
    }
  }
  await mapConcurrent(tasks, async ({ entry, hk, dayStart, dayEnd }) => {
    const iid = String(entry.itemid)
    const rows = await zabbixRpc('history.get', {
      history: hk.history,
      itemids: [iid],
      time_from: dayStart,
      time_till: dayEnd,
      output: ['itemid', 'clock', 'value'],
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: 50000,
    }).catch(() => [])
    for (const r of rows || []) {
      if (!byItem[iid]) byItem[iid] = []
      byItem[iid].push({ clock: Number(r.clock), value: Number(r.value) })
    }
  }, 8)
  for (const pts of Object.values(byItem)) {
    pts.sort((a, b) => a.clock - b.clock)
  }
  return byItem
}

function clipSpanSec(rangeFrom, rangeTo, spanFrom, spanTo) {
  return Math.max(0, Math.min(rangeTo, spanTo) - Math.max(rangeFrom, spanFrom))
}

/** Total seconds of [fromTs, toTs) inside BH (matches Custom Dashboard bhSecondsInRange). */
function bhSecondsInRange(fromTs, toTs, bh, tzOffsetMin = IST_OFFSET_MIN) {
  if (toTs <= fromTs) return 0
  if (!bh?.enabled) return toTs - fromTs
  const bhStartSec = (Number(bh.start) || 0) * 3600
  const bhEndSec = (Number(bh.end) || 0) * 3600
  const bhDays = new Set(bh.days || [])
  let total = 0
  const first = dayBounds(fromTs, tzOffsetMin)
  for (let cursor = first.start; cursor < toTs; cursor += 86400) {
    const d = dayBounds(cursor, tzOffsetMin)
    const offSec = tzOffsetMin * 60
    const dayDate = new Date((d.start + offSec) * 1000)
    const dow = dayDate.getUTCDay()
    if (bhDays.size && !bhDays.has(dow)) continue
    if (bhEndSec <= bhStartSec) {
      total += clipSpanSec(fromTs, toTs, cursor, cursor + bhEndSec)
      total += clipSpanSec(fromTs, toTs, cursor + bhStartSec, cursor + 86400)
    } else {
      total += clipSpanSec(fromTs, toTs, cursor + bhStartSec, cursor + bhEndSec)
    }
  }
  return total
}

function dayBounds(epochSec, tzOffsetMin = IST_OFFSET_MIN) {
  const offSec = tzOffsetMin * 60
  const local = epochSec + offSec
  const startLocal = Math.floor(local / 86400) * 86400
  return {
    start: startLocal - offSec,
    end: startLocal - offSec + 86400,
  }
}

/** Seconds of [fromTs, toTs) that fall inside business hours when BH is enabled. */
function bhClippedSpanSec(fromTs, toTs, bh, tzOffsetMin = IST_OFFSET_MIN) {
  if (toTs <= fromTs) return 0
  if (!bh?.enabled) return toTs - fromTs
  return bhSecondsInRange(fromTs, toTs, bh, tzOffsetMin)
}

const UPTIME_GAP_THRESHOLD_SEC = 240

/**
 * Downtime from system.uptime — same heuristics as Custom Dashboard
 * (reboots, reporting gaps, BH-clipped when enabled).
 */
function computeUptimeDowntime(points, fromSec, toSec, bh, tzOffsetMin) {
  const inRange = [...(points || [])]
    .filter((p) => Number.isFinite(p.clock) && Number.isFinite(p.value))
    .filter((p) => p.clock >= fromSec && p.clock <= toSec)
    .sort((a, b) => a.clock - b.clock)

  if (!inRange.length) {
    return { downtimeMin: 0, downtimeSec: 0, pointCount: 0 }
  }

  let downSec = 0
  if (inRange[0].clock - fromSec > UPTIME_GAP_THRESHOLD_SEC) {
    downSec += bhClippedSpanSec(fromSec, inRange[0].clock, bh, tzOffsetMin)
  }
  for (let i = 1; i < inRange.length; i++) {
    const prev = inRange[i - 1]
    const cur = inRange[i]
    const gap = cur.clock - prev.clock
    if (cur.value < prev.value) {
      const bootAt = cur.clock - cur.value
      const at = bootAt > prev.clock ? bootAt : cur.clock
      if (at > prev.clock) downSec += bhClippedSpanSec(prev.clock, at, bh, tzOffsetMin)
    } else if (gap > UPTIME_GAP_THRESHOLD_SEC) {
      downSec += bhClippedSpanSec(prev.clock, cur.clock, bh, tzOffsetMin)
    }
  }
  if (toSec - inRange[inRange.length - 1].clock > UPTIME_GAP_THRESHOLD_SEC) {
    downSec += bhClippedSpanSec(inRange[inRange.length - 1].clock, toSec, bh, tzOffsetMin)
  }

  return {
    downtimeMin: Math.round((downSec / 60) * 10) / 10,
    downtimeSec: Math.round(downSec),
    pointCount: inRange.length,
  }
}

function filterPointsBusinessHours(points, fromSec, toSec, bh, tzOffsetMin) {
  if (!bh?.enabled) {
    return (points || []).filter((p) => {
      const clock = Number(p.clock)
      return Number.isFinite(clock) && clock >= fromSec && clock <= toSec
    })
  }
  const days = enumerateDays(fromSec, toSec, tzOffsetMin)
  return (points || []).filter((p) => {
    const clock = Number(p.clock)
    if (!Number.isFinite(clock)) return false
    for (const day of days) {
      if (clock >= day.start && clock < day.end) {
        return inBhDay(clock, day.start, bh, tzOffsetMin)
      }
    }
    return false
  })
}

function meanFromPoints(points) {
  const vals = (points || []).map((p) => Number(p.value)).filter((v) => Number.isFinite(v) && v >= 0)
  if (!vals.length) return { avgMs: null, pointCount: 0 }
  return {
    avgMs: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
    pointCount: vals.length,
  }
}

function buildMetricMap(hostMap, itemByHost, seriesByItem, fromSec, toSec, bh, tzOffsetMin, metric) {
  const map = {}
  for (const [hid, host] of Object.entries(hostMap || {})) {
    const it = itemByHost[hid]
    if (!it) continue
    const raw = seriesByItem[String(it.itemid)] || []
    if (metric === 'downtime') {
      const { downtimeMin, downtimeSec, pointCount } = computeUptimeDowntime(raw, fromSec, toSec, bh, tzOffsetMin)
      if (downtimeSec <= 0 && pointCount === 0) continue
      map[hid] = {
        hostid: hid,
        host: host.host,
        name: host.name || host.host,
        downtimeMin,
        downtimeSec,
        pointCount,
      }
      continue
    }
    const inBh = filterPointsBusinessHours(raw, fromSec, toSec, bh, tzOffsetMin)
    const { avgMs, pointCount } = meanFromPoints(inBh)
    if (avgMs == null) continue
    map[hid] = {
      hostid: hid,
      host: host.host,
      name: host.name || host.host,
      value: avgMs,
      pointCount,
    }
  }
  return map
}

function buildProblematicRows(latencyMap, jitterMap, downtimeMap, limit) {
  const hostids = new Set([
    ...Object.keys(latencyMap || {}),
    ...Object.keys(jitterMap || {}),
    ...Object.keys(downtimeMap || {}),
  ])
  const rows = []
  for (const hid of hostids) {
    const lat = latencyMap[hid]
    const jit = jitterMap[hid]
    const down = downtimeMap[hid]
    const downtimeMin = down?.downtimeMin ?? 0
    const downtimeSec = down?.downtimeSec ?? Math.round(downtimeMin * 60)
    const latencyMs = lat?.value ?? null
    const jitterMs = jit?.value ?? null
    if (downtimeSec <= 0 && downtimeMin <= 0 && latencyMs == null && jitterMs == null) continue
    const score = (downtimeMin * 10) + (latencyMs ?? 0) * 0.3 + (jitterMs ?? 0) * 1.5
    rows.push({
      hostid: hid,
      host: lat?.host || jit?.host || down?.host,
      name: lat?.name || jit?.name || down?.name,
      downtimeMin,
      downtimeSec,
      latencyMs,
      jitterMs,
      meanLatencyMs: latencyMs,
      meanJitterMs: jitterMs,
      latencyPoints: lat?.pointCount ?? 0,
      jitterPoints: jit?.pointCount ?? 0,
      downtimePoints: down?.pointCount ?? 0,
      score: Math.round(score * 10) / 10,
    })
  }
  rows.sort((a, b) => b.score - a.score)
  const top = rows.slice(0, limit)
  const maxScore = top[0]?.score || 1
  for (const r of top) {
    r.percent = Math.round((r.score / maxScore) * 1000) / 10
  }
  return top
}

function buildTopRows(hostMap, itemByHost, seriesByItem, fromSec, toSec, bh, tzOffsetMin, limit) {
  const rows = []
  for (const [hid, host] of Object.entries(hostMap || {})) {
    const it = itemByHost[hid]
    if (!it) continue
    const raw = seriesByItem[String(it.itemid)] || []
    const inBh = filterPointsBusinessHours(raw, fromSec, toSec, bh, tzOffsetMin)
    const { avgMs, pointCount } = meanFromPoints(inBh)
    if (avgMs == null) continue
    rows.push({
      hostid: hid,
      host: host.host,
      name: host.name || host.host,
      itemid: String(it.itemid),
      itemName: it.name || it.key_,
      key: it.key_ || '',
      value: avgMs,
      pointCount,
    })
  }
  rows.sort((a, b) => b.value - a.value)
  const top = rows.slice(0, limit)
  const maxVal = top[0]?.value || 1
  for (const r of top) {
    r.percent = Math.round((r.value / maxVal) * 1000) / 10
  }
  return top
}

function parseRange(query, nowSec) {
  const range = String(query.range || '7d').toLowerCase()
  const customFromSec = parseInt(String(query.from || ''), 10)
  const customToSec = parseInt(String(query.to || ''), 10)
  if (Number.isFinite(customFromSec) && Number.isFinite(customToSec) && customToSec > customFromSec) {
    return { fromSec: customFromSec, toSec: customToSec, rangeLabel: 'custom' }
  }
  const span = ({
    '24h': 86_400,
    '1d': 86_400,
    'today': 86_400,
    '7d': 7 * 86_400,
    '14d': 14 * 86_400,
    '30d': 30 * 86_400,
  })[range] || 7 * 86_400
  return { fromSec: nowSec - span, toSec: nowSec, rangeLabel: range }
}

/**
 * @param {object} opts
 * @param {Function} opts.zabbixRpc
 * @param {Function} opts.resolveMonitoredHostsForGroup — (groupName) => { hostMap, hostids, groupFilter }
 */
export async function fetchRoDashboardNetworkTop(opts) {
  const zabbixRpc = opts.zabbixRpc
  const resolveHosts = opts.resolveMonitoredHostsForGroup
  const nowSec = Math.floor(Date.now() / 1000)
  const { fromSec, toSec, rangeLabel } = parseRange(opts.query || {}, nowSec)
  const limit = Math.min(Math.max(parseInt(String(opts.query?.limit || '30'), 10) || 30, 1), 50)
  const groupFilter = String(opts.query?.group || '').trim()
  const bizStart = Math.min(23, Math.max(0, parseInt(String(opts.query?.bizStart ?? '9'), 10) || 9))
  const bizEnd = Math.min(24, Math.max(0, parseInt(String(opts.query?.bizEnd ?? '21'), 10) || 21))
  const bizEnabled = !['0', 'false', 'off', 'no'].includes(String(opts.query?.bizEnabled ?? '1').toLowerCase())
  const tzOffsetMinutes = parseInt(String(opts.query?.tzOffset ?? String(IST_OFFSET_MIN)), 10) || IST_OFFSET_MIN
  const bizDaysRaw = String(opts.query?.bizDays ?? '0,1,2,3,4,5,6')
  const weekdays = bizDaysRaw.split(',').map((d) => parseInt(d.trim(), 10)).filter((d) => Number.isFinite(d) && d >= 0 && d <= 6)
  const bh = {
    enabled: bizEnabled,
    start: bizStart,
    end: bizEnd,
    days: weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6],
  }

  const key = cacheKey({ groupFilter, fromSec, toSec, limit, bizEnabled, bizStart, bizEnd, tzOffsetMinutes, weekdays })
  const hit = _cache.get(key)
  if (hit && Date.now() - hit.at < REPORT_CACHE_MS) return hit.data

  const { hostMap, hostids, groupFilter: resolvedGroup } = await resolveHosts(groupFilter)
  if (!hostids.length) {
    const empty = {
      groupFilter: resolvedGroup,
      window: { from: fromSec, to: toSec, rangeLabel, fromAt: formatPortalTimestamp(fromSec * 1000), toAt: formatPortalTimestamp(toSec * 1000) },
      businessHours: { enabled: bizEnabled, startHour: bizStart, endHour: bizEnd, tzOffsetMinutes, weekdays: bh.days, label: bizEnabled ? `${String(bizStart).padStart(2, '0')}:00–${String(bizEnd).padStart(2, '0')}:00` : 'OFF (24/7)' },
      limit,
      latency: [],
      jitter: [],
      problematic: [],
      note: 'No hosts in scope.',
    }
    _cache.set(key, { at: Date.now(), data: empty })
    return empty
  }

  const [latencyItems, jitterItems, uptimeItems] = await Promise.all([
    fetchItemsChunked(zabbixRpc, hostids, 'custom.ping.ms'),
    fetchItemsChunked(zabbixRpc, hostids, 'custom.ping.jitter'),
    fetchItemsChunked(zabbixRpc, hostids, 'system.uptime'),
  ])

  const latencyByHost = pickItemPerHost(latencyItems, '8.8.8.8')
  const jitterByHost = pickItemPerHost(jitterItems, '8.8.8.8')
  const uptimeByHost = pickItemPerHost(uptimeItems, 'system.uptime')
  const latencyEntries = Object.values(latencyByHost)
  const jitterEntries = Object.values(jitterByHost)
  const uptimeEntries = Object.values(uptimeByHost)

  const windowSec = toSec - fromSec

  const [latencyFetch, jitterFetch] = await Promise.all([
    fetchSeriesForRange(zabbixRpc, latencyEntries, fromSec, toSec),
    fetchSeriesForRange(zabbixRpc, jitterEntries, fromSec, toSec),
  ])
  const uptimeSeries = await fetchUptimeHistoryPerItem(zabbixRpc, uptimeEntries, fromSec, toSec)
  const latencySeries = latencyFetch.byItem
  const jitterSeries = jitterFetch.byItem

  const latencyMap = buildMetricMap(hostMap, latencyByHost, latencySeries, fromSec, toSec, bh, tzOffsetMinutes, 'latency')
  const jitterMap = buildMetricMap(hostMap, jitterByHost, jitterSeries, fromSec, toSec, bh, tzOffsetMinutes, 'jitter')
  const downtimeMap = buildMetricMap(hostMap, uptimeByHost, uptimeSeries, fromSec, toSec, bh, tzOffsetMinutes, 'downtime')

  const latency = buildTopRows(hostMap, latencyByHost, latencySeries, fromSec, toSec, bh, tzOffsetMinutes, limit)
  const jitter = buildTopRows(hostMap, jitterByHost, jitterSeries, fromSec, toSec, bh, tzOffsetMinutes, limit)
  const problematic = buildProblematicRows(latencyMap, jitterMap, downtimeMap, limit)

  const data = {
    groupFilter: resolvedGroup,
    window: {
      from: fromSec,
      to: toSec,
      rangeLabel,
      rangeSec: windowSec,
      fromAt: formatPortalTimestamp(fromSec * 1000),
      toAt: formatPortalTimestamp(toSec * 1000),
    },
    businessHours: {
      enabled: bizEnabled,
      startHour: bizStart,
      endHour: bizEnd,
      tzOffsetMinutes,
      weekdays: bh.days,
      label: bizEnabled ? `${String(bizStart).padStart(2, '0')}:00–${String(bizEnd).padStart(2, '0')}:00` : 'OFF (24/7)',
    },
    limit,
    latency,
    jitter,
    problematic,
    summary: {
      hostsInScope: hostids.length,
      latencyRanked: latency.length,
      jitterRanked: jitter.length,
      problematicRanked: problematic.length,
      source: latencyFetch.source || jitterFetch.source || 'history',
    },
    sampledAt: nowSec,
  }

  _cache.set(key, { at: Date.now(), data })
  return data
}
