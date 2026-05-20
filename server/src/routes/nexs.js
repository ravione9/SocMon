/**
 * routes/nexs.js — Nexs / Lenskart Auth Service user management
 */

import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import * as nexs from '../services/nexsAuthService.js'

const router = Router()
router.use(authenticate)

function nexsStatus(e, { login = false } = {}) {
  const s = e.status || 500
  if (login) return s
  if (e.code === 'NEXS_AUTH_REQUIRED' || e.code === 'NEXS_TOKEN_INVALID') return 401
  return s
}

function credsFromReq(req) {
  return nexs.resolveCredentials(req)
}

function pickText(row, keys) {
  for (const k of keys) {
    const v = row?.[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
  }
  return ''
}

function parseList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]+/g) : []
  return [...new Set(raw.map((v) => String(v || '').trim()).filter(Boolean))]
}

function userMatchesQuery(user, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  const fields = [
    pickText(user, ['employeeCode', 'empCode', 'employee_code', 'userId']),
    pickText(user, ['email', 'emailId', 'mail']),
    pickText(user, ['name', 'displayName', 'fullName']),
  ].filter(Boolean)
  return fields.some((v) => v.toLowerCase().includes(q))
}

router.get('/meta', (req, res) => {
  res.json(nexs.getNexsConfigPublic())
})

router.post('/login', async (req, res) => {
  try {
    const { userName, password, appId } = req.body
    const result = await nexs.login({ userName, password, appId })
    res.json({
      token: result.token,
      appId: result.appId,
      userName: result.userName,
      email: result.email,
      empCode: result.empCode,
      raw: result.raw,
    })
  } catch (e) {
    const status = nexsStatus(e, { login: true })
    res.status(status).json({
      error: e.message,
      code: e.code,
      details: process.env.NEXS_DEBUG_RESPONSE === '1' ? e.data : undefined,
    })
  }
})

router.get('/employees/:empCode/lookup', async (req, res) => {
  let credentials
  try {
    credentials = credsFromReq(req)
  } catch (e) {
    return res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }

  const empCode = String(req.params.empCode || '').trim()
  if (!empCode) return res.status(400).json({ error: 'empCode is required' })

  try {
    const raw = await nexs.lookupEmployee(credentials, empCode)
    const employee = nexs.normalizeEmployeeRecord(raw)
    res.json({
      employee,
      raw: process.env.NEXS_DEBUG_RESPONSE === '1' ? raw : undefined,
    })
  } catch (e) {
    const status = nexsStatus(e)
    if (status === 401 && (e.code === 'NEXS_TOKEN_INVALID' || e.code === 'NEXS_AUTH_REQUIRED')) {
      return res.status(401).json({ error: e.message, code: e.code })
    }
    // 404 / 5xx etc — return null employee so the modal can fall back to typed empCode.
    res.json({
      employee: null,
      warning: e.message || 'Employee lookup unavailable',
      code: e.code || 'NEXS_EMPLOYEE_LOOKUP_FAILED',
    })
  }
})

router.get('/me', async (req, res) => {
  try {
    const credentials = credsFromReq(req)
    const identity = nexs.identityFromJwt(credentials.token)
    let empCode = identity.empCode
    if (!empCode && (identity.email || identity.userName)) {
      try {
        empCode = await nexs.resolveEmpCode(credentials, {
          email: identity.email,
          userName: identity.userName,
        })
      } catch {
        empCode = null
      }
    }
    res.json({
      empCode: empCode || null,
      email: identity.email || null,
      userName: identity.userName || null,
    })
  } catch (e) {
    res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }
})

