/**
 * Thin HTTP client for NetPulse's existing /api/agent/* endpoints.
 *
 * Auth: every call carries the per-session NetPulse JWT (Authorization: Bearer
 * <jwt>) supplied by the MCP caller. NetPulse already enforces user-level page
 * access on that JWT, so we just propagate errors verbatim.
 */
import { fetch } from 'undici'

const DEFAULT_TIMEOUT_MS = 30_000

export class NetPulseClient {
  constructor({ baseUrl, bearer, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!baseUrl) throw new Error('NETPULSE_API_BASE is required')
    if (!bearer) throw new Error('NetPulse JWT bearer is required')
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.bearer = bearer
    this.timeoutMs = timeoutMs
  }

  buildHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.bearer}`,
    }
  }

  async request(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + path)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      const payload = text ? safeJson(text) : null
      if (!res.ok) {
        const err = new Error(
          payload?.error || `${method} ${path} failed: HTTP ${res.status}`,
        )
        err.status = res.status
        err.code = payload?.code
        err.body = payload
        throw err
      }
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  meta() { return this.request('GET', '/api/agent/meta') }
  modules() { return this.request('GET', '/api/agent/modules') }

  context({ modules, question, autoModules = true, format = 'json' } = {}) {
    return this.request('POST', '/api/agent/context', {
      body: { modules, question, autoModules, format },
    })
  }

  query({ question, modules, autoModules = true, includeContext = true } = {}) {
    return this.request('POST', '/api/agent/query', {
      body: { question, modules, autoModules, includeContext },
    })
  }
}

/**
 * Verify a JWT by calling /api/agent/meta on the configured NetPulse base URL.
 * Returns { ok: true, meta } or { ok: false, status, error }. We deliberately
 * delegate validation to NetPulse so the MCP container never needs JWT_SECRET
 * and revocations take effect on the next tool call.
 */
export async function verifyJwtAgainstNetPulse({ baseUrl, bearer, timeoutMs = 8_000 } = {}) {
  if (!bearer) return { ok: false, status: 401, error: 'No bearer provided' }
  const client = new NetPulseClient({ baseUrl, bearer, timeoutMs })
  try {
    const meta = await client.meta()
    return { ok: true, meta }
  } catch (err) {
    return {
      ok: false,
      status: err.status || 500,
      error: err.message,
      code: err.code,
    }
  }
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return { raw: text } }
}
