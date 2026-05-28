/**
 * idcsService.js — Oracle IDCS SCIM 2.0 + Identity REST API
 * Uses Node 18+ built-in fetch (no axios needed).
 * Token cached in Redis for 55 min.
 */

import { getRedis } from '../config/redis.js'

const REDIS_TOKEN_KEY = 'idcs:access_token'
const TOKEN_TTL       = 55 * 60

const TENANT_URL    = (process.env.IDCS_TENANT_URL || '').trim().replace(/\/+$/, '')
const CLIENT_ID     = (process.env.IDCS_CLIENT_ID || '').trim()
const CLIENT_SECRET = (process.env.IDCS_CLIENT_SECRET || '').trim()
const ADMIN_BASE    = TENANT_URL ? `${TENANT_URL}/admin/v1` : ''
const TOKEN_URL     = TENANT_URL ? `${TENANT_URL}/oauth2/v1/token` : ''

function assertIdcsConfigured() {
  if (!TENANT_URL || !CLIENT_ID || !CLIENT_SECRET) {
    throw Object.assign(
      new Error(
        'IDCS is not configured. Set IDCS_TENANT_URL, IDCS_CLIENT_ID, and IDCS_CLIENT_SECRET on the server (see server/.env.example), then restart.',
      ),
      { status: 503 },
    )
  }
}

function idcsTlsInsecure() {
  return ['1', 'true', 'yes'].includes(String(process.env.IDCS_TLS_INSECURE || '').toLowerCase())
}

let idcsDispatcher
/** Native fetch, or undici with relaxed TLS when IDCS_TLS_INSECURE=1 (corp SSL inspection). */
async function idcsFetch(url, init) {
  if (!idcsTlsInsecure()) {
    try {
      return await fetch(url, init)
    } catch (err) {
      throw mapIdcsFetchError(err)
    }
  }
  try {
    const { fetch: undiciFetch, Agent } = await import('undici')
    if (!idcsDispatcher) {
      idcsDispatcher = new Agent({ connect: { rejectUnauthorized: false } })
    }
    return await undiciFetch(url, { ...init, dispatcher: idcsDispatcher })
  } catch (err) {
    throw mapIdcsFetchError(err)
  }
}

function mapIdcsFetchError(err) {
  const cause = err?.cause?.code || err?.cause?.message || ''
  const msg = String(err?.message || '')
  if (/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/i.test(`${cause} ${msg}`)) {
    return Object.assign(
      new Error(
        'IDCS HTTPS failed (untrusted certificate — common behind corporate SSL inspection). Set IDCS_TLS_INSECURE=1 on the API server for testing, or install your enterprise CA (NODE_EXTRA_CA_CERTS).',
      ),
      { status: 502 },
    )
  }
  return Object.assign(new Error(msg || 'IDCS request failed'), { status: 502 })
}

// ─── Token ───────────────────────────────────────────────────────────────────

async function fetchFreshToken() {
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  const body  = 'grant_type=client_credentials&scope=urn%3Aopc%3Aidm%3A__myscopes__'
  const res   = await idcsFetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body,
  })
  if (!res.ok) throw Object.assign(new Error(`IDCS token fetch failed: ${res.status}`), { status: res.status })
  const data = await res.json()
  return data.access_token
}

export async function getToken() {
  assertIdcsConfigured()
  const redis = getRedis()
  if (redis) {
    try { const cached = await redis.get(REDIS_TOKEN_KEY); if (cached) return cached } catch (_) {}
  }
  const token = await fetchFreshToken()
  if (redis) {
    try { await redis.setex(REDIS_TOKEN_KEY, TOKEN_TTL, token) } catch (_) {}
  }
  return token
}

// ─── Base fetch helper ───────────────────────────────────────────────────────

async function api(method, path, body = null, params = {}) {
  const token = await getToken()
  const url   = new URL(`${ADMIN_BASE}${path}`)
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v) })

  const opts = {
    method:  method.toUpperCase(),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  }
  if (body) opts.body = JSON.stringify(body)

  const res = await idcsFetch(url.toString(), opts)

  // 204 No Content — success with no body
  if (res.status === 204) return {}

  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch (_) { data = text }

  if (!res.ok) {
    const msg = data?.detail || data?.message || (typeof data === 'string' ? data : JSON.stringify(data))
    throw Object.assign(new Error(msg), { status: res.status })
  }
  return data
}

// ─── Users ───────────────────────────────────────────────────────────────────

export async function listUsers({ filter = '', startIndex = 1, count = 50, attributes = '' } = {}) {
  const params = { startIndex, count }
  if (filter)     params.filter     = filter
  if (attributes) params.attributes = attributes
  return api('get', '/Users', null, params)
}

export async function getUserById(id) {
  const safe = encodeURIComponent(id)
  const attributes = [
    'id', 'userName', 'displayName', 'name', 'emails', 'phoneNumbers',
    'active', 'groups', 'meta', 'nickName', 'title', 'userType',
    'preferredLanguage', 'locale', 'timezone',
  ].join(',')
  return api('get', `/Users/${safe}`, null, { attributes })
}

