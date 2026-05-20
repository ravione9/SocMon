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

/**
 * Real-world phishing-sim quirk: many corporate gateways (Gmail Workspace with
 * "Restrict external images", Lenskart's delivery.lenskart.in wrapper, Outlook
 * with image blocking) strip remote images. Recipients still click links from
 * preview panes, so we see clicked/landing/submitted but Opens stays at 0%.
 *
 * A click physically implies the message was opened. Push an "opened" event the
 * first time we see any downstream activity, so stats reflect real engagement
 * instead of just "did this client auto-fetch images".
 */
async function ensureOpenedEvent(trackingToken, source) {
  try {
    await EmailSimRecipient.updateOne(
      { trackingToken, 'events.type': { $ne: 'opened' } },
      { $push: { events: { type: 'opened', at: new Date(), meta: { source } } } },
    )
  } catch (_) {}
}

router.get('/ping', (_req, res) => {
  res.json({ ok: true })
})

router.get('/open/:token', async (req, res) => {
  const token = req.params.token
  const variant = String(req.query.p || '').slice(0, 16)
  const ua = req.headers['user-agent'] || ''
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim()
  // Always log — operators need to see open hits in container logs to debug
  // "why is my open rate stuck at 0?" without grepping the DB.
  console.log(`[email-sim] open hit token=${token.slice(0, 8)}… variant=${variant || '-'} ip=${ip} ua="${String(ua).slice(0, 120)}"`)
  try {
    await EmailSimRecipient.updateOne(
      { trackingToken: token, 'events.type': { $ne: 'opened' } },
      { $push: { events: { type: 'opened', at: new Date(), meta: { source: `pixel:${variant || 'default'}`, ua, ip } } } },
    )
  } catch (e) {
    console.warn('[email-sim] open update failed:', e?.message || e)
  }
  res.setHeader('Content-Type', 'image/gif')
  res.setHeader('Content-Length', String(PIXEL_GIF.length))
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.status(200).end(PIXEL_GIF)
})

router.get('/click/:token', async (req, res) => {
  let target = ''
  try {
    target = decodeURIComponent(String(req.query.u || ''))
  } catch (_) {
    target = ''
  }
  await ensureOpenedEvent(req.params.token, 'click')
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
  await ensureOpenedEvent(req.params.token, 'landing')
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
  await ensureOpenedEvent(req.params.token, 'capture')
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
