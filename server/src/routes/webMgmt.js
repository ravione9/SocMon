import { Router } from 'express'
import http from 'http'
import https from 'https'
import zlib from 'zlib'
import crypto from 'crypto'
import Device from '../models/Device.js'
import { authenticate } from '../middleware/auth.js'
import { getPlainMgmtForUser } from '../utils/deviceUserCredential.js'
import { getRedis } from '../config/redis.js'

const router = Router()

// ── Signed self-contained session tokens ────────────────────────────────────
// Token = base64url(JSON payload) + "." + HMAC-SHA256(payload, secret)
//
// Benefits over server-side storage:
//   • Survives server restarts, Redis restarts, and horizontal scaling
//   • No GC needed — expiry is embedded in the payload and checked on read
//   • Tamper-proof — any modification invalidates the HMAC signature
//
// Legacy support: old opaque hex tokens (no ".") still resolve via
// Redis / in-memory so they continue working until they naturally expire.
const SESSION_SECRET  = process.env.SESSION_SECRET || process.env.JWT_SECRET || 'netpulse-web-mgmt-changeme'
const TTL_MS          = 30 * 60 * 1000  // 30 min
const TTL_SEC         = 30 * 60
const REDIS_PREFIX    = 'web-mgmt:session:'

// In-memory Map kept only as fallback for legacy opaque tokens
const SESSIONS_MEM = new Map()
function gcMem() {
  const now = Date.now()
  for (const [tok, s] of SESSIONS_MEM.entries()) {
    if (s.expiresAt < now) SESSIONS_MEM.delete(tok)
  }
}
setInterval(gcMem, 60_000).unref()

/** base64url — RFC 4648 §5 (no padding) */
function b64u(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Create a new signed, self-contained session token.
 * The token itself IS the session — nothing is stored server-side.
 */
function signSession(data) {
  const payload = b64u(Buffer.from(JSON.stringify(data)))
  const sig     = b64u(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest())
  return `${payload}.${sig}`
}

/**
 * Verify a signed token and return its payload, or null if invalid/expired.
 * Constant-time HMAC comparison prevents timing-based forgery attacks.
 */
function verifySignedToken(token) {
  const dot = token.indexOf('.')
  if (dot < 0) return null
  const payload  = token.slice(0, dot)
  const sig      = token.slice(dot + 1)
  const expected = b64u(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest())
  // Pad to equal length so timingSafeEqual won't throw on length mismatch
  const a = Buffer.from(sig.padEnd(expected.length, '\0'))
  const b = Buffer.from(expected)
  if (!crypto.timingSafeEqual(a, b) || sig.length !== expected.length) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    if (!data.expiresAt || data.expiresAt < Date.now()) return null
    return data
  } catch { return null }
}

/**
 * Resolve a session token → session data, or null if invalid/expired.
 *
 * Priority:
 *   1. Signed token  (new format — no server-side lookup needed)
 *   2. Legacy opaque token — check in-memory Map then Redis
 */
async function getSession(token) {
  if (!token) return null

  // New signed tokens contain exactly one "."
  if (token.includes('.')) return verifySignedToken(token)

  // Legacy opaque tokens (random hex) — check in-memory then Redis
  const mem = SESSIONS_MEM.get(token)
  if (mem) {
    if (mem.expiresAt < Date.now()) { SESSIONS_MEM.delete(token) }
    else return mem
  }
  try {
    const r = getRedis()
    if (r) {
      const raw = await r.get(REDIS_PREFIX + token)
      if (raw) {
        const s = JSON.parse(raw)
        SESSIONS_MEM.set(token, s)
        return s
      }
    }
  } catch { /* Redis unavailable */ }
  return null
}

/**
 * Authenticate against the device's web UI login endpoint and return its session cookies.
 *
 * FortiGate NGUI serves static assets (runtime.js, polyfills.js, main.js) behind session-auth.
 * Without a valid APSCOOKIE the Angular app never boots — every asset returns 401 and the
 * inline `extend-session` check immediately calls `login_redirect`.
 *
 * We POST to /logincheck (the standard FortiGate web-login endpoint) at session-creation time,
 * capture the resulting session cookie, embed it in the signed token, and inject it as a
 * Cookie header on every subsequent proxied request.
 *
 * Other devices (Cisco, etc.) that don't have /logincheck simply get a 404 from us and we
 * fall back to Basic-auth-only mode — no harm done.
 */
/**
 * Low-level helper: make one HTTPS/HTTP request and return { status, headers, body, cookies }.
 * Used by preAuthDevice to try multiple auth endpoints.
 */
function deviceRequest(ip, port, scheme, method, path, reqHeaders, reqBody) {
  const lib = scheme === 'https' ? https : http
  return new Promise(resolve => {
    const opts = {
      hostname: ip.replace(/^\[|\]$/g, ''),
      port,
      method,
      path,
      headers: { Host: `${ip}:${port}`, ...reqHeaders },
      rejectUnauthorized: false,
      timeout: 10_000,
    }
    const req = lib.request(opts, res => {
      const rawCookies = (res.headers['set-cookie'] || [])
        .map(c => c.split(';')[0].trim()).filter(Boolean)
      let body = ''
      res.setEncoding('utf8')
      res.on('data', d => { body += d })
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body,
        cookies: rawCookies,
        cookieStr: rawCookies.join('; '),
      }))
    })
    req.on('error',   () => resolve({ status: 0, headers: {}, body: '', cookies: [], cookieStr: '' }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '', cookies: [], cookieStr: '' }) })
    if (reqBody) req.write(reqBody)
    req.end()
  })
}

