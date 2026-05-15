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
export const exportUsers = async ({ format = 'csv', status = '', groupId = '' } = {}) => {
  const params = new URLSearchParams({ format })
  if (status)  params.set('status', status)
  if (groupId) params.set('groupId', groupId)

  const response = await api.get(`${BASE}/export/users?${params.toString()}`, { responseType: 'blob' })

  const disposition = response.headers['content-disposition'] || ''
  const match       = disposition.match(/filename="?([^"]+)"?/)
  const filename    = match ? match[1] : `idcs_users_${status || 'all'}.${format}`

  const url  = window.URL.createObjectURL(new Blob([response.data]))
  const link = document.createElement('a')
  link.href  = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}
// ════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ════════════════════════════════════════════════════════════════════════════

export const getAuditLogs = (params = {}) =>
  api.get(`${BASE}/audit`, { params }).then((r) => r.data)