import { APP_PAGE_KEYS } from '../config/appPages.js'

const ALL = [...APP_PAGE_KEYS]

/**
 * Route keys shipped after granular page ACL landed. Users edited before that may
 * have an explicit Mongo `allowedPages` array that omitted these — they would never
 * see new nav entries. If the only gaps vs current ALL are listed here, treat as migration.
 */
const IMPLICIT_GRANT_IF_ONLY_MISSING = ['idcs', 'ad', 'emailSim', 'solarwinds', 'nexs']

/** @internal */
function mergeLegacyImplicitGrant(role, filtered) {
  if (role === 'custom_admin' || role === 'admin' || role === 'role_template') return filtered
  if (role !== 'analyst' && role !== 'viewer') return filtered
  const missing = ALL.filter((k) => !filtered.includes(k))
  if (!missing.length) return filtered
  if (!missing.every((k) => IMPLICIT_GRANT_IF_ONLY_MISSING.includes(k))) return filtered
  return [...new Set([...filtered, ...missing])]
}

/**
 * Allowed page keys for routing and nav. Prefer `allowedPages` from the server
 * when present (includes role_template and derived ACL).
 */
export function getEffectiveAllowedPages(user) {
  if (!user) return []
  if (user.role === 'admin') return ALL
  if (user.role === 'role_template') {
    if (user.pageAccess && typeof user.pageAccess === 'object' && Object.keys(user.pageAccess).length) {
      return Object.keys(user.pageAccess).filter((k) => ALL.includes(k))
    }
    if (Array.isArray(user.allowedPages)) {
      return user.allowedPages.filter((k) => ALL.includes(k))
    }
    return []
  }
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

/** @returns {'none'|'read'|'full'} */
export function getPageAccessLevel(user, pageKey) {
  if (!user || !ALL.includes(pageKey)) return 'none'
  if (user.role === 'admin') return 'full'
  if (user.pageAccess && typeof user.pageAccess === 'object' && user.pageAccess[pageKey]) {
    const a = user.pageAccess[pageKey]
    return a === 'read' || a === 'full' ? a : 'none'
  }
  if (!canAccessPage(user, pageKey)) return 'none'
  return user.role === 'viewer' ? 'read' : 'full'
}

export function canWritePage(user, pageKey) {
  return getPageAccessLevel(user, pageKey) === 'full'
}

const NAV_ORDER = ['soc', 'noc', 'sentinel', 'infra', 'solarwinds', 'idcs', 'ad', 'nexs', 'tickets', 'reports', 'emailSim', 'ai', 'admin']

export function getFirstAllowedPath(user) {
  const allowed = getEffectiveAllowedPages(user)
  for (const k of NAV_ORDER) {
    if (allowed.includes(k)) return `/${k}`
  }
  return '/no-access'
}
