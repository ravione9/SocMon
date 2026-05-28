/**
 * SolarWinds Orion — server-side credentials from environment only.
 * SWIS REST (filters / API) and web-console pre-auth for the in-app proxy.
 */

import https from 'https'
import http from 'http'

const SWIS_PATH = '/SolarWinds/InformationService/v3/Json'

function requestTimeoutMs() {
  const n = Number(process.env.ORION_REQUEST_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 15_000
}

function tlsInsecure() {
  return ['1', 'true', 'yes'].includes(String(process.env.ORION_TLS_INSECURE || '').toLowerCase())
}

function insecureAgent() {
  if (!tlsInsecure()) return undefined
  return new https.Agent({ rejectUnauthorized: false })
}

/** @returns {{ scheme: string, hostname: string, port: number, origin: string }} */
export function parseOrionWebUrl() {
  const raw = (process.env.ORION_WEB_URL || 'http://192.168.10.100:8787').trim()
  const u = new URL(raw)
  const scheme = u.protocol.replace(':', '') || 'http'
  const port = u.port
    ? Number(u.port)
    : scheme === 'https'
      ? 443
      : 80
  return { scheme, hostname: u.hostname, port, origin: u.origin.replace(/\/$/, '') }
}

export function resolveOrionSwisBase() {
  const explicit = (process.env.ORION_SWIS_URL || '').trim().replace(/\/$/, '')
  if (explicit) return explicit
  const web = parseOrionWebUrl()
  return `${web.scheme === 'https' ? 'https' : 'http'}://${web.hostname}:17774${SWIS_PATH}`
}

export function getOrionUsername() {
  const user = (process.env.ORION_USERNAME || '').trim()
  if (!user) return ''
  if (user.includes('\\') || user.includes('@')) return user
  const domain = (process.env.ORION_DOMAIN || '').trim()
  if (domain) return `${domain}\\${user}`
  return user
}

export function getOrionPassword() {
  return process.env.ORION_PASSWORD || ''
}

export function isOrionConfigured() {
  return Boolean(getOrionUsername() && getOrionPassword())
}

export function orionBasicAuthHeader() {
  const user = getOrionUsername()
  const pass = getOrionPassword()
  if (!user || !pass) return null
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
}

function collectSetCookie(headers) {
  const raw = headers['set-cookie']
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

function cookieStr(cookies) {
  return cookies.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ')
}

function mergeCookies(existing, incoming) {
  const map = new Map()
  for (const c of [...existing, ...incoming]) {
    const part = c.split(';')[0].trim()
    if (!part) continue
    const eq = part.indexOf('=')
    const key = eq >= 0 ? part.slice(0, eq) : part
    map.set(key, part)
  }
  return [...map.values()]
}

/**
 * Low-level raw HTTP/HTTPS request, returns body text + cookies.
 * Follows a single redirect (3xx) so Orion login POSTs work correctly.
 */
function orionRawRequest(target, { method = 'GET', path = '/', reqHeaders = {}, body = null, cookies = [], followRedirect = true } = {}) {
  const lib = target.scheme === 'https' ? https : http
  const to = requestTimeoutMs()

  return new Promise((resolve) => {
    const allCookies = cookieStr(cookies)
    const hdrs = {
      host: `${target.hostname}:${target.port}`,
      'user-agent': 'Mozilla/5.0 (compatible; Netpulse/1.0)',
      connection: 'close',
      ...reqHeaders,
    }
    if (allCookies) hdrs.cookie = allCookies
    if (body) hdrs['content-length'] = String(Buffer.byteLength(body))

    const opts = {
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      method,
      path,
      headers: hdrs,
      rejectUnauthorized: !tlsInsecure(),
      timeout: to,
    }
    const agent = target.scheme === 'https' ? insecureAgent() : undefined
    if (agent) opts.agent = agent

    const req = lib.request(opts, (res) => {
      const newCookies = collectSetCookie(res.headers)
      let bodyText = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { bodyText += d })
      res.on('end', () => {
        const allC = mergeCookies(cookies, newCookies)
        const location = res.headers['location'] || null

        // Follow one 3xx redirect — important after Orion login POST
        if (followRedirect && res.statusCode >= 300 && res.statusCode < 400 && location) {
          let redirectPath = location
          try {
            const u = new URL(location)
            redirectPath = u.pathname + u.search
          } catch {
            if (!location.startsWith('/')) redirectPath = `/${location}`
          }
          orionRawRequest(target, { method: 'GET', path: redirectPath, cookies: allC, followRedirect: false })
            .then((r2) => resolve({
              statusCode: r2.statusCode,
              body: r2.body,
              cookies: mergeCookies(allC, r2.cookies),
              location: r2.location,
            }))
            .catch(() => resolve({ statusCode: res.statusCode, body: bodyText, cookies: allC, location }))
          return
        }

        resolve({ statusCode: res.statusCode || 0, body: bodyText, cookies: allC, location })
      })
    })
    req.on('error', () => resolve({ statusCode: 0, body: '', cookies, location: null }))
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: 0, body: '', cookies, location: null }) })
    if (body) req.write(body)
    req.end()
  })
}

