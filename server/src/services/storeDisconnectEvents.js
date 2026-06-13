/**
 * Store disconnect events — shared BH semantics for Store Zabbix ROP UI,
 * REST /rop-store-disconnects, MCP storeZabbix, and storeProblems.
 */

import StoreProblemHistory from '../models/StoreProblemHistory.js'
import {
  extractStoreCode,
  extractStoreHostname,
  shouldUseStoreCodeAlias,
} from './ai/queryContext.js'

export const OFFLINE_CODE = 'offline'

/** Default BH for MCP + Store Zabbix ROP toolbar (09:00–18:00 IST, all days). */
export const MCP_DEFAULT_BUSINESS_HOURS = {
  startHour: 9,
  endHour: 18,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  tzOffsetMinutes: 330,
}

export function clampHour(h) {
  const n = Number(h)
  return Number.isFinite(n) ? Math.max(0, Math.min(24, Math.round(n))) : 0
}

export function normaliseBusinessHours(bh, defaults = MCP_DEFAULT_BUSINESS_HOURS) {
  const def = defaults
  if (!bh || typeof bh !== 'object') return { ...def, weekdays: [...def.weekdays] }
  const startHour = clampHour(bh.startHour ?? def.startHour)
  const endHour = clampHour(bh.endHour ?? def.endHour)
  let weekdays = Array.isArray(bh.weekdays)
    ? [...new Set(bh.weekdays.map((d) => Number(d)).filter((d) => Number.isFinite(d) && d >= 0 && d <= 6))]
    : def.weekdays.slice()
  if (!weekdays.length) weekdays = def.weekdays.slice()
  const tzOffsetMinutes = Number.isFinite(Number(bh.tzOffsetMinutes))
    ? Number(bh.tzOffsetMinutes)
    : def.tzOffsetMinutes
  return { startHour, endHour, weekdays: weekdays.sort((a, b) => a - b), tzOffsetMinutes }
}

