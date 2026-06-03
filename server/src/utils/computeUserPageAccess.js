import { APP_PAGE_KEYS, APP_PAGE_KEY_SET, normalizeAllowedPages } from '../constants/appPages.js'
import CustomRole from '../models/CustomRole.js'

const ALL = [...APP_PAGE_KEYS]

const IMPLICIT_GRANT_IF_ONLY_MISSING = ['idcs', 'ad', 'emailSim', 'solarwinds', 'storeZabbix', 'storeMonitor', 'nexs']

function mergeLegacyImplicitGrant(role, filtered) {
  if (role === 'custom_admin' || role === 'admin' || role === 'role_template') return filtered
  if (role !== 'analyst' && role !== 'viewer') return filtered
  const missing = ALL.filter((k) => !filtered.includes(k))
  if (!missing.length) return filtered
  if (!missing.every((k) => IMPLICIT_GRANT_IF_ONLY_MISSING.includes(k))) return filtered
  return [...new Set([...filtered, ...missing])]
}

/**
 * Returns { allowedPages, pageAccess, customRoleName } for API / auth responses.
 * pageAccess values: 'read' | 'full' per pageKey.
 */
export async function computeUserPageAccess(userDoc) {
  const role = userDoc?.role
  if (!role) {
    return { allowedPages: [], pageAccess: {}, customRoleName: null }
  }

  if (role === 'admin') {
    const pageAccess = Object.fromEntries(ALL.map((k) => [k, 'full']))
    return { allowedPages: [...ALL], pageAccess, customRoleName: null }
  }

  if (role === 'role_template') {
    const id = userDoc.customRoleId
    if (!id) {
      return { allowedPages: [], pageAccess: {}, customRoleName: null }
    }
    const cr = await CustomRole.findById(id).lean()
    const customRoleName = cr?.name ?? null
    if (!cr?.pages?.length) {
      return { allowedPages: [], pageAccess: {}, customRoleName }
    }
    const pageAccess = {}
    for (const { pageKey, access } of cr.pages) {
      if (APP_PAGE_KEY_SET.has(pageKey) && (access === 'read' || access === 'full')) {
        pageAccess[pageKey] = access
      }
    }
    const allowedPages = Object.keys(pageAccess)
    return { allowedPages, pageAccess, customRoleName }
  }

  if (role === 'custom_admin') {
    const allowed = Array.isArray(userDoc.allowedPages)
      ? normalizeAllowedPages(userDoc.allowedPages)
      : []
    const pageAccess = Object.fromEntries(allowed.map((k) => [k, 'full']))
    return { allowedPages: allowed, pageAccess, customRoleName: null }
  }

  let allowed = ALL
  if (Array.isArray(userDoc.allowedPages)) {
    allowed = normalizeAllowedPages(userDoc.allowedPages)
  }
  allowed = mergeLegacyImplicitGrant(role, allowed)
  const level = role === 'viewer' ? 'read' : 'full'
  const pageAccess = Object.fromEntries(allowed.map((k) => [k, level]))
  return { allowedPages: allowed, pageAccess, customRoleName: null }
}

export async function toClientUserPayload(userDoc) {
  const u = userDoc?.toObject ? userDoc.toObject() : { ...userDoc }
  delete u.password
  const { allowedPages, pageAccess, customRoleName } = await computeUserPageAccess(u)
  return {
    _id: u._id,
    id: u._id,
    name: u.name,
    email: u.email,
    authKind: u.authKind || 'local',
    adLoginIdentity: u.authKind === 'ad' ? u.adLoginIdentity || '' : '',
    role: u.role,
    active: u.active,
    lastLogin: u.lastLogin,
    avatar: u.avatar,
    allowedPages,
    pageAccess,
    customRoleId: u.customRoleId,
    customRoleName,
    theme: u.theme,
    themeSaveToProfile: u.themeSaveToProfile,
    apiAccessEnabled: !!u.apiAccessEnabled,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }
}

export async function userHasAdminConsoleFull(userDoc) {
  if (!userDoc?.active) return false
  const { pageAccess } = await computeUserPageAccess(userDoc)
  return pageAccess.admin === 'full'
}