/**
 * Orion web form login.
 *
 * Orion uses ASP.NET WebForms authentication:
 *  1. GET /Orion/Login.aspx — grab __VIEWSTATE / __EVENTVALIDATION hidden fields + initial cookies
 *  2. POST /Orion/Login.aspx — submit credentials with those tokens
 *  3. If Orion accepts: redirect to /Orion/SummaryView.aspx (or similar), cookies include the session
 *
 * Username format for Windows/AD accounts: DOMAIN\user or user@domain
 */
export async function orionWebPreAuth() {
  if (!isOrionConfigured()) {
    return { ok: false, cookies: '', reason: 'Set ORION_USERNAME and ORION_PASSWORD in server .env' }
  }

  const target = parseOrionWebUrl()
  const username = getOrionUsername()
  const password = getOrionPassword()
  const tag = `[orion-preauth ${target.hostname}:${target.port}]`

  // ── Step 1: GET login page — collect ALL hidden fields and session cookies ──
  // Orion uses __AntiXsrfToken (cookie) + __AntiXsrfTokenInput (hidden field);
  // both must come from the SAME request so the server can validate they match.
  const loginPath = '/Orion/Login.aspx'
  const getRes = await orionRawRequest(target, { path: loginPath, followRedirect: false })
  if (getRes.statusCode === 0) {
    return { ok: false, cookies: '', reason: `Cannot reach Orion at ${target.hostname}:${target.port} — check ORION_WEB_URL and firewall` }
  }
  const initCookies = getRes.cookies
  const body1 = getRes.body

  function extractHidden(name) {
    const m = body1.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i'))
      || body1.match(new RegExp(`id="${name}"[^>]*value="([^"]*)"`, 'i'))
      || body1.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`, 'i'))
    return m ? m[1] : ''
  }

  const viewState          = extractHidden('__VIEWSTATE')
  const viewStateGenerator = extractHidden('__VIEWSTATEGENERATOR')
  const eventValidation    = extractHidden('__EVENTVALIDATION')
  const antiXsrf           = extractHidden('__AntiXsrfTokenInput')

  console.log(`${tag} GET ${loginPath} → HTTP ${getRes.statusCode} | viewState=${!!viewState} antiXsrf=${!!antiXsrf} cookies=[${cookieStr(initCookies).slice(0,80)}]`)

  // ── Step 2: POST credentials ──────────────────────────────────────────────
  // Orion Login.aspx field names (confirmed from live page inspection):
  //   ctl00$BodyContent$Username  (current Orion Platform 2022+)
  //   ctl00$BodyContent$Password
  //   ctl00$BodyContent$LoginButton  (uses WebForm_DoPostBackWithOptions)
  // Fallbacks for older Orion builds.
  const fieldPrefixes = ['ctl00$BodyContent', 'ctl00$ContentPlaceHolder1', 'ctl00$MainContent']

  for (const prefix of fieldPrefixes) {
    const formFields = {
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewStateGenerator,
      __EVENTTARGET: `${prefix}$LoginButton`,
      __EVENTARGUMENT: '',
      [`${prefix}$Username`]: username,
      [`${prefix}$Password`]: password,
    }
    if (eventValidation) formFields.__EVENTVALIDATION = eventValidation
    if (antiXsrf) formFields.__AntiXsrfTokenInput = antiXsrf
    const formBody = Object.entries(formFields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v || '')}`)
      .join('&')

    const postRes = await orionRawRequest(target, {
      method: 'POST',
      path: loginPath,
      reqHeaders: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: `${target.scheme}://${target.hostname}:${target.port}${loginPath}`,
        accept: 'text/html,application/xhtml+xml,*/*',
        'accept-language': 'en-US,en;q=0.9',
      },
      body: formBody,
      cookies: initCookies,
      followRedirect: true,
    })

    const finalCookies = cookieStr(postRes.cookies)
    console.log(
      `${tag} POST ${loginPath} [${prefix}] → HTTP ${postRes.statusCode}` +
      ` | cookies: [${finalCookies.slice(0, 120)}]` +
      ` | location: ${postRes.location || '—'}` +
      ` | body[200]: ${(postRes.body || '').slice(0, 200).replace(/\n/g, ' ')}`
    )

    // Success indicators: redirected away from Login, or body contains Orion dashboard markers
    const redirectedAway = postRes.location && !postRes.location.toLowerCase().includes('login')
    const bodyIsOrion = postRes.body && (
      postRes.body.includes('Orion') ||
      postRes.body.includes('SummaryView') ||
      postRes.body.includes('NodeDetails') ||
      postRes.body.includes('logout') ||
      postRes.body.includes('Logout')
    )
    const hasSession = finalCookies.includes('ASP.NET_SessionId') ||
      finalCookies.includes('OrionSession') ||
      finalCookies.includes('.ASPXAUTH') ||
      finalCookies.includes('orion') ||
      finalCookies.includes('Orion')

    if (hasSession || redirectedAway || bodyIsOrion) {
      console.log(`${tag} login succeeded (hasSession=${hasSession}, redirectedAway=${redirectedAway})`)
      return { ok: true, cookies: finalCookies, reason: null }
    }

    // Wrong credentials signals
    if (postRes.body && (
      postRes.body.includes('Invalid username') ||
      postRes.body.includes('Invalid password') ||
      postRes.body.includes('incorrect') ||
      postRes.body.includes('credentials') ||
      postRes.body.includes('denied')
    )) {
      return { ok: false, cookies: '', reason: 'Orion rejected the credentials — check ORION_USERNAME and ORION_PASSWORD' }
    }
  }

  // Still here: no session cookie but also no clear error — proxy will still send Basic auth fallback
  console.log(`${tag} login form flow did not obtain session cookies — proxy will rely on Basic auth headers`)
  return {
    ok: false,
    cookies: cookieStr(initCookies),
    reason: 'Orion form login did not return a session cookie. Proxy will try Basic auth on each request. If login still appears, check credentials and that the account is a local Orion account (not AD-only without credentials configured).',
  }
}

