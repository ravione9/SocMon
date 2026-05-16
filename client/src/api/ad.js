/**
 * Active Directory API client (JWT via shared axios instance).
 */
import api from './client.js'

const BASE = '/api/ad'

export const getAdStatus = () =>
  api.get(`${BASE}/status`).then((r) => r.data)

export const getAdStats = () =>
  api.get(`${BASE}/stats`).then((r) => r.data)

/** @param {string} reportId @param {Record<string, string|number>} [params] query: days, limit */
export const getAdReport = (reportId, params = {}) =>
  api.get(`${BASE}/reports/${encodeURIComponent(reportId)}`, { params }).then((r) => r.data)

export const diagnoseAd = () =>
  api.get(`${BASE}/diagnose`).then((r) => r.data)

/** LDAP bind test (overview troubleshooting). Same TLS rules as directory integration. */
export const testAdUserBind = (body) =>
  api.post(`${BASE}/test-user-bind`, body).then((r) => r.data)

export const listAdUsers = (params = {}) =>
  api.get(`${BASE}/users`, { params }).then((r) => r.data)

/** @param {{ dn: string }} params — dn should be the LDAP distinguished name */
export const getAdUserDetail = (params) =>
  api.get(`${BASE}/users/detail`, { params }).then((r) => r.data)

export const resetAdUserPassword = (body) =>
  api.post(`${BASE}/users/password`, body).then((r) => r.data)

export const modifyAdUser = (body) =>
  api.post(`${BASE}/users/modify`, body).then((r) => r.data)

export const setAdUserAccount = (body) =>
  api.post(`${BASE}/users/account`, body).then((r) => r.data)

export const moveAdUser = (body) =>
  api.post(`${BASE}/users/move`, body).then((r) => r.data)

export const createAdUser = (body) =>
  api.post(`${BASE}/users/create`, body).then((r) => r.data)

export const listAdGroups = (params = {}) =>
  api.get(`${BASE}/groups`, { params }).then((r) => r.data)

export const getAdGroupDetail = (params) =>
  api.get(`${BASE}/groups/detail`, { params }).then((r) => r.data)

export const modifyAdGroup = (body) =>
  api.post(`${BASE}/groups/modify`, body).then((r) => r.data)

export const addAdGroupMembers = (body) =>
  api.post(`${BASE}/groups/members/add`, body).then((r) => r.data)

export const removeAdGroupMembers = (body) =>
  api.post(`${BASE}/groups/members/remove`, body).then((r) => r.data)

export const createAdGroup = (body) =>
  api.post(`${BASE}/groups/create`, body).then((r) => r.data)

export const listAdComputers = (params = {}) =>
  api.get(`${BASE}/computers`, { params }).then((r) => r.data)

export const getAdComputerDetail = (params) =>
  api.get(`${BASE}/computers/detail`, { params }).then((r) => r.data)

export const modifyAdComputer = (body) =>
  api.post(`${BASE}/computers/modify`, body).then((r) => r.data)

export const setAdComputerAccount = (body) =>
  api.post(`${BASE}/computers/account`, body).then((r) => r.data)

export const listAdOus = (params = {}) =>
  api.get(`${BASE}/ous`, { params }).then((r) => r.data)

export const getAdOuDetail = (params) =>
  api.get(`${BASE}/ous/detail`, { params }).then((r) => r.data)

export const modifyAdOu = (body) =>
  api.post(`${BASE}/ous/modify`, body).then((r) => r.data)

export const createAdOu = (body) =>
  api.post(`${BASE}/ous/create`, body).then((r) => r.data)