router.get('/users', async (req, res) => {
  try {
    const credentials = credsFromReq(req)
    const { search, emailIds, empCodes, roles, mode } = req.query
    const q = String(search || '').trim()
    const debugRaw = []

    let raw
    let source
    if (emailIds || empCodes || roles || q.includes('@')) {
      raw = await nexs.getUsersByParams(credentials, {
        emailIds: emailIds || (q.includes('@') ? q : undefined),
        empCodes: empCodes || (!q.includes('@') && q ? q : undefined),
        roles,
      })
      source = 'get-users-by-params'
    } else if (mode === 'search' && q) {
      raw = await nexs.getUsersByParams(credentials, { empCodes: q })
      source = 'get-users-by-empcode'
    } else {
      raw = await nexs.listApplicationUsers(credentials, req.query.appName)
      source = 'list-application-users'
    }
    if (raw && process.env.NEXS_DEBUG_RESPONSE === '1') debugRaw.push({ source, raw })

    let users = nexs.normalizeUserList(raw)
    if (q && users.length === 0) {
      // Some auth-service responses for /v1/get/users are inconsistent; fallback to app user list and filter locally.
      const fallbackRaw = await nexs.listApplicationUsers(credentials, req.query.appName)
      const fallbackUsers = nexs.normalizeUserList(fallbackRaw)
      users = fallbackUsers.filter((u) => userMatchesQuery(u, q))
      if (process.env.NEXS_DEBUG_RESPONSE === '1') debugRaw.push({ source: 'app-users-fallback', raw: fallbackRaw })
    }

    // Blank-search fallback: admin-style accounts often have no rows from /v1/app/users/{appName},
    // so we mine the user list by the roles we know about (matches the portal's "all users in my scope" view).
    if (!q && !emailIds && !empCodes && !roles && users.length === 0) {
      try {
        const roleSources = []
        // 1) Parent's grantable child roles
        if (req.query.parentEmpCode) {
          try {
            const childRolesRaw = await nexs.getAssignableRoles(credentials, req.query.parentEmpCode)
            roleSources.push(...nexs.normalizeRoleList(childRolesRaw))
          } catch {
            // ignore
          }
        }
        // 2) Global app roles
        if (roleSources.length === 0) {
          try {
            const globalRolesRaw = await nexs.listRoles(credentials, req.query.appName)
            roleSources.push(...nexs.normalizeRoleList(globalRolesRaw))
          } catch {
            // ignore
          }
        }

        const roleNames = [
          ...new Set(
            roleSources
              .map((r) => (typeof r === 'string' ? r : r?.name || r?.roleGroupName || r?.roleName))
              .filter(Boolean)
              .map((s) => String(s).trim())
              .filter(Boolean),
          ),
        ].slice(0, 100)

        if (roleNames.length) {
          const byRolesRaw = await nexs.getUsersByParams(credentials, { roles: roleNames.join(',') })
          if (process.env.NEXS_DEBUG_RESPONSE === '1') {
            debugRaw.push({ source: 'by-grantable-roles', rolesCount: roleNames.length, raw: byRolesRaw })
          }
          users = nexs.normalizeUserList(byRolesRaw)
          source = 'by-grantable-roles'
        }
      } catch {
        // ignore — fall through with whatever users we had.
      }
    }

    // Upstream returns one row per user/role-group binding, so the same user repeats N times.
    // Collapse them so the UI shows one row per unique person.
    users = nexs.dedupeUserList(users)

    res.json({
      users,
      total: users.length,
      source,
      raw: process.env.NEXS_DEBUG_RESPONSE === '1' ? debugRaw : undefined,
    })
  } catch (e) {
    res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }
})

router.get('/users/:empCode/roles', async (req, res) => {
  try {
    const credentials = credsFromReq(req)
    const data = await nexs.getActiveRoleGroups(credentials, req.params.empCode)
    res.json(data)
  } catch (e) {
    res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }
})

router.get('/users/:empCode/assignable-roles', async (req, res) => {
  let credentials
  try {
    credentials = credsFromReq(req)
  } catch (e) {
    return res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }

  const empCode = String(req.params.empCode || '').trim()
  if (!empCode) return res.status(400).json({ error: 'empCode is required' })

  const debug = process.env.NEXS_DEBUG_RESPONSE === '1'
  const attempts = []
  const collected = new Map()
  let authError = null

  const tryEndpoint = async (label, fn) => {
    try {
      const raw = await fn()
      const list = nexs.normalizeRoleList(raw)
      attempts.push({ source: label, count: list.length, raw: debug ? raw : undefined })
      for (const role of list) {
        const value =
          typeof role === 'string'
            ? role.trim()
            : String(role?.name || role?.roleGroupName || role?.roleName || role?.id || role?.code || '').trim()
        if (!value || collected.has(value)) continue
        collected.set(value, typeof role === 'string' ? { name: role } : role)
      }
    } catch (e) {
      attempts.push({ source: label, error: e.message, status: e.status, code: e.code })
      if (e?.code === 'NEXS_TOKEN_INVALID' || e?.code === 'NEXS_AUTH_REQUIRED') authError = e
    }
  }

  await tryEndpoint('getAllChildRoles', () => nexs.getAssignableRoles(credentials, empCode))
  await tryEndpoint('approverRoleGroups', () => nexs.getApproverRoleGroups(credentials, empCode))

  // If both endpoints rejected the token, surface that as 401 so the page can sign out.
  if (collected.size === 0 && authError) {
    return res.status(401).json({ error: authError.message, code: authError.code })
  }

  res.json({
    roles: [...collected.values()],
    sources: attempts.map((a) => ({ source: a.source, count: a.count ?? 0, error: a.error, status: a.status })),
    attempts: debug ? attempts : undefined,
  })
})

