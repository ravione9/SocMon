import {
  isInfluxStoreConfigured,
  getInfluxStoreMeta,
  pingInflux,
  fetchStoreSnapshot,
  buildOverviewSummary,
  fetchCrashSummary,
  crashTypeLabel,
  crashSeverity,
} from './influxStore.js'
import { getManualRopSdwanStoreCodes } from '../utils/manualRopStoreCodes.js'
import StoreMonitorSetting from '../models/StoreMonitorSetting.js'
import StoreProblemHistory from '../models/StoreProblemHistory.js'
import StoreAlertRule from '../models/StoreAlertRule.js'
import StoreAlertEvent from '../models/StoreAlertEvent.js'
import { getProblemSnapshotStatus } from './storeProblemSnapshotter.js'
import { getEvalStatus } from './storeAlertEngine.js'

const VALID_RANGES = new Set(['-1h', '-3h', '-6h', '-12h', '-24h', '-2d', '-7d'])

function parseBool(v, defaultVal) {
  if (v === undefined || v === null || v === '') return defaultVal
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())
}

function filterStores(stores, { q, connState, issuesOnly }) {
  let out = stores
  const search = String(q || '').trim().toLowerCase()
  if (search) {
    out = out.filter(
      (s) =>
        String(s.hostname).toLowerCase().includes(search) ||
        String(s.serial).toLowerCase().includes(search) ||
        String(s.storeTag).toLowerCase().includes(search) ||
        String(s.gatewayIp).toLowerCase().includes(search),
    )
  }
  const conn = String(connState || '').trim()
  if (conn) out = out.filter((s) => s.connState === conn)
  if (issuesOnly) out = out.filter((s) => s.issueCount > 0)
  return out
}

function flattenProblems(stores) {
  const problems = []
  for (const s of stores) {
    for (const issue of s.issues || []) {
      problems.push({
        storeTag: s.storeTag,
        hostname: s.hostname,
        serial: s.serial,
        lastSeen: s.lastSeen,
        connState: s.connState,
        gatewayVendor: s.gatewayVendor,
        ...issue,
      })
    }
  }
  problems.sort((a, b) => {
    const sev = { critical: 0, high: 1, warning: 2 }
    return (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9)
  })
  return problems
}

function aggregateCrashes(summary) {
  const byApp = {}
  const byType = {}
  for (const s of summary) {
    if (s.appName) {
      if (!byApp[s.appName]) byApp[s.appName] = { appName: s.appName, totalCrashes: 0, affectedStores: 0 }
      byApp[s.appName].totalCrashes += s.totalCrashes
      byApp[s.appName].affectedStores += 1
    }
    const t = s.crashType || 'app_crash'
    if (!byType[t]) {
      byType[t] = {
        crashType: t,
        label: crashTypeLabel(t),
        severity: crashSeverity(t),
        totalCrashes: 0,
        affectedStores: 0,
      }
    }
    byType[t].totalCrashes += s.totalCrashes
    byType[t].affectedStores += 1
  }
  return {
    summary,
    byApp: Object.values(byApp).sort((a, b) => b.totalCrashes - a.totalCrashes),
    byType: Object.values(byType).sort((a, b) => b.totalCrashes - a.totalCrashes),
    totalEvents: summary.reduce((acc, s) => acc + s.totalCrashes, 0),
    criticalEvents: summary
      .filter((s) => s.crashSeverity === 'critical')
      .reduce((acc, s) => acc + s.totalCrashes, 0),
    affectedStores: new Set(summary.map((s) => s.storeTag || s.hostname)).size,
  }
}

/**
 * Single wide store-monitor payload for API consumers.
 */
