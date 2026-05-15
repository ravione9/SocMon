/**
 * routes/idcs.js — Oracle IDCS User Management
 * Mounted in index.js as: app.use('/api/idcs', idcsRoutes)
 */

import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
// ExcelJS loaded lazily inside the xlsx handler — server starts fine even before npm install
import IdcsAuditLog from '../models/IdcsAuditLog.js'
import * as idcs from '../services/idcsService.js'

const router = Router()
router.use(authenticate)

// ─── Audit helper (fire-and-forget) ──────────────────────────────────────────
function audit(action, req, targetUser, targetGroup, status, details) {
  IdcsAuditLog.create({
    action,
    performedBy: { userId: req.user?._id, email: req.user?.email, username: req.user?.email },
    targetUser,
    targetGroup,
    status,
    details,
    ipAddress: req.ip,
  }).catch((e) => console.error('[idcs audit]', e.message))
}

// ─── Safe status helper ───────────────────────────────────────────────────────
// Never forward a raw IDCS 401/403 to the browser — our axios interceptor
// treats any backend 401 as NetPulse session expiry and logs the admin out.
function idcsStatus(e) {
  const s = e.status || 500
  return (s === 401 || s === 403) ? 502 : s
}

// ─── CSV helper (no extra dependency) ────────────────────────────────────────
function toCSV(rows) {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0])
  const escape  = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\n')
}

// ─── Flatten IDCS user to plain row ──────────────────────────────────────────
function flattenUser(u) {
  return {
    userName:     u.userName || '',
    displayName:  u.displayName || '',
    firstName:    u.name?.givenName || '',
    lastName:     u.name?.familyName || '',
    email:        u.emails?.find((e) => e.primary)?.value || u.emails?.[0]?.value || '',
    mobileNumber: u.phoneNumbers?.find((p) => p.type === 'mobile')?.value || '',
    status:       u.active ? 'Active' : 'Inactive',
    groups:       (u.groups || []).map((g) => g.display).join('; '),
    idcsId:       u.id || '',
    createdAt:    u.meta?.created || '',
    lastModified: u.meta?.lastModified || '',
  }
}

// ════════════════════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════════════════════

router.get('/users', async (req, res) => {
  try {
    const { status, search, page = 1, limit = 25 } = req.query
    const count      = Math.min(parseInt(limit) || 25, 200)
    const startIndex = (parseInt(page) - 1) * count + 1
    const filters    = []
    if (status === 'active')   filters.push('active eq true')
    if (status === 'inactive') filters.push('active eq false')
    if (search) filters.push(`(userName co "${search}" or displayName co "${search}")`)
    const result = await idcs.listUsers({ filter: filters.join(' and '), startIndex, count })
    res.json({ users: result.Resources || [], total: result.totalResults || 0, page: +page, limit: count })
  } catch (e) { res.status(idcsStatus(e)).json({ error: e.message }) }
})

router.get('/users/:id', async (req, res) => {
  try { res.json(await idcs.getUserById(req.params.id)) }
  catch (e) { res.status(idcsStatus(e)).json({ error: e.message }) }
})

router.post('/users', async (req, res) => {
  try {
    const { firstName, lastName, email } = req.body
    if (!email || !firstName || !lastName)
      return res.status(400).json({ error: 'firstName, lastName, email are required' })
    const created = await idcs.createUser(req.body)
    audit('CREATE_USER', req, { idcsId: created.id, userName: created.userName, email }, null, 'SUCCESS', null)
    res.status(201).json(created)
  } catch (e) {
    audit('CREATE_USER', req, { userName: req.body.email }, null, 'FAILED', { error: e.message })
    res.status(idcsStatus(e)).json({ error: e.message })
  }
})

router.delete('/users/:id', async (req, res) => {
  try {
    let info = { idcsId: req.params.id }
    try { const u = await idcs.getUserById(req.params.id); info = { idcsId: u.id, userName: u.userName, email: u.emails?.[0]?.value } } catch (_) {}
    await idcs.deleteUser(req.params.id)
    audit('DELETE_USER', req, info, null, 'SUCCESS', null)
    res.json({ message: 'User deleted', idcsId: req.params.id })
  } catch (e) {
    audit('DELETE_USER', req, { idcsId: req.params.id }, null, 'FAILED', { error: e.message })
    res.status(idcsStatus(e)).json({ error: e.message })
  }
})

