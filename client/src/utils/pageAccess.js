import { APP_PAGE_KEYS } from '../config/appPages.js'

const ALL = [...APP_PAGE_KEYS]

export function getEffectiveAllowedPages(user) {
  if (!user) return []
  if (user.role === 'admin') return ALL
  if (!Array.isArray(user.allowedPages)) return ALL
  return user.allowedPages.filter((k) => ALL.includes(k))
}

export function canAccessPage(user, pageKey) {
  return getEffectiveAllowedPages(user).includes(pageKey)
}

const NAV_ORDER = ['soc', 'noc', 'sentinel', 'infra', 'tickets', 'reports', 'ai', 'admin']

export function getFirstAllowedPath(user) {
  const allowed = getEffectiveAllowedPages(user)
  for (const k of NAV_ORDER) {
    if (allowed.includes(k)) return `/${k}`
  }
  return '/no-access'
}
