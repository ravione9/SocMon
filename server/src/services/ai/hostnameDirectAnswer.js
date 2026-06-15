import StoreProblemHistory from '../../models/StoreProblemHistory.js'
import {
  isInfluxStoreConfigured,
  fetchStoreSnapshot,
  fetchStoreHistory,
  fetchCrashSummary,
  crashTypeLabel,
} from '../influxStore.js'
import { getProblemSnapshotStatus } from '../storeProblemSnapshotter.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'
import {
  extractStoreCode,
  extractStoreHostname,
  formatRangeLabelFromInflux,
  isHostnameDataRequest,
  isStoreHostnamePortalQuery,
  parseQuestionTimeRange,
  resolveCrashQueryWindow,
  shouldUseStoreCodeAlias,
} from './queryContext.js'
import { isNetworkInfraQuery, isZabbixQuestion, buildStoreZabbixContext } from './zabbixDirectAnswer.js'

import {
  fetchHostnameEnvironments,
  formatEnvironmentSections,
} from './environmentDataFetcher.js'

const DETAIL_MARKERS = /\b(complete details|full details|all environ|all data|full data|give me all|give me.*details|details of|everything about|store details|health of|status of|history of|this hostname|usb|threat|sentinel|firewall|soc|noc)\b/i

function rangeToSeconds(range) {
  const m = /^-(\d+)([smhd])$/i.exec(String(range || ''))
  if (!m) return 6 * 3600
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()] || 3600
  return Number(m[1]) * mult
}

function hostnameMatchesStore(store, hostname) {
  const h = String(hostname || '').toLowerCase()
  const sh = String(store?.hostname || '').toLowerCase()
  const tag = String(store?.storeTag || '').toLowerCase()
  if (sh === h || sh.includes(h) || tag.includes(h) || tag.startsWith(`${h}_`)) return true
  if (!shouldUseStoreCodeAlias(hostname)) return false
  // Alias matching: LKST973/LK973 should match RP973-* (same store code).
  const queryCode = extractStoreCode(hostname)
  if (!queryCode) return false
  const hostCode = extractStoreCode(store?.hostname || '')
  const tagCode = extractStoreCode(store?.storeTag || '')
  return queryCode === hostCode || queryCode === tagCode
}

function summarizeHistory(history) {
  const stats = []
  for (const series of history?.series || []) {
    const vals = series.points.map(p => p.value).filter(v => Number.isFinite(v))
    if (!vals.length) continue
    stats.push({
      name: series.name,
      latest: vals[vals.length - 1],
      min: Math.min(...vals),
      max: Math.max(...vals),
      samples: vals.length,
      points: series.points,
    })
  }
  return stats.slice(0, 12)
}

function downsampleValues(points, maxPoints = 64) {
  const vals = (points || []).map(p => p.value).filter(v => Number.isFinite(v))
  if (vals.length <= maxPoints) return vals
  const step = Math.ceil(vals.length / maxPoints)
  const out = []
  for (let i = 0; i < vals.length; i += step) out.push(vals[i])
  return out
}

function formatSeriesLabel(name) {
  const n = String(name || '')
  const target = n.match(/\(([^)]+)\)/)?.[1]
  if (n.includes('average_response_ms')) return target ? `Ping avg (${target})` : 'Ping avg'
  if (n.includes('packet_loss')) return target ? `Packet loss (${target})` : 'Packet loss'
  if (n.includes('cpu_usage')) return 'CPU %'
  if (n.includes('mem_used')) return 'Memory %'
  if (n.includes('download_mbps')) return 'Download Mbps'
  if (n.includes('upload_mbps')) return 'Upload Mbps'
  if (n.includes('conn_state')) return 'Connection state'
  return n.replace(/^connectivity\./, '').replace(/^ping\./, 'Ping ').replace(/^system\./, '').replace(/^speedtest\./, 'Speed ')
}

function buildChartSeries(historyStats) {
  return historyStats.slice(0, 8).map((s, i) => ({
    id: `${i}-${s.name}`,
    name: s.name,
    label: formatSeriesLabel(s.name),
    latest: s.latest,
    min: s.min,
    max: s.max,
    samples: s.samples,
    values: downsampleValues(s.points, 64),
  }))
}

function formatChartSection(historyStats) {
  if (!historyStats.length) {
    return ['', 'No metric history available for charting in this window.']
  }
  return [
    '',
    `${Math.min(historyStats.length, 8)} metric series loaded — interactive charts below.`,
    'Open Store Monitor for full history and zoom.',
  ]
}

