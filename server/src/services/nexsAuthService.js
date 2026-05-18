/**
 * nexsAuthService.js — Lenskart Auth Service (Nexs) REST proxy
 * Swagger: https://lk-authservice-prod-eks.lenskart.com/swagger-ui.html
 */

const BASE_URL = (process.env.NEXS_AUTH_BASE_URL || 'https://lk-authservice-prod-eks.lenskart.com')
  .trim()
  .replace(/\/+$/, '')
const ENV_AUTH_TOKEN = (process.env.NEXS_AUTH_TOKEN || '').trim()
const ENV_APP_ID = (process.env.NEXS_APP_ID || '').trim()
const PORTAL_APP_ID = (process.env.NEXS_PORTAL_APP_ID || 'nexs_search').trim()
/** Auth service rejects login without X-Lenskart-App-Id ("Invalid app"). */
const DEFAULT_APP_ID = ENV_APP_ID || PORTAL_APP_ID
/** Application key for GET /v1/app/users/{appName} */
const APP_NAME = (process.env.NEXS_APP_NAME || DEFAULT_APP_ID || 'nexs_search').trim()
/** Body for POST /v1/get/roles */
const ROLES_APP = (process.env.NEXS_ROLES_APP_NAME || process.env.NEXS_APP_NAME || DEFAULT_APP_ID || 'nexs_search').trim()
const PORTAL_URL = (process.env.NEXS_PORTAL_URL || 'https://app.nexs.lenskart.com/usermanagement/roles').trim()
const PORTAL_ORIGIN = (process.env.NEXS_PORTAL_ORIGIN || 'https://app.nexs.lenskart.com').trim().replace(/\/+$/, '')
const SOURCE_DOMAIN = (process.env.NEXS_SOURCE_DOMAIN || PORTAL_ORIGIN).trim()

export function isNexsBaseConfigured() {
  return Boolean(BASE_URL)
}

export function getNexsConfigPublic() {
  return {
    configured: isNexsBaseConfigured(),
    baseUrl: BASE_URL || null,
    appId: DEFAULT_APP_ID || null,
    appName: APP_NAME || null,
    rolesAppName: ROLES_APP,
    authMode: 'page-login',
    hasStaticToken: Boolean(ENV_AUTH_TOKEN),
    portalUrl: PORTAL_URL || null,
    portalOrigin: PORTAL_ORIGIN || null,
    portalAppId: PORTAL_APP_ID,
    defaultAppId: DEFAULT_APP_ID,
  }
}

/** Pull session token + app id from request headers (page login) or server env fallback. */
export function resolveCredentials(req) {
  if (!isNexsBaseConfigured()) {
    throw Object.assign(
      new Error('Nexs Auth Service is not configured. Set NEXS_AUTH_BASE_URL on the server (see server/.env.example).'),
      { status: 503 },
    )
  }

  const token =
    String(req.headers['x-nexs-auth-token'] || req.headers['x-lenskart-auth-token'] || '').trim() ||
    ENV_AUTH_TOKEN

  const appId =
    String(req.headers['x-nexs-app-id'] || req.headers['x-lenskart-app-id'] || '').trim() ||
    DEFAULT_APP_ID

  if (!token) {
    throw Object.assign(
      new Error('Nexs sign-in required. Enter your username and password on this page to obtain a session token.'),
      { status: 401, code: 'NEXS_AUTH_REQUIRED' },
    )
  }

  if (!looksLikeJwt(token)) {
    throw Object.assign(
      new Error('Stored session is not a valid JWT. Please sign out and sign in again.'),
      { status: 401, code: 'NEXS_TOKEN_INVALID' },
    )
  }

  return { token, appId: appId || null, appName: APP_NAME || null }
}

export function looksLikeJwt(value) {
  const parts = String(value || '').trim().split('.')
  return parts.length === 3 && parts.every((p) => p.length > 0)
}

function findJwtDeep(value, depth = 0) {
  if (depth > 6 || value == null) return null
  if (typeof value === 'string' && looksLikeJwt(value)) return value.trim()
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJwtDeep(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) {
      const found = findJwtDeep(v, depth + 1)
      if (found) return found
    }
  }
  return null
}

function credHeaders(credentials, extra = {}) {
  const token = String(credentials.token || '').trim()
  const headers = {
    'X-Lenskart-Auth-Token': token,
    Accept: 'application/json',
    'source-domain': SOURCE_DOMAIN,
    ...extra,
  }
  if (credentials.appId) {
    headers['X-Lenskart-App-Id'] = credentials.appId
  }
  return headers
}