router.post('/roles', async (req, res) => {
  try {
    const credentials = credsFromReq(req)
    const app = req.body?.app || req.body?.appName || req.query?.app || undefined
    const raw = await nexs.listRoles(credentials, app)
    const roles = nexs.normalizeRoleList(raw)
    res.json({ roles, raw: process.env.NEXS_DEBUG_RESPONSE === '1' ? raw : undefined })
  } catch (e) {
    const message = String(e?.message || '')
    if (/active roles not found/i.test(message)) {
      return res.json({
        roles: [],
        info: 'No active roles found for this app or account.',
        code: 'NEXS_NO_ACTIVE_ROLES',
      })
    }

    const status = nexsStatus(e)
    if (status >= 500) {
      return res.json({
        roles: [],
        warning: message || 'Roles endpoint unavailable from upstream service',
        code: e.code || 'NEXS_ROLES_UNAVAILABLE',
      })
    }
    res.status(status).json({ error: e.message, code: e.code })
  }
})

router.get('/facilities', async (req, res) => {
  // Facilities are an enhancement, not core functionality. This route NEVER returns
  // 401 from upstream failures — the user can still search/manage roles even if we
  // can't list facilities. A real session expiry will surface via search/roles calls.
  let credentials
  try {
    credentials = credsFromReq(req)
  } catch (e) {
    // Only missing/malformed local token bounces here (so the page can show login).
    return res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }

  const debugRaw = []
  const attempts = []

  // 1) Portal host /facilities (matches the Nexs SPA's call).
  try {
    const raw = await nexs.getFacilities(credentials, {
      facilityType: req.query.facilityType || undefined,
      facilityStatus: req.query.facilityStatus || undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      pageNumber: req.query.pageNumber ? Number(req.query.pageNumber) : undefined,
    })
    debugRaw.push({ source: 'nexs-portal:/facilities', raw })
    const facilities = nexs.normalizeFacilityList(raw)
    if (facilities.length) {
      return res.json({
        facilities,
        source: 'nexs-portal',
        raw: process.env.NEXS_DEBUG_RESPONSE === '1' ? debugRaw : undefined,
      })
    }
  } catch (e) {
    attempts.push({ source: 'nexs-portal', message: e.message, status: e.status, code: e.code })
  }

  // 2) Derive facility names from the application user listing (auth-service call).
  try {
    const fallbackRaw = await nexs.listApplicationUsers(credentials, req.query.appName)
    debugRaw.push({ source: 'app-users', raw: fallbackRaw })
    const users = nexs.normalizeUserList(fallbackRaw)
    const facilities = nexs.normalizeFacilityList(users)
    if (facilities.length) {
      return res.json({
        facilities,
        source: 'derived-from-users',
        raw: process.env.NEXS_DEBUG_RESPONSE === '1' ? debugRaw : undefined,
      })
    }
    attempts.push({ source: 'app-users', message: 'No facilities discoverable from user listing' })
  } catch (e) {
    attempts.push({ source: 'app-users', message: e.message, status: e.status, code: e.code })
  }

  // Nothing worked — return an empty list. The Assign-roles modal lets the user
  // type facility names manually, so the page remains functional.
  return res.json({
    facilities: [],
    source: 'empty',
    attempts: process.env.NEXS_DEBUG_RESPONSE === '1' ? attempts : undefined,
    raw: process.env.NEXS_DEBUG_RESPONSE === '1' ? debugRaw : undefined,
  })
})