export function makeBhChecker(bh) {
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
export function bhMinutesInInterval(aMs, bMs, isBh) {
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

export function isBhFilterActive(bh) {
  const n = normaliseBusinessHours(bh)
  return !(n.startHour === 0 && n.endHour === 24 && n.weekdays.length === 7)
}

/**
 * Map one StoreProblemHistory offline record to a disconnect event (BH-aware).
 * Returns null when BH filter is active and the outage does not overlap BH.
 */
export function mapStoreDisconnectEvent(r, { fromMsN, toMsN, isBh, bhActive, nowMs }) {
  const disconnectAtMs = new Date(r.firstSeenAt).getTime()
  const backUpAtMs = r.resolvedAt ? new Date(r.resolvedAt).getTime() : null
  const endMs = backUpAtMs != null
    ? backUpAtMs
    : (r.status === 'active' ? nowMs : disconnectAtMs)
  const durationMs = endMs - disconnectAtMs

  const segStart = Math.max(disconnectAtMs, fromMsN)
  const segEnd = Math.min(endMs, toMsN)
  const bhDurationMin = (segEnd > segStart && isBh)
    ? bhMinutesInInterval(segStart, segEnd, isBh)
    : 0
  const totalDurationMin = durationMs != null ? Math.round(durationMs / 60_000) : null

  if (bhActive && bhDurationMin <= 0) return null

  return {
    storeTag: r.storeTag || '',
    hostname: r.hostname || '',
    disconnectAt: r.firstSeenAt,
    disconnectAtMs,
    disconnectedAt: r.firstSeenAt,
    backUpAt: r.resolvedAt,
    backUpAtMs,
    durationMin: totalDurationMin,
    totalDurationMin,
    bhDurationMin: bhActive ? bhDurationMin : totalDurationMin,
    status: r.status,
    stillOffline: r.status === 'active',
  }
}

/**
 * @param {object[]} records StoreProblemHistory offline rows
 * @param {{ fromMs: number, toMs: number, businessHours?: object, nowMs?: number }} opts
 */
export function buildStoreDisconnectEvents(records, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now()
  const fromMsN = Number(opts.fromMs)
  const toMsN = Number(opts.toMs)
  const bh = normaliseBusinessHours(opts.businessHours)
  const isBh = makeBhChecker(bh)
  const bhActive = isBhFilterActive(bh)

  const events = []
  for (const r of records || []) {
    const ev = mapStoreDisconnectEvent(r, { fromMsN, toMsN, isBh, bhActive, nowMs })
    if (ev) events.push(ev)
  }

  return {
    events,
    businessHours: bh,
    bhApplied: bhActive,
  }
}

function escapeMongoRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Mongo $or filter when the question names a store hostname/tag (LKST → RP alias).
 * @param {string} userMessage
 */
export function buildDisconnectHostScope(userMessage) {
  const hostname = extractStoreHostname(userMessage)
  if (!hostname) return null

  const escaped = escapeMongoRegex(hostname)
  const or = [
    { hostname: new RegExp(escaped, 'i') },
    { storeTag: new RegExp(escaped, 'i') },
  ]

  const code = extractStoreCode(userMessage)
  if (code && shouldUseStoreCodeAlias(userMessage)) {
    or.push(
      { hostname: new RegExp(`^RP0*${code}(?:-|$)`, 'i') },
      { hostname: new RegExp(`^LK0*${code}(?:-|$)`, 'i') },
      { storeTag: new RegExp(`^RP0*${code}(?:_|$)`, 'i') },
      { storeTag: new RegExp(`^LK0*${code}(?:_|$)`, 'i') },
      { storeTag: new RegExp(`^LKST0*${code}(?:_|$)?`, 'i') },
    )
  } else if (code) {
    const prefix = hostname.replace(/-.*$/, '')
    const prefixEsc = escapeMongoRegex(prefix)
    or.push(
      { hostname: new RegExp(`^${prefixEsc}(?:-|$)`, 'i') },
      { storeTag: new RegExp(prefixEsc, 'i') },
    )
  }

  return { hostname, code, filter: { $or: or } }
}

/**
 * BH-filtered disconnect payload for MCP (Store Zabbix ROP semantics).
 * Uses Mongo only — works when Zabbix API is down or not configured.
 * @param {string} [userMessage]
 */
export async function buildStoreDisconnectMcpContext(userMessage = '') {
  const fetchedAt = new Date().toISOString()
  const nowMs = Date.now()
  const hostScope = buildDisconnectHostScope(userMessage)
  const DISCONNECT_LOOKBACK_DAYS = hostScope ? 30 : 14
  const DISCONNECT_FETCH_LIMIT = hostScope ? 300 : 400
  const DISCONNECT_EVENT_LIMIT = hostScope ? 100 : 120
  const fromMs = nowMs - DISCONNECT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  const toMs = nowMs
  const scopeFilter = hostScope?.filter

  const disconnectQuery = {
    code: OFFLINE_CODE,
    firstSeenAt: { $lt: new Date(toMs) },
    $or: [{ resolvedAt: null }, { resolvedAt: { $gt: new Date(fromMs) } }],
  }
  if (scopeFilter) Object.assign(disconnectQuery, scopeFilter)

  const activeOfflineQuery = { status: 'active', code: OFFLINE_CODE }
  if (scopeFilter) Object.assign(activeOfflineQuery, scopeFilter)

  let disconnectRaw = []
  let activeOfflineRaw = []
  try {
    ;[disconnectRaw, activeOfflineRaw] = await Promise.all([
      StoreProblemHistory.find(disconnectQuery)
        .sort({ firstSeenAt: -1 })
        .limit(DISCONNECT_FETCH_LIMIT)
        .select({
          hostname: 1,
          storeTag: 1,
          firstSeenAt: 1,
          resolvedAt: 1,
          status: 1,
        })
        .lean(),
      StoreProblemHistory.find(activeOfflineQuery)
        .sort({ firstSeenAt: -1 })
        .limit(hostScope ? 100 : 80)
        .select({
          hostname: 1,
          storeTag: 1,
          firstSeenAt: 1,
          resolvedAt: 1,
          status: 1,
        })
        .lean(),
    ])
  } catch (err) {
    return {
      disconnectConfigured: false,
      disconnectError: err?.message || String(err),
      fetchedAt,
    }
  }

  const bhOpts = {
    fromMs,
    toMs,
    businessHours: MCP_DEFAULT_BUSINESS_HOURS,
    nowMs,
  }
  const { events: disconnectEvents, businessHours: bh, bhApplied } = buildStoreDisconnectEvents(disconnectRaw, bhOpts)
  const { events: activeDisconnectEvents } = buildStoreDisconnectEvents(activeOfflineRaw, bhOpts)

  const disconnectEventsTruncated = !hostScope && (
    disconnectRaw.length >= DISCONNECT_FETCH_LIMIT || disconnectEvents.length >= DISCONNECT_EVENT_LIMIT
  )
  const limitedDisconnectEvents = disconnectEvents.slice(0, DISCONNECT_EVENT_LIMIT)

  return {
    disconnectConfigured: true,
    disconnectSource: `MongoDB StoreProblemHistory (code='${OFFLINE_CODE}')${bhApplied ? ' · BH-filtered (Store Zabbix ROP)' : ''}`,
    disconnectFetchedAt: fetchedAt,
    activeDisconnectCount: activeDisconnectEvents.length,
    activeDisconnectEvents,
    disconnectEventsWindowDays: DISCONNECT_LOOKBACK_DAYS,
    disconnectEventsLimit: DISCONNECT_EVENT_LIMIT,
    disconnectEventsFilter: hostScope
      ? { hostname: hostScope.hostname, storeCode: hostScope.code, scoped: true }
      : { scoped: false },
    disconnectEventsTruncated,
    businessHours: bh,
    bhApplied,
    disconnectEventsCount: limitedDisconnectEvents.length,
    disconnectEvents: limitedDisconnectEvents,
    disconnectNote: hostScope
      ? `BH disconnect history scoped to ${hostScope.hostname} (30-day window, 09:00–18:00 IST).`
      : disconnectEventsTruncated
        ? `BH-filtered disconnect events (newest ${DISCONNECT_EVENT_LIMIT}, ${DISCONNECT_LOOKBACK_DAYS}d). Events with zero BH overlap excluded.`
        : 'Active disconnect + BH history from Store Zabbix ROP rules (Mongo, not Zabbix host status).',
  }
}