/**
 * Update IDCS user via SCIM PATCH.
 *
 * `patch` accepts a subset of profile fields. We fetch the current record so multi-valued
 * arrays (emails, phoneNumbers) can be re-sent intact when only one slot changes — this avoids
 * accidentally wiping the primary work email when an admin updates the recovery email.
 *
 * Recovery email lives in `emails` with `type: "recovery"` (Oracle IDCS convention on top of SCIM 2.0).
 *
 * @param {string} id
 * @param {object} patch
 * @param {string} [patch.displayName]
 * @param {string} [patch.firstName]
 * @param {string} [patch.lastName]
 * @param {string} [patch.email]            Primary work email (replaces the existing primary).
 * @param {string} [patch.recoveryEmail]    Empty string removes the recovery email entry.
 * @param {string} [patch.mobileNumber]     Empty string removes the mobile phone entry.
 * @param {boolean} [patch.active]
 */
export async function updateUser(id, patch = {}) {
  const current = await getUserById(id)
  const ops = []

  if (typeof patch.displayName === 'string') {
    ops.push({ op: 'replace', path: 'displayName', value: patch.displayName })
  }
  if (typeof patch.firstName === 'string') {
    ops.push({ op: 'replace', path: 'name.givenName', value: patch.firstName })
  }
  if (typeof patch.lastName === 'string') {
    ops.push({ op: 'replace', path: 'name.familyName', value: patch.lastName })
  }
  if (typeof patch.active === 'boolean') {
    ops.push({ op: 'replace', path: 'active', value: patch.active })
  }

  const wantsEmailEdit = patch.email !== undefined || patch.recoveryEmail !== undefined
  if (wantsEmailEdit) {
    const emails = (current.emails || []).map((e) => ({ ...e }))

    if (patch.email !== undefined) {
      const val = String(patch.email || '').trim()
      const primaryIdx = emails.findIndex((e) => e.primary === true)
      if (val) {
        if (primaryIdx >= 0) emails[primaryIdx].value = val
        else emails.push({ value: val, type: 'work', primary: true })
      }
    }

    if (patch.recoveryEmail !== undefined) {
      const recIdx = emails.findIndex((e) => String(e.type || '').toLowerCase() === 'recovery')
      const val = String(patch.recoveryEmail || '').trim()
      if (val) {
        if (recIdx >= 0) emails[recIdx].value = val
        else emails.push({ value: val, type: 'recovery', primary: false })
      } else if (recIdx >= 0) {
        emails.splice(recIdx, 1)
      }
    }

    ops.push({ op: 'replace', path: 'emails', value: emails })
  }

  if (patch.mobileNumber !== undefined) {
    const phones = (current.phoneNumbers || []).map((p) => ({ ...p }))
    const mobIdx = phones.findIndex((p) => String(p.type || '').toLowerCase() === 'mobile')
    const val = String(patch.mobileNumber || '').trim()
    if (val) {
      if (mobIdx >= 0) phones[mobIdx].value = val
      else phones.push({ value: val, type: 'mobile' })
    } else if (mobIdx >= 0) {
      phones.splice(mobIdx, 1)
    }
    ops.push({ op: 'replace', path: 'phoneNumbers', value: phones })
  }

  if (!ops.length) return current

  await api('patch', `/Users/${encodeURIComponent(id)}`, {
    schemas:    ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: ops,
  })

  return getUserById(id)
}

export async function createUser({ userName, firstName, lastName, email, recoveryEmail, mobileNumber, password }) {
  const emails = [{ value: email, type: 'work', primary: true }]
  if (recoveryEmail && String(recoveryEmail).trim() && String(recoveryEmail).trim() !== email) {
    emails.push({ value: String(recoveryEmail).trim(), type: 'recovery', primary: false })
  }
  const body = {
    schemas:  ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: userName || email,
    name:     { givenName: firstName, familyName: lastName },
    emails,
    active:   true,
  }
  if (mobileNumber) body.phoneNumbers = [{ value: mobileNumber, type: 'mobile' }]
  if (password)     body.password = password
  return api('post', '/Users', body)
}

