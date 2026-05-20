/**
 * client/src/api/nexs.js — Nexs Auth Service (proxied via NetPulse backend)
 */
import api from './client.js'
import {
  clearNexsSession,
  getNexsSession,
  nexsAuthHeaders,
  setNexsSession,
  updateNexsSession,
} from './nexsSession.js'
import { clearPortalCreds, setPortalCreds } from './nexsPortalCreds.js'

const BASE = '/api/nexs'

function nexsRequest(config) {
  return api({
    ...config,
    headers: { ...config.headers, ...nexsAuthHeaders() },
  })
}

export {
  getNexsSession,
  setNexsSession,
  clearNexsSession,
  updateNexsSession,
  clearPortalCreds,
  setPortalCreds,
}

export const getNexsMeta = () => api.get(`${BASE}/meta`).then((r) => r.data)

export const nexsLogin = ({ userName, password, appId, rememberForPortal = true }) =>
  api.post(`${BASE}/login`, {
    userName,
    password,
    appId: appId || undefined,
  }).then((r) => {
    const { token, appId: resolvedAppId, userName: name, email, empCode } = r.data
    setNexsSession({
      token,
      appId: resolvedAppId,
      userName: name,
      email: email || null,
      empCode: empCode || null,
    })
    if (rememberForPortal && password) {
      setPortalCreds({ userName: name || userName, password })
    }
    return r.data
  })

export const getNexsMe = () =>
  nexsRequest({ method: 'get', url: `${BASE}/me` }).then((r) => r.data)

export function signOutNexs() {
  clearNexsSession()
  clearPortalCreds()
}

export const listUsers = (params = {}) =>
  nexsRequest({ method: 'get', url: `${BASE}/users`, params }).then((r) => r.data)

export const listRoles = (app) =>
  nexsRequest({ method: 'post', url: `${BASE}/roles`, data: { app: app || undefined } }).then((r) => r.data)

export const listFacilities = (appName) =>
  nexsRequest({ method: 'get', url: `${BASE}/facilities`, params: { appName: appName || undefined } }).then((r) => r.data)

export const getUserRoles = (empCode) =>
  nexsRequest({ method: 'get', url: `${BASE}/users/${encodeURIComponent(empCode)}/roles` }).then((r) => r.data)

export const getAssignableRoles = (empCode) =>
  nexsRequest({ method: 'get', url: `${BASE}/users/${encodeURIComponent(empCode)}/assignable-roles` }).then((r) => r.data)

export const lookupEmployee = (empCode) =>
  nexsRequest({ method: 'get', url: `${BASE}/employees/${encodeURIComponent(empCode)}/lookup` }).then((r) => r.data)

export const createUser = (data) =>
  nexsRequest({ method: 'post', url: `${BASE}/users`, data }).then((r) => r.data)

export const assignUserRoles = (empCode, body) =>
  nexsRequest({ method: 'post', url: `${BASE}/users/${encodeURIComponent(empCode)}/roles`, data: body }).then((r) => r.data)

export const assignUsersRolesBulk = (body) =>
  nexsRequest({ method: 'post', url: `${BASE}/users/roles/bulk`, data: body }).then((r) => r.data)

export const validateEmail = (email) =>
  nexsRequest({ method: 'get', url: `${BASE}/validate-email`, params: { email } }).then((r) => r.data)

export const bulkUploadCsv = async ({ file, kind = 'create' }) => {
  const csvBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
  return nexsRequest({
    method: 'post',
    url: `${BASE}/users/bulk`,
    data: { csvBase64, filename: file.name, kind },
  }).then((r) => r.data)
}