async function parseBody(res) {
  const text = await res.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

export function formatUpstreamError(data, fallbackStatus = 500) {
  if (Array.isArray(data?.errors) && data.errors.length) {
    const parts = data.errors
      .map((e) => e?.errorMessage || e?.errorCode)
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  if (data?.message) return String(data.message)
  if (data?.error) return String(data.error)
  if (typeof data === 'string' && data.trim()) return data.trim()
  return `Nexs Auth Service request failed (${fallbackStatus})`
}

function upstreamError(res, data, { login = false } = {}) {
  let msg = formatUpstreamError(data, res.status)
  let status = res.status

  if (
    /jwt-token cannot be empty|Unable to get Expiration time from Json Web Token|Json Web Token|invalid token|token expired/i.test(
      msg,
    )
  ) {
    throw Object.assign(new Error('Invalid or expired session token. Please sign out and sign in again.'), {
      status: 401,
      code: 'NEXS_TOKEN_INVALID',
      data,
    })
  }

  if (login) {
    if (/invalid app/i.test(msg)) {
      msg = `Invalid App ID. Set NEXS_APP_ID=${PORTAL_APP_ID} on the server (or pass appId in the request).`
      status = 400
    } else if (
      status === 500 ||
      status === 401 ||
      status === 403 ||
      /user not found|invalid password|invalid credentials|unauthorized/i.test(msg)
    ) {
      status = 401
      if (/user not found/i.test(msg)) msg = 'Invalid username or password'
    }
  }

  throw Object.assign(new Error(msg), { status, data })
}

/** Extract JWT from Nexs login response (content field is standard for Nexs SPA). */
export function extractAuthToken(data) {
  if (!data) return null

  if (typeof data.content === 'string' && looksLikeJwt(data.content)) {
    return data.content.trim()
  }

  const candidates = [
    data.content?.token,
    data.content?.jwt,
    data.content?.authToken,
    data.token,
    data.jwt,
    data.authToken,
    data.accessToken,
    data['X-Lenskart-Auth-Token'],
    data.data?.token,
    data.data?.jwt,
    data.data?.authToken,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && looksLikeJwt(c)) return c.trim()
  }

  return findJwtDeep(data)
}

/** POST /v1/user/login — returns fresh JWT (no prior token required). */
export async function login({ userName, password, appId }) {
  if (!isNexsBaseConfigured()) {
    throw Object.assign(new Error('NEXS_AUTH_BASE_URL is not configured on the server'), { status: 503 })
  }
  const user = String(userName || '').trim()
  const pass = String(password ?? '')
  const aid = String(appId || DEFAULT_APP_ID).trim()

  if (!user || !pass) {
    throw Object.assign(new Error('userName and password are required'), { status: 400 })
  }
  if (!aid) {
    throw Object.assign(
      new Error(`App ID is required by the auth service. Set NEXS_APP_ID or NEXS_PORTAL_APP_ID (e.g. ${PORTAL_APP_ID}).`),
      { status: 400 },
    )
  }

  const loginHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Lenskart-App-Id': aid,
    'source-domain': SOURCE_DOMAIN,
  }

  const res = await fetch(`${BASE_URL}/v1/user/login`, {
    method: 'POST',
    headers: loginHeaders,
    body: JSON.stringify({ userName: user, password: pass }),
  })

  const data = await parseBody(res)
  if (!res.ok) upstreamError(res, data, { login: true })

  if (data?.success === false) {
    const msg = formatUpstreamError(data, 401)
    throw Object.assign(new Error(/user not found/i.test(msg) ? 'Invalid username or password' : msg), {
      status: 401,
      data,
    })
  }

  const token = extractAuthToken(data)
  if (!token || !looksLikeJwt(token)) {
    throw Object.assign(
      new Error(
        formatUpstreamError(data, 502) ||
          'Login succeeded but no valid JWT was returned. Enable NEXS_DEBUG_RESPONSE=1 on the server to inspect the login payload.',
      ),
      { status: 502, data },
    )
  }

  return {
    token,
    appId: aid,
    userName: user,
    raw: process.env.NEXS_DEBUG_RESPONSE === '1' ? data : undefined,
  }
}

export async function nexsFetch(credentials, path, { method = 'GET', query, body, headers } = {}) {
  const url = new URL(`${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`)
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    })
  }

  const opts = {
    method: method.toUpperCase(),
    headers: credHeaders(credentials, headers),
  }
  if (body !== undefined && body !== null) {
    if (body instanceof FormData) {
      opts.body = body
    } else {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
  }

  const res = await fetch(url.toString(), opts)
  const data = await parseBody(res)
  if (!res.ok) upstreamError(res, data)
  return data
}

export async function listApplicationUsers(credentials, appName = APP_NAME) {
  const candidates = []
  const pushCandidate = (value) => {
    const v = String(value || '').trim()
    if (v && !candidates.includes(v)) candidates.push(v)
  }

  pushCandidate(appName)
  pushCandidate(APP_NAME)
  pushCandidate(DEFAULT_APP_ID)
  pushCandidate('nexs_search')
  pushCandidate('nexs')

  let lastData = null
  let lastError = null

  for (const name of candidates) {
    try {
      const data = await nexsFetch(credentials, `/v1/app/users/${encodeURIComponent(name)}`)
      lastData = data
      if (normalizeUserList(data).length > 0) return data
    } catch (e) {
      if (e?.code === 'NEXS_TOKEN_INVALID' || e?.code === 'NEXS_AUTH_REQUIRED' || e?.status === 401) {
        throw e
      }
      lastError = e
    }
  }

  if (lastData) return lastData
  if (lastError) throw lastError
  return []
}