/** Cap slow Orion probes so API handlers return before the client axios timeout. */
export function withOrionTimeout(promise, label = 'Orion') {
  const ms = requestTimeoutMs() + 5_000   // a bit more than the per-request socket timeout
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const e = new Error(`${label} probe timed out after ${ms}ms — check ORION_WEB_URL and that port 17774 is open`)
        e.code = 'ORION_TIMEOUT'
        reject(e)
      }, ms)
    }),
  ])
}

/** After first successful SWIS call, reuse this base (avoids multi-minute probe loops). */
let cachedSwisBase = null
let swisBaseDiscovery = null

function swisBasesFullList() {
  const web = parseOrionWebUrl()
  const host = web.hostname
  const ports = [17774, 17778, web.port].filter((p, i, a) => p && a.indexOf(p) === i)
  const schemes = ['https', 'http']
  const bases = []

  const explicit = (process.env.ORION_SWIS_URL || '').trim().replace(/\/$/, '')
  if (explicit) bases.push(explicit)

  for (const scheme of schemes) {
    for (const port of ports) {
      bases.push(`${scheme}://${host}:${port}${SWIS_PATH}`)
    }
  }

  return [...new Set(bases)]
}

function swisBasesToTry() {
  if (cachedSwisBase) return [cachedSwisBase]
  const explicit = (process.env.ORION_SWIS_URL || '').trim().replace(/\/$/, '')
  if (explicit) return [explicit]
  return swisBasesFullList()
}

