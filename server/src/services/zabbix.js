/**
 * Zabbix JSON-RPC client.
 * - Zabbix 7.4+: use ZABBIX_AUTH=bearer (JSON "auth" is rejected).
 * - Zabbix 6.x: default auto tries Bearer then JSON auth.
 * @see https://www.zabbix.com/documentation/current/en/manual/api
 */

import https from 'https'

let requestId = 0

function parseJsonSafe(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function formatZabbixRpcError(data) {
  const msg = data.error.data || data.error.message || 'Zabbix API error'
  const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  err.code = 'ZABBIX_API_ERROR'
  err.zabbixCode = data.error.code
  return err
}

function isAuthRelatedError(data) {
  if (!data?.error) return false
  const msg = String(data.error.message || '').toLowerCase()
  const dataStr = typeof data.error.data === 'string' ? data.error.data.toLowerCase() : ''
  if (msg.includes('not authorized') || msg.includes('authorisation') || msg.includes('authorization'))
    return true
  if (msg.includes('session') && msg.includes('invalid')) return true
  if (dataStr.includes('not authorized')) return true
  return false
}

function isUnexpectedAuthParam(data) {
  const msg = String(data?.error?.message || '')
  return msg.includes('unexpected parameter') && msg.includes('auth')
}

function shouldRetryBearerWithBody(data) {
  if (!data?.error) return false
  if (isUnexpectedAuthParam(data)) return false
  return (
    isAuthRelatedError(data) ||
    data.error.code === -32602 ||
    data.error.code === -32500
  )
}

function maskUrl(u) {
  try {
    const x = new URL(u)
    return `${x.protocol}//${x.host}${x.pathname}`
  } catch {
    return String(u).replace(/\?.*/, '')
  }
}

function normalizeZabbixUrl(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return ''
  try {
    const u = new URL(trimmed)
    u.pathname = u.pathname.replace(/\/{2,}/g, '/')
    return u.toString()
  } catch {
    return trimmed.replace(/([^:]\/)\/+/g, '$1')
  }
}

/**
 * @param {string} envPrefix e.g. ZABBIX or STORE_ZABBIX
 */
export function createZabbixClient(envPrefix = 'ZABBIX') {
  const urlEnv = `${envPrefix}_URL`
  const tokenEnv = `${envPrefix}_API_TOKEN`
  const tokenAliasEnv = `${envPrefix}_TOKEN`
  const authEnv = `${envPrefix}_AUTH`
  const tlsEnv = `${envPrefix}_TLS_INSECURE`
  const timeoutEnv = `${envPrefix}_REQUEST_TIMEOUT_MS`

  const getUrl = () => normalizeZabbixUrl(process.env[urlEnv])
  const getZabbixToken = () => {
    const t = process.env[tokenEnv]?.trim() || process.env[tokenAliasEnv]?.trim()
    return t || ''
  }
  const getAuthMode = () => (process.env[authEnv] || 'auto').toLowerCase()
  const isTlsInsecure = () => process.env[tlsEnv] === '1' || process.env[tlsEnv] === 'true'
  const getRequestTimeoutMs = (override) => {
    if (override != null && Number.isFinite(Number(override)) && Number(override) > 0) {
      return Number(override)
    }
    const fromEnv = parseInt(process.env[timeoutEnv] || process.env.ZABBIX_REQUEST_TIMEOUT_MS || '45000', 10)
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 45000
  }

  function insecureAgent() {
    if (!isTlsInsecure()) return undefined
    return new https.Agent({ rejectUnauthorized: false })
  }

  function httpError(res, text, url) {
    const err = new Error(`Zabbix HTTP ${res.status} at ${maskUrl(url)} — ${text.slice(0, 200)}`)
    err.code = 'ZABBIX_HTTP'
    if (res.status === 404) {
      err.hint = `Check ${urlEnv}: often http://HOST/zabbix/api_jsonrpc.php`
    } else if (res.status === 401 || res.status === 403) {
      err.hint = 'Web server or Zabbix rejected the request (token or permissions)'
    }
    return err
  }

  function handleRpcResponse(res, text, data, url) {
    if (!res.ok && !data) throw httpError(res, text, url)
    if (!data) {
      const err = new Error(`Zabbix returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
      err.code = 'ZABBIX_BAD_RESPONSE'
      err.hint = `Wrong URL (HTML login page), proxy, or SSL — try ${tlsEnv}=1 for self-signed HTTPS`
      throw err
    }
    if (data.error) return { ok: false, data }
    return { ok: true, result: data.result }
  }

  function wrapFetchError(e, url, timeoutMs) {
    if (e.code) return e
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      const err = new Error(`Zabbix request timed out after ${timeoutMs}ms`)
      err.code = 'ZABBIX_TIMEOUT'
      err.hint =
        `Cannot reach ${maskUrl(url)} from the Netpulse server within ${timeoutMs}ms. ` +
        'If Zabbix works in your browser or from your PC but not here, Docker may be blocking LAN/VPN routes. ' +
        'Try running the API on the host (cd server && npm run dev) or fix Docker/VPN routing. ' +
        `Expected URL like http://172.20.11.197/zabbix/api_jsonrpc.php (${urlEnv}).`
      return err
    }
    const err = new Error(`Cannot reach Zabbix: ${e.message || e}`)
    err.code = 'ZABBIX_FETCH'
    err.hint =
      `Network error reaching ${maskUrl(url)}. If Netpulse runs in Docker, the container must route to ${urlEnv} — ` +
      'LAN/VPN IPs reachable from your PC are often unreachable from the container.'
    return err
  }

  /**
   * @param {'none' | 'bearer' | 'body'} authHow
   */
  async function rpcOnce(url, method, params, token, authHow, timeoutMs) {
    const id = ++requestId
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    }
    if (authHow === 'body' && token) payload.auth = token

    const headers = { 'Content-Type': 'application/json' }
    if (authHow === 'bearer' && token) headers.Authorization = `Bearer ${token}`

    const init = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    }
    const agent = insecureAgent()
    if (agent && url.startsWith('https:')) init.agent = agent

    const res = await fetch(url, init)
    const text = await res.text()
    const data = parseJsonSafe(text)
    return { res, text, data }
  }

  const isZabbixConfigured = () => Boolean(getUrl() && getZabbixToken())

  /**
   * @param {string} method
   * @param {object} params
   * @param {{ skipAuth?: boolean }} [opts]
   */
  async function zabbixRpc(method, params = {}, opts = {}) {
    const url = getUrl()
    const token = getZabbixToken()
    const timeoutMs = getRequestTimeoutMs(opts.timeoutMs)
    /** Zabbix rejects JSON `auth` and Bearer for this method (-32602). */
    const skipAuth = Boolean(opts.skipAuth || method === 'apiinfo.version')

    if (!url) {
      const err = new Error(`${urlEnv} is not set`)
      err.code = 'ZABBIX_NOT_CONFIGURED'
      throw err
    }

    if (!skipAuth && !token) {
      const err = new Error(`Zabbix is not configured (set ${tokenEnv} or ${tokenAliasEnv})`)
      err.code = 'ZABBIX_NOT_CONFIGURED'
      throw err
    }

    if (skipAuth) {
      try {
        const { res, text, data } = await rpcOnce(url, method, params, '', 'none', timeoutMs)
        const out = handleRpcResponse(res, text, data, url)
        if (!out.ok) throw formatZabbixRpcError(out.data)
        return out.result
      } catch (e) {
        throw wrapFetchError(e, url, timeoutMs)
      }
    }

    const authMode = getAuthMode()
    const tryBearer = authMode === 'bearer' || authMode === 'auto'
    const tryBody = authMode === 'body' || authMode === 'auto'

    let bearerFailure = null

    if (tryBearer) {
      try {
        const { res, text, data } = await rpcOnce(url, method, params, token, 'bearer', timeoutMs)
        const out = handleRpcResponse(res, text, data, url)
        if (out.ok) return out.result
        bearerFailure = out.data
        if (!tryBody || !shouldRetryBearerWithBody(out.data)) {
          throw formatZabbixRpcError(out.data)
        }
      } catch (e) {
        if (e.code) throw e
        throw wrapFetchError(e, url, timeoutMs)
      }
    }

    if (tryBody && (authMode === 'body' || (authMode === 'auto' && bearerFailure))) {
      try {
        const { res, text, data } = await rpcOnce(url, method, params, token, 'body', timeoutMs)
        const out = handleRpcResponse(res, text, data, url)
        if (out.ok) return out.result
        if (authMode === 'auto' && bearerFailure && isUnexpectedAuthParam(out.data)) {
          const err = formatZabbixRpcError(bearerFailure)
          err.hint = `Zabbix 7.4+ requires Bearer tokens only — use ${authEnv}=bearer and a valid API token`
          throw err
        }
        throw formatZabbixRpcError(out.data)
      } catch (e) {
        if (e.code) throw e
        throw wrapFetchError(e, url, timeoutMs)
      }
    }

    const err = new Error('Zabbix request failed')
    err.code = 'ZABBIX_API_ERROR'
    throw err
  }

  /** Connection + version check (unauthenticated). */
  async function zabbixPing(opts = {}) {
    const url = getUrl()
    if (!url) {
      return { ok: false, step: 'config', message: `${urlEnv} is empty` }
    }
    try {
      const version = await zabbixRpc('apiinfo.version', {}, { timeoutMs: opts.timeoutMs })
      return { ok: true, step: 'apiinfo.version', version: String(version || ''), url: maskUrl(url) }
    } catch (e) {
      return {
        ok: false,
        step: 'apiinfo.version',
        message: e.message,
        code: e.code,
        zabbixCode: e.zabbixCode,
        hint: e.hint,
        url: maskUrl(url),
      }
    }
  }

  return {
    envPrefix,
    urlEnv,
    tokenEnv,
    tokenAliasEnv,
    authEnv,
    tlsEnv,
    getUrl,
    getZabbixToken,
    getAuthMode,
    isZabbixConfigured,
    zabbixRpc,
    zabbixPing,
  }
}

const defaultClient = createZabbixClient('ZABBIX')
export const getZabbixToken = defaultClient.getZabbixToken
export const isZabbixConfigured = defaultClient.isZabbixConfigured
export const zabbixRpc = defaultClient.zabbixRpc
export const zabbixPing = defaultClient.zabbixPing