function formatPing(store) {
  const ping =
    store.ping?.['8.8.8.8']
    || store.ping?.['google.com']
    || Object.values(store.ping || {})[0]
  if (!ping) return null
  const parts = []
  if (ping.avgMs != null) parts.push(`${ping.avgMs} ms avg`)
  if (ping.packetLossPct != null) parts.push(`${ping.packetLossPct}% loss`)
  return parts.join(', ') || null
}

export function isHostnameDetailQuery(question, ctx = null) {
  const q = String(question || '')
  const hostname = extractStoreHostname(question) || ctx?.hostname
  if (hostname && isHostnameDataRequest(q)) return true
  if (isStoreHostnamePortalQuery(q)) return true
  if (isZabbixQuestion(q, ctx) || isNetworkInfraQuery(q)) return false
  if (ctx?.followUpKind === 'chart' && ctx?.priorTopic === 'hostname') return true
  if (/\b(graph|graphical|chart|visual|plot|timeline)\b/i.test(q) && ctx?.priorTopic === 'hostname') return true
  if (!hostname && !(ctx?.isFollowUp && ctx?.priorTopic === 'hostname')) return false
  if (DETAIL_MARKERS.test(q)) return true
  if (ctx?.directHandler === 'hostname') return true
  if (ctx?.isFollowUp && ctx?.priorTopic === 'hostname' && !isZabbixQuestion(q) && !isNetworkInfraQuery(q)) return true
  if (/\b(hostname|host)\b/i.test(q) && /\b(details|detail|info|information)\b/i.test(q)) return true
  return false
}

/**
 * Instant per-hostname report from live Influx + problem tracker — no LLM.
 * @param {string} question
 * @param {string[]} allowedPages
 * @param {ReturnType<import('./queryContext.js').resolveQueryContext>} [ctx]
 */
