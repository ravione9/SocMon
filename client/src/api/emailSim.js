import api from './client'

const base = '/api/email-sim'

export function getEmailSimMeta() {
  return api.get(`${base}/meta`).then((r) => r.data)
}

export function getEmailSimStats() {
  return api.get(`${base}/stats/summary`, { params: { _: Date.now() } }).then((r) => r.data)
}

export function listSmtpProfiles() {
  return api.get(`${base}/smtp-profiles`).then((r) => r.data)
}

export function createSmtpProfile(payload) {
  return api.post(`${base}/smtp-profiles`, payload).then((r) => r.data)
}

export function updateSmtpProfile(id, payload) {
  return api.patch(`${base}/smtp-profiles/${id}`, payload).then((r) => r.data)
}

export function deleteSmtpProfile(id) {
  return api.delete(`${base}/smtp-profiles/${id}`).then((r) => r.data)
}

export function listTemplates() {
  return api.get(`${base}/templates`).then((r) => r.data)
}

export function createTemplate(payload) {
  return api.post(`${base}/templates`, payload).then((r) => r.data)
}

export function updateTemplate(id, payload) {
  return api.patch(`${base}/templates/${id}`, payload).then((r) => r.data)
}

export function deleteTemplate(id) {
  return api.delete(`${base}/templates/${id}`).then((r) => r.data)
}

export function seedIndustryTemplates() {
  return api.post(`${base}/templates/seed/industry`).then((r) => r.data)
}

export function seedWorkplaceTemplates() {
  return api.post(`${base}/templates/seed/workplace`).then((r) => r.data)
}

export function listCampaigns() {
  return api.get(`${base}/campaigns`).then((r) => r.data)
}

export function createCampaign(payload) {
  return api.post(`${base}/campaigns`, payload).then((r) => r.data)
}

export function getCampaign(id) {
  return api.get(`${base}/campaigns/${id}`).then((r) => r.data)
}

export function getCampaignAnalytics(id) {
  return api.get(`${base}/campaigns/${id}/analytics`).then((r) => r.data)
}

export function injectCampaignRecipients(id, body) {
  return api.post(`${base}/campaigns/${id}/recipients/inject`, body).then((r) => r.data)
}

/** Draft campaigns: merge recipients from saved groups + contacts (by Mongo id). */
export function addCampaignRecipientsFromSources(id, body) {
  return api.post(`${base}/campaigns/${id}/recipients/from-sources`, body).then((r) => r.data)
}

/** @param {{ q?: string, page?: number, limit?: number }} [params] — pass `limit` to enable pagination (max 200) */
export function listContacts(params) {
  return api.get(`${base}/contacts`, { params }).then((r) => r.data)
}

export function createContact(payload) {
  return api.post(`${base}/contacts`, payload).then((r) => r.data)
}

/** @param {{ csv?: string, rows?: any[], groupId?: string }} payload — `groupId` also adds imported rows to that group. */
export function importContacts(payload) {
  return api.post(`${base}/contacts/import`, payload).then((r) => r.data)
}

export function updateContact(id, payload) {
  return api.patch(`${base}/contacts/${id}`, payload).then((r) => r.data)
}

export function deleteContact(id) {
  return api.delete(`${base}/contacts/${id}`).then((r) => r.data)
}

/** @param {{ q?: string, page?: number, limit?: number }} [params] */
export function listGroups(params) {
  return api.get(`${base}/groups`, { params }).then((r) => r.data)
}

export function createGroup(payload) {
  return api.post(`${base}/groups`, payload).then((r) => r.data)
}

export function updateGroup(id, payload) {
  return api.patch(`${base}/groups/${id}`, payload).then((r) => r.data)
}

export function deleteGroup(id) {
  return api.delete(`${base}/groups/${id}`).then((r) => r.data)
}

export function listGroupMembers(groupId) {
  return api.get(`${base}/groups/${groupId}/members`).then((r) => r.data)
}

export function addGroupMember(groupId, payload) {
  return api.post(`${base}/groups/${groupId}/members`, payload).then((r) => r.data)
}

export function importGroupMembers(groupId, payload) {
  return api.post(`${base}/groups/${groupId}/members/import`, payload).then((r) => r.data)
}

export function deleteGroupMember(groupId, memberId) {
  return api.delete(`${base}/groups/${groupId}/members/${memberId}`).then((r) => r.data)
}

export function updateCampaign(id, payload) {
  return api.patch(`${base}/campaigns/${id}`, payload).then((r) => r.data)
}

export function deleteCampaign(id) {
  return api.delete(`${base}/campaigns/${id}`).then((r) => r.data)
}

export function addCampaignRecipients(id, emails) {
  return api.post(`${base}/campaigns/${id}/recipients`, { emails }).then((r) => r.data)
}

export function launchCampaign(id) {
  return api.post(`${base}/campaigns/${id}/launch`).then((r) => r.data)
}

export function sendOneEmail(payload) {
  return api.post(`${base}/send-one`, payload).then((r) => r.data)
}

/** Origin shown in UI — matches server resolve when env not set (usually browser origin via proxy). */
export function getEmailSimTrackingPublicOriginHint(metaTrackingOrigin) {
  const v = import.meta.env.VITE_EMAIL_SIM_PUBLIC_ORIGIN
  if (v && String(v).trim()) return String(v).trim().replace(/\/+$/, '')
  if (metaTrackingOrigin && String(metaTrackingOrigin).trim()) return String(metaTrackingOrigin).trim().replace(/\/+$/, '')
  if (typeof window !== 'undefined') return window.location.origin
  return ''
}
