/**
 * Active Directory management API — status + directory KPI queries (LDAP to DC).
 * Prefer AD_DOMAIN + AD_DOMAIN_CONTROLLER + service account; optional legacy AD_LDAP_URL.
 */

import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { logAdAudit } from '../utils/adAudit.js'
import AdAuditLog, { AD_AUDIT_ACTIONS } from '../models/AdAuditLog.js'
import {
  adIntegrationConfigured,
  adCredentialsConfigured,
  adLdapWritesEnabled,
  fetchAdOverviewStats,
  fetchAdReport,
  probeAdConnectivity,
  testAdUserBindCredentials,
  listAdUsers,
  listAdGroups,
  listAdComputers,
  listAdOus,
  getAdUserDetail,
  resetAdUserPassword,
  modifyAdUserPatch,
  setAdUserAccountFlags,
  moveAdUser,
  createAdUser,
  getAdGroupDetail,
  modifyAdGroupPatch,
  addAdGroupMembers,
  removeAdGroupMembers,
  createAdGroup,
  getAdComputerDetail,
  modifyAdComputerPatch,
  setAdComputerAccountFlags,
  getAdOuDetail,
  modifyAdOuPatch,
  createAdOu,
} from '../services/adService.js'

const router = Router()
router.use(authenticate)

function trim(v) {
  return typeof v === 'string' ? v.trim() : ''
}

router.get('/status', (_req, res) => {
  const configured = adIntegrationConfigured()
  const credentialsConfigured = adCredentialsConfigured()
  const domainNetbios = trim(process.env.AD_DOMAIN_NETBIOS)
  const domainFqdn = trim(process.env.AD_DOMAIN_FQDN || process.env.AD_DOMAIN)
  const domainController = trim(
    process.env.AD_DOMAIN_CONTROLLER ||
      process.env.AD_DC_HOST ||
      process.env.AD_WRITABLE_DC,
  )
  const legacyUrlSet = Boolean(trim(process.env.AD_LDAP_URL))
  const directParams = Boolean(domainFqdn && domainController)

  let message = ''
  if (!configured) {
    message =
      'Set AD_DOMAIN (DNS name of your AD domain) and AD_DOMAIN_CONTROLLER (writable DC hostname), plus AD_SERVICE_USERNAME / AD_SERVICE_PASSWORD.'
  } else if (!credentialsConfigured) {
    message =
      'Domain and DC are set; add AD_SERVICE_USERNAME and AD_SERVICE_PASSWORD so Netpulse can run directory queries for dashboards and lists.'
  } else if (directParams) {
    message = 'Direct Active Directory integration is configured (domain + DC + credentials).'
  } else {
    message =
      'Active Directory connection is configured (legacy URL mode). Prefer AD_DOMAIN + AD_DOMAIN_CONTROLLER when possible.'
  }

  res.json({
    configured,
    credentialsConfigured,
    adLdapWritesEnabled: adLdapWritesEnabled(),
    domainNetbios: domainNetbios || null,
    domainFqdn: domainFqdn || null,
    domainController: domainController || null,
    connectionHint: directParams ? 'direct' : legacyUrlSet ? 'legacy_url' : null,
    message,
  })
})

router.get('/reports/:reportId', async (req, res) => {
  if (!adIntegrationConfigured()) {
    return res.status(503).json({
      ok: false,
      code: 'AD_NOT_CONFIGURED',
      error: 'Active Directory is not configured on the server.',
    })
  }
  if (!adCredentialsConfigured()) {
    return res.status(503).json({
      ok: false,
      code: 'AD_CREDENTIALS_MISSING',
      error:
        'Set AD_SERVICE_USERNAME and AD_SERVICE_PASSWORD (or AD_BIND_DN / AD_BIND_PASSWORD) to query the domain.',
    })
  }
  try {
    const result = await fetchAdReport(req.params.reportId, req.query || {})
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[ad/reports]', req.params.reportId, e.code || '', e.message)
    const code = e.code || 'AD_REPORT_FAILED'
    if (code === 'AD_REPORT_UNKNOWN') {
      return res.status(400).json({ ok: false, code, error: e.message || 'Unknown report.' })
    }
    const status =
      code === 'AD_CREDENTIALS_MISSING' || code === 'AD_NOT_CONFIGURED'
        ? 503
        : code === 'AD_DN_INVALID' || code === 'AD_DN_OUT_OF_BASE'
          ? 400
          : 502
    const devDetail =
      process.env.NODE_ENV === 'development' ||
      ['1', 'true', 'yes'].includes(String(process.env.AD_DEBUG || '').toLowerCase())
        ? String(e.cause?.message || e.cause || e.stack || '').slice(0, 800)
        : undefined
    res.status(status).json({
      ok: false,
      code,
      error: e.message || 'Report failed.',
      ...(devDetail ? { detail: devDetail } : {}),
    })
  }
})