async function preAuthDevice(ip, port, scheme, username, password) {
  const tag = `[web-mgmt pre-auth ${ip}:${port}]`

  // ── Helper: run the login-disclaimer acceptance flow ──────────────────────
  // FortiGate v6/v7: after a successful credential check, the device sometimes
  // requires the admin to accept a login banner before issuing APSCOOKIE.
  // We GET the disclaimer page (to associate the session) then POST confirm=confirm.
  async function acceptDisclaimer(tempCookies, label) {
    const rd = await deviceRequest(ip, port, scheme, 'GET', '/logindisclaimer', { Cookie: tempCookies })
    console.log(`${tag} /logindisclaimer GET [${label}] → HTTP ${rd.status} | cookies: [${rd.cookies.join(', ') || 'none'}]`)
    if (rd.cookies.length) tempCookies = [...new Set([...tempCookies.split('; '), ...rd.cookies])].filter(Boolean).join('; ')

    const disclaimerBody = 'confirm=confirm'
    const ra = await deviceRequest(ip, port, scheme, 'POST', '/logindisclaimer', {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(disclaimerBody),
      Cookie:           tempCookies,
    }, disclaimerBody)
    console.log(`${tag} /logindisclaimer POST [${label}] → HTTP ${ra.status} | cookies: [${ra.cookies.join(', ') || 'none'}]`)
    if (ra.cookies.length) tempCookies = [...new Set([...tempCookies.split('; '), ...ra.cookies])].filter(Boolean).filter(Boolean).join('; ')
    return tempCookies
  }

  // ── Check if a cookie string contains a FortiGate session cookie ──────────
  function hasSessionCookie(cookieStr) {
    return Boolean(cookieStr) && (cookieStr.includes('APSCOOKIE') || cookieStr.includes('ccsrftoken'))
  }

  // ── Check disclaimer indicators in a response ─────────────────────────────
  function needsDisclaimer(r) {
    return r.body.includes('redir=/logindisclaimer') ||
           r.body.includes('/logindisclaimer') ||
           (r.headers && r.headers.location && r.headers.location.includes('logindisclaimer'))
  }

  // ── Strategy 1a: POST /logincheck with ajax=1 (FortiOS 6.x / 7.x) ────────
  // This is the standard FortiGate web-UI login endpoint.
  // Success → HTTP 200 or 302 + Set-Cookie: APSCOOKIE_... + ccsrftoken
  // Disclaimer required → HTTP 200/302, temp cookie, body/Location → /logindisclaimer
  // Trusted-host fail → HTTP 200/401/403, no cookie (silently rejected)
  // Wrong password → HTTP 200, no cookie, body often empty or redir=/logindisclaimer
  const formBodyAjax = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&ajax=1`
  const r1 = await deviceRequest(ip, port, scheme, 'POST', '/logincheck', {
    'Content-Type':   'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(formBodyAjax),
  }, formBodyAjax)

  // Log 300 chars of body + location header for diagnostics (visible in server terminal)
  console.log(
    `${tag} /logincheck(ajax=1) → HTTP ${r1.status}` +
    ` | cookies: [${r1.cookies.join(', ') || 'none'}]` +
    ` | location: ${r1.headers.location || '—'}` +
    ` | body[300]: ${r1.body.slice(0, 300).replace(/\n/g, '\\n')}`
  )

  // Direct success: FortiGate handed us APSCOOKIE immediately
  if (hasSessionCookie(r1.cookieStr)) {
    if (needsDisclaimer(r1)) {
      console.log(`${tag} [1a] cookies present + disclaimer → accepting disclaimer`)
      const finalCookies = await acceptDisclaimer(r1.cookieStr, '1a-disc')
      if (hasSessionCookie(finalCookies)) return { ok: true, cookies: finalCookies, reason: 'ajax-disclaimer' }
    }
    console.log(`${tag} [1a] direct success`)
    return { ok: true, cookies: r1.cookieStr, reason: 'ajax-direct' }
  }

  // Disclaimer without a cookie yet (credentials OK, but disclaimer gate is pre-cookie)
  if (needsDisclaimer(r1) && !hasSessionCookie(r1.cookieStr)) {
    console.log(`${tag} [1a] disclaimer detected (no cookie yet) — attempting auto-accept`)
    const finalCookies = await acceptDisclaimer(r1.cookieStr || '', '1a-noauth-disc')
    if (hasSessionCookie(finalCookies)) return { ok: true, cookies: finalCookies, reason: 'ajax-disclaimer-pre' }
    console.log(`${tag} [1a] disclaimer flow produced no session cookie — credentials may be wrong or Trusted Host restriction is active`)
  }

  // ── Strategy 1b: POST /logincheck WITHOUT ajax=1 ─────────────────────────
  // Older FortiOS firmware (5.x / some 6.x) ignores the ajax flag and always
  // returns HTTP 302 + Set-Cookie.  The ajax=1 variant on these builds sometimes
  // causes the cookie to be omitted from the 200 response.
  const formBodyPlain = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
  const r1b = await deviceRequest(ip, port, scheme, 'POST', '/logincheck', {
    'Content-Type':   'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(formBodyPlain),
  }, formBodyPlain)
  console.log(
    `${tag} /logincheck(plain) → HTTP ${r1b.status}` +
    ` | cookies: [${r1b.cookies.join(', ') || 'none'}]` +
    ` | location: ${r1b.headers.location || '—'}` +
    ` | body[150]: ${r1b.body.slice(0, 150).replace(/\n/g, '\\n')}`
  )

  if (hasSessionCookie(r1b.cookieStr)) {
    if (needsDisclaimer(r1b)) {
      const finalCookies = await acceptDisclaimer(r1b.cookieStr, '1b-disc')
      if (hasSessionCookie(finalCookies)) return { ok: true, cookies: finalCookies, reason: 'plain-disclaimer' }
    }
    console.log(`${tag} [1b] direct success`)
    return { ok: true, cookies: r1b.cookieStr, reason: 'plain-direct' }
  }

  // Any non-empty cookie from 1b is worth a disclaimer attempt even without APSCOOKIE
  if (r1b.cookieStr && needsDisclaimer(r1b)) {
    const finalCookies = await acceptDisclaimer(r1b.cookieStr, '1b-noauth-disc')
    if (hasSessionCookie(finalCookies)) return { ok: true, cookies: finalCookies, reason: 'plain-disclaimer-pre' }
  }

  // ── Explicit rejection signals ────────────────────────────────────────────
  // 401/403 OR FortiGate's known trusted-host/VPN-permission error strings
  if (r1.status === 401 || r1.status === 403 || r1b.status === 401 || r1b.status === 403 ||
      r1.body.includes('err=sslvpn_permission') || r1.body.includes('trusted host') ||
      r1.body.includes('Trusted Host') || r1b.body.includes('err=sslvpn_permission')) {
    console.log(`${tag} trusted-host or explicit rejection (HTTP ${r1.status} / ${r1b.status})`)
    return {
      ok: false, cookies: '',
      reason: `trusted-host-restriction: FortiGate returned HTTP ${r1.status} — the Netpulse server's source IP is not in this admin account's Trusted Hosts list. In FortiGate: System → Administrators → Edit [${username}] → Trusted Hosts → add the Netpulse server IP or set to 0.0.0.0/0.`,
    }
  }

  // ── Strategy 2: FortiGate REST API authentication ─────────────────────────
  // FortiOS 6.2+: POST /api/v2/authentication
  // Returns a session token in the response body; for web-UI use we need the cookie.
  const apiBody = JSON.stringify({ username, password, async: true })
  const r2 = await deviceRequest(ip, port, scheme, 'POST', '/api/v2/authentication', {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(apiBody),
  }, apiBody)
  console.log(
    `${tag} /api/v2/authentication → HTTP ${r2.status}` +
    ` | cookies: [${r2.cookies.join(', ') || 'none'}]` +
    ` | body[120]: ${r2.body.slice(0, 120).replace(/\n/g, '\\n')}`
  )

  if (hasSessionCookie(r2.cookieStr) && (r2.status === 200 || r2.status === 201)) {
    console.log(`${tag} REST API auth succeeded`)
    return { ok: true, cookies: r2.cookieStr, reason: 'rest-api' }
  }
  // REST API may return a bearer token instead of a cookie — if so, inject it
  if (r2.status === 200 && r2.body.includes('access_token')) {
    try {
      const parsed = JSON.parse(r2.body)
      if (parsed.access_token) {
        // Store as a synthetic cookie-like header value; the proxy injects it
        const synthCookie = `access_token=${parsed.access_token}`
        console.log(`${tag} REST API bearer token obtained`)
        return { ok: true, cookies: synthCookie, reason: 'rest-api-bearer' }
      }
    } catch { /* not JSON */ }
  }

  // ── Determine specific failure reason ─────────────────────────────────────
  const allBodies = r1.body + ' ' + r1b.body
  let reason
  if (allBodies.includes('Two-factor') || allBodies.includes('2fa') ||
      allBodies.includes('OTP') || allBodies.includes('one-time')) {
    reason = [
      'two-factor-auth: This admin account has 2FA/OTP enabled.',
      'Netpulse cannot pre-authenticate accounts with 2FA.',
      'Disable 2FA for this account, or create a dedicated service account (Admin Profile: Super_Admin) without 2FA.',
    ].join(' ')
  } else {
    // When SSH works but /logincheck returns 200 with no cookie, the most common
    // cause is Trusted Host restriction — FortiGate silently drops the login when
    // the source IP is not in the admin account's trusted-hosts list.
    reason = [
      `/logincheck returned HTTP ${r1.status} with no session cookie.`,
      `Most likely causes (in order):`,
      `(1) Trusted Host restriction — FortiGate System → Administrators → Edit [${username}] → Trusted Hosts → add the Netpulse server IP, or set to 0.0.0.0/0 to allow any source IP.`,
      `(2) Admin profile does not allow GUI login — the account must use a profile with "System" access; REST-API-only profiles won't work for the web UI.`,
      `(3) Account locked — check System → Administrators in FortiGate for a lock icon next to the account.`,
      `(4) Wrong password — verify the password in Admin → Devices → Edit.`,
      `Check the server terminal for the body[300] log line above to see FortiGate's raw rejection message.`,
    ].join(' ')
  }

  console.log(`${tag} all strategies failed — ${reason}`)
  return { ok: false, cookies: '', reason }
}