async function discoverSwisBase() {
  const ping = 'SELECT TOP 1 NodeID FROM Orion.Nodes'
  let lastErr = null

  for (const base of swisBasesToTry()) {
    try {
      await swisFetchOnce(base, ping)
      cachedSwisBase = base
      return base
    } catch (e) {
      lastErr = e
      if (e.code === 'ORION_NOT_CONFIGURED') throw e
    }
  }

  // ORION_SWIS_URL alone failed — try all candidate ports/schemes once
  const explicit = (process.env.ORION_SWIS_URL || '').trim().replace(/\/$/, '')
  if (explicit) {
    for (const base of swisBasesFullList()) {
      if (base === explicit) continue
      try {
        await swisFetchOnce(base, ping)
        cachedSwisBase = base
        return base
      } catch (e) {
        lastErr = e
      }
    }
  }

  try {
    const pre = await orionWebPreAuth()
    if (pre.cookies) {
      const web = parseOrionWebUrl()
      const base = `${web.origin}${SWIS_PATH}`
      await swisFetchOnce(base, ping, { cookieHeader: pre.cookies })
      cachedSwisBase = base
      return base
    }
    if (!pre.ok && pre.reason) {
      lastErr = new Error(`SWIS ports failed and web login failed: ${pre.reason}`)
      lastErr.code = 'ORION_SWIS_ERROR'
    }
  } catch (e) {
    lastErr = e
  }

  throw lastErr || new Error('SWIS query failed — no Orion endpoint responded')
}

async function ensureSwisBase() {
  if (cachedSwisBase) return cachedSwisBase
  if (!swisBaseDiscovery) {
    swisBaseDiscovery = discoverSwisBase().finally(() => { swisBaseDiscovery = null })
  }
  return swisBaseDiscovery
}

/**
 * Single SWIS HTTP call. Uses Basic auth unless `cookieHeader` is provided (web session).
 */
function swisHttpRequest(baseUrl, { method, query, auth, cookieHeader }) {
  const baseClean = baseUrl.replace(/\/$/, '')
  const u = new URL(baseClean)
  const isHttps = u.protocol === 'https:'
  const lib = isHttps ? https : http
  const to = requestTimeoutMs()
  const agent = isHttps ? new https.Agent({ rejectUnauthorized: !tlsInsecure(), keepAlive: false }) : undefined

  const isPost = method === 'POST'
  const reqBody = isPost ? JSON.stringify({ query }) : null
  const basePath = u.pathname.replace(/\/?$/, '')
  const path = isPost
    ? `${basePath}/Query`
    : `${basePath}/Query?query=${encodeURIComponent(query)}`

  const hdrs = { Accept: 'application/json' }
  if (cookieHeader) hdrs.Cookie = cookieHeader
  else if (auth) hdrs.Authorization = auth
  if (isPost) {
    hdrs['Content-Type'] = 'application/json'
    hdrs['Content-Length'] = String(Buffer.byteLength(reqBody))
  }

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path,
      method,
      headers: hdrs,
      timeout: to,
      ...(isHttps ? { rejectUnauthorized: !tlsInsecure() } : {}),
    }
    if (agent) reqOpts.agent = agent

    const req = lib.request(reqOpts, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        // Follow one redirect (Orion sometimes redirects SWIS to login without cookies)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const e = new Error(`SWIS redirect HTTP ${res.statusCode} — auth failed or wrong port`)
          e.code = 'ORION_SWIS_ERROR'
          e.status = res.statusCode
          e.redirect = res.headers.location
          return reject(e)
        }
        let data = null
        try { data = JSON.parse(body) } catch { /* non-JSON */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(data?.Message || data?.ExceptionMessage || data?.error || body.slice(0, 300) || `SWIS HTTP ${res.statusCode}`)
          e.code = 'ORION_SWIS_ERROR'
          e.status = res.statusCode
          e.url = `${u.origin}${path}`
          e.method = method
          return reject(e)
        }
        resolve(data)
      })
    })
    req.on('timeout', () => {
      req.destroy()
      const e = new Error(`SWIS request timed out after ${to}ms`)
      e.code = 'ORION_TIMEOUT'
      reject(e)
    })
    req.on('error', (err) => {
      err.code = err.code || 'ORION_NETWORK_ERROR'
      reject(err)
    })
    if (reqBody) req.write(reqBody)
    req.end()
  })
}

