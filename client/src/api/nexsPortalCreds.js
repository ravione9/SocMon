/** Session-only credentials for handoff to app.nexs.lenskart.com (cleared on Nexs sign-out). */

const KEY = 'netpulse_nexs_portal_creds'

export function setPortalCreds({ userName, password }) {
  if (!userName || !password) return
  sessionStorage.setItem(KEY, JSON.stringify({ userName: String(userName), password: String(password) }))
}

export function getPortalCreds() {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.userName || !parsed?.password) return null
    return parsed
  } catch {
    return null
  }
}

export function clearPortalCreds() {
  sessionStorage.removeItem(KEY)
}
