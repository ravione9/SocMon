/**
 * Direct login to Nexs web portal (app.nexs.lenskart.com) from the browser.
 * Uses the same API as the Nexs SPA (POST /v1/user/login).
 */

const PORTAL_ORIGIN = 'https://app.nexs.lenskart.com'
const DEFAULT_PORTAL_PATH = '/usermanagement/roles'

export function resolvePortalRolesUrl(meta) {
  const fromMeta = meta?.portalUrl || meta?.portalRolesUrl
  if (fromMeta) return fromMeta
  return `${PORTAL_ORIGIN}${DEFAULT_PORTAL_PATH}`
}

export function extractPortalLoginToken(data) {
  if (!data) return null
  if (typeof data.content === 'string' && data.content.split('.').length >= 2) {
    return data.content.trim()
  }
  return data.token || data.jwt || data.authToken || null
}

/** Login on app.nexs origin (sets cookies when browser allows cross-site cookies). */
export async function loginToNexsPortal({ userName, password, appId = 'nexs_search' }) {
  const headers = {
    'Content-Type': 'application/json',
    'source-domain': window.location.origin,
  }
  if (appId) headers['X-Lenskart-App-Id'] = appId

  const res = await fetch(`${PORTAL_ORIGIN}/v1/user/login`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ userName, password }),
  })

  let data = {}
  try {
    data = await res.json()
  } catch {
    data = {}
  }

  if (!res.ok || data.success === false) {
    throw new Error(data.message || `Nexs portal login failed (${res.status})`)
  }

  return { data, token: extractPortalLoginToken(data) }
}

/**
 * Sign in on the Nexs portal origin, then open the roles page in a new tab.
 */
export async function openNexsPortalRoles({ userName, password, portalUrl, appId }) {
  const login = await loginToNexsPortal({ userName, password, appId })
  const url = portalUrl || `${PORTAL_ORIGIN}${DEFAULT_PORTAL_PATH}`
  const win = window.open(url, '_blank', 'noopener,noreferrer')
  if (!win) {
    throw new Error('Popup blocked. Allow popups for this site and try again.')
  }
  return login
}