router.get('/stats', async (_req, res) => {
  if (!adIntegrationConfigured()) {
    return res.status(503).json({
      ok: false,
      code: 'AD_NOT_CONFIGURED',
      error: 'Active Directory is not configured on the server.',
    })
  }
  if (!adCredentialsConfigured()) {
    return res.status(503).json({
      ok: false,
      code: 'AD_CREDENTIALS_MISSING',
      error:
        'Set AD_SERVICE_USERNAME and AD_SERVICE_PASSWORD (or AD_BIND_DN / AD_BIND_PASSWORD) to query the domain.',
    })
  }
  try {
    const stats = await fetchAdOverviewStats()
    const safe = { ...stats }
    delete safe.baseDn
    res.json({ ok: true, stats: safe })
  } catch (e) {
    console.error('[ad/stats]', e.code || '', e.message, e.cause?.message || '')
    const code = e.code || 'AD_QUERY_FAILED'
    const status =
      code === 'AD_CREDENTIALS_MISSING' || code === 'AD_NOT_CONFIGURED' ? 503 : 502
    const devDetail =
      process.env.NODE_ENV === 'development' || ['1', 'true', 'yes'].includes(String(process.env.AD_DEBUG || '').toLowerCase())
        ? String(e.cause?.message || e.cause || e.stack || '').slice(0, 800)
        : undefined
    res.status(status).json({
      ok: false,
      code,
      error: e.message || 'Directory query failed.',
      ...(devDetail ? { detail: devDetail } : {}),
    })
  }
})

function requireAdReady(req, res, next) {
  if (!adIntegrationConfigured()) {
    return res.status(503).json({ ok: false, code: 'AD_NOT_CONFIGURED', error: 'Active Directory is not configured on the server.' })
  }
  if (!adCredentialsConfigured()) {
    return res.status(503).json({ ok: false, code: 'AD_CREDENTIALS_MISSING', error: 'Set AD_SERVICE_USERNAME and AD_SERVICE_PASSWORD on the server.' })
  }
  next()
}

function requireAdWrites(req, res, next) {
  if (!adLdapWritesEnabled()) {
    return res.status(403).json({
      ok: false,
      code: 'AD_WRITES_DISABLED',
      error:
        'LDAP writes are disabled. Remove AD_LDAP_WRITES=0 / AD_LDAP_WRITES=off from the server environment to allow password reset and updates.',
    })
  }
  next()
}

function sendAdModifyError(res, e) {
  console.error('[ad/write]', e.code || '', e.message, e.cause?.message || '')
  const code = e.code || 'AD_MODIFY_FAILED'
  const devDetail =
    process.env.NODE_ENV === 'development' || ['1', 'true', 'yes'].includes(String(process.env.AD_DEBUG || '').toLowerCase())
      ? String(e.cause?.message || e.cause || e.stack || '').slice(0, 800)
      : undefined

  const badReq = new Set([
    'AD_DN_INVALID',
    'AD_DN_OUT_OF_BASE',
    'AD_PASSWORD_INVALID',
    'AD_PATCH_EMPTY',
    'AD_ACCOUNT_ACTION_EMPTY',
    'AD_GROUP_MEMBERS_EMPTY',
    'AD_OU_CONTAINER_READONLY',
    'AD_BODY_INVALID',
    'AD_MOVE_NOOP',
    'AD_LDAP_CONSTRAINT',
    'AD_LDAP_UNWILLING',
    'AD_LDAP_INSUFFICIENT_ACCESS',
  ])
  const notFound = new Set(['AD_USER_NOT_FOUND', 'AD_GROUP_NOT_FOUND', 'AD_COMPUTER_NOT_FOUND', 'AD_OU_NOT_FOUND'])
  let status = 502
  if (code === 'AD_WRITES_DISABLED') status = 403
  else if (notFound.has(code)) status = 404
  else if (badReq.has(code)) status = 400

  res.status(status).json({
    ok: false,
    code,
    error: e.message || 'Directory modification failed.',
    ...(devDetail ? { detail: devDetail } : {}),
  })
}

