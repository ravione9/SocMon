/**
 * Fleet-wide RP store health from Store Zabbix session history.
 * Covers all hosts in the Zabbix "RP" host group in batched API calls
 * (custom.ping.ms[8.8.8.8], custom.ping.loss, system.uptime).
 */
import { ZABBIX_HOST_FETCH_MAX } from './zabbixHostFetch.js'
import { formatPortalTimestamp } from '../utils/portalTimestamp.js'

const REPORT_CACHE_MS = 60_000
const _cache = new Map()

const DEFAULT_LATENCY_MS = 50
const ITEM_CHUNK = 400
const HISTORY_CHUNK = 50
const HISTORY_CONCURRENCY = 6

function cacheKey(opts) {
  return JSON.stringify({
    g: opts.groupName,
    f: opts.fromSec,
    t: opts.toSec,
    l: opts.latencyThresholdMs,
  })
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

async function resolveGroupHosts(zabbixRpc, groupName) {
  const name = String(groupName || 'RP').trim() || 'RP'
  let groups = await zabbixRpc('hostgroup.get', {
    output: ['groupid', 'name'],
    filter: { name },
  }).catch(() => [])
  if (!groups?.length) {
    groups = await zabbixRpc('hostgroup.get', {
      output: ['groupid', 'name'],
      search: { name },
      searchWildcardsEnabled: true,
    }).catch(() => [])
    groups = (groups || []).filter((g) => String(g.name || '').toLowerCase() === name.toLowerCase())
  }
  if (!groups?.length) {
    return { groupFound: false, groupName: name, hosts: [] }
  }
  const hosts = await zabbixRpc('host.get', {
    groupids: groups.map((g) => g.groupid),
    monitored_hosts: true,
    output: ['hostid', 'host', 'name'],
    sortfield: 'name',
    limit: ZABBIX_HOST_FETCH_MAX,
  }).catch(() => [])
  return {
    groupFound: true,
    groupName: groups[0].name || name,
    hosts: hosts || [],
  }
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
      output: ['itemid', 'clock', 'value_avg', 'value_max', 'value_min'],
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: 5000,
    }).catch(() => [])
    for (const r of rows || []) {
      const iid = String(r.itemid)
      if (!byItem[iid]) byItem[iid] = []
      byItem[iid].push({
        clock: Number(r.clock),
        avg: Number(r.value_avg),
        max: Number(r.value_max),
        min: Number(r.value_min),
      })
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

function statsFromTrend(points) {
  const vals = (points || []).map((p) => p.avg).filter(Number.isFinite)
  const maxs = (points || []).map((p) => p.max).filter(Number.isFinite)
  if (!vals.length) return { avgMs: null, maxMs: null, pointCount: 0, source: 'trend' }
  const avgMs = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
  const maxMs = Math.round(Math.max(...maxs) * 10) / 10
  return { avgMs, maxMs, pointCount: vals.length, source: 'trend' }
}

function statsFromHistory(points) {
  const vals = (points || []).map((p) => p.value).filter(Number.isFinite)
  if (!vals.length) return { avgMs: null, maxMs: null, pointCount: 0, source: 'history' }
  const avgMs = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
  const maxMs = Math.round(Math.max(...vals) * 10) / 10
  return { avgMs, maxMs, pointCount: vals.length, source: 'history' }
}

function detectUptimeResets(points) {
  const sorted = [...(points || [])].sort((a, b) => a.clock - b.clock)
  let resets = 0
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].value
    const curr = sorted[i].value
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue
    if (curr < prev * 0.5 || (prev - curr) > 300) resets++
  }
  return resets
}

function estimateIssueMinutes(latencyStats, lossStats, windowSec) {
  const latSpike = latencyStats.maxMs > DEFAULT_LATENCY_MS
    || (latencyStats.avgMs != null && latencyStats.avgMs > DEFAULT_LATENCY_MS)
  const lossIssue = (lossStats.maxPct != null && lossStats.maxPct > 0)
    || (lossStats.avgPct != null && lossStats.avgPct > 0)
  if (!latSpike && !lossIssue) return 0
  const pollMin = Math.max(5, Math.round(windowSec / Math.max(latencyStats.pointCount || lossStats.pointCount || 1, 1) / 60))
  return Math.min(windowSec / 60, pollMin * Math.max(1, latencyStats.pointCount || 1))
}

