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

export function resolvedApiBase() {
  const raw = import.meta.env.VITE_API_URL
  if (raw == null || String(raw).trim() === '') return ''
  return rewriteLocalhostToIPv4(raw)
}

export function resolvedWsUrl() {
  const raw = import.meta.env.VITE_WS_URL
  if (raw == null || String(raw).trim() === '') return ''
  return rewriteLocalhostToIPv4(raw)
}
