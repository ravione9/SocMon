/** Per-tab Nexs auth session (JWT from Lenskart Auth Service login). Cleared when the browser tab closes. */

const STORAGE_KEY = 'netpulse_nexs_session'

function looksLikeJwt(token) {
  const parts = String(token || '').trim().split('.')
  return parts.length === 3 && parts.every((p) => p.length > 0)
}

export function getNexsSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.token || !looksLikeJwt(parsed.token)) {
      sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function setNexsSession(session) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

/** Merge new fields into the existing session (used to backfill empCode after login). */
export function updateNexsSession(patch) {
  const current = getNexsSession()
  if (!current) return null
  const next = { ...current, ...patch }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  return next
}

export function clearNexsSession() {
  sessionStorage.removeItem(STORAGE_KEY)
}

export function nexsAuthHeaders() {
  const s = getNexsSession()
  if (!s?.token) return {}
  const headers = { 'X-Nexs-Auth-Token': s.token }
  if (s.appId) headers['X-Nexs-App-Id'] = s.appId
  return headers
}
