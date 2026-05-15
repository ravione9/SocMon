/**
 * idcsService.js — Oracle IDCS SCIM 2.0 + Identity REST API
 * Uses Node 18+ built-in fetch (no axios needed).
 * Token cached in Redis for 55 min.
 */

import { getRedis } from '../config/redis.js'

const REDIS_TOKEN_KEY = 'idcs:access_token'
const TOKEN_TTL       = 55 * 60

const TENANT_URL    = process.env.IDCS_TENANT_URL    || ''
const CLIENT_ID     = process.env.IDCS_CLIENT_ID     || ''
const CLIENT_SECRET = process.env.IDCS_CLIENT_SECRET || ''
const ADMIN_BASE    = `${TENANT_URL}/admin/v1`
const TOKEN_URL     = `${TENANT_URL}/oauth2/v1/token`

// ─── Token ───────────────────────────────────────────────────────────────────

async function fetchFreshToken() {
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  const body  = 'grant_type=client_credentials&scope=urn%3Aopc%3Aidm%3A__myscopes__'
  const res   = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body,
  })
  if (!res.ok) throw Object.assign(new Error(`IDCS token fetch failed: ${res.status}`), { status: res.status })
  const data = await res.json()
  return data.access_token
}

export async function getToken() {
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

  const res = await fetch(url.toString(), opts)

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
    'active', 'groups', 'meta',
  ].join(',')
  return api('get', `/Users/${safe}`, null, { attributes })
}

export async function createUser({ userName, firstName, lastName, email, mobileNumber, password }) {
  const body = {
    schemas:  ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: userName || email,
    name:     { givenName: firstName, familyName: lastName },
    emails:   [{ value: email, type: 'work', primary: true }],
    active:   true,
  }
  if (mobileNumber) body.phoneNumbers = [{ value: mobileNumber, type: 'mobile' }]
  if (password)     body.password = password
  return api('post', '/Users', body)
}

export async function deleteUser(id) {
  const token = await getToken()
  const res   = await fetch(`${ADMIN_BASE}/Users/${id}`, {
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
