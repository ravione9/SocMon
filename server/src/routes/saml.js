import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { userHasAdminConsoleFull } from '../utils/computeUserPageAccess.js'
import {
  loadSamlSettings,
  buildSamlInstance,
  extractSamlIdentity,
  resolveOrProvisionSamlUser,
  issueSamlLoginToken,
  toAdminSamlPayload,
  toPublicSamlPayload,
  upsertSamlSettings,
  getFrontendReturnUrl,
  mergeSamlDraftWithSaved,
  testSamlConfiguration,
  importIdpMetadata,
} from '../services/samlService.js'

const router = Router()

function trim(s) {
  return String(s || '').trim()
}

/** GET /api/auth/saml/config — public discovery for login page */
router.get('/config', async (req, res) => {
  try {
    const settings = await loadSamlSettings()
    res.json(toPublicSamlPayload(settings, req))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /api/auth/saml/metadata — SP metadata XML for IdP registration */
router.get('/metadata', async (req, res) => {
  try {
    const settings = await loadSamlSettings()
    if (!settings?.enabled) return res.status(404).json({ error: 'SAML SSO is disabled' })
    const saml = buildSamlInstance(settings, req)
    const xml = saml.generateServiceProviderMetadata(null, null)
    res.type('application/xml').send(xml)
  } catch (err) {
    res.status(err.code === 'SAML_NOT_CONFIGURED' ? 503 : 500).json({ error: err.message, code: err.code })
  }
})

/** GET /api/auth/saml/login — redirect browser to IdP */
router.get('/login', async (req, res) => {
  try {
    const settings = await loadSamlSettings()
    if (!settings?.enabled) return res.status(404).json({ error: 'SAML SSO is disabled' })
    const saml = buildSamlInstance(settings, req)
    const url = await saml.getAuthorizeUrlAsync('', undefined, {})
    res.redirect(url)
  } catch (err) {
    res.status(err.code === 'SAML_NOT_CONFIGURED' ? 503 : 500).json({ error: err.message, code: err.code })
  }
})

/** POST /api/auth/saml/acs — Assertion Consumer Service */
router.post('/acs', async (req, res) => {
  try {
    const settings = await loadSamlSettings()
    if (!settings?.enabled) return res.status(404).send('SAML SSO is disabled')
    const saml = buildSamlInstance(settings, req)
    const { profile } = await saml.validatePostResponseAsync(req.body)
    const { email, name } = extractSamlIdentity(profile, settings)
    const user = await resolveOrProvisionSamlUser({ email, name, settings })
    const { token } = await issueSamlLoginToken(user)
    const returnUrl = `${getFrontendReturnUrl()}/login/saml/callback?token=${encodeURIComponent(token)}`
    res.redirect(returnUrl)
  } catch (err) {
    console.warn('[saml] ACS error:', err?.message || err)
    const msg = encodeURIComponent(err.message || 'SAML sign-in failed')
    res.redirect(`${getFrontendReturnUrl()}/login?saml_error=${msg}`)
  }
})

const adminRouter = Router()
adminRouter.use(authenticate)
adminRouter.use(async (req, res, next) => {
  try {
    if (!(await userHasAdminConsoleFull(req.user))) {
      return res.status(403).json({ error: 'Full access to the Admin console is required' })
    }
    next()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/** GET /api/admin/saml */
adminRouter.get('/', async (req, res) => {
  try {
    const settings = await loadSamlSettings()
    res.json(toAdminSamlPayload(settings, req))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** PUT /api/admin/saml */
adminRouter.put('/', async (req, res) => {
  try {
    const body = req.body || {}
    if (body.enabled && (!trim(body.idpSsoUrl) && !body.idpCertPem)) {
      const existing = await loadSamlSettings()
      const hasExisting = existing && trim(existing.idpSsoUrl) && trim(existing.idpCertPem)
      if (!hasExisting) {
        return res.status(400).json({ error: 'Configure IdP SSO URL and certificate before enabling SAML.' })
      }
    }
    const saved = await upsertSamlSettings(body, req.user?._id)
    res.json(toAdminSamlPayload(saved, req))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** POST /api/admin/saml/test — validate draft config without enabling SSO */
adminRouter.post('/test', async (req, res) => {
  try {
    const saved = await loadSamlSettings()
    const merged = mergeSamlDraftWithSaved(saved, req.body || {})
    const result = await testSamlConfiguration(merged, req)
    res.json(result)
  } catch (err) {
    res.status(err.code === 'INVALID_TENANT' ? 400 : 500).json({ error: err.message, code: err.code })
  }
})

/** POST /api/admin/saml/import-metadata — load IdP settings from metadata URL or XML */
adminRouter.post('/import-metadata', async (req, res) => {
  try {
    const result = await importIdpMetadata({
      metadataUrl: req.body?.metadataUrl,
      metadataXml: req.body?.metadataXml,
    })
    res.json(result)
  } catch (err) {
    const code = err.code || 'IMPORT_FAILED'
    const status = ['INVALID_METADATA', 'INVALID_METADATA_URL', 'METADATA_FETCH_FAILED'].includes(code) ? 400 : 500
    res.status(status).json({ error: err.message, code })
  }
})

export { adminRouter as samlAdminRoutes }
export default router