router.get('/validate-email', async (req, res) => {
  try {
    const credentials = credsFromReq(req)
    const data = await nexs.validateEmail(credentials, req.query.email)
    res.json(data)
  } catch (e) {
    res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }
})

router.post('/users', async (req, res) => {
  try {
    const credentials = credsFromReq(req)
    const {
      name,
      email,
      employeeCode,
      phoneCode,
      phoneNumber,
      department,
      userType,
      userId,
      accesses,
      roleGroups,
      facilities,
    } = req.body

    if (!email && !employeeCode) {
      return res.status(400).json({ error: 'email or employeeCode is required' })
    }

    const createPayload = {
      name: name || undefined,
      email: email || undefined,
      employeeCode: employeeCode || undefined,
      phoneCode: phoneCode || undefined,
      phoneNumber: phoneNumber || undefined,
      department: department || undefined,
      userType: userType || undefined,
      userId: userId || undefined,
      accesses: accesses || undefined,
    }
    Object.keys(createPayload).forEach((k) => {
      if (createPayload[k] === undefined) delete createPayload[k]
    })

    const createResult = await nexs.createOrUpdateUser(credentials, createPayload)

    let roleResult = null
    const groups = Array.isArray(roleGroups) ? roleGroups.filter(Boolean) : []
    const facs = Array.isArray(facilities) ? facilities.filter(Boolean) : []
    const emp = employeeCode || createResult?.data?.employeeCode || createResult?.employeeCode

    if (groups.length || facs.length) {
      const mgmt = { roleGroups: groups, facilities: facs }
      if (emp) mgmt.employeeCodes = [String(emp)]
      else if (userId) mgmt.userId = String(userId)
      else if (email) mgmt.userId = String(email)
      roleResult = await nexs.userManagementCreateEdit(credentials, mgmt)
    }

    res.status(201).json({ create: createResult, roles: roleResult })
  } catch (e) {
    res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }
})

router.post('/users/:empCode/roles', async (req, res) => {
  try {
    const credentials = credsFromReq(req)
    const empCode = String(req.params.empCode || '').trim()
    const roleGroups = Array.isArray(req.body?.roleGroups) ? req.body.roleGroups.filter(Boolean) : []
    const facilities = Array.isArray(req.body?.facilities) ? req.body.facilities.filter(Boolean) : []
    if (!empCode) return res.status(400).json({ error: 'empCode is required' })
    if (!roleGroups.length && !facilities.length) {
      return res.status(400).json({ error: 'roleGroups or facilities required' })
    }
    const result = await nexs.userManagementCreateEdit(credentials, {
      employeeCodes: [empCode],
      roleGroups,
      facilities,
    })
    res.json(result)
  } catch (e) {
    res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }
})

router.post('/users/roles/bulk', async (req, res) => {
  try {
    const credentials = credsFromReq(req)
    const employeeCodes = parseList(req.body?.employeeCodes)
    const roleGroups = parseList(req.body?.roleGroups)
    const facilities = parseList(req.body?.facilities)

    if (!employeeCodes.length) return res.status(400).json({ error: 'employeeCodes are required' })
    if (!roleGroups.length && !facilities.length) {
      return res.status(400).json({ error: 'roleGroups or facilities required' })
    }

    const result = await nexs.userManagementCreateEdit(credentials, {
      employeeCodes,
      roleGroups,
      facilities,
    })
    res.json(result)
  } catch (e) {
    res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }
})

router.post('/users/bulk', async (req, res) => {
  try {
    const credentials = credsFromReq(req)
    const { csvBase64, filename = 'users.csv', kind = 'create' } = req.body
    if (!csvBase64) return res.status(400).json({ error: 'csvBase64 is required' })
    const buf = Buffer.from(String(csvBase64), 'base64')
    if (!buf.length) return res.status(400).json({ error: 'Empty CSV payload' })

    let result
    if (kind === 'roles') {
      result = await nexs.bulkUpdateUserRolesFromCsv(credentials, buf, filename)
    } else if (kind === 'management') {
      result = await nexs.bulkUserManagementFromCsv(credentials, buf, filename)
    } else {
      result = await nexs.bulkCreateUsersFromCsv(credentials, buf, filename)
    }
    res.json(result)
  } catch (e) {
    res.status(nexsStatus(e)).json({ error: e.message, code: e.code })
  }
})

export default router
