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
  buildStoreHostAliases,
  extractStoreCode,
  extractStoreHostname,
  resolveQueryWindow,
  shouldUseStoreCodeAlias,
  wantsCrashEventLog,
  crashRecordMatches,
} from './ai/queryContext.js'

/** Match Influx crash rows to LKST/LK/RP store scope (agent hostname may be LK64-*, not LKST64). */
function hostOrTagMatchesAlias(hostOrTag, alias) {
  const h = String(hostOrTag || '').toLowerCase()
  const al = String(alias || '').toLowerCase()
  if (!al) return false
  if (h === al) return true
  return h.startsWith(`${al}-`) || h.startsWith(`${al}_`)
}

export function crashRecordMatchesStoreScope(record, userMessage) {
  const hostname = extractStoreHostname(userMessage)
  const code = extractStoreCode(userMessage)
  if (!hostname && !code) return true

  const rh = String(record.hostname || record.storeTag || '').toLowerCase()
  const rt = String(record.storeTag || '').toLowerCase()

  if (hostname) {
    const h = hostname.toLowerCase()
    if (rh === h || rt === h || rt.startsWith(`${h}_`)) return true
    if (hostOrTagMatchesAlias(rh, hostname) || hostOrTagMatchesAlias(rt, hostname)) return true
  }

  if (code) {
    const recordCode = extractStoreCode(record.hostname || '') || extractStoreCode(record.storeTag || '')
    if (recordCode === code) return true
    if (shouldUseStoreCodeAlias(userMessage)) {
      for (const alias of buildStoreHostAliases(userMessage)) {
        if (hostOrTagMatchesAlias(rh, alias) || hostOrTagMatchesAlias(rt, alias)) {
          return true
        }
      }
    }
  }

  return false
}

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

  const scopeFilter = Boolean(hostnameFilter || extractStoreCode(userMessage))

  if (wantsEvents) {
    let events = await fetchCrashEventList(window.range, window.fromSec, window.toSec, {
      appName: appFilter,
    })
    if (scopeFilter) {
      events = events.filter((e) => crashRecordMatchesStoreScope(e, userMessage))
    }
    const limit = 200
    return {
      crashConfigured: true,
      crashSource: 'InfluxDB /app-crashes (not Zabbix)',
      crashWindow: windowMeta,
      crashEvents: events.slice(0, limit).map(formatCrashEventRow),
      crashEventsTotal: events.length,
      crashEventsTruncated: events.length > limit,
      crashHostnameFilter: hostnameFilter,
      crashAppFilter: appFilter,
      crashNote: window.fromSec
        ? `InfluxDB crash event log for ${window.label} — same bucket as REST /app-crashes and netpulse_query hostname report.`
        : `InfluxDB crash event log for ${window.label}.`,
    }
  }

  let summary = await fetchCrashSummary(window.range, window.fromSec, window.toSec)
  if (appFilter) {
    summary = summary.filter((s) => crashRecordMatches(s, appFilter, crashTypeLabel))
  }
  if (scopeFilter) {
    summary = summary.filter((s) => crashRecordMatchesStoreScope(s, userMessage))
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
    crashSource: 'InfluxDB /app-crashes (not Zabbix)',
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
