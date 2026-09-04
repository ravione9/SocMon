const RANGE_IDS = new Set(['24h', '7d', '14d', '30d', 'custom'])
const WIDGET_IDS = new Set([
  'cpu', 'memory', 'uptime', 'systemUptime', 'latency', 'jitter',
  'maxLatency', 'maxJitter', 'maxGatewayLatency',
  'internet', 'usb', 'appCrash', 'agentLastConnected', 'storeProfile',
])
const EVENT_LIMITS = new Set([500, 1000, 2000, 5000])
const SCOPES = new Set(['store-zabbix', 'zabbix', 'ro-dashboard'])

export function normalizeCustomDashScope(raw) {
  const s = String(raw || '').trim().toLowerCase()
  return SCOPES.has(s) ? s : 'store-zabbix'
}

/** Sanitize client payload before persisting on the user document. */
export function sanitizeCustomDashPrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const bhDays = Array.isArray(p.bhDays)
    ? [...new Set(p.bhDays.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    : [1, 2, 3, 4, 5]

  let customEpoch = null
  if (p.customEpoch && typeof p.customEpoch === 'object') {
    const from = Number(p.customEpoch.from)
    const to = Number(p.customEpoch.to)
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
      customEpoch = { from: Math.floor(from), to: Math.floor(to) }
    }
  }

  const eventLimit = Number(p.eventLimit)
  const activeWidget = p.activeWidget == null || p.activeWidget === ''
    ? null
    : (WIDGET_IDS.has(String(p.activeWidget)) ? String(p.activeWidget) : null)

  return {
    v: 1,
    selectedHostIds: Array.isArray(p.selectedHostIds)
      ? [...new Set(p.selectedHostIds.map((id) => String(id)).filter(Boolean))].slice(0, 200)
      : [],
    range: RANGE_IDS.has(p.range) ? p.range : '24h',
    customEpoch,
    customFrom: typeof p.customFrom === 'string' ? p.customFrom.slice(0, 40) : '',
    customTo: typeof p.customTo === 'string' ? p.customTo.slice(0, 40) : '',
    bhEnabled: !!p.bhEnabled,
    bhStart: Math.min(23, Math.max(0, Math.floor(Number(p.bhStart) || 9))),
    bhEnd: Math.min(24, Math.max(0, Math.floor(Number(p.bhEnd) || 18))),
    bhDays: bhDays.length ? bhDays : [1, 2, 3, 4, 5],
    eventLimit: EVENT_LIMITS.has(eventLimit) ? eventLimit : 2000,
    activeWidget,
    updatedAt: new Date().toISOString(),
  }
}

export function readCustomDashPrefs(userDoc, scope) {
  const key = normalizeCustomDashScope(scope)
  const bucket = userDoc?.uiPrefs?.customDashboard
  if (!bucket || typeof bucket !== 'object') return null
  const raw = bucket[key]
  if (!raw || typeof raw !== 'object') return null
  return sanitizeCustomDashPrefs(raw)
}

const SAVED_FILTER_LIMIT = 30
const SAVED_FILTER_NAME_MAX = 60

function makeFilterId() {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeSavedFilterName(raw, fallback = 'Untitled') {
  const s = String(raw || '').trim().slice(0, SAVED_FILTER_NAME_MAX)
  return s || fallback
}

/** Sanitize one saved filter row. Drops bad rows by returning null. */
export function sanitizeSavedFilterEntry(raw, { keepId = true } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const prefs = sanitizeCustomDashPrefs(raw.prefs)
  const name = sanitizeSavedFilterName(raw.name)
  const id = keepId && typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim().slice(0, 40)
    : makeFilterId()
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString()
  return {
    id,
    name,
    prefs,
    createdAt,
    updatedAt: new Date().toISOString(),
  }
}

/** Sanitize a list of saved filters, dedupe ids, cap length. */
export function sanitizeSavedFilterList(list) {
  const arr = Array.isArray(list) ? list : []
  const seen = new Set()
  const out = []
  for (const raw of arr) {
    const entry = sanitizeSavedFilterEntry(raw)
    if (!entry) continue
    if (seen.has(entry.id)) entry.id = makeFilterId()
    seen.add(entry.id)
    out.push(entry)
    if (out.length >= SAVED_FILTER_LIMIT) break
  }
  return out
}

export function readSavedFilters(userDoc, scope) {
  const key = normalizeCustomDashScope(scope)
  const bucket = userDoc?.uiPrefs?.customDashboardFilters
  if (!bucket || typeof bucket !== 'object') return []
  return sanitizeSavedFilterList(bucket[key])
}

export function writeSavedFilters(userDoc, scope, list) {
  const key = normalizeCustomDashScope(scope)
  const uiPrefs = userDoc.uiPrefs && typeof userDoc.uiPrefs === 'object' ? { ...userDoc.uiPrefs } : {}
  const bucket = uiPrefs.customDashboardFilters && typeof uiPrefs.customDashboardFilters === 'object'
    ? { ...uiPrefs.customDashboardFilters }
    : {}
  bucket[key] = sanitizeSavedFilterList(list)
  uiPrefs.customDashboardFilters = bucket
  userDoc.uiPrefs = uiPrefs
  userDoc.markModified('uiPrefs')
  return bucket[key]
}

export const SAVED_FILTER_LIMITS = {
  maxFilters: SAVED_FILTER_LIMIT,
  maxNameLen: SAVED_FILTER_NAME_MAX,
}