export async function buildStoreMonitorFull(query = {}) {
  const fetchedAt = new Date().toISOString()
  const meta = getInfluxStoreMeta()

  if (!isInfluxStoreConfigured()) {
    return {
      configured: false,
      connected: false,
      fetchedAt,
      meta: { ...meta, manualRopSdwanStoreCodes: getManualRopSdwanStoreCodes() },
      error: 'InfluxDB not configured',
    }
  }

  const staleMinutes = Math.min(Math.max(parseInt(String(query.staleMinutes || '15'), 10) || 15, 2), 60)
  const rawRange = String(query.range || '-24h')
  const metricRange = VALID_RANGES.has(rawRange) ? rawRange : '-24h'
  const crashRange = VALID_RANGES.has(String(query.crashRange || ''))
    ? String(query.crashRange)
    : metricRange
  const fromTs = query.from ? parseInt(String(query.from), 10) : undefined
  const toTs = query.to ? parseInt(String(query.to), 10) : undefined
  const crashFrom = query.crashFrom ? parseInt(String(query.crashFrom), 10) : fromTs
  const crashTo = query.crashTo ? parseInt(String(query.crashTo), 10) : toTs

  const includeCrashes = parseBool(query.includeCrashes, true)
  const includeSettings = parseBool(query.includeSettings, true)
  const includeAlerts = parseBool(query.includeAlerts, true)
  const includeProblemHistory = parseBool(query.includeProblemHistory, false)
  const alertEventsLimit = Math.min(Math.max(parseInt(String(query.alertEventsLimit || '50'), 10) || 50, 1), 200)
  const problemHistoryLimit = Math.min(Math.max(parseInt(String(query.problemHistoryLimit || '20'), 10) || 20, 1), 100)

  const filterOpts = {
    q: query.q,
    connState: query.connState,
    issuesOnly: parseBool(query.issuesOnly, false),
  }

  const [ping, storesRaw] = await Promise.all([
    pingInflux().catch(() => ({ ok: false })),
    fetchStoreSnapshot(staleMinutes, metricRange, fromTs, toTs),
  ])

  const stores = filterStores(storesRaw, filterOpts)
  const summary = buildOverviewSummary(stores)
  const problems = flattenProblems(stores)

  const tasks = []

  if (includeCrashes) {
    tasks.push(
      fetchCrashSummary(crashRange, crashFrom, crashTo)
        .then((summary) => ({ key: 'crashes', data: aggregateCrashes(summary) }))
        .catch((e) => ({ key: 'crashes', error: e.message })),
    )
  }

  if (includeSettings) {
    tasks.push(
      StoreMonitorSetting.findOne()
        .lean()
        .then((doc) => {
          const envCodes = getManualRopSdwanStoreCodes()
          const rawText = doc?.manualRopSdwanCodes ?? ''
          const codes = rawText.trim()
            ? [
                ...new Set(
                  rawText
                    .split(/[\n,;|\t]+/)
                    .map((c) => c.trim().toUpperCase().replace(/^STORE[-_\s]*/i, ''))
                    .filter(Boolean),
                ),
              ]
            : envCodes
          return {
            key: 'settings',
            data: {
              manualRopSdwanCodes: rawText,
              manualRopSdwanCodeList: codes,
              updatedAt: doc?.updatedAt ?? null,
            },
          }
        })
        .catch((e) => ({ key: 'settings', error: e.message })),
    )
  }

  if (includeAlerts) {
    tasks.push(
      Promise.all([
        StoreAlertRule.find().select('name enabled group severity condition lastFiredAt channels').lean(),
        StoreAlertEvent.find()
          .sort({ firedAt: -1 })
          .limit(alertEventsLimit)
          .lean(),
      ])
        .then(([rules, events]) => ({
          key: 'alerts',
          data: {
            rules,
            rulesTotal: rules.length,
            recentEvents: events,
            engine: getEvalStatus(),
          },
        }))
        .catch((e) => ({ key: 'alerts', error: e.message })),
    )
  }

  if (includeProblemHistory) {
    tasks.push(
      StoreProblemHistory.find()
        .sort({ firstSeenAt: -1 })
        .limit(problemHistoryLimit)
        .lean()
        .then((records) => ({
          key: 'problemHistory',
          data: {
            records,
            total: records.length,
            tracker: getProblemSnapshotStatus(),
          },
        }))
        .catch((e) => ({ key: 'problemHistory', error: e.message })),
    )
  }

  const extras = await Promise.all(tasks)
  const optional = {}
  const partialErrors = {}
  for (const r of extras) {
    if (r.error) partialErrors[r.key] = r.error
    else optional[r.key] = r.data
  }

  return {
    configured: true,
    connected: ping.ok,
    fetchedAt,
    staleMinutes,
    metricRange,
    crashRange: includeCrashes ? crashRange : null,
    customFrom: fromTs ? new Date(fromTs * 1000).toISOString() : null,
    customTo: toTs ? new Date(toTs * 1000).toISOString() : null,
    filters: filterOpts,
    meta: {
      ...meta,
      connected: ping.ok,
      pingMessage: ping.message || null,
    },
    summary,
    stores,
    storesTotal: stores.length,
    problems,
    problemsTotal: problems.length,
    offlineStores: stores.filter((s) => s.connState === 'offline'),
    offlineCount: stores.filter((s) => s.connState === 'offline').length,
    ...optional,
    partialErrors: Object.keys(partialErrors).length ? partialErrors : undefined,
  }
}