export async function tryDirectHostnameAnswer(question, allowedPages, ctx = null) {
  if (!isHostnameDetailQuery(question, ctx)) return null
  if (!allowedPages.some(p => ['storeMonitor', 'sentinel', 'soc', 'noc'].includes(p))) return null

  const hostname = extractStoreHostname(question) || ctx?.hostname
  if (!hostname) return null

  const wantsChart =
    ctx?.followUpKind === 'chart'
    || /\b(graph|graphical|chart|visual|plot|timeline)\b/i.test(question)

  const range = ctx?.range || parseQuestionTimeRange(question)
  const crashWindow = resolveCrashQueryWindow(question, ctx)
  const rangeSec = rangeToSeconds(range)
  const rangeLabel = crashWindow.fromSec
    ? (crashWindow.label || formatRangeLabelFromInflux(range))
    : formatRangeLabelFromInflux(range)
  const fetchedAt = new Date().toISOString()
  const fmtTs = (v) => formatPortalTimestamp(v)
  const envOpts = { showEmptyModules: true, maxUsbSamples: 15 }
  const fetchEnv = (storeTag = '') => (wantsChart
    ? Promise.resolve({})
    : fetchHostnameEnvironments(hostname, range, allowedPages, {
      storeTag,
      extendSentinelWindow: true,
      usbSampleSize: 20,
    }))

  const influxOk = isInfluxStoreConfigured() && allowedPages.includes('storeMonitor')

  if (!influxOk) {
    const env = await fetchEnv()
    const lines = [
      `Hostname report — ${hostname} (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
      `Window: ${rangeLabel}`,
      '',
      '── Store Monitor ──',
      '  InfluxDB not configured or no storeMonitor access.',
      ...formatEnvironmentSections(env, rangeLabel, fmtTs, envOpts),
      '',
      '(Direct answer from SocMon live data — no LLM wait.)',
    ]
    return buildHostnameResponse(lines, hostname, range, fetchedAt, env, ctx, {
      storeFound: false,
      store: null,
      crashTotal: 0,
      problemCount: 0,
    })
  }

  const [stores, crashRows, tracker] = await Promise.all([
    fetchStoreSnapshot(10, range),
    wantsChart ? Promise.resolve([]) : fetchCrashSummary(range, crashWindow.fromSec, crashWindow.toSec),
    wantsChart ? Promise.resolve({}) : getProblemSnapshotStatus(),
  ])

  const store = stores.find(s => hostnameMatchesStore(s, hostname))
  const env = await fetchEnv(store?.storeTag || '')

  if (!store) {
    const lines = [
      `Hostname report — ${hostname} (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
      `Window: ${rangeLabel}`,
      '',
      '── Store Monitor (LIVE) ──',
      `  No store agent data in Influx for "${hostname}" in ${rangeLabel}.`,
      ...formatEnvironmentSections(env, rangeLabel, fmtTs, envOpts),
      '',
      '(Direct answer from SocMon live data — no LLM wait.)',
    ]
    return buildHostnameResponse(lines, hostname, range, fetchedAt, env, ctx, {
      storeFound: false,
      store: null,
      crashTotal: 0,
      problemCount: 0,
    })
  }

  const storeTag = store.storeTag || hostname
  const wantsZabbixCm = allowedPages.includes('storeZabbix')
  const [history, problems, storeZabbixCtx] = await Promise.all([
    fetchStoreHistory(storeTag, rangeSec),
    wantsChart
      ? Promise.resolve([])
      : StoreProblemHistory.find({
        $or: [
          { hostname: new RegExp(`^${hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
          { storeTag: new RegExp(hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        ],
      })
        .sort({ lastSeenAt: -1 })
        .limit(100)
        .lean(),
    !wantsZabbixCm
      ? Promise.resolve(null)
      : buildStoreZabbixContext(
        wantsChart ? `${hostname} CPU memory 24h trend graph` : `${hostname} CPU memory`,
      ).catch(() => null),
  ])

  const crashes = wantsChart ? [] : crashRows.filter(r => hostnameMatchesStore(r, hostname))
  const crashTotal = crashes.reduce((n, r) => n + r.totalCrashes, 0)
  const historyStats = summarizeHistory(history)
  const pingLine = formatPing(store)
  const issues = (store.issues || []).map(i => i.message).filter(Boolean)

  if (wantsChart) {
    const chartSeries = buildChartSeries(historyStats)
    const lines = [
      `Metrics chart — ${store.hostname || hostname} (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
      `Window: ${rangeLabel}`,
      `Online: ${store.online ? 'yes' : 'no'} · Connection: ${store.connState || 'unknown'}`,
      ...formatChartSection(historyStats),
      '',
      '(Direct chart from live Influx history — no LLM wait.)',
    ]
    return buildHostnameResponse(lines, hostname, range, fetchedAt, {}, ctx, {
      storeFound: true,
      store,
      crashTotal: 0,
      problemCount: 0,
      historySeries: historyStats.length,
      chartMode: true,
      chartSeries,
    })
  }

  const lines = [
    `Store hostname report — ${store.hostname || hostname} (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    `Window: ${rangeLabel}`,
    '',
    '── Store Monitor (LIVE) ──',
    `Store tag: ${storeTag}`,
    `Serial: ${store.serial || '—'}`,
    `Online: ${store.online ? 'yes' : 'no'}`,
    `Connection: ${store.connState || 'unknown'}`,
    `Last seen: ${store.lastSeen || 'unknown'}`,
    `Gateway: ${store.gatewayVendor || '—'} ${store.gatewayIp || ''}`.trim(),
  ]

  if (store.activeInterface) lines.push(`Active interface: ${store.activeInterface}`)
  if (store.activeSsid) lines.push(`SSID: ${store.activeSsid}`)
  if (pingLine) lines.push(`Ping: ${pingLine}`)
  if (store.cpuPct != null) lines.push(`CPU (store agent): ${store.cpuPct}%`)
  if (store.memPct != null) lines.push(`Memory (store agent): ${store.memPct}%`)

  const zabbixCm = storeZabbixCtx?.cpuMemoryMetricsState
  const zabbixPrimary = zabbixCm?.zabbix?.primary
  if (zabbixPrimary?.cpu?.percent != null) {
    lines.push(`CPU (Zabbix — ${zabbixPrimary.name}): ${zabbixPrimary.cpu.percent}%`)
  }
  if (zabbixPrimary?.memory?.percent != null) {
    lines.push(`Memory (Zabbix — ${zabbixPrimary.name}): ${zabbixPrimary.memory.percent}%`)
  }
  if (store.cpuPct == null && store.memPct == null && !zabbixPrimary?.cpu && !zabbixPrimary?.memory) {
    lines.push('CPU / Memory: not reported by store agent or Zabbix utilization items')
  } else if (store.cpuPct == null && store.memPct == null) {
    lines.push('CPU / Memory (store agent): not reported on last Influx heartbeat')
  }
  if (store.downloadMbps != null) {
    lines.push(`Speedtest: ↓ ${store.downloadMbps} Mbps${store.uploadMbps != null ? ` · ↑ ${store.uploadMbps} Mbps` : ''}`)
  }
  if (issues.length) {
    lines.push('', 'Current issues:')
    for (const msg of issues.slice(0, 8)) lines.push(`  • ${msg}`)
  } else {
    lines.push('', 'Current issues: none detected in live snapshot')
  }

  lines.push('', `── Metrics history (${rangeLabel}) ──`)
  if (historyStats.length) {
    for (const s of historyStats) {
      lines.push(`  • ${s.name}: latest ${s.latest} · min ${s.min} · max ${s.max} (${s.samples} samples)`)
    }
  } else {
    lines.push('  No ping/system/speedtest history in this window.')
  }

  lines.push('', `── App crashes (${rangeLabel}) ──`)
  if (crashTotal === 0) {
    lines.push('  No crash events for this store in the window.')
  } else {
    lines.push(`  Total events: ${crashTotal}`)
    for (const c of crashes.slice(0, 10)) {
      const app = c.appName ? ` · ${c.appName}` : ''
      lines.push(`  • ${crashTypeLabel(c.crashType)}${app}: ${c.totalCrashes} events`)
    }
    if (crashes.length > 10) lines.push(`  … and ${crashes.length - 10} more crash groups`)
  }

  lines.push('', '── Problem tracker (PERIODIC) ──')
  const intervalMin = Math.round((tracker.intervalMs || 120000) / 60000)
  if (!problems.length) {
    lines.push(`  No tracked problems for this hostname (snapshot every ~${intervalMin} min).`)
  } else {
    for (const p of problems) {
      lines.push(`  • [${p.status}] ${p.code}: ${p.message} (last ${p.lastSeenAt ? formatPortalTimestamp(p.lastSeenAt) : '—'})`)
    }
  }

  lines.push(...formatEnvironmentSections(env, rangeLabel, fmtTs, envOpts))
  lines.push('', '(Direct answer from SocMon live data (all environments) — no LLM wait.)')

  return buildHostnameResponse(lines, hostname, range, fetchedAt, env, ctx, {
    storeFound: true,
    store,
    crashTotal,
    problemCount: problems.length,
    historySeries: historyStats.length,
    intervalMin: Math.round((tracker.intervalMs || 120000) / 60000),
  })
}

function buildHostnameResponse(lines, hostname, range, fetchedAt, env, ctx, stats) {
  const contextMeta = []
  if (stats.storeFound) {
    contextMeta.push(
      {
        id: 'storeMonitor',
        label: 'Store Monitor',
        freshness: 'live',
        fetchedAt,
        configured: true,
        note: `${stats.store?.hostname || hostname} · ${formatRangeLabelFromInflux(range)}`,
      },
      {
        id: 'storeProblems',
        label: 'Problem tracker',
        freshness: 'periodic',
        fetchedAt,
        configured: true,
        note: `~${stats.intervalMin || 2} min job`,
      },
      {
        id: 'storeCrashes',
        label: 'App crashes',
        freshness: 'live',
        fetchedAt,
        configured: true,
        note: `${stats.crashTotal || 0} events`,
      },
    )
  }
  if (env.sentinel?.configured) {
    contextMeta.push({
      id: 'sentinelXdr',
      label: 'Sentinel',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: `USB ${env.sentinel.usbConnected}/${env.sentinel.usbDisconnected} · threats ${env.sentinel.threatsDetected}`,
    })
  }
  if (env.soc?.configured) {
    contextMeta.push({
      id: 'soc',
      label: 'SOC / firewall',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: `${env.soc.total} events · ${env.soc.denies} denies`,
    })
  }
  if (env.noc?.configured) {
    contextMeta.push({
      id: 'noc',
      label: 'NOC / switch',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: `${env.noc.total} events · ${env.noc.updown} UPDOWN`,
    })
  }

  return {
    content: lines.join('\n'),
    chartSeries: stats.chartSeries?.length ? stats.chartSeries : undefined,
    contextMeta,
    contextPreview: {
      hostname: stats.store?.hostname || hostname,
      storeTag: stats.store?.storeTag,
      range,
      found: stats.storeFound,
      online: stats.store?.online,
      connState: stats.store?.connState,
      crashTotal: stats.crashTotal,
      problemCount: stats.problemCount,
      historySeries: stats.historySeries,
      sentinel: env.sentinel ? {
        usbConnected: env.sentinel.usbConnected,
        usbDisconnected: env.sentinel.usbDisconnected,
        threats: env.sentinel.threatsDetected,
      } : undefined,
      soc: env.soc ? { total: env.soc.total, denies: env.soc.denies } : undefined,
      noc: env.noc ? { total: env.noc.total, updown: env.noc.updown } : undefined,
    },
    queryContext: {
      topic: 'hostname',
      hostname: stats.store?.hostname || hostname,
      range,
      isFollowUp: ctx?.isFollowUp,
    },
  }
}