function sendAdError(res, e, fallbackCode = 'AD_QUERY_FAILED') {
  console.error('[ad]', e.code || '', e.message, e.cause?.message || '')
  const code = e.code || fallbackCode
  const status = code === 'AD_CREDENTIALS_MISSING' || code === 'AD_NOT_CONFIGURED' ? 503 : 502
  const devDetail =
    process.env.NODE_ENV === 'development' || ['1', 'true', 'yes'].includes(String(process.env.AD_DEBUG || '').toLowerCase())
      ? String(e.cause?.message || e.cause || e.stack || '').slice(0, 800)
      : undefined
  res.status(status).json({ ok: false, code, error: e.message || 'Directory query failed.', ...(devDetail ? { detail: devDetail } : {}) })
}

function clampLimit(v, def, max) {
  const n = parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(n, max)
}

router.get('/users', requireAdReady, async (req, res) => {
  try {
    const search = String(req.query.search || '').slice(0, 100)
    const limit = clampLimit(req.query.limit, 500, 5000)
    const parentDn = String(req.query.parentDn || '').trim()
    const data = await listAdUsers({ search, limit, parentDn })
    res.json({ ok: true, ...data, baseDn: undefined })
  } catch (e) {
    if (e.code === 'AD_DN_INVALID' || e.code === 'AD_DN_OUT_OF_BASE') {
      return res.status(400).json({ ok: false, code: e.code, error: e.message })
    }
    sendAdError(res, e)
  }
})

router.get('/users/detail', requireAdReady, async (req, res) => {
  try {
    const raw = String(req.query.dn || '').trim()
    if (!raw) {
      return res.status(400).json({
        ok: false,
        code: 'AD_DN_REQUIRED',
        error: 'Query parameter dn is required (URL-encoded distinguished name).',
      })
    }
    const data = await getAdUserDetail(raw)
    res.json({ ok: true, detail: data.detail })
  } catch (e) {
    const code = e.code || 'AD_QUERY_FAILED'
    if (code === 'AD_DN_INVALID' || code === 'AD_DN_OUT_OF_BASE') {
      return res.status(400).json({ ok: false, code, error: e.message || 'Invalid DN.' })
    }
    if (code === 'AD_USER_NOT_FOUND') {
      return res.status(404).json({ ok: false, code, error: e.message || 'User not found.' })
    }
    sendAdError(res, e)
  }
})

