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
        limit: 10000,
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

function filterPointsBusinessHours(points, fromSec, toSec, bh, tzOffsetMin) {
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
  const tzOffsetMinutes = parseInt(String(opts.query?.tzOffset ?? String(IST_OFFSET_MIN)), 10) || IST_OFFSET_MIN
  const bizDaysRaw = String(opts.query?.bizDays ?? '0,1,2,3,4,5,6')
  const weekdays = bizDaysRaw.split(',').map((d) => parseInt(d.trim(), 10)).filter((d) => Number.isFinite(d) && d >= 0 && d <= 6)
  const bh = {
    enabled: true,
    start: bizStart,
    end: bizEnd,
    days: weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6],
  }

  const key = cacheKey({ groupFilter, fromSec, toSec, limit, bizStart, bizEnd, tzOffsetMinutes, weekdays })
  const hit = _cache.get(key)
  if (hit && Date.now() - hit.at < REPORT_CACHE_MS) return hit.data

  const { hostMap, hostids, groupFilter: resolvedGroup } = await resolveHosts(groupFilter)
  if (!hostids.length) {
    const empty = {
      groupFilter: resolvedGroup,
      window: { from: fromSec, to: toSec, rangeLabel, fromAt: formatPortalTimestamp(fromSec * 1000), toAt: formatPortalTimestamp(toSec * 1000) },
      businessHours: { startHour: bizStart, endHour: bizEnd, tzOffsetMinutes, weekdays: bh.days },
      limit,
      latency: [],
      jitter: [],
      note: 'No hosts in scope.',
    }
    _cache.set(key, { at: Date.now(), data: empty })
    return empty
  }

  const [latencyItems, jitterItems] = await Promise.all([
    fetchItemsChunked(zabbixRpc, hostids, 'custom.ping.ms'),
    fetchItemsChunked(zabbixRpc, hostids, 'custom.ping.jitter'),
  ])

  const latencyByHost = pickItemPerHost(latencyItems, '8.8.8.8')
  const jitterByHost = pickItemPerHost(jitterItems, '8.8.8.8')
  const latencyEntries = Object.values(latencyByHost)
  const jitterEntries = Object.values(jitterByHost)

  const windowSec = toSec - fromSec
  const useTrends = windowSec >= 3600

  const [latencySeries, jitterSeries] = await Promise.all([
    useTrends
      ? fetchTrendSeries(zabbixRpc, latencyEntries, fromSec, toSec)
      : fetchHistorySeries(zabbixRpc, latencyEntries, fromSec, toSec),
    useTrends
      ? fetchTrendSeries(zabbixRpc, jitterEntries, fromSec, toSec)
      : fetchHistorySeries(zabbixRpc, jitterEntries, fromSec, toSec),
  ])

  const latency = buildTopRows(hostMap, latencyByHost, latencySeries, fromSec, toSec, bh, tzOffsetMinutes, limit)
  const jitter = buildTopRows(hostMap, jitterByHost, jitterSeries, fromSec, toSec, bh, tzOffsetMinutes, limit)

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
      startHour: bizStart,
      endHour: bizEnd,
      tzOffsetMinutes,
      weekdays: bh.days,
      label: `${String(bizStart).padStart(2, '0')}:00–${String(bizEnd).padStart(2, '0')}:00`,
    },
    limit,
    latency,
    jitter,
    summary: {
      hostsInScope: hostids.length,
      latencyRanked: latency.length,
      jitterRanked: jitter.length,
      source: useTrends ? 'trend' : 'history',
    },
    sampledAt: nowSec,
  }

  _cache.set(key, { at: Date.now(), data })
  return data
}
