import http from 'http'
import https from 'https'

/** Host segment for URL (bracket IPv6). */
export function hostForMgmtUrl(ip) {
  if (!ip) return ''
  const s = String(ip).trim()
  if (s.startsWith('[') && s.endsWith(']')) return s
  if (s.includes(':')) return `[${s}]`
  return s
}

/**
 * GET request that always ignores self-signed cert errors and short-circuits on timeout.
 * Returns `{ ok, statusCode }` (never rejects).
 */
function tryGet(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(url)
    } catch {
      return resolve({ ok: false, error: 'bad_url' })
    }
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    const opts = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname === '' ? '/' : u.pathname,
      timeout: timeoutMs,
      rejectUnauthorized: false,
      // Some embedded HTTP/HTTPS stacks misbehave on HEAD; GET with low timeout is the safest probe.
      headers: { 'User-Agent': 'Netpulse-Probe/1.0', Accept: '*/*' },
    }
    const req = lib.request(opts, (res) => {
      res.resume()
      resolve({ ok: true, statusCode: res.statusCode })
    })
    req.on('error', () => resolve({ ok: false }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'timeout' })
    })
    req.end()
  })
}

/**
 * Probes BOTH HTTPS (configured port) and HTTP (port 80) in parallel.
 * Self-signed certificates are ignored.
 * Returns the preferred scheme (HTTPS if it answers; otherwise HTTP if it answers; otherwise HTTPS guessed).
 */
export async function probeMgmtBase(ip, httpsPort, httpPort = 80) {
  const host = hostForMgmtUrl(ip)
  const hp = Number(httpsPort) > 0 ? Number(httpsPort) : 443
  const htp = Number(httpPort) > 0 ? Number(httpPort) : 80

  const httpsUrl = `https://${host}:${hp}`
  const httpUrl = `http://${host}:${htp}`

  const [r1, r2] = await Promise.all([tryGet(`${httpsUrl}/`), tryGet(`${httpUrl}/`)])

  const httpsOk = r1.ok && r1.statusCode && r1.statusCode < 500
  const httpOk = r2.ok && r2.statusCode && r2.statusCode < 500

  // Prefer HTTPS when it answered.
  let scheme = httpsOk ? 'https' : httpOk ? 'http' : 'https'
  let baseUrl = scheme === 'https' ? httpsUrl : httpUrl
  return {
    scheme,
    baseUrl,
    reachable: httpsOk || httpOk,
    guessed: !(httpsOk || httpOk),
    httpsUrl,
    httpsReachable: !!httpsOk,
    httpUrl,
    httpReachable: !!httpOk,
  }
}

/**
 * Legacy/basic-auth style URL. Note: most modern browsers strip `user:pass@` silently,
 * so this only auto-logs in on devices that accept HTTP Basic via userinfo and on browsers
 * that haven't disabled it. Provided as best-effort.
 */
export function buildBasicAuthUrl(username, password, baseUrl) {
  const u = new URL(`${baseUrl.replace(/\/$/, '')}/`)
  const user = encodeURIComponent(username || '')
  const pass = encodeURIComponent(password || '')
  return `${u.protocol}//${user}:${pass}@${u.host}/`
}
