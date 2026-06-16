/**
 * Store app crash events from InfluxDB — shared semantics for Store Zabbix UI,
 * REST /app-crashes, MCP storeZabbix, and netpulse_query crash direct answers.
 */

import {
  isInfluxStoreConfigured,
  fetchCrashEventList,
  fetchCrashSummary,
  crashTypeLabel,
} from './influxStore.js'
import {
  extractStoreHostname,
  resolveQueryWindow,
  wantsCrashEventLog,
  crashRecordMatches,
} from './ai/queryContext.js'

const CRASH_MARKERS = /\b(crash|crashed|crashes|app crash|app hang|hangs|bsod|wer)\b/i

export function wantsCrashMcpContext(userMessage) {
  return CRASH_MARKERS.test(String(userMessage || ''))
}

function formatCrashEventRow(e) {
  return {
    ts: e.ts,
    hostname: e.hostname || e.storeTag || null,
    storeTag: e.storeTag || null,
    appName: e.appName || null,
    crashType: e.crashType || null,
    crashTypeLabel: crashTypeLabel(e.crashType),
    count: e.count || 1,
    message: e.message ? String(e.message).slice(0, 200) : null,
    eventId: e.eventId || null,
  }
}

/**
 * @param {string} userMessage
 * @param {{ historyFrom?: number, historyTo?: number }} [opts]
 * @param {ReturnType<import('./ai/queryContext.js').resolveQueryContext>} [queryContext]
 */
export async function buildStoreCrashMcpContext(userMessage = '', opts = {}, queryContext = null) {
  if (!wantsCrashMcpContext(userMessage)) return {}
  if (!isInfluxStoreConfigured()) {
    return {
      crashConfigured: false,
      crashNote: 'InfluxDB not configured for app crash events.',
    }
  }

  const hostnameFilter = extractStoreHostname(userMessage) || queryContext?.hostname || null
  const appFilter = queryContext?.appName || null
  const window = opts.queryWindow || resolveQueryWindow(userMessage, queryContext, opts)
  const wantsEvents = wantsCrashEventLog(userMessage, queryContext)
    || queryContext?.wantsCrashEventList
    || /\b(event log|each crash|list crash|timestamps?)\b/i.test(userMessage)

  const windowMeta = {
    range: window.range,
    fromSec: window.fromSec ?? null,
    toSec: window.toSec ?? null,
    label: window.label,
    parseNote: window.parseNote,
    fromAt: window.fromSec ? new Date(window.fromSec * 1000).toISOString() : null,
    toAt: window.toSec ? new Date(window.toSec * 1000).toISOString() : null,
  }

  if (wantsEvents) {
    const events = await fetchCrashEventList(window.range, window.fromSec, window.toSec, {
      hostname: hostnameFilter,
      appName: appFilter,
    })
    const limit = 200
    return {
      crashConfigured: true,
      crashWindow: windowMeta,
      crashEvents: events.slice(0, limit).map(formatCrashEventRow),
      crashEventsTotal: events.length,
      crashEventsTruncated: events.length > limit,
      crashHostnameFilter: hostnameFilter,
      crashAppFilter: appFilter,
      crashNote: window.fromSec
        ? `InfluxDB crash event log for ${window.label} (same source as Store Zabbix /app-crashes).`
        : `InfluxDB crash event log for ${window.label}.`,
    }
  }

  let summary = await fetchCrashSummary(window.range, window.fromSec, window.toSec)
  if (appFilter) {
    summary = summary.filter((s) => crashRecordMatches(s, appFilter, crashTypeLabel))
  }
  if (hostnameFilter) {
    const h = String(hostnameFilter).toLowerCase()
    summary = summary.filter((s) =>
      String(s.hostname || '').toLowerCase().includes(h)
      || String(s.storeTag || '').toLowerCase().includes(h))
  }

  const totalEvents = summary.reduce((acc, s) => acc + (s.totalCrashes || 0), 0)
  const topStores = summary
    .sort((a, b) => (b.totalCrashes || 0) - (a.totalCrashes || 0))
    .slice(0, 25)
    .map((s) => ({
      hostname: s.hostname,
      storeTag: s.storeTag,
      appName: s.appName,
      crashType: s.crashType,
      totalCrashes: s.totalCrashes,
      lastSeen: s.lastSeen,
    }))

  return {
    crashConfigured: true,
    crashWindow: windowMeta,
    crashSummary: {
      totalEvents,
      affectedStores: new Set(summary.map((s) => s.storeTag || s.hostname).filter(Boolean)).size,
      topStores,
    },
    crashHostnameFilter: hostnameFilter,
    crashAppFilter: appFilter,
    crashNote: window.fromSec
      ? `InfluxDB crash summary for ${window.label} (same source as Store Zabbix /app-crashes).`
      : `InfluxDB crash summary for ${window.label}.`,
  }
}
