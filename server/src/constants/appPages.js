/** Route segment keys (match client paths /:key). */
export const APP_PAGE_KEYS = ['soc', 'noc', 'sentinel', 'infra', 'storeZabbix', 'storeMonitor', 'solarwinds', 'idcs', 'ad', 'nexs', 'tickets', 'reports', 'emailSim', 'ai', 'admin']

export const APP_PAGE_KEY_SET = new Set(APP_PAGE_KEYS)

/** Retired keys mapped to their replacement (e.g. network access → SolarWinds Orion). */
export const LEGACY_PAGE_ALIASES = { network: 'solarwinds' }

export function normalizePageKey(key) {
  if (typeof key !== 'string') return null
  const trimmed = key.trim()
  if (!trimmed) return null
  const mapped = LEGACY_PAGE_ALIASES[trimmed] || trimmed
  return APP_PAGE_KEY_SET.has(mapped) ? mapped : null
}

export function normalizeAllowedPages(value) {
  if (!Array.isArray(value)) return []
  const next = []
  const seen = new Set()
  for (const raw of value) {
    const k = normalizePageKey(raw)
    if (k && !seen.has(k)) {
      seen.add(k)
      next.push(k)
    }
  }
  return next
}

export function sanitizeAllowedPages(value) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined
  return normalizeAllowedPages(value)
}