export async function deleteUser(id) {
  const token = await getToken()
  const res   = await idcsFetch(`${ADMIN_BASE}/Users/${id}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw Object.assign(new Error(text || 'Delete failed'), { status: res.status })
  }
  return { deleted: true, id }
}

export async function resetPassword(id) {
  return api('post', '/UserPasswordResetRequestor', {
    schemas: ['urn:ietf:params:scim:schemas:oracle:idcs:UserPasswordResetRequestor'],
    userId:  id,
    type:    'byAdministrator',
  })
}

export async function setPassword(id, newPassword, mustChangePassword = false) {
  // Step 1 — set the admin-chosen password.
  await api('put', `/UserPasswordChanger/${id}`, {
    schemas:  ['urn:ietf:params:scim:schemas:oracle:idcs:UserPasswordChanger'],
    password: newPassword,
  })

  if (mustChangePassword) {
    // Use mustChangePassword PATCH (works for local/native IDCS login).
    // For SAML enforcement we also attempt UserPasswordResetRequestor with
    // bypassNotification:true, but treat it as best-effort — if it fails
    // (e.g. IDCS account lacks the Notification bypass privilege) we still
    // return success because the password itself was set correctly.
    try {
      await api('post', '/UserPasswordResetRequestor', {
        schemas:            ['urn:ietf:params:scim:schemas:oracle:idcs:UserPasswordResetRequestor'],
        userId:             id,
        type:               'byAdministrator',
        bypassNotification: true,
      })
    } catch (resetErr) {
      // Log for ops visibility but do NOT re-throw — password was set.
      console.warn('[idcs] UserPasswordResetRequestor failed (non-fatal):', resetErr.message)

      // Fallback: set mustChangePassword on the User extension schema.
      // This enforces change for native IDCS login; SAML enforcement depends
      // on the IDCS sign-on policy "Re-authenticate" setting.
      try {
        await api('patch', `/Users/${id}`, {
          schemas:    ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{
            op:    'replace',
            value: {
              'urn:ietf:params:scim:schemas:oracle:idcs:extension:user:User': {
                mustChangePassword: true,
              },
            },
          }],
        })
      } catch (patchErr) {
        console.warn('[idcs] mustChangePassword PATCH also failed (non-fatal):', patchErr.message)
      }
    }
  }

  return { success: true, mustChangePassword: !!mustChangePassword }
}

/**
 * Look up a single IDCS user by email or userName.
 * Tries email match first, then userName. Returns the user object (with `id`).
 * Throws with .status set to 404 (not found) or 409 (multiple matches).
 */
export async function findUserByEmailOrUserName(identifier) {
  const raw = String(identifier ?? '').trim()
  if (!raw) {
    throw Object.assign(new Error('email/userName required'), { status: 400 })
  }
  const safe = raw.replace(/"/g, '\\"')
  const filter = `emails.value eq "${safe}" or userName eq "${safe}"`
  const res = await listUsers({
    filter,
    count: 2,
    attributes: 'id,userName,displayName,emails,active',
  })
  const list = Array.isArray(res?.Resources) ? res.Resources : []
  if (list.length === 0) {
    throw Object.assign(new Error(`No IDCS user matches "${raw}"`), { status: 404 })
  }
  if (list.length > 1) {
    throw Object.assign(new Error(`Multiple IDCS users match "${raw}"`), { status: 409 })
  }
  return list[0]
}

// ─── Groups ──────────────────────────────────────────────────────────────────

export async function listGroups({ startIndex = 1, count = 200, filter = '', attributes = 'id,displayName' } = {}) {
  const params = { startIndex, count }
  if (filter) params.filter = filter
  if (attributes != null && attributes !== '') params.attributes = attributes
  return api('get', '/Groups', null, params)
}

/** Paginated group members via Users filter (avoids huge /Groups/:id members payloads). */
export async function listGroupMembersPaginated(groupId, { startIndex = 1, count = 50, search = '' } = {}) {
  const esc = (s) => String(s ?? '').replace(/"/g, '')
  const gid = esc(groupId)
  let filter = `groups.value eq "${gid}"`
  if (String(search).trim()) {
    const q = esc(String(search).trim())
    filter += ` and (userName co "${q}" or displayName co "${q}" or emails.value co "${q}")`
  }
  return listUsers({ filter, startIndex, count })
}

export async function getGroupMembers(groupId) {
  return api('get', `/Groups/${groupId}`, null, { attributes: 'members' })
}

export async function addUsersToGroup(groupId, userIds) {
  return api('patch', `/Groups/${groupId}`, {
    schemas:    ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: userIds.map((id) => ({ op: 'add', path: 'members', value: [{ value: id, type: 'User' }] })),
  })
}

export async function removeUsersFromGroup(groupId, userIds) {
  return api('patch', `/Groups/${groupId}`, {
    schemas:    ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: userIds.map((id) => ({ op: 'remove', path: `members[value eq "${id}"]` })),
  })
}

// ─── Full-fetch helpers for export ───────────────────────────────────────────

export async function fetchAllUsers(filter = '') {
  const PAGE = 500
  let startIndex = 1, total = null
  const all = []
  do {
    const page = await listUsers({ filter, startIndex, count: PAGE })
    if (total === null) total = page.totalResults || 0
    all.push(...(page.Resources || []))
    startIndex += PAGE
  } while (all.length < total)
  return all
}

export async function fetchAllGroupMembers(groupId) {
  const PAGE = 500
  let startIndex = 1
  let total = null
  const all = []
  const esc = (s) => String(s ?? '').replace(/"/g, '')
  const filter = `groups.value eq "${esc(groupId)}"`
  for (;;) {
    const page = await listUsers({ filter, startIndex, count: PAGE })
    if (total === null) total = page.totalResults || 0
    const batch = page.Resources || []
    all.push(...batch)
    startIndex += PAGE
    if (batch.length === 0 || all.length >= total) break
  }
  return all
}
