import { APP_PAGE_KEYS } from '../config/appPages.js'

const ALL = [...APP_PAGE_KEYS]

/**
 * Route keys shipped after granular page ACL landed. Users edited before that may
 * have an explicit Mongo `allowedPages` array that omitted these — they would never
 * see new nav entries. If the only gaps vs current ALL are listed here, treat as migration.
 * (Strict: does not widen intentionally locked-down ACLs that omit other pages.)
 */
const IMPLICIT_GRANT_IF_ONLY_MISSING = ['idcs']

/** @internal */
function mergeLegacyImplicitGrant(role, filtered) {
  if (role === 'custom_admin' || role === 'admin') return filtered
  if (role !== 'analyst' && role !== 'viewer') return filtered
  const missing = ALL.filter((k) => !filtered.includes(k))
  if (!missing.length) return filtered
  if (!missing.every((k) => IMPLICIT_GRANT_IF_ONLY_MISSING.includes(k))) return filtered
  return [...new Set([...filtered, ...missing])]
}

export function getEffectiveAllowedPages(user) {
  if (!user) return []
  if (user.role === 'admin') return ALL
  if (user.role === 'custom_admin') {
    if (!Array.isArray(user.allowedPages)) return []
    return user.allowedPages.filter((k) => ALL.includes(k))
  }
  if (!Array.isArray(user.allowedPages)) return ALL
  const filtered = user.allowedPages.filter((k) => ALL.includes(k))
  return mergeLegacyImplicitGrant(user.role, filtered)
}

export function canAccessPage(user, pageKey) {
  return getEffectiveAllowedPages(user).includes(pageKey)
}

const NAV_ORDER = ['soc', 'noc', 'sentinel', 'infra', 'network', 'idcs', 'tickets', 'reports', 'ai', 'admin']

export function getFirstAllowedPath(user) {
  const allowed = getEffectiveAllowedPages(user)
  for (const k of NAV_ORDER) {
    if (allowed.includes(k)) return `/${k}`
  }
  return '/no-access'
}
