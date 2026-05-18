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

router.get('/users', async (req, res) => {
  try {
    const credentials = credsFromReq(req)
    const { search, emailIds, empCodes, roles, mode } = req.query
    const q = String(search || '').trim()

    let raw
    if (emailIds || empCodes || roles || q.includes('@')) {
      raw = await nexs.getUsersByParams(credentials, {
        emailIds: emailIds || (q.includes('@') ? q : undefined),
        empCodes: empCodes || (!q.includes('@') && q ? q : undefined),
        roles,
      })
    } else if (mode === 'search' && q) {
      raw = await nexs.getUsersByParams(credentials, { empCodes: q })
    } else {
      raw = await nexs.listApplicationUsers(credentials, req.query.appName)
    }

    let users = nexs.normalizeUserList(raw)
    if (q && users.length === 0) {
      // Some auth-service responses for /v1/get/users are inconsistent; fallback to app user list and filter locally.
      const fallbackRaw = await nexs.listApplicationUsers(credentials, req.query.appName)
      const fallbackUsers = nexs.normalizeUserList(fallbackRaw)
      users = fallbackUsers.filter((u) => userMatchesQuery(u, q))
    }

    res.json({ users, total: users.length, raw: process.env.NEXS_DEBUG_RESPONSE === '1' ? raw : undefined })
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
