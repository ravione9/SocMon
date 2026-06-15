const RANGE_IDS = new Set(['24h', '7d', '14d', '30d', 'custom'])
const WIDGET_IDS = new Set(['cpu', 'memory', 'uptime', 'latency', 'internet', 'usb', 'appCrash'])
const EVENT_LIMITS = new Set([500, 1000, 2000, 5000])
const SCOPES = new Set(['store-zabbix', 'zabbix'])

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