router.post('/users/:id/password-reset', async (req, res) => {
  try {
    await idcs.resetPassword(req.params.id)
    audit('PASSWORD_RESET', req, { idcsId: req.params.id }, null, 'SUCCESS', { type: 'email' })
    res.json({ message: 'Password reset email sent' })
  } catch (e) {
    audit('PASSWORD_RESET', req, { idcsId: req.params.id }, null, 'FAILED', { error: e.message })
    res.status(idcsStatus(e)).json({ error: e.message })
  }
})

router.post('/users/:id/set-password', async (req, res) => {
  try {
    const { newPassword, mustChangePassword = false } = req.body
    if (!newPassword) return res.status(400).json({ error: 'newPassword required' })
    await idcs.setPassword(req.params.id, newPassword, mustChangePassword)
    audit('PASSWORD_RESET', req, { idcsId: req.params.id }, null, 'SUCCESS', { type: 'admin_set', mustChangePassword: !!mustChangePassword })
    res.json({ message: 'Password updated', mustChangePassword: !!mustChangePassword })
  } catch (e) {
    audit('PASSWORD_RESET', req, { idcsId: req.params.id }, null, 'FAILED', { error: e.message })
    res.status(idcsStatus(e)).json({ error: e.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// BULK
// ════════════════════════════════════════════════════════════════════════════

router.post('/users/bulk', async (req, res) => {
  try {
    const users = req.body.users
    if (!Array.isArray(users) || !users.length) return res.status(400).json({ error: 'users[] required' })
    if (users.length > 500) return res.status(400).json({ error: 'Max 500 per request' })

    const succeeded = [], failed = []
    const CHUNK = 10
    for (let i = 0; i < users.length; i += CHUNK) {
      const chunk   = users.slice(i, i + CHUNK)
      const results = await Promise.allSettled(chunk.map((u) => idcs.createUser(u)))
      results.forEach((r, idx) => {
        r.status === 'fulfilled'
          ? succeeded.push({ email: chunk[idx].email, idcsId: r.value.id })
          : failed.push({ email: chunk[idx].email, error: r.reason?.message })
      })
    }
    const status = failed.length === 0 ? 'SUCCESS' : succeeded.length > 0 ? 'PARTIAL' : 'FAILED'
    audit('BULK_CREATE_USERS', req, null, null, status, { total: users.length, succeeded: succeeded.length, failed: failed.length })
    res.json({ succeeded, failed, total: users.length })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/users/bulk-delete', async (req, res) => {
  try {
    const { userIds } = req.body
    if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: 'userIds[] required' })
    const succeeded = [], failed = []
    await Promise.allSettled(userIds.map(async (id) => {
      try { await idcs.deleteUser(id); succeeded.push(id) }
      catch (e) { failed.push({ id, error: e.message }) }
    }))
    const status = failed.length === 0 ? 'SUCCESS' : succeeded.length > 0 ? 'PARTIAL' : 'FAILED'
    audit('BULK_DELETE_USERS', req, null, null, status, { total: userIds.length, succeeded: succeeded.length, failed: failed.length })
    res.json({ succeeded, failed })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ════════════════════════════════════════════════════════════════════════════
// GROUPS
// ════════════════════════════════════════════════════════════════════════════

router.get('/groups', async (req, res) => {
  try {
    const { search = '', page = 1, limit = 100 } = req.query
    const count      = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500)
    const pageNum    = Math.max(parseInt(page, 10) || 1, 1)
    const startIndex = (pageNum - 1) * count + 1
    const esc        = (s) => String(s ?? '').replace(/"/g, '')
    let filter       = ''
    if (String(search).trim()) filter = `displayName co "${esc(String(search).trim())}"`
    const result = await idcs.listGroups({ filter, startIndex, count, attributes: 'id,displayName' })
    res.json({
      groups: result.Resources || [],
      total:  result.totalResults || 0,
      page:   pageNum,
      limit:  count,
    })
  } catch (e) { res.status(idcsStatus(e)).json({ error: e.message }) }
})

router.get('/groups/:id/members', async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query
    const count      = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
    const pageNum    = Math.max(parseInt(page, 10) || 1, 1)
    const startIndex = (pageNum - 1) * count + 1
    const result     = await idcs.listGroupMembersPaginated(req.params.id, {
      startIndex,
      count,
      search,
    })
    const members = (result.Resources || []).map((u) => ({
      value:   u.id,
      display: u.displayName || u.userName,
    }))
    res.json({
      members,
      total: result.totalResults ?? members.length,
      page:  pageNum,
      limit: count,
    })
  } catch (e) { res.status(idcsStatus(e)).json({ error: e.message }) }
})

router.post('/groups/:id/members', async (req, res) => {
  try {
    const { userIds } = req.body
    if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: 'userIds[] required' })
    const result = await idcs.addUsersToGroup(req.params.id, userIds)
    audit('ADD_TO_GROUP', req, null, { idcsId: req.params.id }, 'SUCCESS', { userIds })
    res.json(result)
  } catch (e) {
    audit('ADD_TO_GROUP', req, null, { idcsId: req.params.id }, 'FAILED', { error: e.message })
    res.status(idcsStatus(e)).json({ error: e.message })
  }
})

router.delete('/groups/:id/members', async (req, res) => {
  try {
    const { userIds } = req.body
    if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: 'userIds[] required' })
    const result = await idcs.removeUsersFromGroup(req.params.id, userIds)
    audit('REMOVE_FROM_GROUP', req, null, { idcsId: req.params.id }, 'SUCCESS', { userIds })
    res.json(result)
  } catch (e) {
    audit('REMOVE_FROM_GROUP', req, null, { idcsId: req.params.id }, 'FAILED', { error: e.message })
    res.status(idcsStatus(e)).json({ error: e.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════════════════════

router.get('/export/users', async (req, res) => {
  try {
    const { format = 'csv', status, groupId } = req.query
    let filter = ''
    if (status === 'active')   filter = 'active eq true'
    if (status === 'inactive') filter = 'active eq false'

    const users = groupId
      ? await idcs.fetchAllGroupMembers(groupId)
      : await idcs.fetchAllUsers(filter)

    const rows     = users.map(flattenUser)
    const filename = `idcs_users_${status || 'all'}_${Date.now()}`

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`)
      res.setHeader('Content-Type', 'application/json')
      audit('EXPORT_USERS', req, null, null, 'SUCCESS', { format, status, groupId, count: rows.length })
      return res.json(rows)
    }

    if (format === 'xlsx') {
      // Try exceljs if available, otherwise fall back to CSV with .xlsx extension
      try {
        const { default: ExcelJS } = await import('exceljs')
        const wb    = new ExcelJS.Workbook()
        const sheet = wb.addWorksheet('IDCS Users')
        sheet.columns = [
          { header: 'User Name',    key: 'userName',     width: 30 },
          { header: 'Display Name', key: 'displayName',  width: 25 },
          { header: 'First Name',   key: 'firstName',    width: 18 },
          { header: 'Last Name',    key: 'lastName',     width: 18 },
          { header: 'Email',        key: 'email',        width: 32 },
          { header: 'Mobile',       key: 'mobileNumber', width: 16 },
          { header: 'Status',       key: 'status',       width: 12 },
          { header: 'Groups',       key: 'groups',       width: 40 },
          { header: 'IDCS ID',      key: 'idcsId',       width: 30 },
          { header: 'Created At',   key: 'createdAt',    width: 22 },
          { header: 'Last Modified',key: 'lastModified', width: 22 },
        ]
        sheet.getRow(1).eachCell((cell) => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
          cell.alignment = { vertical: 'middle', horizontal: 'center' }
        })
        rows.forEach((row) => {
          const r = sheet.addRow(row)
          if (row.status === 'Inactive') {
            r.eachCell((cell) => {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
            })
          }
        })
        sheet.autoFilter = { from: 'A1', to: 'K1' }
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`)
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        audit('EXPORT_USERS', req, null, null, 'SUCCESS', { format, status, groupId, count: rows.length })
        await wb.xlsx.write(res)
        return res.end()
      } catch (_) {
        // exceljs not installed — fall through to CSV download
      }
    }

    // Default: CSV
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`)
    res.setHeader('Content-Type', 'text/csv')
    audit('EXPORT_USERS', req, null, null, 'SUCCESS', { format, status, groupId, count: rows.length })
    return res.send(toCSV(rows))

  } catch (e) {
    audit('EXPORT_USERS', req, null, null, 'FAILED', { error: e.message })
    res.status(idcsStatus(e)).json({ error: e.message })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ════════════════════════════════════════════════════════════════════════════

router.get('/audit', async (req, res) => {
  try {
    const { action, status, email, from, to, page = 1, limit = 50 } = req.query
    const query = {}
    if (action) query.action = action
    if (status) query.status = status
    if (email)  query['performedBy.email'] = email
    if (from || to) {
      query.createdAt = {}
      if (from) query.createdAt.$gte = new Date(from)
      if (to)   query.createdAt.$lte = new Date(to)
    }
    const skip = (parseInt(page) - 1) * parseInt(limit)
    const [logs, total] = await Promise.all([
      IdcsAuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      IdcsAuditLog.countDocuments(query),
    ])
    res.json({ logs, total, page: +page, limit: +limit })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