/** Try GET then POST on one SWIS base URL. */
async function swisFetchOnce(base, query, { cookieHeader } = {}) {
  const auth = cookieHeader ? null : orionBasicAuthHeader()
  if (!auth && !cookieHeader) {
    const e = new Error('Orion API credentials not configured')
    e.code = 'ORION_NOT_CONFIGURED'
    throw e
  }

  const methods = ['GET', 'POST']
  let lastErr = null
  for (const method of methods) {
    try {
      return await swisHttpRequest(base, { method, query, auth, cookieHeader })
    } catch (e) {
      lastErr = e
      // Wrong verb — try the other method
      if (e.status !== 405 && e.status !== 404) break
    }
  }
  throw lastErr || new Error('SWIS query failed')
}

/** Probe all candidate SWIS bases (for /diagnostic). */
export async function orionSwisProbe() {
  const query = 'SELECT TOP 1 NodeID FROM Orion.Nodes'
  const results = []
  for (const base of swisBasesFullList()) {
    for (const method of ['GET', 'POST']) {
      try {
        await swisHttpRequest(base, { method, query, auth: orionBasicAuthHeader() })
        cachedSwisBase = base
        results.push({ base, method, ok: true })
        return { ok: true, working: { base, method }, attempts: results }
      } catch (e) {
        results.push({
          base,
          method,
          ok: false,
          status: e.status,
          error: e.message,
        })
      }
    }
  }

  // Session cookies on web console port (8787) — works when dedicated SWIS ports block Basic auth
  try {
    const pre = await orionWebPreAuth()
    if (pre.ok && pre.cookies) {
      const web = parseOrionWebUrl()
      const base = `${web.origin}${SWIS_PATH}`
      for (const method of ['GET', 'POST']) {
        try {
          await swisHttpRequest(base, { method, query, cookieHeader: pre.cookies })
          cachedSwisBase = base
          results.push({ base, method, ok: true, auth: 'session-cookie' })
          return { ok: true, working: { base, method, auth: 'session-cookie' }, attempts: results }
        } catch (e) {
          results.push({ base, method, ok: false, auth: 'session-cookie', status: e.status, error: e.message })
        }
      }
    }
  } catch (e) {
    results.push({ base: 'web-session', ok: false, error: e.message })
  }

  return { ok: false, attempts: results }
}

/** Run SWQL — discovers SWIS once, then reuses the working base. */
export async function orionSwisQuery(query) {
  let lastErr = null
  try {
    const base = await ensureSwisBase()
    return await swisFetchOnce(base, query)
  } catch (e) {
    lastErr = e
    if (e.code === 'ORION_NOT_CONFIGURED') throw e
    // Stale cache (Orion restarted / URL changed) — rediscover once
    if (cachedSwisBase) {
      cachedSwisBase = null
      try {
        const base = await ensureSwisBase()
        return await swisFetchOnce(base, query)
      } catch (e2) {
        lastErr = e2
      }
    }
  }

  if (lastErr?.status === 405) {
    lastErr.message = [
      lastErr.message,
      'Tip: set ORION_SWIS_URL in server/.env (try https://192.168.10.100:17774/SolarWinds/InformationService/v3/Json) or ORION_TLS_INSECURE=true for self-signed HTTPS.',
    ].join(' ')
  }

  throw lastErr || new Error('SWIS query failed — no Orion endpoint responded')
}

export async function orionSwisPing() {
  const data = await orionSwisQuery('SELECT TOP 1 NodeID, Caption FROM Orion.Nodes')
  const row = data?.results?.[0]
  return { ok: true, sampleNode: row?.Caption || row?.NodeID || null }
}