/** Quick reachability probe — tells the client if the device is reachable from the server. */
router.get('/probe/:deviceId', authenticate, async (req, res) => {
  try {
    const dev = await Device.findById(req.params.deviceId)
    if (!dev) return res.status(404).json({ error: 'Device not found' })

    const ip   = String(dev.ip || '').trim()
    const hp   = Number(dev.httpsPort) > 0 ? Number(dev.httpsPort) : 443
    const reachable = await new Promise(resolve => {
      const req2 = https.request(
        { hostname: ip, port: hp, path: '/', method: 'HEAD', rejectUnauthorized: false, timeout: 6000 },
        r => { r.resume(); resolve({ ok: true, status: r.statusCode }) }
      )
      req2.on('error', e => resolve({ ok: false, error: e.message }))
      req2.on('timeout', () => { req2.destroy(); resolve({ ok: false, error: 'timeout' }) })
      req2.end()
    })
    res.json({ ip, httpsPort: hp, ...reachable })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/session/:deviceId', authenticate, async (req, res) => {
  try {
    const dev = await Device.findById(req.params.deviceId)
    if (!dev) return res.status(404).json({ error: 'Device not found' })
    if (!dev.ip) return res.status(400).json({ error: 'Device has no IP' })

    const scheme = req.query.scheme === 'http' ? 'http' : 'https'
    const ip     = String(dev.ip).trim()
    const port   = scheme === 'https'
      ? (Number(dev.httpsPort) > 0 ? Number(dev.httpsPort) : 443)
      : 80

    // Pre-authenticate with the device so its session cookie travels with every
    // proxied request.  FortiGate NGUI gates even static JS behind session-auth;
    // without APSCOOKIE the Angular app never boots (all assets → 401).
    const plain = await getPlainMgmtForUser(req.user._id, dev._id)
    const hasCredentials = Boolean(plain.mgmtUsername && plain.password)
    let devCookies   = ''
    let preAuthOk    = false
    let preAuthReason = null
    if (hasCredentials) {
      try {
        const auth = await preAuthDevice(ip, port, scheme, plain.mgmtUsername, plain.password)
        preAuthOk    = auth.ok
        devCookies   = auth.cookies || ''
        preAuthReason = auth.reason || null
      } catch (e) {
        preAuthReason = `Exception during pre-auth: ${e.message}`
        console.warn('[web-mgmt] pre-auth error (non-fatal):', e.message)
      }
    } else {
      console.log(`[web-mgmt] no credentials for user ${req.user?._id} on device ${dev._id} (${ip}) — FortiGate NGUI will likely 401`)
    }

    // Signed self-contained token — no server-side storage required.
    // Survives server restarts, Redis restarts, and pod restarts.
    const token = signSession({
      deviceId:  String(dev._id),
      userId:    String(req.user?._id || ''),
      scheme,
      expiresAt: Date.now() + TTL_MS,
      cookies:   devCookies,   // device session cookies (e.g. FortiGate APSCOOKIE)
    })
    res.json({
      token,
      url:            `/api/web-mgmt/p/${token}/`,
      scheme,
      expiresInMs:    TTL_MS,
      hasCredentials,
      preAuthOk,
      // Hint for the client: if pre-auth failed, warn the user what to fix
      preAuthWarning: !hasCredentials
        ? 'No management credentials saved for your user on this device. FortiGate NGUI needs a valid session — edit the device and set your username and password (stored per user, not shared).'
        : !preAuthOk
          ? (preAuthReason || `Login to ${ip}:${port} failed. Check your saved credentials in the device form.`)
          : null,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

const FRAME_BLOCK_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]

/**
 * Strip the default port from a URL host so comparisons work whether or not
 * the redirect Location includes it.
 *   "192.168.24.4:443"  (https) → "192.168.24.4"
 *   "192.168.24.4:80"   (http)  → "192.168.24.4"
 *   "192.168.24.4:8443" (https) → "192.168.24.4:8443"  (non-default, kept)
 */
function stripDefaultPort(host, scheme) {
  if (!host) return ''
  if (scheme === 'https' && host.endsWith(':443')) return host.slice(0, -4)
  if (scheme === 'http'  && host.endsWith(':80'))  return host.slice(0, -3)
  return host
}

/**
 * Return true when a full redirect URL points back at the same device.
 * This is the fix for the FortiGate blank-iframe bug:
 *   FortiGate at 192.168.24.4:443 redirects to https://192.168.24.4/ng/
 *   URL.host → "192.168.24.4"  (port omitted because 443 is default)
 *   Our deviceHostKey → "192.168.24.4:443"
 *   Old code: "192.168.24.4" !== "192.168.24.4:443" → redirect NOT rewritten → blank iframe
 *   New code: strip default ports before comparing → match → redirect rewritten correctly
 */
function redirectIsToDevice(location, deviceIp, devicePort, scheme) {
  try {
    const u = new URL(location)
    const locScheme = u.protocol.replace(':', '')
    const normLoc = stripDefaultPort(u.host, locScheme)
    const normDev = stripDefaultPort(`${deviceIp}:${devicePort}`, scheme)
    return normLoc === normDev || u.hostname === deviceIp
  } catch {
    return false
  }
}

function rewriteLocation(loc, mountPath, deviceIp, devicePort, scheme) {
  if (!loc) return loc
  try {
    if (/^https?:\/\//i.test(loc)) {
      if (redirectIsToDevice(loc, deviceIp, devicePort, scheme)) {
        const u = new URL(loc)
        return mountPath + u.pathname + u.search + u.hash
      }
      return loc // external redirect — leave as-is
    }
    if (loc.startsWith('/')) return mountPath + loc
    return loc
  } catch {
    return loc
  }
}

function rewriteSetCookie(arr, mountPath) {
  if (!arr) return arr
  const list = Array.isArray(arr) ? arr : [arr]
  return list.map(c => {
    let out = c
    out = out.replace(/;\s*Path=[^;]*/i, `; Path=${mountPath}/`)
    if (!/Path=/i.test(out)) out += `; Path=${mountPath}/`
    out = out.replace(/;\s*Domain=[^;]*/i, '')
    out = out.replace(/;\s*Secure\b/i, '')
    out = out.replace(/;\s*SameSite=[^;]*/i, '')
    return out
  })
}

/**
 * JS shim injected into every proxied HTML page.
 *
 * Intercepts ALL navigation patterns so the SPA stays within the proxy:
 *   - fetch / XHR / WebSocket
 *   - history.pushState / replaceState
 *   - location.assign / location.replace
 *   - location.href setter  ← KEY: catches window.location.href = '/path'
 *                                   AND window.location.href = 'https://device-ip/path'
 *   - <a> clicks (dynamically created links)
 *
 * @param {string} mountPath  e.g. /api/web-mgmt/p/<token>
 * @param {string} deviceIp   e.g. 192.168.24.4  (used to rewrite full device URLs)
 */
function clientShim(mountPath, deviceIp) {
  const p   = JSON.stringify(mountPath)
  const dip = JSON.stringify(String(deviceIp || ''))
  // String.raw preserves every backslash literally so that \/ in regexes does NOT
  // become // (a JS line comment) when emitted into the browser's <script> tag.
  return String.raw`<script>(function(){
var P=${p},DIP=${dip};
/* ── 1. iframe-detection bypass ─────────────────────────────────────────────
   Enterprise UIs (FortiGate NGUI, Cisco, etc.) often check window.top !== window
   or window.frameElement !== null and refuse to render inside an iframe.
   Spoof them so the app thinks it is the top-level browsing context. */
try{['top','parent'].forEach(function(k){
  try{Object.defineProperty(window,k,{get:function(){return window;},configurable:true,enumerable:true});}catch(e){}
});}catch(e){}
try{Object.defineProperty(window,'frameElement',{get:function(){return null;},configurable:true,enumerable:true});}catch(e){}

/* ── 2. URL helpers ─────────────────────────────────────────────────────── */
function isDev(u){if(!DIP||!u)return false;try{return new URL(u).hostname===DIP;}catch(e){return false;}}
/* Rewrite a URL to stay within the proxy:
   /path              → P/path
   //host/path        → P/path  (protocol-relative)
   https://device/p   → P/p
   everything else    → unchanged  */
function fix(u){
  if(typeof u!=='string'||!u)return u;
  if(u.charAt(0)==='/'&&u.charAt(1)==='/'&&isDev('https:'+u)){try{var pr=new URL('https:'+u);return P+pr.pathname+pr.search+pr.hash;}catch(e){}}
  if(u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.indexOf(P)!==0)return P+u;
  if(/^https?:\/\//i.test(u)&&isDev(u)){try{var x=new URL(u);return P+x.pathname+x.search+x.hash;}catch(e){}}
  return u;
}

/* ── 3. fetch ───────────────────────────────────────────────────────────── */
if(window.fetch){var _f=window.fetch.bind(window);window.fetch=function(i,o){
  try{if(typeof i==='string')i=fix(i);else if(i&&typeof i.url==='string')i=new Request(fix(i.url),i);}catch(e){}
  return _f(i,o);
};}
/* ── 4. XHR ─────────────────────────────────────────────────────────────── */
if(window.XMLHttpRequest){var _x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){
  try{arguments[1]=fix(u);}catch(e){}return _x.apply(this,arguments);
};}
/* ── 5. WebSocket ───────────────────────────────────────────────────────── */
var _ws=window.WebSocket;if(_ws){window.WebSocket=function(u,pr){
  try{if(typeof u==='string'){if(u.charAt(0)==='/')u=(location.origin.replace(/^http/,'ws'))+P+u;else if(/^wss?:\/\//i.test(u)&&isDev(u)){var wx=new URL(u);u=(wx.protocol==='wss:'?'wss:':'ws:')+'//'+(location.host)+P+wx.pathname+wx.search;}}
  }catch(e){}return pr?new _ws(u,pr):new _ws(u);
};window.WebSocket.prototype=_ws.prototype;}
/* ── 6. history ─────────────────────────────────────────────────────────── */
try{
  var _pu=history.pushState.bind(history),_rp=history.replaceState.bind(history);
  history.pushState=function(s,t,u){return _pu(s,t,u!=null?fix(String(u)):u);};
  history.replaceState=function(s,t,u){return _rp(s,t,u!=null?fix(String(u)):u);};
}catch(e){}
/* ── 7. location.assign / location.replace ──────────────────────────────── */
try{
  var _la=location.assign.bind(location),_lr=location.replace.bind(location);
  location.assign=function(u){return _la(fix(u));};
  location.replace=function(u){return _lr(fix(u));};
}catch(e){}
/* ── 8. location.href setter ────────────────────────────────────────────── */
try{
  var _hd=Object.getOwnPropertyDescriptor(Location.prototype,'href');
  if(_hd&&_hd.set){
    Object.defineProperty(Location.prototype,'href',{
      get:_hd.get,
      set:function(v){_hd.set.call(this,fix(String(v||'')));},
      configurable:true,enumerable:true,
    });
  }
}catch(e){}
/* ── 8b. window.open — FortiGate "tools" / diagnostics often open in a new window;
   without this, the browser loads https://device-ip/… directly (unreachable / wrong cert). */
try{
  var _wo=window.open;
  window.open=function(url,name,features){
    try{
      if(url!=null&&String(url)!==''){
        var s=String(url);
        if(/^\s*mailto:/i.test(s)||/^\s*tel:/i.test(s)||/^\s*data:/i.test(s))
          return _wo.apply(window,arguments);
        var u=fix(s);
        var abs=/^https?:\/\//i.test(u)?u:((location.origin||'')+(u.charAt(0)==='/'?u:'/'+u));
        return _wo.call(window,abs,name,features);
      }
    }catch(e2){}
    return _wo.apply(window,arguments);
  };
}catch(e){}
/* ── 9. <a> clicks ──────────────────────────────────────────────────────── */
document.addEventListener('click',function(ev){
  var el=ev.target&&ev.target.closest('a');if(!el)return;
  var h=el.getAttribute('href');
  if(!h||h.charAt(0)==='#'||/^\s*javascript:/i.test(h))return;
  var t=(el.getAttribute('target')||'').toLowerCase();
  if(t==='_blank'||t==='_new'){
    if(/^\s*mailto:/i.test(h)||/^\s*tel:/i.test(h)||/^\s*data:/i.test(h))return;
    ev.preventDefault();
    var u=fix(h);
    var abs=/^https?:\/\//i.test(u)?u:((location.origin||'')+(u.charAt(0)==='/'?u:'/'+u));
    window.open(abs,'_blank','noopener,noreferrer');
    return;
  }
  if(h.charAt(0)==='/'&&h.charAt(1)!=='/'&&h.indexOf(P)!==0){
    ev.preventDefault();history.pushState(null,'',fix(h));
  }
},true);
/* ── 10. document.write shim ────────────────────────────────────────────── */
try{
  var _dw=document.write.bind(document);
  document.write=function(s){return _dw(typeof s==='string'?s.replace(/(<(?:src|href|action)\s*=\s*["'])\/(?!\/)/gi,function(m,pre){return pre+P+'/';}):'');};
}catch(e){}
console.debug('[netpulse-proxy] shim active on',P,'device',DIP,'top?',window===window.top);
})();</script>`
}

function rewriteHtmlAttrs(html, mountPath) {
  const re = /(\s(?:src|href|action|poster|cite|formaction|data|manifest)\s*=\s*)(["'])\/(?!\/)([^"']*)\2/gi
  return html.replace(re, (_, prefix, q, path) => `${prefix}${q}${mountPath}/${path}${q}`)
}

/**
 * Inject <base href> and the proxy shim into an HTML response.
 *
 * WHY subPath matters for Angular/Vue SPAs (e.g. FortiGate /ng/):
 *   FortiGate's Angular app is compiled with base href "/ng/".
 *   Angular strips the base from the current URL to derive its route.
 *   If we always set base = mountPath + "/", Angular sees "/ng/" as a
 *   sub-path of the app root → no route match → blank white page.
 *
 *   Fix: set <base href> = mountPath + DIRECTORY OF THE RESPONSE PATH so
 *   the SPA sees the same relative position it was compiled for:
 *     response at  /ng/          → base = /api/web-mgmt/p/{tok}/ng/
 *     response at  /ng/index.html → base = /api/web-mgmt/p/{tok}/ng/
 *     response at  /             → base = /api/web-mgmt/p/{tok}/
 *
 *   The shim's fix() still uses mountPath (not base) for rewriting absolute
 *   paths, so API calls like fetch('/api/v2/...') still route correctly.
 *
 * WHY we strip CSP / XFO meta tags:
 *   We already delete Content-Security-Policy from the upstream *response headers*,
 *   but devices (FortiGate NGUI, Cisco) often repeat the policy inside the HTML:
 *     <meta http-equiv="Content-Security-Policy" content="script-src 'nonce-XYZ' ...">
 *   That meta CSP is enforced by the browser even when the header is gone, and it
 *   blocks our <script> shim (no matching nonce) → blank page.
 *   Stripping these meta tags removes all content-level CSP so the shim can run.
 */
function injectBaseTag(html, mountPath, deviceIp, subPath) {
  // Derive the directory portion of the response's path
  const sp  = subPath || '/'
  const dir = sp.endsWith('/') ? sp : sp.replace(/\/[^/]*$/, '/')
  const baseHref = mountPath + dir

  let out = html

  // ── Strip security-related <meta> tags that would block our shim or iframe ──
  // CSP in meta tags is enforced by the browser just like the HTTP header.
  out = out.replace(/<meta\s[^>]*http-equiv\s*=\s*["']content-security-policy["'][^>]*\/?>/gi, '')
  out = out.replace(/<meta\s[^>]*http-equiv\s*=\s*["']x-frame-options["'][^>]*\/?>/gi, '')
  // Some devices use reversed attribute order: content="..." http-equiv="..."
  out = out.replace(/<meta\s[^>]*content\s*=\s*["'][^"']*["'][^>]*http-equiv\s*=\s*["']content-security-policy["'][^>]*\/?>/gi, '')
  out = out.replace(/<meta\s[^>]*content\s*=\s*["'][^"']*["'][^>]*http-equiv\s*=\s*["']x-frame-options["'][^>]*\/?>/gi, '')

  // ── Remove any existing <base> tag (we'll inject the correct one) ──
  out = out.replace(/<base\s[^>]*\/?\s*>/gi, '')

  // ── Rewrite absolute-path src/href/action attributes ──
  out = rewriteHtmlAttrs(out, mountPath)

  // ── Inject our base href + shim at the very start of <head> ──
  const head = `<base href="${baseHref}">${clientShim(mountPath, deviceIp)}`
  if (/<head[^>]*>/i.test(out)) {
    return out.replace(/<head([^>]*)>/i, `<head$1>${head}`)
  }
  if (/<html[^>]*>/i.test(out)) {
    return out.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`)
  }
  return head + out
}

/** Rewrite absolute-path url() and @import references in CSS files. */
function rewriteCss(css, mountPath) {
  let out = css.replace(/url\(\s*(['"]?)\/(?!\/)([^)'"]*)\1\s*\)/gi,
    (_, q, path) => `url(${q}${mountPath}/${path}${q})`)
  out = out.replace(/@import\s+(['"])\/(?!\/)([^'"]*)\1/gi,
    (_, q, path) => `@import ${q}${mountPath}/${path}${q}`)
  return out
}

function decompressBody(buf, enc) {
  const e = (enc || '').toLowerCase()
  try {
    if (e === 'gzip')    return zlib.gunzipSync(buf)
    if (e === 'br')      return zlib.brotliDecompressSync(buf)
    if (e === 'deflate') { try { return zlib.inflateSync(buf) } catch { return zlib.inflateRawSync(buf) } }
  } catch { /* fall through — return raw */ }
  return buf
}

function proxyErrHtml(title, detail) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:32px;font-family:monospace;background:#1a1a2e;color:#e0e0e0;}
h2{color:#f5534f;margin:0 0 12px;}p{color:#aaa;margin:4px 0;word-break:break-all;}
.hint{margin-top:20px;padding:12px;border-radius:8px;background:rgba(79,126,245,0.12);color:#8ab4f8;font-size:12px;}
</style></head><body>
<h2>⚠ ${title}</h2><p>${detail}</p>
<div class="hint">Tip: Check the device IP and port in Admin → Devices. If using HTTPS on a non-standard port (e.g. 4444), make sure the device is actually running its web UI on that port and is reachable from the Netpulse server.</div>
</body></html>`
}

router.use('/p/:token', async (req, res) => {
  // Remove Helmet security headers that would block the iframe.
  res.removeHeader('X-Frame-Options')
  res.removeHeader('Content-Security-Policy')
  res.removeHeader('Cross-Origin-Embedder-Policy')
  res.removeHeader('Cross-Origin-Opener-Policy')
  res.removeHeader('Cross-Origin-Resource-Policy')

  const session = await getSession(req.params.token)
  if (!session) {
    return res.status(401).type('html').send(proxyErrHtml('Session expired', 'Web UI proxy session expired or invalid. Close and re-open the Web UI from Netpulse.'))
  }

  try {
    const dev = await Device.findById(session.deviceId)
    if (!dev) return res.status(404).type('html').send(proxyErrHtml('Device not found', 'The device was deleted or is no longer in Netpulse.'))

    const isHttps   = session.scheme !== 'http'
    const scheme    = isHttps ? 'https' : 'http'
    const ip        = String(dev.ip).trim()
    const port      = isHttps
      ? (Number(dev.httpsPort) > 0 ? Number(dev.httpsPort) : 443)
      : 80
    const mountPath = req.baseUrl // /api/web-mgmt/p/<token>
    const subPath   = req.url || '/'

    const upHeaders = { ...req.headers }
    delete upHeaders.host
    upHeaders.host = `${ip}:${port}`
    delete upHeaders.referer
    delete upHeaders.origin
    upHeaders['accept-encoding'] = 'identity' // disable compression so we can transform

    // Inject the device session cookie captured at session-creation time.
    // FortiGate NGUI requires APSCOOKIE on every request — including static assets.
    if (session.cookies) {
      const existing = upHeaders.cookie ? upHeaders.cookie + '; ' : ''
      upHeaders.cookie = existing + session.cookies
    }

    // Basic-auth fallback for devices that accept it (Cisco, generic HTTP devices).
    // FortiGate ignores this header for web-UI requests (it uses cookies instead).
    let basicUser = ''
    let basicPass = ''
    if (session.userId) {
      const cred = await getPlainMgmtForUser(session.userId, session.deviceId)
      basicUser = cred.mgmtUsername || ''
      basicPass = cred.password || ''
    }
    if (basicUser && basicPass && !upHeaders.authorization) {
      upHeaders.authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`
    }

    const opts = {
      hostname: ip.replace(/^\[|\]$/g, ''),
      port,
      method:  req.method,
      path:    subPath,
      headers: upHeaders,
      rejectUnauthorized: false,
      timeout: 30_000,
    }

    const lib = isHttps ? https : http
    const upstream = lib.request(opts, upRes => {
      const outHeaders = { ...upRes.headers }
      for (const h of FRAME_BLOCK_HEADERS) delete outHeaders[h]

      // ── KEY FIX: rewrite Location using default-port-aware comparison ──
      if (outHeaders.location) {
        outHeaders.location = rewriteLocation(outHeaders.location, mountPath, ip, port, scheme)
      }
      if (outHeaders['set-cookie']) {
        outHeaders['set-cookie'] = rewriteSetCookie(outHeaders['set-cookie'], mountPath)
      }

      const ct     = String(upRes.headers['content-type'] || '').toLowerCase()
      const enc    = String(upRes.headers['content-encoding'] || '').toLowerCase()
      const status = upRes.statusCode || 200

      // ── Correct-MIME stubs for error responses to script/style requests ───
      // Problem: Cisco switch (and others) return text/html for 404s on missing
      // feature modules (mrpRingDirective.js, ewlc_common_js.js, etc.).
      // Chrome's strict MIME checking blocks any <script> response that isn't
      // a JS MIME type — even a 404 — producing:
      //   "Refused to execute script ... MIME type ('text/html')"
      // Fix: drain the upstream body and reply with the correct MIME type +
      // an empty stub.  The browser/framework handles the 4xx status normally
      // (fires onerror / rejects the promise) without the MIME noise.
      if (status >= 400) {
        const rawPath = subPath.split('?')[0]
        if (rawPath.endsWith('.js') || rawPath.endsWith('.mjs') || rawPath.endsWith('.cjs')) {
          upRes.resume()   // drain so the socket is freed
          return res.status(status).type('application/javascript').send('/* unavailable */\n')
        }
        if (rawPath.endsWith('.css')) {
          upRes.resume()
          return res.status(status).type('text/css').send('/* unavailable */\n')
        }
        // For all other error responses (HTML 404 pages, API errors, etc.) fall
        // through to the normal transform / stream path below so the user sees
        // the actual device error page if they navigated to a missing route.
      }

      const needsTransform = (ct.includes('text/html') || ct.includes('text/css')) && status < 400

      if (needsTransform) {
        delete outHeaders['content-length']
        delete outHeaders['transfer-encoding']
        delete outHeaders['content-encoding']

        const chunks = []
        upRes.on('data', c => chunks.push(c))
        upRes.on('end', () => {
          try {
            const buf  = decompressBody(Buffer.concat(chunks), enc)
            let   body = buf.toString('utf8')
            body = ct.includes('text/html') ? injectBaseTag(body, mountPath, ip, subPath) : rewriteCss(body, mountPath)
            res.status(upRes.statusCode || 502)
            for (const [k, v] of Object.entries(outHeaders)) { if (v != null) res.setHeader(k, v) }
            res.end(body)
          } catch (e) {
            if (!res.headersSent) res.status(502).type('html').send(proxyErrHtml('Proxy transform error', e.message))
          }
        })
        upRes.on('error', () => { try { res.end() } catch { /**/ } })
        return
      }

      // Binary / non-HTML — stream directly.
      res.status(upRes.statusCode || 502)
      for (const [k, v] of Object.entries(outHeaders)) { if (v != null) res.setHeader(k, v) }
      upRes.pipe(res)
    })

    upstream.on('error', e => {
      const msg = `Cannot reach ${ip}:${port} — ${e.message}. Check the device IP/port and ensure it is reachable from the Netpulse server.`
      if (!res.headersSent) res.status(502).type('html').send(proxyErrHtml('Device unreachable', msg))
      else try { res.end() } catch { /**/ }
    })
    upstream.on('timeout', () => {
      upstream.destroy()
      const msg = `Connection to ${ip}:${port} timed out after 30 s. The device may be offline or the port may be wrong.`
      if (!res.headersSent) res.status(504).type('html').send(proxyErrHtml('Connection timeout', msg))
    })

    // Only pipe body for requests that actually carry one; always call end() for GET/HEAD.
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method)
    if (hasBody) req.pipe(upstream)
    else upstream.end()

  } catch (e) {
    if (!res.headersSent) res.status(500).type('html').send(proxyErrHtml('Server error', `Device lookup failed: ${e.message}`))
  }
})

export default router

/**
 * WebSocket upgrade proxy for the device Web UI.
 *
 * Attach to the raw HTTP server BEFORE Socket.IO so we intercept WS upgrades
 * that belong to the web-mgmt proxy:
 *
 *   httpServer.on('upgrade', proxyWsUpgrade)
 *
 * When a proxied SPA (FortiGate, Cisco) calls:
 *   new WebSocket('/realtime')          →  shim rewrites to ws://server/api/web-mgmt/p/<tok>/realtime
 *   new WebSocket('wss://192.168.x.y/') →  shim rewrites to ws://server/api/web-mgmt/p/<tok>/
 *
 * The browser sends the HTTP Upgrade to the Netpulse server; we forward it
 * over TLS (rejectUnauthorized:false for self-signed certs) to the real device
 * and pipe the frames bidirectionally.
 */
export async function proxyWsUpgrade(req, socket, head) {
  // Only handle paths under our proxy mount
  const match = req.url.match(/^\/api\/web-mgmt\/p\/([^/?#]+)(\/[^?#]*)?(\?.*)?/)
  if (!match) return // not ours — Socket.IO or other handlers will take it

  const token   = match[1]
  const subPath = (match[2] || '/') + (match[3] || '')  // path + query string

  const session = await getSession(token)
  if (!session) {
    try { socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); socket.destroy() } catch { /**/ }
    return
  }

  try {
    const dev = await Device.findById(session.deviceId)
    if (!dev) {
      try { socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); socket.destroy() } catch { /**/ }
      return
    }

    const ip      = String(dev.ip).trim()
    const port    = session.scheme !== 'http'
      ? (Number(dev.httpsPort) > 0 ? Number(dev.httpsPort) : 443)
      : 80
    const isHttps = session.scheme !== 'http'
    const lib     = isHttps ? https : http

    // Forward all original headers but fix Host / Origin / Referer
    const upHeaders = { ...req.headers }
    upHeaders.host   = `${ip}:${port}`
    delete upHeaders.origin
    delete upHeaders.referer

    // Inject device session cookie (same as HTTP proxy — FortiGate WS endpoints need it too)
    if (session.cookies) {
      const existing = upHeaders.cookie ? upHeaders.cookie + '; ' : ''
      upHeaders.cookie = existing + session.cookies
    }

    // Basic-auth fallback (per user who opened the session)
    let basicUser = ''
    let basicPass = ''
    if (session.userId) {
      const cred = await getPlainMgmtForUser(session.userId, session.deviceId)
      basicUser = cred.mgmtUsername || ''
      basicPass = cred.password || ''
    }
    if (basicUser && basicPass && !upHeaders.authorization) {
      upHeaders.authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`
    }

    const upReq = lib.request({
      hostname: ip.replace(/^\[|\]$/g, ''),
      port,
      path:    subPath,
      method:  'GET',
      headers: upHeaders,
      rejectUnauthorized: false,
      timeout: 30_000,
    })

    upReq.on('upgrade', (upRes, upSocket, upHead) => {
      let reply = 'HTTP/1.1 101 Switching Protocols\r\n'
      reply += `Upgrade: ${upRes.headers['upgrade'] || 'websocket'}\r\n`
      reply += 'Connection: Upgrade\r\n'
      if (upRes.headers['sec-websocket-accept'])    reply += `Sec-WebSocket-Accept: ${upRes.headers['sec-websocket-accept']}\r\n`
      if (upRes.headers['sec-websocket-protocol'])  reply += `Sec-WebSocket-Protocol: ${upRes.headers['sec-websocket-protocol']}\r\n`
      if (upRes.headers['sec-websocket-extensions'])reply += `Sec-WebSocket-Extensions: ${upRes.headers['sec-websocket-extensions']}\r\n`
      reply += '\r\n'
      socket.write(reply)

      if (upHead && upHead.length) upSocket.unshift(upHead)
      if (head   && head.length)   socket.unshift(head)

      upSocket.pipe(socket)
      socket.pipe(upSocket)
      upSocket.on('error', () => { try { socket.destroy()   } catch { /**/ } })
      socket.on('error',   () => { try { upSocket.destroy() } catch { /**/ } })
      upSocket.on('close', () => { try { socket.destroy()   } catch { /**/ } })
      socket.on('close',   () => { try { upSocket.destroy() } catch { /**/ } })
    })

    upReq.on('error', e => {
      console.error('[ws-proxy] upstream error:', e.message)
      try { socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); socket.destroy() } catch { /**/ }
    })
    upReq.on('timeout', () => {
      upReq.destroy()
      try { socket.write('HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\n\r\n'); socket.destroy() } catch { /**/ }
    })

    upReq.end()
  } catch (e) {
    console.error('[ws-proxy] error:', e.message)
    try { socket.write('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n'); socket.destroy() } catch { /**/ }
  }
}
