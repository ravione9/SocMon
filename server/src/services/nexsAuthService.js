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
/** Portal app's own REST host (used for /facilities and other portal-side endpoints; mirrors the SPA's XHRs). */
const PORTAL_API_BASE_URL = (process.env.NEXS_PORTAL_API_BASE_URL || PORTAL_ORIGIN || 'https://app.nexs.lenskart.com')
  .trim()
  .replace(/\/+$/, '')
const SOURCE_DOMAIN = (process.env.NEXS_SOURCE_DOMAIN || PORTAL_ORIGIN).trim()
/** Facility code the portal sends on its auth-service calls (defaults to NXS1, the Nexs admin facility). */
const FACILITY_CODE = (process.env.NEXS_FACILITY_CODE || 'NXS1').trim()

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

/** Decode a JWT payload (base64url JSON) without verifying the signature. Safe for our own JWT. */
export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length < 2) return null
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
    const json = Buffer.from(b64 + pad, 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** Pull the most useful identity fields from a Nexs JWT payload. */
export function identityFromJwt(token) {
  const claims = decodeJwtPayload(token) || {}
  const empCodeRaw =
    claims.empCode ||
    claims.employeeCode ||
    claims.employee_code ||
    claims.empcode ||
    claims.user?.empCode ||
    claims.user?.employeeCode ||
    null
  const email =
    claims.email ||
    claims.emailId ||
    claims.user?.email ||
    claims.user?.emailId ||
    (typeof claims.sub === 'string' && claims.sub.includes('@') ? claims.sub : null) ||
    null
  const userName = claims.userName || claims.user?.userName || claims.sub || email || null
  return {
    empCode: empCodeRaw ? String(empCodeRaw).trim() : null,
    email: email ? String(email).trim() : null,
    userName: userName ? String(userName).trim() : null,
    claims,
  }
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
  if (FACILITY_CODE && !headers['facility-code']) {
    headers['facility-code'] = FACILITY_CODE
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

  const identity = identityFromJwt(token)
  let empCode = identity.empCode
  const email = identity.email || (user.includes('@') ? user : null)

  // Fallback: JWT often omits empCode for portal users — look it up by email/userName via the search endpoint.
  if (!empCode) {
    empCode = await lookupEmpCodeByIdentity({ token, appId: aid }, { email, userName: user })
  }

  return {
    token,
    appId: aid,
    userName: identity.userName || user,
    email: email || null,
    empCode: empCode || null,
    raw: process.env.NEXS_DEBUG_RESPONSE === '1' ? data : undefined,
  }
}

/** Public alias around lookupEmpCodeByIdentity for routes that need to resolve a parent user's code. */
export function resolveEmpCode(credentials, { email, userName } = {}) {
  return lookupEmpCodeByIdentity(credentials, { email, userName })
}

/** Best-effort: resolve a user's empCode using their email/userName via /v1/get/users. */
async function lookupEmpCodeByIdentity(credentials, { email, userName }) {
  const tries = []
  if (email) tries.push({ emailIds: email })
  if (userName && userName !== email) tries.push({ empCodes: userName })

  for (const params of tries) {
    try {
      const raw = await getUsersByParams(credentials, params)
      const users = normalizeUserList(raw)
      for (const u of users) {
        const code =
          u?.employeeCode ||
          u?.empCode ||
          u?.employee_code ||
          u?.empcode ||
          (typeof u?.userId === 'string' && /^\d+$/.test(u.userId) ? u.userId : null)
        if (code) return String(code).trim()
      }
    } catch {
      // ignore — fallback is best-effort
    }
  }
  return null
}

async function nexsHttp(baseUrl, credentials, path, { method = 'GET', query, body, headers } = {}) {
  const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`)
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

export function nexsFetch(credentials, path, options) {
  return nexsHttp(BASE_URL, credentials, path, options)
}

/** Call the Nexs portal's own REST host (app.nexs.lenskart.com). Used for endpoints the SPA itself owns. */
export function nexsPortalFetch(credentials, path, options) {
  return nexsHttp(PORTAL_API_BASE_URL, credentials, path, options)
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
      // Only a genuine token error invalidates the session. Other 401s (e.g. "no access to this app")
      // are app-name-specific — keep retrying other candidates.
      if (e?.code === 'NEXS_TOKEN_INVALID' || e?.code === 'NEXS_AUTH_REQUIRED') {
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

/** GET /v1/userManagement/user/{empCode}/getAllChildRoles/ — assignable role groups for a manager (portal flow). */
export async function getAssignableRoles(credentials, empCode) {
  const code = String(empCode || '').trim()
  if (!code) throw Object.assign(new Error('Employee code is required'), { status: 400 })
  return nexsFetch(credentials, `/v1/userManagement/user/${encodeURIComponent(code)}/getAllChildRoles/`)
}

/** GET /v1/userManagement/user/{empCode}/approverRoleGroups — fallback when getAllChildRoles isn't available. */
export async function getApproverRoleGroups(credentials, empCode) {
  const code = String(empCode || '').trim()
  if (!code) throw Object.assign(new Error('Employee code is required'), { status: 400 })
  return nexsFetch(credentials, `/v1/userManagement/user/${encodeURIComponent(code)}/approverRoleGroups`)
}

/**
 * GET /v1/userManagement/get/employeeData/{empCode} — resolve an employee from HR master data
 * (works whether or not the employee is already a Nexs user). Mirrors the portal's add-user picker.
 * Tries the auth service first (our JWT works there); falls back to the portal host (matches the SPA call).
 */
export async function lookupEmployee(credentials, empCode) {
  const code = String(empCode || '').trim()
  if (!code) throw Object.assign(new Error('Employee code is required'), { status: 400 })

  const path = `/v1/userManagement/get/employeeData/${encodeURIComponent(code)}`
  try {
    return await nexsFetch(credentials, path)
  } catch (e) {
    if (e?.code === 'NEXS_TOKEN_INVALID' || e?.code === 'NEXS_AUTH_REQUIRED') throw e
    // Best-effort fallback — same endpoint on the portal app's host (the SPA hits this).
    return nexsPortalFetch(credentials, path)
  }
}

/** Pick the most useful "employee" object out of the HR endpoint's response. */
export function normalizeEmployeeRecord(raw) {
  if (!raw) return null
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.data) ? raw.data : Array.isArray(raw.content) ? raw.content : null
  const row = list && list.length ? list[0] : (raw && typeof raw === 'object' && raw.employeeCode ? raw : null)
  if (!row || typeof row !== 'object') return null
  return {
    empCode: row.employeeCode || row.empCode || row.employee_code || null,
    name: row.employeeName || row.name || row.fullName || null,
    status: row.employeeStatus || row.status || null,
    designation: row.designation || row.title || null,
    department: row.department || row.dept || null,
    location: row.location || row.facility || null,
    managerEmpCode: row.managerEmployeeCode || row.managerEmpCode || null,
    managerName: row.managerEmployeeName || row.managerName || null,
    mobile: row.mobileNumber || row.phone || row.phoneNumber || null,
    email: row.email || row.emailId || null,
    dateOfJoining: row.dateOfJoining || row.doj || null,
    raw: row,
  }
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

/**
 * Dedupe a flat list of user rows by empCode (falling back to email or userId).
 * The upstream often returns one row per user/role-group binding, which makes the same
 * user appear many times. Here we collapse those rows into one and union the role/facility lists.
 */
export function dedupeUserList(users) {
  if (!Array.isArray(users) || users.length < 2) return Array.isArray(users) ? users : []

  const keyOf = (u) => {
    if (!u || typeof u !== 'object') return null
    const code = u.employeeCode || u.empCode || u.employee_code || u.empcode
    if (code) return `emp:${String(code).trim().toLowerCase()}`
    const email = u.email || u.emailId || u.mail
    if (email) return `email:${String(email).trim().toLowerCase()}`
    const userId = u.userId || u.id
    if (userId) return `uid:${String(userId).trim().toLowerCase()}`
    return null
  }

  const LIST_KEYS = ['roleGroups', 'roles', 'roleNames', 'activeRoleGroups', 'facilities', 'facilityList', 'accesses']

  const mergeListField = (existing, incoming) => {
    if (!incoming) return existing
    const seen = new Map()
    const add = (item) => {
      if (item == null) return
      const key =
        typeof item === 'string'
          ? item.trim().toLowerCase()
          : typeof item === 'object'
            ? String(item.name || item.roleGroupName || item.id || JSON.stringify(item)).trim().toLowerCase()
            : String(item).toLowerCase()
      if (!key || seen.has(key)) return
      seen.set(key, item)
    }
    if (Array.isArray(existing)) existing.forEach(add)
    if (Array.isArray(incoming)) incoming.forEach(add)
    else add(incoming)
    return [...seen.values()]
  }

  const merged = new Map()
  const fallbackRows = []

  for (const row of users) {
    const key = keyOf(row)
    if (!key) {
      fallbackRows.push(row)
      continue
    }
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, { ...row })
      continue
    }

    // Merge: keep first non-empty scalar for each field, union list-shaped fields.
    for (const [field, value] of Object.entries(row)) {
      if (LIST_KEYS.includes(field) || Array.isArray(value)) {
        prev[field] = mergeListField(prev[field], value)
      } else if (prev[field] === undefined || prev[field] === null || prev[field] === '') {
        prev[field] = value
      }
    }
  }

  return [...merged.values(), ...fallbackRows]
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
  if (Array.isArray(data)) return data.filter((r) => r !== null && r !== undefined)

  const arrays = []
  const seen = new Set()
  const priorityKeys = [
    'roleGroups',
    'roles',
    'childRoles',
    'activeRoleGroups',
    'data',
    'content',
    'result',
    'results',
    'payload',
    'items',
    'records',
  ]

  const pushArray = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return
    const key = `${arr.length}:${typeof arr[0]}`
    if (seen.has(key)) return
    seen.add(key)
    arrays.push(arr)
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

  const scoreRoleArray = (arr) =>
    arr.reduce((score, r) => {
      if (typeof r === 'string' && r.trim()) return score + 1
      if (r && typeof r === 'object' && (r.name || r.roleGroupName || r.roleName || r.id || r.code)) {
        return score + 1
      }
      return score
    }, 0)

  arrays.sort((a, b) => scoreRoleArray(b) - scoreRoleArray(a) || b.length - a.length)
  return arrays[0] || []
}

function facilityName(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'object') return ''
  return String(
    value.name ||
      value.facilityName ||
      value.facility ||
      value.franchiseName ||
      value.storeName ||
      value.siteName ||
      value.location ||
      value.code ||
      value.id ||
      '',
  ).trim()
}

/**
 * POST {portal-host}/facilities — exact call the Nexs SPA makes when populating the role-assign modal.
 * Body matches the portal HAR ({type, pageRequest, facility_status}); response carries facility rows under data.results.
 */
export async function getFacilities(
  credentials,
  { facilityType, facilityStatus = 'ACTIVE', pageSize = 6000, pageNumber = 0, sortKey = 'updated_at', sortOrder = 'DESC' } = {},
) {
  const body = {
    type: facilityType || 'facilities',
    pageRequest: { pageNumber, pageSize, sortKey, sortOrder },
    facility_status: facilityStatus,
  }
  return nexsPortalFetch(credentials, '/facilities', { method: 'POST', body })
}

const FACILITY_OBJECT_HINT_KEYS = new Set([
  'facilityName',
  'facility',
  'facilityCode',
  'franchiseName',
  'storeName',
  'siteName',
  'storeCode',
  'siteCode',
  'code',
  'name',
])

function looksLikeFacilityObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  for (const k of Object.keys(obj)) {
    if (FACILITY_OBJECT_HINT_KEYS.has(k)) return true
  }
  return false
}

export function normalizeFacilityList(data) {
  const found = new Set()
  const add = (value) => {
    const name = facilityName(value)
    if (name) found.add(name)
  }

  const visit = (node, depth = 0) => {
    if (node == null || depth > 8) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      add(node)
      return
    }
    if (typeof node !== 'object') return

    // Pull a name from this object if it shaped like a facility row.
    if (looksLikeFacilityObject(node)) add(node)

    const arrayKeys = [
      'content',
      'data',
      'result',
      'results',
      'payload',
      'items',
      'records',
      'rows',
      'facilities',
      'facility',
      'facilityNames',
      'franchises',
      'sites',
      'stores',
      'locations',
    ]
    for (const key of arrayKeys) {
      if (node[key] !== undefined) visit(node[key], depth + 1)
    }

    for (const [key, value] of Object.entries(node)) {
      if (/facilit|franchise|store|site|location/i.test(key) && (Array.isArray(value) || typeof value === 'object')) {
        visit(value, depth + 1)
      }
    }
  }

  visit(data)
  return [...found].sort((a, b) => a.localeCompare(b))
}
