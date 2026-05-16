/**
 * Docker Desktop on Windows often resets connections to localhost (::1) while 127.0.0.1 works.
 */
export function rewriteLocalhostToIPv4(url) {
  const s = String(url).trim()
  if (!s) return s
  try {
    const u = new URL(s)
    if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.1'
      return u.href.replace(/\/$/, '')
    }
  } catch {
    /* ignore */
  }
  return s.replace(/\/$/, '')
}

function apiHostIsLoopback(absoluteUrl) {
  try {
    const normalized = /^[a-z]+:/i.test(absoluteUrl) ? absoluteUrl : `http://${absoluteUrl}`
    const u = new URL(normalized)
    const h = u.hostname.toLowerCase()
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
  } catch {
    return false
  }
}

function browserPageIsLoopback() {
  if (typeof window === 'undefined') return true
  const h = String(window.location.hostname || '').toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
}

/**
 * In dev, if the SPA is opened from a LAN hostname/IP but VITE_* points at loopback,
 * browsers send API/WebSocket traffic to the wrong machine → universal "Network Error".
 * Using same-origin `/api` hits the Vite proxy instead (set VITE_DEV_PROXY_TARGET in Docker).
 * Opt out: VITE_FORCE_ABSOLUTE_API=1
 */
function shouldPreferRelativeDevProxy(absoluteBase) {
  if (!absoluteBase) return false
  if (import.meta.env.PROD) return false
  if (import.meta.env.SSR) return false
  if (typeof window === 'undefined') return false
  const force = ['1', 'true', 'yes'].includes(
    String(import.meta.env.VITE_FORCE_ABSOLUTE_API || '').toLowerCase(),
  )
  if (force) return false
  return apiHostIsLoopback(absoluteBase) && !browserPageIsLoopback()
}

export function resolvedApiBase() {
  const raw = import.meta.env.VITE_API_URL
  if (raw == null || String(raw).trim() === '') return ''
  const base = rewriteLocalhostToIPv4(String(raw).trim())
  if (shouldPreferRelativeDevProxy(base)) return ''
  return base
}

export function resolvedWsUrl() {
  const raw = import.meta.env.VITE_WS_URL
  if (raw == null || String(raw).trim() === '') return ''
  const base = rewriteLocalhostToIPv4(String(raw).trim())
  if (shouldPreferRelativeDevProxy(base)) return ''
  return base
}
