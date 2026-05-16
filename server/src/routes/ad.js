/**
 * Active Directory management API — status + directory KPI queries (LDAP to DC).
 * Prefer AD_DOMAIN + AD_DOMAIN_CONTROLLER + service account; optional legacy AD_LDAP_URL.
 */

import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
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
  try {
    const dn = String(req.body?.dn || '').trim()
    const newPassword = req.body?.newPassword ?? req.body?.password ?? ''
    const mustChangeNextLogon = Boolean(req.body?.mustChangeNextLogon)
    if (!dn || !newPassword) {
      return res.status(400).json({
        ok: false,
        code: 'AD_BODY_INVALID',
        error: 'Request body must include dn and newPassword.',
      })
    }
    await resetAdUserPassword({ dn, newPassword, mustChangeNextLogon })
    res.json({ ok: true })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/users/modify', requireAdReady, requireAdWrites, async (req, res) => {
  try {
    const dn = String(req.body?.dn || '').trim()
    const patch = req.body?.patch
    if (!dn || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({
        ok: false,
        code: 'AD_BODY_INVALID',
        error: 'Request body must include dn and a patch object.',
      })
    }
    await modifyAdUserPatch({ dn, patch })
    res.json({ ok: true })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/users/account', requireAdReady, requireAdWrites, async (req, res) => {
  try {
    const dn = String(req.body?.dn || '').trim()
    if (!dn) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn is required.' })
    }
    const unlock = req.body?.unlock === true
    const disabled = typeof req.body?.disabled === 'boolean' ? req.body.disabled : undefined
    const mustChangePassword = req.body?.mustChangePassword === true
    const dontExpirePassword =
      typeof req.body?.dontExpirePassword === 'boolean' ? req.body.dontExpirePassword : undefined
    await setAdUserAccountFlags({ dn, unlock, disabled, mustChangePassword, dontExpirePassword })
    res.json({ ok: true })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/users/move', requireAdReady, requireAdWrites, async (req, res) => {
  try {
    const dn = String(req.body?.dn || '').trim()
    const newParentDn = String(req.body?.newParentDn || '').trim()
    if (!dn || !newParentDn) {
      return res
        .status(400)
        .json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and newParentDn are required.' })
    }
    const result = await moveAdUser({ dn, newParentDn })
    res.json({ ok: true, ...result })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/users/create', requireAdReady, requireAdWrites, async (req, res) => {
  try {
    const body = req.body || {}
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
    res.json({ ok: true, ...result })
  } catch (e) {
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
  try {
    const dn = String(req.body?.dn || '').trim()
    const patch = req.body?.patch
    if (!dn || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and patch object required.' })
    }
    await modifyAdGroupPatch({ dn, patch })
    res.json({ ok: true })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/groups/members/add', requireAdReady, requireAdWrites, async (req, res) => {
  try {
    const dn = String(req.body?.dn || '').trim()
    const members = req.body?.members
    if (!dn || !members) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and members required.' })
    }
    const result = await addAdGroupMembers({ dn, members })
    res.json({ ok: true, ...result })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/groups/create', requireAdReady, requireAdWrites, async (req, res) => {
  try {
    const body = req.body || {}
    const result = await createAdGroup({
      parentDn: body.parentDn,
      cn: body.cn,
      samAccountName: body.samAccountName,
      description: body.description,
      mail: body.mail,
      groupCategory: body.groupCategory,
      groupScope: body.groupScope,
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/groups/members/remove', requireAdReady, requireAdWrites, async (req, res) => {
  try {
    const dn = String(req.body?.dn || '').trim()
    const members = req.body?.members
    if (!dn || !members) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and members required.' })
    }
    const result = await removeAdGroupMembers({ dn, members })
    res.json({ ok: true, ...result })
  } catch (e) {
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
  try {
    const dn = String(req.body?.dn || '').trim()
    const patch = req.body?.patch
    if (!dn || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and patch object required.' })
    }
    await modifyAdComputerPatch({ dn, patch })
    res.json({ ok: true })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/computers/account', requireAdReady, requireAdWrites, async (req, res) => {
  try {
    const dn = String(req.body?.dn || '').trim()
    if (!dn || typeof req.body?.disabled !== 'boolean') {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and disabled (boolean) required.' })
    }
    await setAdComputerAccountFlags({ dn, disabled: req.body.disabled })
    res.json({ ok: true })
  } catch (e) {
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
  try {
    const body = req.body || {}
    const result = await createAdOu({
      parentDn: body.parentDn,
      name: body.name,
      description: body.description,
      managedBy: body.managedBy,
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    sendAdModifyError(res, e)
  }
})

router.post('/ous/modify', requireAdReady, requireAdWrites, async (req, res) => {
  try {
    const dn = String(req.body?.dn || '').trim()
    const patch = req.body?.patch
    if (!dn || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ ok: false, code: 'AD_BODY_INVALID', error: 'dn and patch object required.' })
    }
    await modifyAdOuPatch({ dn, patch })
    res.json({ ok: true })
  } catch (e) {
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

export default router
