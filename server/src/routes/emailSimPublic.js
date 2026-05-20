/**
 * Public tracking endpoints — no JWT (recipient inbox / browser).
 * Mounted at app.use('/api/email-sim/pub', ...)
 */

import { Router } from 'express'
import EmailSimRecipient from '../models/EmailSimRecipient.js'
import { defaultLandingPageHtml, mergeTemplate } from '../services/emailSimCampaignService.js'
import { isSafeHttpUrl, resolveTrackingOriginFromEnv, resolveOriginFromRequest } from '../services/emailSimTrackingService.js'

const router = Router()

const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

router.get('/ping', (_req, res) => {
  res.json({ ok: true })
})

router.get('/open/:token', async (req, res) => {
  try {
    await EmailSimRecipient.updateOne(
      { trackingToken: req.params.token },
      { $push: { events: { type: 'opened', at: new Date(), meta: { ua: req.headers['user-agent'] || '' } } } },
    )
  } catch (_) {}
  res.setHeader('Content-Type', 'image/gif')
  res.setHeader('Cache-Control', 'no-store')
  res.send(PIXEL_GIF)
})

router.get('/click/:token', async (req, res) => {
  let target = ''
  try {
    target = decodeURIComponent(String(req.query.u || ''))
  } catch (_) {
    target = ''
  }
  try {
    await EmailSimRecipient.updateOne(
      { trackingToken: req.params.token },
      { $push: { events: { type: 'clicked', at: new Date(), meta: { target } } } },
    )
  } catch (_) {}
  if (!target || !isSafeHttpUrl(target)) {
    return res.status(400).send('Invalid link')
  }
  res.redirect(302, target)
})

router.get('/landing/:token', async (req, res) => {
  const origin =
    resolveTrackingOriginFromEnv() || resolveOriginFromRequest(req) || `${req.protocol}://${req.get('host')}`
  try {
    const rec = await EmailSimRecipient.findOne({ trackingToken: req.params.token }).populate('campaignId').lean()
    if (rec) {
      await EmailSimRecipient.updateOne(
        { _id: rec._id },
        { $push: { events: { type: 'landing_view', at: new Date(), meta: {} } } },
      )
      const campaign = rec.campaignId
      const vars = {
        ...(campaign?.mergeDefaults && typeof campaign.mergeDefaults === 'object' ? campaign.mergeDefaults : {}),
        ...(rec.mergeVars && typeof rec.mergeVars === 'object' ? rec.mergeVars : {}),
        email: rec.email,
      }
      const html =
        campaign?.landingHtml && String(campaign.landingHtml).trim()
          ? mergeTemplate(campaign.landingHtml, vars)
          : defaultLandingPageHtml({ origin, token: req.params.token })
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      return res.send(html)
    }
  } catch (_) {}
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(defaultLandingPageHtml({ origin, token: req.params.token }))
})

router.post('/capture/:token', async (req, res) => {
  try {
    const payload =
      typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length ? req.body : { raw: '' }
    await EmailSimRecipient.updateOne(
      { trackingToken: req.params.token },
      { $push: { events: { type: 'submitted', at: new Date(), meta: { payload } } } },
    )
  } catch (_) {}
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Recorded</title></head><body style="font-family:system-ui;padding:24px;">
<p>Thank you. This simulation recorded your submission only.</p></body></html>`)
})

export default router
