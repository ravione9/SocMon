import { X509Certificate } from 'crypto'
import { SAML } from '@node-saml/node-saml'
import * as cheerio from 'cheerio'
import SamlSetting from '../models/SamlSetting.js'
import User from '../models/User.js'
import { signLoginJwt } from '../utils/jwtAuth.js'
import { toClientUserPayload } from '../utils/computeUserPageAccess.js'

function trim(s) {
  return String(s || '').trim()
}

function firstCorsOrigin() {
  const raw = process.env.CORS_ORIGIN || 'http://localhost:3000'
  return trim(raw.split(',')[0]) || 'http://localhost:3000'
}

export function getApiPublicBase(req) {
  const env = trim(process.env.PUBLIC_APP_URL)
  if (env) return env.replace(/\/$/, '')
  if (req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http'
    const host = req.get('x-forwarded-host') || req.get('host')
    if (host) return `${proto}://${host}`.replace(/\/$/, '')
  }
  return 'http://localhost:5000'
}

export function getFrontendReturnUrl() {
  return firstCorsOrigin().replace(/\/$/, '')
}

export async function loadSamlSettings() {
  return SamlSetting.findOne().lean()
}

function normalizeCertPem(pem) {
  const p = trim(pem)
  if (!p) return ''
  if (p.includes('BEGIN CERTIFICATE')) return p
  const body = p.replace(/\s+/g, '')
  const lines = body.match(/.{1,64}/g) || []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`
}

function resolveSpEntityId(settings, apiBase) {
  const custom = trim(settings?.spEntityId)
  if (custom) return custom
  return `${apiBase}/api/auth/saml/metadata`
}

function resolveAcsUrl(apiBase) {
  return `${apiBase}/api/auth/saml/acs`
}

export function buildSamlInstance(settings, req) {
  const apiBase = getApiPublicBase(req)
  const idpCert = normalizeCertPem(settings?.idpCertPem)
  const entryPoint = trim(settings?.idpSsoUrl)
  const issuer = resolveSpEntityId(settings, apiBase)
  if (!entryPoint || !idpCert) {
    const err = new Error('SAML is not fully configured (IdP SSO URL and certificate required).')
    err.code = 'SAML_NOT_CONFIGURED'
    throw err
  }
  return new SAML({
    issuer,
    callbackUrl: resolveAcsUrl(apiBase),
    entryPoint,
    idpCert,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    wantAssertionsSigned: true,
    acceptedClockSkewMs: 120000,
  })
}

function pickAttribute(profile, primary, fallbacks = []) {
  const keys = [primary, ...fallbacks].filter(Boolean)
  for (const key of keys) {
    const val = profile?.[key]
    if (val != null && String(val).trim()) return String(val).trim()
  }
  return ''
}

export function extractSamlIdentity(profile, settings) {
  const emailAttr = trim(settings?.emailAttribute) || 'email'
  const nameAttr = trim(settings?.nameAttribute) || 'displayName'
  const email = pickAttribute(profile, emailAttr, [
    'email',
    'mail',
    'Email',
    'nameID',
    'nameId',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  ]).toLowerCase()
  const name = pickAttribute(profile, nameAttr, [
    'displayName',
    'name',
    'cn',
    'givenName',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  ]) || email.split('@')[0] || 'SSO User'
  return { email, name }
}

export async function resolveOrProvisionSamlUser({ email, name, settings }) {
  if (!email) {
    const err = new Error('SAML response did not include an email address.')
    err.code = 'SAML_NO_EMAIL'
    throw err
  }
  let user = await User.findOne({ email, active: true })
  if (!user && settings?.autoProvision) {
    user = await User.create({
      name,
      email,
      authKind: 'saml',
      role: settings.defaultRole || 'viewer',
      active: true,
    })
  }
  if (!user) {
    const err = new Error('Your account is not provisioned in Netpulse. Ask an administrator to create your user or enable auto-provisioning.')
    err.code = 'SAML_NOT_PROVISIONED'
    throw err
  }
  if (user.authKind !== 'saml') {
    user.authKind = 'saml'
  }
  if (!trim(user.name) && name) user.name = name
  user.lastLogin = new Date()
  await user.save()
  return user
}

export async function issueSamlLoginToken(user) {
  const token = signLoginJwt(user._id)
  const dto = await toClientUserPayload(user)
  return {
    token,
    user: {
      id: dto.id,
      name: dto.name,
      email: dto.email,
      authKind: dto.authKind || 'saml',
      role: dto.role,
      allowedPages: dto.allowedPages,
      pageAccess: dto.pageAccess,
      customRoleId: dto.customRoleId,
      customRoleName: dto.customRoleName,
      apiAccessEnabled: !!dto.apiAccessEnabled,
      theme: user.themeSaveToProfile ? user.theme : null,
      themeSaveToProfile: !!user.themeSaveToProfile,
    },
  }
}

export function toAdminSamlPayload(settings, req) {
  if (!settings) {
    return {
      enabled: false,
      allowLocalLogin: true,
      autoProvision: false,
      defaultRole: 'viewer',
      idpEntityId: '',
      idpSsoUrl: '',
      idpCertConfigured: false,
      spEntityId: '',
      emailAttribute: 'email',
      nameAttribute: 'displayName',
      acsUrl: resolveAcsUrl(getApiPublicBase(req)),
      metadataUrl: `${getApiPublicBase(req)}/api/auth/saml/metadata`,
      loginUrl: `${getApiPublicBase(req)}/api/auth/saml/login`,
      configured: false,
    }
  }
  const apiBase = getApiPublicBase(req)
  const hasCert = !!trim(settings.idpCertPem)
  const configured = !!(trim(settings.idpSsoUrl) && hasCert)
  return {
    enabled: !!settings.enabled,
    allowLocalLogin: settings.allowLocalLogin !== false,
    autoProvision: !!settings.autoProvision,
    defaultRole: settings.defaultRole || 'viewer',
    idpEntityId: settings.idpEntityId || '',
    idpSsoUrl: settings.idpSsoUrl || '',
    idpCertConfigured: hasCert,
    spEntityId: settings.spEntityId || '',
    emailAttribute: settings.emailAttribute || 'email',
    nameAttribute: settings.nameAttribute || 'displayName',
    acsUrl: resolveAcsUrl(apiBase),
    metadataUrl: `${apiBase}/api/auth/saml/metadata`,
    loginUrl: `${apiBase}/api/auth/saml/login`,
    configured,
    updatedAt: settings.updatedAt,
  }
}

export function toPublicSamlPayload(settings, req) {
  const admin = toAdminSamlPayload(settings, req)
  return {
    enabled: admin.enabled && admin.configured,
    allowLocalLogin: admin.allowLocalLogin,
    loginUrl: admin.loginUrl,
  }
}

export async function upsertSamlSettings(body, userId) {
  const patch = {}
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.allowLocalLogin === 'boolean') patch.allowLocalLogin = body.allowLocalLogin
  if (typeof body.autoProvision === 'boolean') patch.autoProvision = body.autoProvision
  if (body.defaultRole) patch.defaultRole = body.defaultRole
  if (body.idpEntityId != null) patch.idpEntityId = trim(body.idpEntityId)
  if (body.idpSsoUrl != null) patch.idpSsoUrl = trim(body.idpSsoUrl)
  if (body.idpCertPem != null) {
    const cert = normalizeCertPem(body.idpCertPem)
    if (cert) patch.idpCertPem = cert
  }
  if (body.spEntityId != null) patch.spEntityId = trim(body.spEntityId)
  if (body.emailAttribute != null) patch.emailAttribute = trim(body.emailAttribute) || 'email'
  if (body.nameAttribute != null) patch.nameAttribute = trim(body.nameAttribute) || 'displayName'
  patch.updatedBy = userId || null
  return SamlSetting.findOneAndUpdate({}, patch, { upsert: true, new: true, setDefaultsOnInsert: true }).lean()
}

/** Parse SAML 2.0 IdP metadata XML from any identity provider. */
export function parseIdpMetadataXml(xml) {
  const raw = trim(xml)
  if (!raw) {
    const err = new Error('Metadata XML is empty.')
    err.code = 'INVALID_METADATA'
    throw err
  }
  const $ = cheerio.load(raw, { xmlMode: true, decodeEntities: false })
  const entityId =
    $('EntityDescriptor').attr('entityID')
    || $('md\\:EntityDescriptor').attr('entityID')
    || $('[entityID]').first().attr('entityID')
    || ''

  const ssoCandidates = []
  $('SingleSignOnService, md\\:SingleSignOnService').each((_, el) => {
    const binding = $(el).attr('Binding') || ''
    const location = trim($(el).attr('Location'))
    if (location) ssoCandidates.push({ binding, location })
  })
  const prefer = [
    'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
    'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  ]
  let idpSsoUrl = ''
  for (const b of prefer) {
    const hit = ssoCandidates.find((c) => c.binding === b)
    if (hit) { idpSsoUrl = hit.location; break }
  }
  if (!idpSsoUrl && ssoCandidates.length) idpSsoUrl = ssoCandidates[0].location

  let certB64 = ''
  $('KeyDescriptor[use="signing"] X509Certificate, md\\:KeyDescriptor[use="signing"] X509Certificate').each((_, el) => {
    if (!certB64) certB64 = trim($(el).text())
  })
  if (!certB64) {
    $('X509Certificate, md\\:X509Certificate').each((_, el) => {
      if (!certB64) certB64 = trim($(el).text())
    })
  }
  const idpCertPem = certB64 ? normalizeCertPem(certB64) : ''

  if (!entityId && !idpSsoUrl && !idpCertPem) {
    const err = new Error('Could not parse IdP metadata — ensure the XML is valid SAML 2.0 federation metadata.')
    err.code = 'INVALID_METADATA'
    throw err
  }

  return { idpEntityId: entityId, idpSsoUrl, idpCertPem }
}

/** Fetch IdP metadata from URL or parse pasted XML. */
export async function importIdpMetadata({ metadataUrl, metadataXml }) {
  let xml = trim(metadataXml)
  if (!xml && metadataUrl) {
    const url = trim(metadataUrl)
    try {
      new URL(url)
    } catch {
      const err = new Error('Metadata URL is not valid.')
      err.code = 'INVALID_METADATA_URL'
      throw err
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let res
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/samlmetadata+xml, application/xml, text/xml, */*' },
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const err = new Error(`Failed to fetch metadata (HTTP ${res.status}).`)
      err.code = 'METADATA_FETCH_FAILED'
      throw err
    }
    xml = await res.text()
  }
  if (!xml) {
    const err = new Error('Provide a metadata URL or paste metadata XML.')
    err.code = 'INVALID_METADATA'
    throw err
  }
  const parsed = parseIdpMetadataXml(xml)
  return {
    ...parsed,
    source: metadataUrl ? 'url' : 'xml',
    metadataUrl: trim(metadataUrl) || null,
  }
}

export function mergeSamlDraftWithSaved(saved, draft) {
  const merged = {
    enabled: draft?.enabled ?? saved?.enabled ?? false,
    allowLocalLogin: draft?.allowLocalLogin ?? saved?.allowLocalLogin ?? true,
    autoProvision: draft?.autoProvision ?? saved?.autoProvision ?? false,
    defaultRole: draft?.defaultRole || saved?.defaultRole || 'viewer',
    idpEntityId: trim(draft?.idpEntityId) || trim(saved?.idpEntityId) || '',
    idpSsoUrl: trim(draft?.idpSsoUrl) || trim(saved?.idpSsoUrl) || '',
    idpCertPem: normalizeCertPem(draft?.idpCertPem) || normalizeCertPem(saved?.idpCertPem) || '',
    spEntityId: trim(draft?.spEntityId) || trim(saved?.spEntityId) || '',
    emailAttribute: trim(draft?.emailAttribute) || trim(saved?.emailAttribute) || 'email',
    nameAttribute: trim(draft?.nameAttribute) || trim(saved?.nameAttribute) || 'displayName',
  }
  return merged
}

function validateIdpCertificate(pem) {
  if (!pem) {
    return { ok: false, detail: 'IdP certificate is missing.' }
  }
  try {
    const cert = new X509Certificate(pem)
    const validTo = new Date(cert.validTo)
    const now = Date.now()
    const daysLeft = Math.floor((validTo.getTime() - now) / 86400000)
    if (validTo.getTime() < now) {
      return { ok: false, detail: `Certificate expired on ${cert.validTo}.`, subject: cert.subject, issuer: cert.issuer }
    }
    const warn = daysLeft <= 30 ? ` Expires in ${daysLeft} day(s).` : ''
    return {
      ok: true,
      detail: `Valid until ${cert.validTo}.${warn}`,
      subject: cert.subject,
      issuer: cert.issuer,
      daysLeft,
    }
  } catch (e) {
    return { ok: false, detail: e.message || 'Invalid X.509 certificate PEM.' }
  }
}

async function probeUrl(url, label) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal })
    clearTimeout(timer)
    const reachable = res.status < 500
    return {
      ok: reachable,
      detail: reachable
        ? `${label} responded HTTP ${res.status} (reachable from Netpulse server).`
        : `${label} returned HTTP ${res.status}.`,
    }
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Timed out after 8s' : (e.message || 'Unreachable')
    return { ok: false, detail: `${label}: ${msg}` }
  }
}

/**
 * Validate draft or saved SAML config without a live IdP sign-in.
 * @returns {{ ok: boolean, checks: Array<{ id: string, label: string, ok: boolean, detail: string }> }}
 */
export async function testSamlConfiguration(settings, req) {
  const checks = []
  const apiBase = getApiPublicBase(req)
  const push = (id, label, ok, detail) => checks.push({ id, label, ok: !!ok, detail: String(detail || '') })

  if (!trim(process.env.PUBLIC_APP_URL)) {
    const isLocal = /localhost|127\.0\.0\.1|\[::1\]/i.test(apiBase)
    push(
      'public_url',
      'PUBLIC_APP_URL',
      isLocal,
      isLocal
        ? `Not set — using ${apiBase} (fine for local dev; set PUBLIC_APP_URL in production).`
        : `Not set — ACS/metadata URLs use ${apiBase}. Set PUBLIC_APP_URL so your IdP can reach the correct host.`,
    )
  } else {
    push('public_url', 'PUBLIC_APP_URL', true, process.env.PUBLIC_APP_URL)
  }

  const ssoUrl = trim(settings?.idpSsoUrl)
  if (!ssoUrl) {
    push('idp_sso_url', 'IdP SSO URL', false, 'Missing IdP SSO URL.')
  } else {
    try {
      const u = new URL(ssoUrl)
      push('idp_sso_url', 'IdP SSO URL', u.protocol === 'https:', `${u.protocol}//${u.host}${u.pathname}`)
    } catch {
      push('idp_sso_url', 'IdP SSO URL', false, 'Not a valid URL.')
    }
  }

  const entityId = trim(settings?.idpEntityId)
  push('idp_entity_id', 'IdP Entity ID', true, entityId || 'Not set (optional for some IdPs)')

  const certResult = validateIdpCertificate(normalizeCertPem(settings?.idpCertPem))
  push('idp_cert', 'IdP certificate', certResult.ok, certResult.detail)

  if (!ssoUrl || !certResult.ok) {
    return { ok: false, checks }
  }

  try {
    const saml = buildSamlInstance(settings, req)
    const xml = saml.generateServiceProviderMetadata(null, null)
    const hasEntity = xml.includes('EntityDescriptor')
    push('sp_metadata', 'SP metadata XML', hasEntity, hasEntity ? 'Generated successfully.' : 'Metadata XML looks incomplete.')
    const authUrl = await saml.getAuthorizeUrlAsync('', undefined, {})
    push('authorize_url', 'SAML login redirect', !!authUrl, authUrl ? 'Authorize URL built successfully.' : 'Could not build authorize URL.')
    if (authUrl) {
      try {
        const host = new URL(authUrl).origin
        const probe = await probeUrl(`${host}/`, 'IdP origin')
        push('idp_reachability', 'IdP reachability', probe.ok, probe.detail)
      } catch {
        push('idp_reachability', 'IdP reachability', false, 'Could not parse authorize URL for reachability check.')
      }
    }
  } catch (e) {
    push('saml_build', 'SAML library', false, e.message || 'Failed to initialize SAML client.')
  }

  const acsUrl = resolveAcsUrl(apiBase)
  push('acs_url', 'ACS URL', true, acsUrl)
  push('metadata_url', 'Metadata URL', true, `${apiBase}/api/auth/saml/metadata`)

  const emailAttr = trim(settings?.emailAttribute)
  push('email_attribute', 'Email attribute', !!emailAttr, emailAttr || 'Missing')

  return { ok: checks.every((c) => c.ok), checks }
}