router.post('/users/password', requireAdReady, requireAdWrites, async (req, res) => {
  const dn = String(req.body?.dn || '').trim()
  const mustChangeNextLogon = Boolean(req.body?.mustChangeNextLogon)
  try {
    const newPassword = req.body?.newPassword ?? req.body?.password ?? ''
    if (!dn || !newPassword) {
      return res.status(400).json({
        ok: false,
        code: 'AD_BODY_INVALID',
        error: 'Request body must include dn and newPassword.',
      })
    }
    await resetAdUserPassword({ dn, newPassword, mustChangeNextLogon })
    logAdAudit(req, {
      action: 'AD_USER_PASSWORD_RESET',
      status: 'SUCCESS',
      target: { kind: 'user', dn },
      details: { mustChangeNextLogon },
    })
    res.json({ ok: true })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_USER_PASSWORD_RESET',
      status: 'FAILED',
      target: { kind: 'user', dn },
      details: { mustChangeNextLogon, error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.post('/users/modify', requireAdReady, requireAdWrites, async (req, res) => {
  const dn = String(req.body?.dn || '').trim()
  const patch = req.body?.patch
  try {
    if (!dn || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({
        ok: false,
        code: 'AD_BODY_INVALID',
        error: 'Request body must include dn and a patch object.',
      })
    }
    await modifyAdUserPatch({ dn, patch })
    logAdAudit(req, {
      action: 'AD_USER_MODIFY',
      status: 'SUCCESS',
      target: { kind: 'user', dn },
      details: { fields: Object.keys(patch) },
    })
    res.json({ ok: true })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_USER_MODIFY',
      status: 'FAILED',
      target: { kind: 'user', dn },
      details: { fields: patch && typeof patch === 'object' ? Object.keys(patch) : [], error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.post('/users/account', requireAdReady, requireAdWrites, async (req, res) => {
  const dn = String(req.body?.dn || '').trim()
  const unlock = req.body?.unlock === true
  const disabled = typeof req.body?.disabled === 'boolean' ? req.body.disabled : undefined
  const mustChangePassword = req.body?.mustChangePassword === true
  const dontExpirePassword =
    typeof req.body?.dontExpirePassword === 'boolean' ? req.body.dontExpirePassword : undefined
  const flagSnapshot = { unlock, disabled, mustChangePassword, dontExpirePassword }
  try {
    if (!dn) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn is required.' })
    }
    await setAdUserAccountFlags({ dn, unlock, disabled, mustChangePassword, dontExpirePassword })
    logAdAudit(req, {
      action: 'AD_USER_ACCOUNT_FLAGS',
      status: 'SUCCESS',
      target: { kind: 'user', dn },
      details: flagSnapshot,
    })
    res.json({ ok: true })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_USER_ACCOUNT_FLAGS',
      status: 'FAILED',
      target: { kind: 'user', dn },
      details: { ...flagSnapshot, error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.post('/users/move', requireAdReady, requireAdWrites, async (req, res) => {
  const dn = String(req.body?.dn || '').trim()
  const newParentDn = String(req.body?.newParentDn || '').trim()
  try {
    if (!dn || !newParentDn) {
      return res
        .status(400)
        .json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and newParentDn are required.' })
    }
    const result = await moveAdUser({ dn, newParentDn })
    logAdAudit(req, {
      action: 'AD_USER_MOVE',
      status: 'SUCCESS',
      target: { kind: 'user', dn: result?.newDn || dn, parentDn: newParentDn },
      details: { fromDn: dn, toParent: newParentDn, newDn: result?.newDn || null },
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_USER_MOVE',
      status: 'FAILED',
      target: { kind: 'user', dn, parentDn: newParentDn },
      details: { fromDn: dn, toParent: newParentDn, error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.post('/users/create', requireAdReady, requireAdWrites, async (req, res) => {
  const body = req.body || {}
  try {
    const result = await createAdUser({
      parentDn: body.parentDn,
      samAccountName: body.samAccountName,
      userPrincipalName: body.userPrincipalName,
      cn: body.cn,
      displayName: body.displayName,
      givenName: body.givenName,
      sn: body.sn,
      description: body.description,
      mail: body.mail,
      password: body.password,
      dontExpirePassword: body.dontExpirePassword === true,
      mustChangeNextLogon: body.mustChangeNextLogon === true,
      enabled: body.enabled !== false,
    })
    logAdAudit(req, {
      action: 'AD_USER_CREATE',
      status: 'SUCCESS',
      target: { kind: 'user', dn: result?.dn, name: body.samAccountName || body.cn, parentDn: body.parentDn },
      details: {
        samAccountName: body.samAccountName,
        userPrincipalName: body.userPrincipalName,
        displayName: body.displayName,
        mail: body.mail,
        enabled: body.enabled !== false,
        mustChangeNextLogon: body.mustChangeNextLogon === true,
        dontExpirePassword: body.dontExpirePassword === true,
      },
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_USER_CREATE',
      status: 'FAILED',
      target: { kind: 'user', name: body.samAccountName || body.cn, parentDn: body.parentDn },
      details: {
        samAccountName: body.samAccountName,
        userPrincipalName: body.userPrincipalName,
        error: e.message,
      },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.get('/groups', requireAdReady, async (req, res) => {
  try {
    const search = String(req.query.search || '').slice(0, 100)
    const limit = clampLimit(req.query.limit, 500, 5000)
    const data = await listAdGroups({ search, limit })
    res.json({ ok: true, ...data, baseDn: undefined })
  } catch (e) {
    sendAdError(res, e)
  }
})

router.get('/groups/detail', requireAdReady, async (req, res) => {
  try {
    const dn = String(req.query.dn || '').trim()
    if (!dn) {
      return res.status(400).json({ ok: false, code: 'AD_DN_REQUIRED', error: 'dn is required.' })
    }
    const data = await getAdGroupDetail(dn)
    res.json({ ok: true, detail: data.detail })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/groups/modify', requireAdReady, requireAdWrites, async (req, res) => {
  const dn = String(req.body?.dn || '').trim()
  const patch = req.body?.patch
  try {
    if (!dn || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and patch object required.' })
    }
    await modifyAdGroupPatch({ dn, patch })
    logAdAudit(req, {
      action: 'AD_GROUP_MODIFY',
      status: 'SUCCESS',
      target: { kind: 'group', dn },
      details: { fields: Object.keys(patch) },
    })
    res.json({ ok: true })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_GROUP_MODIFY',
      status: 'FAILED',
      target: { kind: 'group', dn },
      details: { fields: patch && typeof patch === 'object' ? Object.keys(patch) : [], error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.post('/groups/members/add', requireAdReady, requireAdWrites, async (req, res) => {
  const dn = String(req.body?.dn || '').trim()
  const members = req.body?.members
  const memberCount = Array.isArray(members) ? members.length : (members ? 1 : 0)
  try {
    if (!dn || !members) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and members required.' })
    }
    const result = await addAdGroupMembers({ dn, members })
    logAdAudit(req, {
      action: 'AD_GROUP_MEMBER_ADD',
      status: 'SUCCESS',
      target: { kind: 'group', dn },
      details: { members: Array.isArray(members) ? members : [members], count: memberCount },
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_GROUP_MEMBER_ADD',
      status: 'FAILED',
      target: { kind: 'group', dn },
      details: { members: Array.isArray(members) ? members : (members ? [members] : []), count: memberCount, error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.post('/groups/create', requireAdReady, requireAdWrites, async (req, res) => {
  const body = req.body || {}
  try {
    const result = await createAdGroup({
      parentDn: body.parentDn,
      cn: body.cn,
      samAccountName: body.samAccountName,
      description: body.description,
      mail: body.mail,
      groupCategory: body.groupCategory,
      groupScope: body.groupScope,
    })
    logAdAudit(req, {
      action: 'AD_GROUP_CREATE',
      status: 'SUCCESS',
      target: { kind: 'group', dn: result?.dn, name: body.samAccountName || body.cn, parentDn: body.parentDn },
      details: {
        samAccountName: body.samAccountName,
        cn: body.cn,
        groupCategory: body.groupCategory,
        groupScope: body.groupScope,
        mail: body.mail,
      },
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_GROUP_CREATE',
      status: 'FAILED',
      target: { kind: 'group', name: body.samAccountName || body.cn, parentDn: body.parentDn },
      details: { samAccountName: body.samAccountName, cn: body.cn, error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.post('/groups/members/remove', requireAdReady, requireAdWrites, async (req, res) => {
  const dn = String(req.body?.dn || '').trim()
  const members = req.body?.members
  const memberCount = Array.isArray(members) ? members.length : (members ? 1 : 0)
  try {
    if (!dn || !members) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and members required.' })
    }
    const result = await removeAdGroupMembers({ dn, members })
    logAdAudit(req, {
      action: 'AD_GROUP_MEMBER_REMOVE',
      status: 'SUCCESS',
      target: { kind: 'group', dn },
      details: { members: Array.isArray(members) ? members : [members], count: memberCount },
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_GROUP_MEMBER_REMOVE',
      status: 'FAILED',
      target: { kind: 'group', dn },
      details: { members: Array.isArray(members) ? members : (members ? [members] : []), count: memberCount, error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.get('/computers', requireAdReady, async (req, res) => {
  try {
    const search = String(req.query.search || '').slice(0, 100)
    const limit = clampLimit(req.query.limit, 500, 5000)
    const data = await listAdComputers({ search, limit })
    res.json({ ok: true, ...data, baseDn: undefined })
  } catch (e) {
    sendAdError(res, e)
  }
})

router.get('/computers/detail', requireAdReady, async (req, res) => {
  try {
    const dn = String(req.query.dn || '').trim()
    if (!dn) {
      return res.status(400).json({ ok: false, code: 'AD_DN_REQUIRED', error: 'dn is required.' })
    }
    const data = await getAdComputerDetail(dn)
    res.json({ ok: true, detail: data.detail })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/computers/modify', requireAdReady, requireAdWrites, async (req, res) => {
  const dn = String(req.body?.dn || '').trim()
  const patch = req.body?.patch
  try {
    if (!dn || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and patch object required.' })
    }
    await modifyAdComputerPatch({ dn, patch })
    logAdAudit(req, {
      action: 'AD_COMPUTER_MODIFY',
      status: 'SUCCESS',
      target: { kind: 'computer', dn },
      details: { fields: Object.keys(patch) },
    })
    res.json({ ok: true })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_COMPUTER_MODIFY',
      status: 'FAILED',
      target: { kind: 'computer', dn },
      details: { fields: patch && typeof patch === 'object' ? Object.keys(patch) : [], error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.post('/computers/account', requireAdReady, requireAdWrites, async (req, res) => {
  const dn = String(req.body?.dn || '').trim()
  const disabled = req.body?.disabled
  try {
    if (!dn || typeof disabled !== 'boolean') {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and disabled (boolean) required.' })
    }
    await setAdComputerAccountFlags({ dn, disabled })
    logAdAudit(req, {
      action: 'AD_COMPUTER_ACCOUNT_FLAGS',
      status: 'SUCCESS',
      target: { kind: 'computer', dn },
      details: { disabled },
    })
    res.json({ ok: true })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_COMPUTER_ACCOUNT_FLAGS',
      status: 'FAILED',
      target: { kind: 'computer', dn },
      details: { disabled, error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.get('/ous', requireAdReady, async (req, res) => {
  try {
    const limit = clampLimit(req.query.limit, 2000, 10000)
    const data = await listAdOus({ limit })
    res.json({ ok: true, ...data, baseDn: undefined })
  } catch (e) {
    sendAdError(res, e)
  }
})

router.get('/ous/detail', requireAdReady, async (req, res) => {
  try {
    const dn = String(req.query.dn || '').trim()
    if (!dn) {
      return res.status(400).json({ ok: false, code: 'AD_DN_REQUIRED', error: 'dn is required.' })
    }
    const data = await getAdOuDetail(dn)
    res.json({ ok: true, detail: data.detail })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/ous/create', requireAdReady, requireAdWrites, async (req, res) => {
  const body = req.body || {}
  try {
    const result = await createAdOu({
      parentDn: body.parentDn,
      name: body.name,
      description: body.description,
      managedBy: body.managedBy,
    })
    logAdAudit(req, {
      action: 'AD_OU_CREATE',
      status: 'SUCCESS',
      target: { kind: 'ou', dn: result?.dn, name: body.name, parentDn: body.parentDn },
      details: { name: body.name, description: body.description, managedBy: body.managedBy },
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_OU_CREATE',
      status: 'FAILED',
      target: { kind: 'ou', name: body.name, parentDn: body.parentDn },
      details: { name: body.name, error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.post('/ous/modify', requireAdReady, requireAdWrites, async (req, res) => {
  const dn = String(req.body?.dn || '').trim()
  const patch = req.body?.patch
  try {
    if (!dn || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and patch object required.' })
    }
    await modifyAdOuPatch({ dn, patch })
    logAdAudit(req, {
      action: 'AD_OU_MODIFY',
      status: 'SUCCESS',
      target: { kind: 'ou', dn },
      details: { fields: Object.keys(patch) },
    })
    res.json({ ok: true })
  } catch (e) {
    logAdAudit(req, {
      action: 'AD_OU_MODIFY',
      status: 'FAILED',
      target: { kind: 'ou', dn },
      details: { fields: patch && typeof patch === 'object' ? Object.keys(patch) : [], error: e.message },
      errorCode: e.code,
    })
    sendAdModifyError(res, e)
  }
})

router.get('/diagnose', async (_req, res) => {
  if (!adIntegrationConfigured()) {
    return res.status(503).json({
      ok: false,
      code: 'AD_NOT_CONFIGURED',
      error: 'Active Directory is not configured on the server.',
    })
  }
  try {
    const report = await probeAdConnectivity()
    res.json({ ok: report.ok, report })
  } catch (e) {
    console.error('[ad/diagnose]', e.message || e)
    res.status(500).json({ ok: false, error: e.message || 'Probe failed' })
  }
})

/** LDAP bind test with arbitrary user credentials (admin troubleshooting). */
router.post('/test-user-bind', async (req, res) => {
  if (!adIntegrationConfigured()) {
    return res.status(503).json({
      ok: false,
      code: 'AD_NOT_CONFIGURED',
      error: 'Active Directory is not configured on the server.',
    })
  }
  try {
    const username = String(req.body?.username ?? '').trim()
    const password = req.body?.password != null ? String(req.body.password) : ''
    const result = await testAdUserBindCredentials(username, password)
    res.json(result)
  } catch (e) {
    const code = e.code || 'AD_TEST_BIND_FAILED'
    const status =
      code === 'AD_NOT_CONFIGURED' || code === 'AD_NO_URL'
        ? 503
        : code === 'AD_TEST_BIND_INPUT'
          ? 400
          : code === 'AD_USER_BIND_REJECTED'
            ? 422
            : 502
    console.warn('[ad/test-user-bind]', code, e.message || e)
    res.status(status).json({ ok: false, code, error: e.message || 'Bind test failed' })
  }
})

/**
 * List recent AD audit entries. Filters are all optional and additive.
 *
 *   GET /api/ad/audit
 *     ?action=AD_USER_PASSWORD_RESET
 *     &status=SUCCESS|FAILED
 *     &email=actor@example.com
 *     &dn=CN=Jane,OU=...,DC=...
 *     &q=free-text (matched against actor email, target dn, target name)
 *     &from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z
 *     &page=1&limit=50
 */
router.get('/audit', async (req, res) => {
  try {
    const { action, status, email, dn, q, from, to } = req.query || {}
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50))

    const query = {}
    if (action && AD_AUDIT_ACTIONS.includes(String(action))) query.action = String(action)
    if (status === 'SUCCESS' || status === 'FAILED') query.status = status
    if (email) query['performedBy.email'] = String(email)
    if (dn)    query['target.dn'] = String(dn)
    if (from || to) {
      query.createdAt = {}
      if (from) {
        const d = new Date(String(from))
        if (!Number.isNaN(d.valueOf())) query.createdAt.$gte = d
      }
      if (to) {
        const d = new Date(String(to))
        if (!Number.isNaN(d.valueOf())) query.createdAt.$lte = d
      }
      if (!Object.keys(query.createdAt).length) delete query.createdAt
    }
    if (q) {
      const safe = String(q).slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const rx = new RegExp(safe, 'i')
      query.$or = [
        { 'performedBy.email':    rx },
        { 'performedBy.username': rx },
        { 'target.dn':            rx },
        { 'target.name':          rx },
      ]
    }

    const skip = (page - 1) * limit
    const [logs, total] = await Promise.all([
      AdAuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdAuditLog.countDocuments(query),
    ])
    res.json({ ok: true, logs, total, page, limit, actions: AD_AUDIT_ACTIONS })
  } catch (e) {
    console.error('[ad/audit]', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

export default router