export async function getUsersByParams(credentials, params = {}) {
  const query = {}
  if (params.emailIds) query.emailIds = params.emailIds
  if (params.empCodes) query.empCodes = params.empCodes
  if (params.phoneNumbers) query.phoneNumbers = params.phoneNumbers
  if (params.roles) query.roles = params.roles
  return nexsFetch(credentials, '/v1/get/users', { query })
}

export async function listRoles(credentials, app = ROLES_APP) {
  const candidates = []
  const pushCandidate = (value) => {
    const v = String(value || '').trim()
    if (v && !candidates.includes(v)) candidates.push(v)
  }

  pushCandidate(app)
  pushCandidate(ROLES_APP)
  pushCandidate(APP_NAME)
  pushCandidate(DEFAULT_APP_ID)
  pushCandidate('nexs_search')
  pushCandidate('nexs')

  let lastError = null
  for (const appName of candidates) {
    try {
      return await nexsFetch(credentials, '/v1/get/roles', { method: 'POST', body: appName })
    } catch (e) {
      // Auth/token failures should surface immediately; app-name mismatches can be retried.
      if (e?.code === 'NEXS_TOKEN_INVALID' || e?.code === 'NEXS_AUTH_REQUIRED' || e?.status === 401) {
        throw e
      }
      lastError = e
    }
  }

  if (lastError) throw lastError
  throw Object.assign(new Error('Failed to load roles from Nexs Auth Service'), { status: 502 })
}

export async function createOrUpdateUser(credentials, payload) {
  return nexsFetch(credentials, '/v1/create/user', { method: 'POST', body: payload })
}

export async function userManagementCreateEdit(credentials, payload) {
  return nexsFetch(credentials, '/v1/userManagement/createEdit/user', { method: 'POST', body: payload })
}

export async function getActiveRoleGroups(credentials, empCode) {
  const code = String(empCode || '').trim()
  if (!code) throw Object.assign(new Error('Employee code is required'), { status: 400 })
  return nexsFetch(credentials, `/v1/userManagement/user/${encodeURIComponent(code)}/activeRoleGroups`)
}

export async function bulkCreateUsersFromCsv(credentials, buffer, filename = 'users.csv') {
  const form = new FormData()
  form.append('csvFile', new Blob([buffer]), filename)
  return nexsFetch(credentials, '/v1/bulk/createUser', { method: 'POST', body: form })
}

export async function bulkUserManagementFromCsv(credentials, buffer, filename = 'users.csv') {
  const form = new FormData()
  form.append('csvFile', new Blob([buffer]), filename)
  return nexsFetch(credentials, '/v1/userManagement/bulk/createEdit/user', { method: 'POST', body: form })
}

export async function bulkUpdateUserRolesFromCsv(credentials, buffer, filename = 'roles.csv') {
  const form = new FormData()
  form.append('file', new Blob([buffer]), filename)
  return nexsFetch(credentials, '/v1/bulk/update/user-roles', { method: 'POST', body: form })
}

export async function validateEmail(credentials, email) {
  return nexsFetch(credentials, '/v1/validate/email', { query: { email: String(email || '').trim() } })
}

export function normalizeUserList(data) {
  if (!data) return []
  if (Array.isArray(data)) return data.filter((u) => u && typeof u === 'object')

  const arrays = []
  const seen = new Set()
  const priorityKeys = ['data', 'content', 'users', 'employees', 'results', 'result', 'payload', 'items', 'records']

  const pushArray = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return
    const objectRows = arr.filter((x) => x && typeof x === 'object')
    if (!objectRows.length) return
    const key = `${objectRows.length}:${Object.keys(objectRows[0]).slice(0, 5).join(',')}`
    if (seen.has(key)) return
    seen.add(key)
    arrays.push(objectRows)
  }

  const visit = (node, depth = 0) => {
    if (!node || depth > 6) return
    if (Array.isArray(node)) {
      pushArray(node)
      return
    }
    if (typeof node !== 'object') return

    for (const k of priorityKeys) {
      if (node[k] !== undefined) visit(node[k], depth + 1)
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') visit(v, depth + 1)
    }
  }

  visit(data)
  if (!arrays.length) return []

  const scoreUserArray = (arr) =>
    arr.reduce((score, u) => {
      if (
        u &&
        typeof u === 'object' &&
        (u.employeeCode ||
          u.empCode ||
          u.employee_code ||
          u.email ||
          u.emailId ||
          u.userId ||
          u.name ||
          u.displayName)
      ) {
        return score + 1
      }
      return score
    }, 0)

  arrays.sort((a, b) => scoreUserArray(b) - scoreUserArray(a) || b.length - a.length)
  return arrays[0] || []
}

export function normalizeRoleList(data) {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data
  if (Array.isArray(data.roles)) return data.roles
  if (data.data && Array.isArray(data.data.roles)) return data.data.roles
  return []
}