/**
 * @param {object} opts
 * @param {Function} opts.zabbixRpc
 * @param {number} opts.fromSec
 * @param {number} opts.toSec
 * @param {string} [opts.groupName]
 * @param {number} [opts.latencyThresholdMs]
 */
export async function fetchRpFleetHealthReport(opts) {
  const fromSec = Number(opts.fromSec)
  const toSec = Number(opts.toSec)
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) {
    const err = new Error('Invalid from/to unix bounds')
    err.code = 'INVALID_WINDOW'
    throw err
  }
  const groupName = String(opts.groupName || 'RP').trim() || 'RP'
  const latencyThresholdMs = Number(opts.latencyThresholdMs) || DEFAULT_LATENCY_MS
  const key = cacheKey({ groupName, fromSec, toSec, latencyThresholdMs })
  const hit = _cache.get(key)
  if (hit && Date.now() - hit.at < REPORT_CACHE_MS) return hit.data

  const { groupFound, hosts } = await resolveGroupHosts(opts.zabbixRpc, groupName)
  const hostMap = Object.fromEntries((hosts || []).map((h) => [String(h.hostid), h]))
  const hostids = (hosts || []).map((h) => String(h.hostid))

  if (!groupFound || !hostids.length) {
    const empty = {
      groupFilter: groupName,
      groupFound,
      window: {
        from: fromSec,
        to: toSec,
        fromAt: formatPortalTimestamp(fromSec * 1000),
        toAt: formatPortalTimestamp(toSec * 1000),
        rangeSec: toSec - fromSec,
      },
      summary: {
        totalHosts: 0,
        latencyHighCount: 0,
        networkIssueNoRestartCount: 0,
        uptimeRestartCount: 0,
      },
      report2HighLatency: [],
      report3NetworkNoRestart: [],
      perStore: [],
      diagnostics: { hostsChecked: 0, latencyItemsFound: 0, uptimeItemsFound: 0, lossItemsFound: 0 },
      note: 'No hosts in Zabbix host group.',
    }
    _cache.set(key, { at: Date.now(), data: empty })
    return empty
  }

  const [latencyItems, lossItems, uptimeItems] = await Promise.all([
    fetchItemsChunked(opts.zabbixRpc, hostids, 'custom.ping.ms'),
    fetchItemsChunked(opts.zabbixRpc, hostids, 'custom.ping.loss'),
    fetchItemsChunked(opts.zabbixRpc, hostids, 'system.uptime'),
  ])

  const latencyByHost = pickItemPerHost(latencyItems, '8.8.8.8')
  const lossByHost = pickItemPerHost(lossItems, '8.8.8.8')
  const uptimeByHost = pickItemPerHost(uptimeItems)

  const latencyEntries = Object.values(latencyByHost)
  const lossEntries = Object.values(lossByHost)
  const uptimeEntries = Object.values(uptimeByHost)

  const windowSec = toSec - fromSec
  const useTrends = windowSec >= 3600

  const [latencyTrend, lossTrend, latencyHist, lossHist, uptimeHist] = await Promise.all([
    useTrends ? fetchTrendSeries(opts.zabbixRpc, latencyEntries, fromSec, toSec) : Promise.resolve({}),
    useTrends ? fetchTrendSeries(opts.zabbixRpc, lossEntries, fromSec, toSec) : Promise.resolve({}),
    useTrends ? Promise.resolve({}) : fetchHistorySeries(opts.zabbixRpc, latencyEntries, fromSec, toSec),
    useTrends ? Promise.resolve({}) : fetchHistorySeries(opts.zabbixRpc, lossEntries, fromSec, toSec),
    fetchHistorySeries(opts.zabbixRpc, uptimeEntries, fromSec, toSec),
  ])

  const perStore = []
  const report2HighLatency = []
  const report3NetworkNoRestart = []

  for (const hid of hostids) {
    const h = hostMap[hid]
    const latIt = latencyByHost[hid]
    const lossIt = lossByHost[hid]
    const upIt = uptimeByHost[hid]

    let latencyStats = { avgMs: null, maxMs: null, pointCount: 0, source: null, key: latIt?.key_ || null }
    if (latIt) {
      const iid = String(latIt.itemid)
      if (useTrends && latencyTrend[iid]?.length) {
        latencyStats = { ...statsFromTrend(latencyTrend[iid]), key: latIt.key_ || '' }
      } else if (latencyHist[iid]?.length) {
        latencyStats = { ...statsFromHistory(latencyHist[iid]), key: latIt.key_ || '' }
      }
    }

    let lossStats = { avgPct: null, maxPct: null, pointCount: 0, source: null }
    if (lossIt) {
      const iid = String(lossIt.itemid)
      if (useTrends && lossTrend[iid]?.length) {
        const s = statsFromTrend(lossTrend[iid])
        lossStats = { avgPct: s.avgMs, maxPct: s.maxMs, pointCount: s.pointCount, source: 'trend' }
      } else if (lossHist[iid]?.length) {
        const s = statsFromHistory(lossHist[iid])
        lossStats = { avgPct: s.avgMs, maxPct: s.maxMs, pointCount: s.pointCount, source: 'history' }
      }
    }

    const uptimeResets = upIt
      ? detectUptimeResets(uptimeHist[String(upIt.itemid)])
      : 0

    const highLatency = (latencyStats.avgMs != null && latencyStats.avgMs > latencyThresholdMs)
      || (latencyStats.maxMs != null && latencyStats.maxMs > latencyThresholdMs)
    const networkProblem = highLatency
      || (lossStats.maxPct != null && lossStats.maxPct > 0)
      || (lossStats.avgPct != null && lossStats.avgPct > 0)
    const networkIssueNoRestart = networkProblem && uptimeResets === 0

    const row = {
      hostid: hid,
      name: h?.name || h?.host || hid,
      host: h?.host || null,
      avgMs: latencyStats.avgMs,
      maxMs: latencyStats.maxMs,
      latencyKey: latencyStats.key,
      latencySource: latencyStats.source,
      avgLossPct: lossStats.avgPct,
      maxLossPct: lossStats.maxPct,
      uptimeResets,
      uptimeMonotonic: uptimeResets === 0,
      networkIssueNoRestart,
      highLatency,
    }
    perStore.push(row)

    if (highLatency) {
      report2HighLatency.push({
        hostname: row.name,
        avgMs: row.avgMs,
        maxMs: row.maxMs,
        itemKey: row.latencyKey || 'custom.ping.ms[8.8.8.8]',
      })
    }
    if (networkIssueNoRestart) {
      const issueParts = []
      if (highLatency) issueParts.push(`latency>${latencyThresholdMs}ms`)
      if (lossStats.maxPct > 0) issueParts.push(`loss ${lossStats.maxPct}%`)
      report3NetworkNoRestart.push({
        hostname: row.name,
        networkIssue: issueParts.join(', ') || 'network',
        uptimeStatus: 'continuous',
        estDurationMin: Math.round(estimateIssueMinutes(latencyStats, lossStats, windowSec)),
        uptimeResets: 0,
      })
    }
  }

  report2HighLatency.sort((a, b) => (b.maxMs ?? 0) - (a.maxMs ?? 0))
  report3NetworkNoRestart.sort((a, b) => (b.estDurationMin ?? 0) - (a.estDurationMin ?? 0))

  const data = {
    groupFilter: groupName,
    groupFound: true,
    window: {
      from: fromSec,
      to: toSec,
      fromAt: formatPortalTimestamp(fromSec * 1000),
      toAt: formatPortalTimestamp(toSec * 1000),
      rangeSec: windowSec,
    },
    latencyThresholdMs,
    summary: {
      totalHosts: hostids.length,
      latencyHighCount: report2HighLatency.length,
      networkIssueNoRestartCount: report3NetworkNoRestart.length,
      uptimeRestartCount: perStore.filter((r) => r.uptimeResets > 0).length,
    },
    report2HighLatency,
    report3NetworkNoRestart,
    perStore,
    diagnostics: {
      hostsChecked: hostids.length,
      latencyItemsFound: latencyEntries.length,
      lossItemsFound: lossEntries.length,
      uptimeItemsFound: uptimeEntries.length,
      historyMode: useTrends ? 'trend.get (hourly)' : 'history.get',
    },
    note: 'Store Zabbix fleet report — custom.ping.ms[8.8.8.8] + system.uptime. Use with rop-uptime for Report 1 restarts.',
  }
  _cache.set(key, { at: Date.now(), data })
  return data
}
