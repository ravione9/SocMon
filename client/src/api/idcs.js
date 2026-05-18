/**
 * client/src/api/idcs.js
 * Uses the existing NetPulse axios instance (JWT from authStore).
 */
import api from './client.js'

const BASE = '/api/idcs'
// ════════════════════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════════════════════

export const listUsers = (params = {}) =>
  api.get(`${BASE}/users`, { params }).then((r) => r.data)
export const getUser = (id) =>
  api.get(`${BASE}/users/${id}`).then((r) => r.data)
export const createUser = (data) =>
  api.post(`${BASE}/users`, data).then((r) => r.data)
export const updateUser = (id, patch) =>
  api.patch(`${BASE}/users/${encodeURIComponent(id)}`, patch).then((r) => r.data)
export const deleteUser = (id) =>
  api.delete(`${BASE}/users/${id}`).then((r) => r.data)
export const resetPassword = (id) =>
  api.post(`${BASE}/users/${id}/password-reset`).then((r) => r.data)
export const setPassword = (id, newPassword, mustChangePassword = false) =>
  api.post(`${BASE}/users/${id}/set-password`, { newPassword, mustChangePassword }).then((r) => r.data)
// ════════════════════════════════════════════════════════════════════════════
// BULK
// ════════════════════════════════════════════════════════════════════════════

export const bulkCreateUsers = (users) =>
  api.post(`${BASE}/users/bulk`, { users }).then((r) => r.data)
export const bulkDeleteUsers = (userIds) =>
  api.post(`${BASE}/users/bulk-delete`, { userIds }).then((r) => r.data)
export const bulkSetActive = (userIds, active) =>
  api.post(`${BASE}/users/bulk-set-active`, { userIds, active }).then((r) => r.data)
/**
 * Direct admin password set, in bulk (no email link).
 *  - Per-user:  bulkSetPassword({ users: [{ idcsId, newPassword, mustChangePassword? }] })
 *  - Shared:    bulkSetPassword({ userIds: [...], newPassword, mustChangePassword? })
 */
export const bulkSetPassword = (body) =>
  api.post(`${BASE}/users/bulk-set-password`, body).then((r) => r.data)
/** Convenience: suspend = active:false, activate = active:true (single user). */
export const suspendUser = (id) => updateUser(id, { active: false })
export const activateUser = (id) => updateUser(id, { active: true })
// ════════════════════════════════════════════════════════════════════════════
// GROUPS
// ════════════════════════════════════════════════════════════════════════════

export const listGroups = (params = {}) =>
  api.get(`${BASE}/groups`, { params }).then((r) => r.data)
export const getGroupMembers = (groupId, params = {}) =>
  api.get(`${BASE}/groups/${encodeURIComponent(groupId)}/members`, { params }).then((r) => r.data)
export const addUsersToGroup = (groupId, userIds) =>
  api.post(`${BASE}/groups/${encodeURIComponent(groupId)}/members`, { userIds }).then((r) => r.data)
export const removeUsersFromGroup = (groupId, userIds) =>
  api.delete(`${BASE}/groups/${encodeURIComponent(groupId)}/members`, { data: { userIds } }).then((r) => r.data)
// ════════════════════════════════════════════════════════════════════════════
// EXPORT / DOWNLOAD
// ════════════════════════════════════════════════════════════════════════════

/**
 * Trigger a file download for user export.
 * @param {object} opts - { format: 'csv'|'xlsx'|'json', status: 'active'|'inactive'|'', groupId }
 */
async function blobErrorMessage(data) {
  if (!(data instanceof Blob)) return null
  try {
    const text = await data.text()
    const j = JSON.parse(text)
    return j.error ? String(j.error) : text.slice(0, 500)
  } catch {
    return null
  }
}

export const exportUsers = async ({ format = 'csv', status = '', groupId = '' } = {}) => {
  const params = new URLSearchParams({ format })
  if (status)  params.set('status', status)
  if (groupId) params.set('groupId', groupId)

  const url = `${BASE}/export/users?${params.toString()}`
  let response
  try {
    response = await api.get(url, { responseType: 'blob', timeout: 600000 })
  } catch (e) {
    const blobMsg = await blobErrorMessage(e.response?.data)
    throw new Error(blobMsg || e.response?.data?.error || e.message || 'Export request failed')
  }

  const ct = String(response.headers['content-type'] || '')
  const disposition = String(response.headers['content-disposition'] || '')
  const hasAttachment = /attachment/i.test(disposition)

  if (!hasAttachment && ct.includes('application/json')) {
    const msg = await blobErrorMessage(response.data)
    throw new Error(msg || 'Export failed')
  }

  const match = disposition.match(/filename="?([^"]+)"?/)
  const filename    = match ? match[1] : `idcs_users_${status || 'all'}.${format}`

  const blobUrl  = window.URL.createObjectURL(new Blob([response.data]))
  const link = document.createElement('a')
  link.href  = blobUrl
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(blobUrl)
}
// ════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ════════════════════════════════════════════════════════════════════════════

export const getAuditLogs = (params = {}) =>
  api.get(`${BASE}/audit`, { params }).then((r) => r.data)