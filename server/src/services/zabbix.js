/**
 * Zabbix JSON-RPC client.
 * - Zabbix 7.4+: use ZABBIX_AUTH=bearer (JSON "auth" is rejected).
 * - Zabbix 6.x: default auto tries Bearer then JSON auth.
 * @see https://www.zabbix.com/documentation/current/en/manual/api
 */

import https from 'https'

let requestId = 0

export function getZabbixToken() {
  const t = process.env.ZABBIX_API_TOKEN?.trim() || process.env.ZABBIX_TOKEN?.trim()
  return t || ''
}

export function isZabbixConfigured() {
  return Boolean(process.env.ZABBIX_URL?.trim() && getZabbixToken())
}

function insecureAgent() {
  if (process.env.ZABBIX_TLS_INSECURE !== '1' && process.env.ZABBIX_TLS_INSECURE !== 'true') return undefined
  return new https.Agent({ rejectUnauthorized: false })
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * @param {'none' | 'bearer' | 'body'} authHow
 */
async function rpcOnce(url, method, params, token, authHow) {
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
  }
  const agent = insecureAgent()
  if (agent && url.startsWith('https:')) init.agent = agent

  const res = await fetch(url, init)
  const text = await res.text()
  const data = parseJsonSafe(text)
  return { res, text, data }
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

function httpError(res, text, url) {
  const err = new Error(`Zabbix HTTP ${res.status} at ${maskUrl(url)} — ${text.slice(0, 200)}`)
  err.code = 'ZABBIX_HTTP'
  if (res.status === 404) {
    err.hint = 'Check ZABBIX_URL: often http://HOST/zabbix/api_jsonrpc.php'
  } else if (res.status === 401 || res.status === 403) {
    err.hint = 'Web server or Zabbix rejected the request (token or permissions)'
  }
  return err
}

function maskUrl(u) {
  try {
    const x = new URL(u)
    return `${x.protocol}//${x.host}${x.pathname}`
  } catch {
    return String(u).replace(/\?.*/, '')
  }
}

function handleRpcResponse(res, text, data, url) {
  if (!res.ok && !data) throw httpError(res, text, url)
  if (!data) {
    const err = new Error(`Zabbix returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
    err.code = 'ZABBIX_BAD_RESPONSE'
    err.hint = 'Wrong URL (HTML login page), proxy, or SSL — try ZABBIX_TLS_INSECURE=1 for self-signed HTTPS'
    throw err
  }
  if (data.error) return { ok: false, data }
  return { ok: true, result: data.result }
}

function wrapFetchError(e) {
  if (e.code) return e
  const err = new Error(`Cannot reach Zabbix: ${e.message || e}`)
  err.code = 'ZABBIX_FETCH'
  err.hint =
    'Network error. If the API runs in Docker, the container must route to ZABBIX_URL (LAN IP, or host.docker.internal for Zabbix on the same PC).'
  return err
}

/**
 * @param {string} method
 * @param {object} params
 * @param {{ skipAuth?: boolean }} [opts]
 */
export async function zabbixRpc(method, params = {}, opts = {}) {
  const url = process.env.ZABBIX_URL?.trim()
  const token = getZabbixToken()
  /** Zabbix rejects JSON `auth` and Bearer for this method (-32602). */
  const skipAuth = Boolean(opts.skipAuth || method === 'apiinfo.version')

  if (!url) {
    const err = new Error('ZABBIX_URL is not set')
    err.code = 'ZABBIX_NOT_CONFIGURED'
    throw err
  }

  if (!skipAuth && !token) {
    const err = new Error('Zabbix is not configured (set ZABBIX_API_TOKEN or ZABBIX_TOKEN)')
    err.code = 'ZABBIX_NOT_CONFIGURED'
    throw err
  }

  if (skipAuth) {
    try {
      const { res, text, data } = await rpcOnce(url, method, params, '', 'none')
      const out = handleRpcResponse(res, text, data, url)
      if (!out.ok) throw formatZabbixRpcError(out.data)
      return out.result
    } catch (e) {
      throw wrapFetchError(e)
    }
  }

  const authMode = (process.env.ZABBIX_AUTH || 'auto').toLowerCase()
  const tryBearer = authMode === 'bearer' || authMode === 'auto'
  const tryBody = authMode === 'body' || authMode === 'auto'

  let bearerFailure = null

  if (tryBearer) {
    try {
      const { res, text, data } = await rpcOnce(url, method, params, token, 'bearer')
      const out = handleRpcResponse(res, text, data, url)
      if (out.ok) return out.result
      bearerFailure = out.data
      if (!tryBody || !shouldRetryBearerWithBody(out.data)) {
        throw formatZabbixRpcError(out.data)
      }
    } catch (e) {
      if (e.code) throw e
      throw wrapFetchError(e)
    }
  }

  if (tryBody && (authMode === 'body' || (authMode === 'auto' && bearerFailure))) {
    try {
      const { res, text, data } = await rpcOnce(url, method, params, token, 'body')
      const out = handleRpcResponse(res, text, data, url)
      if (out.ok) return out.result
      if (authMode === 'auto' && bearerFailure && isUnexpectedAuthParam(out.data)) {
        const err = formatZabbixRpcError(bearerFailure)
        err.hint = 'Zabbix 7.4+ requires Bearer tokens only — use ZABBIX_AUTH=bearer and a valid API token'
        throw err
      }
      throw formatZabbixRpcError(out.data)
    } catch (e) {
      if (e.code) throw e
      throw wrapFetchError(e)
    }
  }

  const err = new Error('Zabbix request failed')
  err.code = 'ZABBIX_API_ERROR'
  throw err
}

/** Connection + version check (unauthenticated). */
export async function zabbixPing() {
  const url = process.env.ZABBIX_URL?.trim()
  if (!url) {
    return { ok: false, step: 'config', message: 'ZABBIX_URL is empty' }
  }
  try {
    const version = await zabbixRpc('apiinfo.version', {})
    return { ok: true, step: 'apiinfo.version', version: String(version || '') }
  } catch (e) {
    return {
      ok: false,
      step: 'apiinfo.version',
      message: e.message,
      code: e.code,
      zabbixCode: e.zabbixCode,
      hint: e.hint,
    }
  }
}
