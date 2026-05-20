import crypto from 'crypto'
import mongoose from 'mongoose'
import * as cheerio from 'cheerio'
import EmailSimCampaign from '../models/EmailSimCampaign.js'
import EmailSimContact from '../models/EmailSimContact.js'
import EmailSimGroup from '../models/EmailSimGroup.js'
import EmailSimGroupMember from '../models/EmailSimGroupMember.js'
import EmailSimRecipient from '../models/EmailSimRecipient.js'
import EmailSimTemplate from '../models/EmailSimTemplate.js'
import { createTransportForProfile, getOwnedProfile } from './smtpProfileService.js'
import { describeTrackingOriginIssue, resolveTrackingOrigin } from './emailSimTrackingService.js'

const PIXEL_PATH = '/api/email-sim/pub/open'
const CLICK_PATH = '/api/email-sim/pub/click'
const LANDING_PATH = '/api/email-sim/pub/landing'

export function mergeTemplate(html, vars) {
  let out = String(html || '')
  const map = vars && typeof vars === 'object' ? vars : {}
  for (const [k, v] of Object.entries(map)) {
    const re = new RegExp(`\\{\\{\\s*${escapeRegex(k)}\\s*\\}\\}`, 'gi')
    out = out.replace(re, v == null ? '' : String(v))
  }
  return out
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildTrackedHtml(html, trackingToken, origin) {
  const base = String(origin || '').replace(/\/+$/, '')
  const openUrl = `${base}${PIXEL_PATH}/${trackingToken}`
  const clickBase = `${base}${CLICK_PATH}/${trackingToken}`
  const landingUrl = `${base}${LANDING_PATH}/${trackingToken}`
  const root = cheerio.load(html, { decodeEntities: false })
  root('a[href]').each((_, el) => {
    const href = root(el).attr('href')
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return
    if (!/^https?:\/\//i.test(href)) return
    let target = href
    try {
      const parsed = new URL(href)
      if (parsed.hostname === 'example.com') target = landingUrl
    } catch {
      target = href
    }
    const u = encodeURIComponent(target)
    root(el).attr('href', `${clickBase}?u=${u}`)
  })

  // Two pixels — top of body and bottom — give us the best chance of an open
  // event regardless of which images the recipient's client decides to fetch.
  // Cache-busting query params make corporate proxies (Gmail image proxy,
  // delivery.lenskart.in, Mimecast) treat each as distinct and re-fetch.
  const pixelTop = `<img src="${openUrl}?p=top" alt="" width="1" height="1" border="0" style="display:block !important;height:1px;width:1px;border:0;line-height:1px;" />`
  const pixelBot = `<img src="${openUrl}?p=bot" alt="" width="1" height="1" border="0" style="display:block !important;height:1px;width:1px;border:0;line-height:1px;" />`
  const body = root('body')
  if (body.length) {
    body.prepend(pixelTop)
    body.append(pixelBot)
  } else {
    root.root().prepend(pixelTop)
    root.root().append(pixelBot)
  }
  return root.html()
}

export function defaultLandingPageHtml({ origin, token }) {
  const base = String(origin || '').replace(/\/+$/, '')
  const captureUrl = `${base}/api/email-sim/pub/capture/${token}`
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Verification</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1419;color:#e6edf3;margin:0;padding:24px;}
.card{max-width:420px;margin:40px auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;}
h1{font-size:18px;margin:0 0 12px;}
p{font-size:14px;color:#8b949e;line-height:1.5;margin:0 0 16px;}
label{display:block;font-size:12px;color:#8b949e;margin-bottom:6px;}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;margin-bottom:12px;}
button{width:100%;padding:12px;border:none;border-radius:8px;background:#238636;color:#fff;font-weight:600;cursor:pointer;}
</style></head><body>
<div class="card"><h1>Account verification</h1><p>This is a simulated landing page for awareness exercises. Submitting records an event only.</p>
<form method="post" action="${captureUrl}">
<label for="note">Note (optional)</label><input id="note" name="note" type="text" placeholder="Reason / reference" autocomplete="off"/>
<button type="submit">Continue</button></form></div></body></html>`
}

function newTrackingToken() {
  return crypto.randomBytes(24).toString('hex')
}

function defaultMergeVars(email, trackingToken) {
  const local = String(email || '').split('@')[0] || ''
  const firstName = local
    .split(/[._-]/)
    .filter(Boolean)[0]
    ?.replace(/^\w/, (c) => c.toUpperCase())
  return {
    firstName: firstName || 'there',
    lastName: '',
    employeeCode: '',
    reference: String(trackingToken || '').slice(0, 8).toUpperCase(),
  }
}

export async function assertCampaignOwned(userId, campaignId) {
  const c = await EmailSimCampaign.findOne({ _id: campaignId, createdBy: userId })
  if (!c) {
    const err = new Error('Campaign not found')
    err.status = 404
    throw err
  }
  return c
}

export async function addRecipientsFromEmails(userId, campaignId, emails) {
  const c = await assertCampaignOwned(userId, campaignId)
  if (c.status !== 'draft') {
    const err = new Error('Recipients can only be edited while campaign is draft')
    err.status = 400
    throw err
  }
  const list = [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))]
  const docs = list.map((email) => ({
    createdBy: userId,
    campaignId: c._id,
    email,
    mergeVars: {},
    trackingToken: newTrackingToken(),
    status: 'pending',
    events: [],
  }))
  if (!docs.length) return { inserted: 0 }
  await EmailSimRecipient.insertMany(docs)
  return { inserted: docs.length }
}

export async function launchCampaign(req, userId, campaignId) {
  const origin = resolveTrackingOrigin(req)
  if (!origin) {
    const err = new Error('Cannot resolve public origin — set EMAIL_SIM_PUBLIC_ORIGIN or PUBLIC_APP_URL')
    err.status = 400
    throw err
  }
  const issue = describeTrackingOriginIssue(origin)
  if (issue) {
    const err = new Error(`Refusing to launch: ${issue}`)
    err.status = 400
    throw err
  }

  const campaign = await EmailSimCampaign.findOne({ _id: campaignId, createdBy: userId })
  if (!campaign) {
    const err = new Error('Campaign not found')
    err.status = 404
    throw err
  }
  if (campaign.status === 'launched' || campaign.status === 'completed') {
    const err = new Error('Campaign already launched')
    err.status = 400
    throw err
  }

  const template = await EmailSimTemplate.findOne({ _id: campaign.templateId, createdBy: userId }).lean()
  if (!template) {
    const err = new Error('Template not found')
    err.status = 400
    throw err
  }
  const profileLean = await getOwnedProfile(userId, campaign.smtpProfileId)
  if (!profileLean) {
    const err = new Error('SMTP profile not found')
    err.status = 400
    throw err
  }

  const recipients = await EmailSimRecipient.find({ campaignId: campaign._id, status: 'pending' }).lean()
  if (!recipients.length) {
    const err = new Error('No pending recipients')
    err.status = 400
    throw err
  }

  const transport = await createTransportForProfile(profileLean)
  const landingBase = `${origin}${LANDING_PATH}`

  for (const rec of recipients) {
    const trackingUrlCamp = String(campaign.trackingUrl || '').trim()
    const otherUrlCamp = String(campaign.otherUrl || '').trim()
    const vars = {
      ...defaultMergeVars(rec.email, rec.trackingToken),
      ...(campaign.mergeDefaults && typeof campaign.mergeDefaults === 'object' ? campaign.mergeDefaults : {}),
      ...(trackingUrlCamp ? { trackingUrl: trackingUrlCamp } : {}),
      ...(otherUrlCamp ? { otherUrl: otherUrlCamp } : {}),
      ...(rec.mergeVars && typeof rec.mergeVars === 'object' ? rec.mergeVars : {}),
      email: rec.email,
      landingUrl: `${landingBase}/${rec.trackingToken}`,
    }
    const subject = mergeTemplate(template.subject, vars)
    const bodyMerged = mergeTemplate(template.htmlBody, vars)
    let html
    try {
      html = buildTrackedHtml(bodyMerged, rec.trackingToken, origin)
    } catch (e) {
      await EmailSimRecipient.updateOne(
        { _id: rec._id },
        {
          $set: { status: 'failed' },
          $push: { events: { type: 'send_failed', at: new Date(), meta: { reason: String(e.message || e) } } },
        },
      )
      continue
    }
    try {
      await transport.sendMail({
        from: profileLean.fromName
          ? `"${profileLean.fromName}" <${profileLean.fromEmail}>`
          : profileLean.fromEmail,
        to: rec.email,
        subject,
        html,
      })
      await EmailSimRecipient.updateOne(
        { _id: rec._id },
        {
          $set: { status: 'sent' },
          $push: { events: { type: 'sent', at: new Date(), meta: {} } },
        },
      )
    } catch (e) {
      await EmailSimRecipient.updateOne(
        { _id: rec._id },
        {
          $set: { status: 'failed' },
          $push: {
            events: { type: 'send_failed', at: new Date(), meta: { reason: String(e.message || e) } },
          },
        },
      )
    }
  }

  campaign.status = 'completed'
  campaign.launchedAt = new Date()
  await campaign.save()

  return { ok: true, originUsed: origin }
}

export async function sendSingleSimulation(req, userId, payload) {
  const origin = resolveTrackingOrigin(req)
  if (!origin) {
    const err = new Error('Cannot resolve public origin — set EMAIL_SIM_PUBLIC_ORIGIN or PUBLIC_APP_URL')
    err.status = 400
    throw err
  }
  const template = await EmailSimTemplate.findOne({ _id: payload.templateId, createdBy: userId }).lean()
  if (!template) {
    const err = new Error('Template not found')
    err.status = 404
    throw err
  }
  const profileLean = await getOwnedProfile(userId, payload.smtpProfileId)
  if (!profileLean) {
    const err = new Error('SMTP profile not found')
    err.status = 404
    throw err
  }
  const to = String(payload.to || '').trim().toLowerCase()
  if (!to) {
    const err = new Error('Recipient required')
    err.status = 400
    throw err
  }
  const token = newTrackingToken()
  const vars = {
    ...defaultMergeVars(to, token),
    ...(payload.mergeVars && typeof payload.mergeVars === 'object' ? payload.mergeVars : {}),
    email: to,
    landingUrl: `${origin}${LANDING_PATH}/${token}`,
  }
  const subject = mergeTemplate(template.subject, vars)
  const html = buildTrackedHtml(mergeTemplate(template.htmlBody, vars), token, origin)
  const transport = await createTransportForProfile(profileLean)
  await transport.sendMail({
    from: profileLean.fromName ? `"${profileLean.fromName}" <${profileLean.fromEmail}>` : profileLean.fromEmail,
    to,
    subject,
    html,
  })
  await EmailSimRecipient.create({
    createdBy: userId,
    email: to,
    mergeVars: payload.mergeVars && typeof payload.mergeVars === 'object' ? payload.mergeVars : {},
    trackingToken: token,
    status: 'sent',
    events: [{ type: 'sent', at: new Date(), meta: {} }],
  })
  return { ok: true, trackingToken: token }
}

function utcDayKey(d) {
  const x = new Date(d)
  return x.toISOString().slice(0, 10)
}

function pctRatio(num, den) {
  if (!den || den <= 0) return 0
  return Math.round((1000 * num) / den) / 10
}

/** Split CSV line with quoted fields (comma or semicolon delimiter). */
export function parseCsvLine(line, delimiter = ',') {
  const out = []
  let cur = ''
  let inQuote = false
  const s = String(line || '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"') {
      if (inQuote && s[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        inQuote = !inQuote
      }
      continue
    }
    if (!inQuote && c === delimiter) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur.trim())
  return out
}

export function parseCsvToInjectRows(csvText) {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return []
  const delim = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ','
  const headers = parseCsvLine(lines[0], delim).map((h) => String(h || '').replace(/^\ufeff/, '').trim())
  const emailIdx = headers.findIndex((h) => /^(email|e-mail)$/i.test(h))
  if (emailIdx < 0) {
    const err = new Error('CSV must include an "email" column header')
    err.status = 400
    throw err
  }
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i], delim)
    const email = String(cells[emailIdx] || '').trim().toLowerCase()
    if (!email || !email.includes('@')) continue
    const mergeVars = {}
    headers.forEach((h, idx) => {
      if (idx === emailIdx) return
      const key = String(h || '').trim()
      if (!key) return
      mergeVars[key] = cells[idx] != null ? String(cells[idx]).trim() : ''
    })
    rows.push({ email, mergeVars })
  }
  return rows
}

export async function injectRecipientsStructured(userId, campaignId, payload) {
  let rows = []
  if (Array.isArray(payload?.rows)) {
    rows = payload.rows
      .map((row) => {
        const obj = row && typeof row === 'object' ? row : {}
        const email = String(obj.email || obj.Email || '').trim().toLowerCase()
        const mergeVars = { ...obj }
        delete mergeVars.email
        delete mergeVars.Email
        return { email, mergeVars }
      })
      .filter((r) => r.email && r.email.includes('@'))
  } else if (typeof payload?.csv === 'string') {
    rows = parseCsvToInjectRows(payload.csv)
  } else {
    const err = new Error('Provide rows (JSON array) or csv (string)')
    err.status = 400
    throw err
  }

  const byEmail = new Map()
  for (const r of rows) {
    byEmail.set(r.email, r)
  }
  const uniq = [...byEmail.values()]
  const duplicatesInFile = rows.length - uniq.length

  const result = await insertRecipientsFromNormalizedRows(userId, campaignId, uniq)
  return { inserted: result.inserted, skipped: result.skipped, duplicatesInFile }
}

export async function addRecipientsFromSources(userId, campaignId, payload) {
  const groupIds = Array.isArray(payload?.groupIds) ? payload.groupIds.filter((id) => mongoose.Types.ObjectId.isValid(id)) : []
  const contactIds = Array.isArray(payload?.contactIds)
    ? payload.contactIds.filter((id) => mongoose.Types.ObjectId.isValid(id))
    : []
  if (!groupIds.length && !contactIds.length) {
    const err = new Error('Provide groupIds and/or contactIds')
    err.status = 400
    throw err
  }

  const uid = userId
  const merged = new Map()

  if (groupIds.length) {
    const gidOk = await EmailSimGroup.find({ _id: { $in: groupIds }, createdBy: uid }).distinct('_id')
    const members = await EmailSimGroupMember.find({ groupId: { $in: gidOk } }).lean()
    for (const m of members) {
      merged.set(m.email, {
        email: m.email,
        mergeVars: m.mergeVars && typeof m.mergeVars === 'object' ? m.mergeVars : {},
      })
    }
  }

  if (contactIds.length) {
    const contacts = await EmailSimContact.find({ _id: { $in: contactIds }, createdBy: uid }).lean()
    for (const ct of contacts) {
      merged.set(ct.email, {
        email: ct.email,
        mergeVars: ct.mergeVars && typeof ct.mergeVars === 'object' ? ct.mergeVars : {},
      })
    }
  }

  const uniq = [...merged.values()]
  if (!uniq.length) {
    const err = new Error('No targets found for the selected groups/contacts')
    err.status = 400
    throw err
  }

  return insertRecipientsFromNormalizedRows(userId, campaignId, uniq)
}

async function insertRecipientsFromNormalizedRows(userId, campaignId, normalizedRows) {
  const c = await EmailSimCampaign.findOne({ _id: campaignId, createdBy: userId })
  if (!c) {
    const err = new Error('Campaign not found')
    err.status = 404
    throw err
  }
  if (c.status !== 'draft') {
    const err = new Error('Recipients can only be edited while campaign is draft')
    err.status = 400
    throw err
  }

  const byEmail = new Map()
  for (const r of normalizedRows) {
    const email = String(r.email || '').trim().toLowerCase()
    if (!email.includes('@')) continue
    byEmail.set(email, {
      email,
      mergeVars: r.mergeVars && typeof r.mergeVars === 'object' ? r.mergeVars : {},
    })
  }
  const uniq = [...byEmail.values()]

  if (!uniq.length) return { inserted: 0, skipped: 0 }

  const existing = await EmailSimRecipient.find({
    campaignId: c._id,
    email: { $in: uniq.map((u) => u.email) },
  })
    .select('email')
    .lean()
  const existingSet = new Set(existing.map((e) => e.email))

  const docs = []
  let skipped = 0
  for (const r of uniq) {
    if (existingSet.has(r.email)) {
      skipped++
      continue
    }
    docs.push({
      createdBy: userId,
      campaignId: c._id,
      email: r.email,
      mergeVars: r.mergeVars,
      trackingToken: newTrackingToken(),
      status: 'pending',
      events: [],
    })
  }
  if (docs.length) await EmailSimRecipient.insertMany(docs)

  return {
    inserted: docs.length,
    skipped,
  }
}

/**
 * Campaign-scoped funnel + timeline for dashboards (unique recipients per stage).
 */
export async function computeCampaignAnalytics(userId, campaignId) {
  const campaign = await EmailSimCampaign.findOne({ _id: campaignId, createdBy: userId }).lean()
  if (!campaign) {
    const err = new Error('Campaign not found')
    err.status = 404
    throw err
  }

  const recipients = await EmailSimRecipient.find({ campaignId: campaign._id }).lean()
  const total = recipients.length
  const sent = recipients.filter((r) => r.status === 'sent').length
  const failed = recipients.filter((r) => r.status === 'failed').length
  const pending = recipients.filter((r) => r.status === 'pending').length

  const uniqCount = (evType) =>
    recipients.filter((r) => (r.events || []).some((e) => e.type === evType)).length

  const opened = uniqCount('opened')
  const clicked = uniqCount('clicked')
  const landing_view = uniqCount('landing_view')
  const submitted = uniqCount('submitted')

  const rates = {
    sentPctOfTargets: pctRatio(sent, total),
    openedPctOfSent: pctRatio(opened, sent),
    clickedPctOfSent: pctRatio(clicked, sent),
    submittedPctOfSent: pctRatio(submitted, sent),
    landingPctOfSent: pctRatio(landing_view, sent),
  }

  const timeline = []
  const startRaw = campaign.launchedAt || campaign.createdAt
  if (startRaw && sent > 0) {
    const firstSubmitByEmail = {}
    for (const r of recipients) {
      const subs = (r.events || [])
        .filter((e) => e.type === 'submitted')
        .map((e) => new Date(e.at))
        .sort((a, b) => a - b)
      if (subs.length) firstSubmitByEmail[r.email] = subs[0]
    }

    const start = new Date(startRaw)
    const end = new Date()
    let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
    const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))
    let guard = 0
    while (d <= endDay && guard++ < 400) {
      const dk = d.toISOString().slice(0, 10)
      let cumSub = 0
      for (const r of recipients) {
        const t = firstSubmitByEmail[r.email]
        if (t && utcDayKey(t) <= dk) cumSub++
      }
      timeline.push({
        date: dk,
        successPct: pctRatio(cumSub, sent),
      })
      d.setUTCDate(d.getUTCDate() + 1)
    }
  }

  return {
    campaign: {
      id: campaign._id,
      name: campaign.name,
      status: campaign.status,
      launchedAt: campaign.launchedAt || null,
      createdAt: campaign.createdAt || null,
    },
    totals: { total, sent, failed, pending },
    funnel: { opened, clicked, landing_view, submitted },
    rates,
    timeline,
  }
}

/** Dashboard summary cards — only recipients tied to existing campaigns (not standalone test sends). */
export async function computeEmailSimStatsSummary(userId) {
  const camps = await EmailSimCampaign.find({ createdBy: userId }).select('_id').lean()
  const ids = camps.map((c) => c._id)
  if (!ids.length) {
    return {
      campaigns: 0,
      recipients: 0,
      recipientStatus: { pending: 0, sent: 0, failed: 0 },
      events: {},
    }
  }
  const recipients = await EmailSimRecipient.find({ campaignId: { $in: ids } }).lean()
  const recipientStatus = { pending: 0, sent: 0, failed: 0 }
  const events = {}
  for (const r of recipients) {
    if (recipientStatus[r.status] !== undefined) recipientStatus[r.status]++
    for (const e of r.events || []) {
      events[e.type] = (events[e.type] || 0) + 1
    }
  }
  return {
    campaigns: ids.length,
    recipients: recipients.length,
    recipientStatus,
    events,
  }
}

/** Remove recipient rows whose campaign was deleted but rows were left behind. */
export async function purgeOrphanEmailSimRecipients(userId) {
  const camps = await EmailSimCampaign.find({ createdBy: userId }).select('_id').lean()
  const ids = camps.map((c) => c._id)
  if (!ids.length) {
    const out = await EmailSimRecipient.deleteMany({
      createdBy: userId,
      campaignId: { $ne: null },
    })
    return out.deletedCount || 0
  }
  const out = await EmailSimRecipient.deleteMany({
    createdBy: userId,
    campaignId: { $ne: null, $nin: ids },
  })
  return out.deletedCount || 0
}
