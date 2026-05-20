/**
 * Authenticated Email Simulation API — SMTP profiles, templates, campaigns, sends.
 */

import { Router } from 'express'
import mongoose from 'mongoose'
import { authenticate } from '../middleware/auth.js'
import { requireAppPage, requirePageWrite } from '../middleware/requireAppPage.js'
import SmtpProfile from '../models/SmtpProfile.js'
import EmailSimTemplate from '../models/EmailSimTemplate.js'
import EmailSimCampaign from '../models/EmailSimCampaign.js'
import EmailSimContact from '../models/EmailSimContact.js'
import EmailSimGroup from '../models/EmailSimGroup.js'
import EmailSimGroupMember from '../models/EmailSimGroupMember.js'
import EmailSimRecipient from '../models/EmailSimRecipient.js'
import { EMAIL_SIM_INDUSTRY_TEMPLATES } from '../constants/emailSimIndustryTemplates.js'
import { EMAIL_SIM_WORKPLACE_TEMPLATES } from '../constants/emailSimWorkplaceTemplates.js'
import { encryptSmtpPassword } from '../services/smtpProfileService.js'
import {
  addRecipientsFromEmails,
  addRecipientsFromSources,
  computeCampaignAnalytics,
  computeEmailSimStatsSummary,
  purgeOrphanEmailSimRecipients,
  injectRecipientsStructured,
  launchCampaign,
  parseCsvToInjectRows,
  sendSingleSimulation,
} from '../services/emailSimCampaignService.js'
import { describeTrackingOriginIssue, resolveTrackingOrigin } from '../services/emailSimTrackingService.js'

const router = Router()
router.use(authenticate)
router.use(requireAppPage('emailSim'))

const write = requirePageWrite('emailSim')

function parseEmailList(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean)
  if (typeof raw === 'string') return raw.split(/[\s,;]+/g).map((s) => s.trim()).filter(Boolean)
  return []
}

/** Safe substring match for Mongo regex filters */
function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function seedTemplatesForUser(userId, rows) {
  const normalizedRows = rows
    .map((row) => ({
      name: String(row.name || '').trim(),
      subject: String(row.subject || '').trim(),
      htmlBody: String(row.htmlBody || ''),
      category: row.category != null ? String(row.category).trim() : 'custom',
    }))
    .filter((row) => row.name && row.subject && row.htmlBody)
  if (!normalizedRows.length) return { inserted: 0, updated: 0, removedDuplicates: 0 }

  const result = await EmailSimTemplate.bulkWrite(
    normalizedRows.map((row) => ({
      updateOne: {
        filter: { createdBy: userId, name: row.name },
        update: { $set: row, $setOnInsert: { createdBy: userId } },
        upsert: true,
      },
    })),
    { ordered: false },
  )

  // If older imports created duplicates, keep the newest document per template name.
  const names = normalizedRows.map((row) => row.name)
  const existing = await EmailSimTemplate.find({ createdBy: userId, name: { $in: names } })
    .select('_id name updatedAt')
    .sort({ name: 1, updatedAt: -1 })
    .lean()
  const seen = new Set()
  const duplicateIds = []
  for (const row of existing) {
    const key = String(row.name || '').trim().toLowerCase()
    if (seen.has(key)) duplicateIds.push(row._id)
    else seen.add(key)
  }
  if (duplicateIds.length) {
    await EmailSimTemplate.deleteMany({ _id: { $in: duplicateIds }, createdBy: userId })
  }

  return {
    inserted: result.upsertedCount || 0,
    updated: result.modifiedCount || 0,
    removedDuplicates: duplicateIds.length,
  }
}

router.get('/meta', (req, res) => {
  const origin = resolveTrackingOrigin(req) || null
  const warning = describeTrackingOriginIssue(origin)
  res.json({
    trackingOrigin: origin,
    trackingOriginWarning: warning,
    hint: warning
      ? warning + ' Until this is fixed, recipients (especially Gmail/Outlook) will not record opens or clicks.'
      : 'Set EMAIL_SIM_PUBLIC_ORIGIN (or PUBLIC_APP_URL) so tracking URLs in outbound mail match where this API is reachable.',
  })
})

router.get('/stats/summary', async (req, res, next) => {
  try {
    res.json(await computeEmailSimStatsSummary(req.user._id))
  } catch (e) {
    next(e)
  }
})

// ─── SMTP profiles ────────────────────────────────────────────────────────────

router.get('/smtp-profiles', async (req, res, next) => {
  try {
    const rows = await SmtpProfile.find({ createdBy: req.user._id }).sort({ updatedAt: -1 }).lean()
    res.json({
      profiles: rows.map((p) => ({
        ...p,
        authPassEncrypted: p.authPassEncrypted ? '********' : '',
      })),
    })
  } catch (e) {
    next(e)
  }
})

router.post('/smtp-profiles', write, async (req, res, next) => {
  try {
    const { name, host, port, secure, username, password, fromEmail, fromName } = req.body || {}
    if (!name || !host || !fromEmail) return res.status(400).json({ error: 'name, host, fromEmail required' })
    const doc = await SmtpProfile.create({
      createdBy: req.user._id,
      name: String(name).trim(),
      host: String(host).trim(),
      port: Number(port) || 587,
      secure: Boolean(secure),
      username: username != null ? String(username) : '',
      authPassEncrypted: password ? encryptSmtpPassword(String(password)) : '',
      fromEmail: String(fromEmail).trim().toLowerCase(),
      fromName: fromName != null ? String(fromName).trim() : '',
    })
    res.status(201).json({ profile: { ...doc.toObject(), authPassEncrypted: doc.authPassEncrypted ? '********' : '' } })
  } catch (e) {
    next(e)
  }
})

router.patch('/smtp-profiles/:id', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const p = await SmtpProfile.findOne({ _id: req.params.id, createdBy: req.user._id })
    if (!p) return res.status(404).json({ error: 'Not found' })
    const { name, host, port, secure, username, password, fromEmail, fromName } = req.body || {}
    if (name !== undefined) p.name = String(name).trim()
    if (host !== undefined) p.host = String(host).trim()
    if (port !== undefined) p.port = Number(port) || 587
    if (secure !== undefined) p.secure = Boolean(secure)
    if (username !== undefined) p.username = String(username)
    if (password !== undefined && String(password).length) p.authPassEncrypted = encryptSmtpPassword(String(password))
    if (fromEmail !== undefined) p.fromEmail = String(fromEmail).trim().toLowerCase()
    if (fromName !== undefined) p.fromName = String(fromName).trim()
    await p.save()
    res.json({ profile: { ...p.toObject(), authPassEncrypted: p.authPassEncrypted ? '********' : '' } })
  } catch (e) {
    next(e)
  }
})

router.delete('/smtp-profiles/:id', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    await SmtpProfile.deleteOne({ _id: req.params.id, createdBy: req.user._id })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

// ─── Templates ───────────────────────────────────────────────────────────────

router.get('/templates', async (req, res, next) => {
  try {
    const templates = await EmailSimTemplate.find({ createdBy: req.user._id }).sort({ updatedAt: -1 }).lean()
    res.json({ templates })
  } catch (e) {
    next(e)
  }
})

router.post('/templates', write, async (req, res, next) => {
  try {
    const { name, subject, htmlBody, category } = req.body || {}
    if (!name || !subject || !htmlBody) return res.status(400).json({ error: 'name, subject, htmlBody required' })
    const t = await EmailSimTemplate.create({
      createdBy: req.user._id,
      name: String(name).trim(),
      subject: String(subject).trim(),
      htmlBody: String(htmlBody),
      category: category != null ? String(category).trim() : 'custom',
    })
    res.status(201).json({ template: t })
  } catch (e) {
    next(e)
  }
})

router.patch('/templates/:id', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const t = await EmailSimTemplate.findOne({ _id: req.params.id, createdBy: req.user._id })
    if (!t) return res.status(404).json({ error: 'Not found' })
    const { name, subject, htmlBody, category } = req.body || {}
    if (name !== undefined) t.name = String(name).trim()
    if (subject !== undefined) t.subject = String(subject).trim()
    if (htmlBody !== undefined) t.htmlBody = String(htmlBody)
    if (category !== undefined) t.category = String(category).trim()
    await t.save()
    res.json({ template: t })
  } catch (e) {
    next(e)
  }
})

router.delete('/templates/:id', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    await EmailSimTemplate.deleteOne({ _id: req.params.id, createdBy: req.user._id })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.post('/templates/seed/industry', write, async (req, res, next) => {
  try {
    const out = await seedTemplatesForUser(req.user._id, EMAIL_SIM_INDUSTRY_TEMPLATES)
    res.status(out.inserted ? 201 : 200).json(out)
  } catch (e) {
    next(e)
  }
})

router.post('/templates/seed/workplace', write, async (req, res, next) => {
  try {
    const out = await seedTemplatesForUser(req.user._id, EMAIL_SIM_WORKPLACE_TEMPLATES)
    res.status(out.inserted ? 201 : 200).json(out)
  } catch (e) {
    next(e)
  }
})

// ─── Campaigns ───────────────────────────────────────────────────────────────

router.get('/campaigns', async (req, res, next) => {
  try {
    const campaigns = await EmailSimCampaign.find({ createdBy: req.user._id }).sort({ updatedAt: -1 }).lean()
    res.json({ campaigns })
  } catch (e) {
    next(e)
  }
})

router.post('/campaigns', write, async (req, res, next) => {
  try {
    const { name, templateId, smtpProfileId, mergeDefaults, landingHtml, trackingUrl, otherUrl } = req.body || {}
    if (!name || !templateId || !smtpProfileId)
      return res.status(400).json({ error: 'name, templateId, smtpProfileId required' })
    if (!mongoose.Types.ObjectId.isValid(templateId) || !mongoose.Types.ObjectId.isValid(smtpProfileId)) {
      return res.status(400).json({ error: 'Invalid ids' })
    }
    const uid = req.user._id
    const hasT = await EmailSimTemplate.exists({ _id: templateId, createdBy: uid })
    const hasP = await SmtpProfile.exists({ _id: smtpProfileId, createdBy: uid })
    if (!hasT || !hasP) return res.status(400).json({ error: 'Template or SMTP profile not found' })
    const c = await EmailSimCampaign.create({
      createdBy: uid,
      name: String(name).trim(),
      templateId,
      smtpProfileId,
      mergeDefaults: mergeDefaults && typeof mergeDefaults === 'object' ? mergeDefaults : {},
      landingHtml: landingHtml != null ? String(landingHtml) : '',
      trackingUrl: trackingUrl != null ? String(trackingUrl).trim() : '',
      otherUrl: otherUrl != null ? String(otherUrl).trim() : '',
      status: 'draft',
    })
    res.status(201).json({ campaign: c })
  } catch (e) {
    next(e)
  }
})

router.get('/campaigns/:id/analytics', async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const data = await computeCampaignAnalytics(req.user._id, req.params.id)
    res.json(data)
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message })
    next(e)
  }
})

router.get('/campaigns/:id', async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const c = await EmailSimCampaign.findOne({ _id: req.params.id, createdBy: req.user._id }).lean()
    if (!c) return res.status(404).json({ error: 'Not found' })
    const recipients = await EmailSimRecipient.find({ campaignId: c._id }).sort({ createdAt: -1 }).lean()
    res.json({ campaign: c, recipients })
  } catch (e) {
    next(e)
  }
})

router.patch('/campaigns/:id', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const c = await EmailSimCampaign.findOne({ _id: req.params.id, createdBy: req.user._id })
    if (!c) return res.status(404).json({ error: 'Not found' })
    if (c.status !== 'draft') return res.status(400).json({ error: 'Only draft campaigns can be edited' })
    const { name, templateId, smtpProfileId, mergeDefaults, landingHtml, trackingUrl, otherUrl } = req.body || {}
    const uid = req.user._id
    if (name !== undefined) c.name = String(name).trim()
    if (landingHtml !== undefined) c.landingHtml = String(landingHtml)
    if (trackingUrl !== undefined) c.trackingUrl = String(trackingUrl || '').trim()
    if (otherUrl !== undefined) c.otherUrl = String(otherUrl || '').trim()
    if (mergeDefaults !== undefined)
      c.mergeDefaults = mergeDefaults && typeof mergeDefaults === 'object' ? mergeDefaults : {}
    if (templateId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(templateId)) return res.status(400).json({ error: 'Invalid templateId' })
      const hasT = await EmailSimTemplate.exists({ _id: templateId, createdBy: uid })
      if (!hasT) return res.status(400).json({ error: 'Template not found' })
      c.templateId = templateId
    }
    if (smtpProfileId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(smtpProfileId)) return res.status(400).json({ error: 'Invalid smtpProfileId' })
      const hasP = await SmtpProfile.exists({ _id: smtpProfileId, createdBy: uid })
      if (!hasP) return res.status(400).json({ error: 'SMTP profile not found' })
      c.smtpProfileId = smtpProfileId
    }
    await c.save()
    res.json({ campaign: c })
  } catch (e) {
    next(e)
  }
})

router.delete('/campaigns/:id', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const c = await EmailSimCampaign.findOne({ _id: req.params.id, createdBy: req.user._id })
    if (!c) return res.status(404).json({ error: 'Not found' })
    const uid = req.user._id
    await EmailSimRecipient.deleteMany({ campaignId: c._id })
    await c.deleteOne()
    await purgeOrphanEmailSimRecipients(uid)
    const [summary, campaigns] = await Promise.all([
      computeEmailSimStatsSummary(uid),
      EmailSimCampaign.find({ createdBy: uid }).sort({ updatedAt: -1 }).lean(),
    ])
    res.json({ ok: true, summary, campaigns })
  } catch (e) {
    next(e)
  }
})

router.post('/campaigns/:id/recipients', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const emails = parseEmailList(req.body?.emails ?? req.body?.addresses ?? '')
    const out = await addRecipientsFromEmails(req.user._id, req.params.id, emails)
    res.json(out)
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message })
    next(e)
  }
})

router.post('/campaigns/:id/recipients/inject', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const out = await injectRecipientsStructured(req.user._id, req.params.id, req.body || {})
    res.json(out)
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message })
    next(e)
  }
})

router.post('/campaigns/:id/recipients/from-sources', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const out = await addRecipientsFromSources(req.user._id, req.params.id, req.body || {})
    res.json(out)
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message })
    next(e)
  }
})

router.post('/campaigns/:id/launch', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const out = await launchCampaign(req, req.user._id, req.params.id)
    res.json(out)
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message })
    next(e)
  }
})

// ─── Saved contacts & groups (campaign audience library) ─────────────────────

router.get('/contacts', async (req, res, next) => {
  try {
    const uid = req.user._id
    const q = String(req.query.q || '').trim()
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const paginate = req.query.limit !== undefined && req.query.limit !== ''
    const limit = paginate ? Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200) : null

    const filter = { createdBy: uid }
    if (q) filter.email = { $regex: escapeRegex(q), $options: 'i' }

    const total = await EmailSimContact.countDocuments(filter)

    let mq = EmailSimContact.find(filter).sort({ updatedAt: -1 })
    if (limit != null) mq = mq.skip((page - 1) * limit).limit(limit)
    const contacts = await mq.lean()

    // Decorate each contact with the groups it belongs to so the UI can render
    // chips (g-suite style) without N extra round-trips. Cheap aggregate, only
    // pulls the email→group edges that match this user's groups.
    const emails = contacts.map((c) => c.email).filter(Boolean)
    const userGroups = await EmailSimGroup.find({ createdBy: uid }).select('_id name').lean()
    const groupIds = userGroups.map((g) => g._id)
    const nameByGroupId = new Map(userGroups.map((g) => [String(g._id), g.name]))

    const membershipByEmail = new Map(emails.map((e) => [e, []]))
    if (emails.length && groupIds.length) {
      const rows = await EmailSimGroupMember.find({
        groupId: { $in: groupIds },
        email: { $in: emails },
      })
        .select('email groupId')
        .lean()
      for (const r of rows) {
        const list = membershipByEmail.get(r.email)
        if (!list) continue
        list.push({ _id: r.groupId, name: nameByGroupId.get(String(r.groupId)) || '' })
      }
    }

    const contactsOut = contacts.map((c) => ({
      ...c,
      groups: membershipByEmail.get(c.email) || [],
    }))

    res.json({
      contacts: contactsOut,
      total,
      ...(limit != null ? { page, limit } : {}),
    })
  } catch (e) {
    next(e)
  }
})

router.post('/contacts', write, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase()
    if (!email.includes('@')) return res.status(400).json({ error: 'Valid email required' })
    const mergeVars =
      req.body?.mergeVars && typeof req.body.mergeVars === 'object' ? req.body.mergeVars : {}
    const doc = await EmailSimContact.findOneAndUpdate(
      { createdBy: req.user._id, email },
      { $set: { mergeVars } },
      { upsert: true, new: true },
    ).lean()
    res.status(201).json({ contact: doc })
  } catch (e) {
    next(e)
  }
})

router.post('/contacts/import', write, async (req, res, next) => {
  try {
    let rows = []
    if (Array.isArray(req.body?.rows)) {
      rows = req.body.rows
        .map((row) => {
          const obj = row && typeof row === 'object' ? row : {}
          const em = String(obj.email || obj.Email || '').trim().toLowerCase()
          const mergeVars = { ...obj }
          delete mergeVars.email
          delete mergeVars.Email
          return { email: em, mergeVars }
        })
        .filter((r) => r.email.includes('@'))
    } else if (typeof req.body?.csv === 'string') {
      rows = parseCsvToInjectRows(req.body.csv)
    } else {
      return res.status(400).json({ error: 'Provide csv or rows' })
    }
    let upserted = 0
    for (const r of rows) {
      await EmailSimContact.findOneAndUpdate(
        { createdBy: req.user._id, email: r.email },
        { $set: { mergeVars: r.mergeVars && typeof r.mergeVars === 'object' ? r.mergeVars : {} } },
        { upsert: true },
      )
      upserted++
    }

    // Optional: also add every imported row to a target group (GoPhish-style
    // "create users and add to a group in one CSV").
    let groupAdded = 0
    let groupName = null
    const groupIdParam = String(req.body?.groupId || '').trim()
    if (groupIdParam) {
      if (!mongoose.Types.ObjectId.isValid(groupIdParam)) {
        return res.status(400).json({ error: 'Invalid groupId' })
      }
      const g = await EmailSimGroup.findOne({ _id: groupIdParam, createdBy: req.user._id })
      if (!g) return res.status(400).json({ error: 'Group not found' })
      groupName = g.name
      for (const r of rows) {
        await EmailSimGroupMember.findOneAndUpdate(
          { groupId: g._id, email: r.email },
          { $set: { mergeVars: r.mergeVars && typeof r.mergeVars === 'object' ? r.mergeVars : {} } },
          { upsert: true },
        )
        groupAdded++
      }
    }

    res.json({ upserted, groupAdded, groupName })
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message })
    next(e)
  }
})

router.patch('/contacts/:id', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const doc = await EmailSimContact.findOne({ _id: req.params.id, createdBy: req.user._id })
    if (!doc) return res.status(404).json({ error: 'Not found' })
    const { email, mergeVars } = req.body || {}
    if (email !== undefined) doc.email = String(email).trim().toLowerCase()
    if (mergeVars !== undefined)
      doc.mergeVars = mergeVars && typeof mergeVars === 'object' ? mergeVars : {}
    await doc.save()
    res.json({ contact: doc })
  } catch (e) {
    next(e)
  }
})

router.delete('/contacts/:id', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    await EmailSimContact.deleteOne({ _id: req.params.id, createdBy: req.user._id })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.get('/groups', async (req, res, next) => {
  try {
    const uid = req.user._id
    const q = String(req.query.q || '').trim()
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const paginate = req.query.limit !== undefined && req.query.limit !== ''
    const limit = paginate ? Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200) : null

    const filter = { createdBy: uid }
    if (q) filter.name = { $regex: escapeRegex(q), $options: 'i' }

    const total = await EmailSimGroup.countDocuments(filter)

    let mq = EmailSimGroup.find(filter).sort({ updatedAt: -1 })
    if (limit != null) mq = mq.skip((page - 1) * limit).limit(limit)
    const groups = await mq.lean()

    const ids = groups.map((g) => g._id)
    let groupsOut = []
    if (!ids.length) {
      groupsOut = []
    } else {
      const counts = await EmailSimGroupMember.aggregate([
        { $match: { groupId: { $in: ids } } },
        { $group: { _id: '$groupId', n: { $sum: 1 } } },
      ])
      const nBy = Object.fromEntries(counts.map((c) => [String(c._id), c.n]))
      groupsOut = groups.map((g) => ({ ...g, memberCount: nBy[String(g._id)] || 0 }))
    }

    res.json({
      groups: groupsOut,
      total,
      ...(limit != null ? { page, limit } : {}),
    })
  } catch (e) {
    next(e)
  }
})

router.post('/groups', write, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const g = await EmailSimGroup.create({
      createdBy: req.user._id,
      name,
      description: req.body?.description != null ? String(req.body.description) : '',
    })
    res.status(201).json({ group: { ...g.toObject(), memberCount: 0 } })
  } catch (e) {
    next(e)
  }
})

router.patch('/groups/:id', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const g = await EmailSimGroup.findOne({ _id: req.params.id, createdBy: req.user._id })
    if (!g) return res.status(404).json({ error: 'Not found' })
    if (req.body?.name !== undefined) g.name = String(req.body.name).trim()
    if (req.body?.description !== undefined) g.description = String(req.body.description)
    await g.save()
    res.json({ group: g })
  } catch (e) {
    next(e)
  }
})

router.delete('/groups/:id', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const g = await EmailSimGroup.findOne({ _id: req.params.id, createdBy: req.user._id })
    if (!g) return res.status(404).json({ error: 'Not found' })
    await EmailSimGroupMember.deleteMany({ groupId: g._id })
    await g.deleteOne()
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.get('/groups/:id/members', async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const g = await EmailSimGroup.findOne({ _id: req.params.id, createdBy: req.user._id }).lean()
    if (!g) return res.status(404).json({ error: 'Group not found' })
    const members = await EmailSimGroupMember.find({ groupId: g._id }).sort({ email: 1 }).lean()
    res.json({ group: g, members })
  } catch (e) {
    next(e)
  }
})

/**
 * Mirror group members into the global saved contacts library so the two views
 * stay in sync — adding to a group also makes it pick-able in the "Saved
 * contacts" picker without manual duplication.
 *
 * Existing contacts are NOT clobbered: we only insert when missing, and we
 * fill in merge vars on the contact only when the contact's mergeVars are
 * empty, so direct edits in the contacts library are preserved.
 */
async function mirrorContactsFromGroupRows(userId, rows) {
  let mirrored = 0
  for (const r of rows || []) {
    const email = String(r?.email || '').trim().toLowerCase()
    if (!email.includes('@')) continue
    const incoming = r?.mergeVars && typeof r.mergeVars === 'object' ? r.mergeVars : {}
    const existing = await EmailSimContact.findOne({ createdBy: userId, email }).lean()
    if (existing) {
      const hasExistingVars = existing.mergeVars && Object.keys(existing.mergeVars).length > 0
      if (!hasExistingVars && Object.keys(incoming).length) {
        await EmailSimContact.updateOne(
          { _id: existing._id },
          { $set: { mergeVars: incoming } },
        )
      }
      mirrored++
      continue
    }
    await EmailSimContact.create({ createdBy: userId, email, mergeVars: incoming })
    mirrored++
  }
  return mirrored
}

router.post('/groups/:id/members', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const g = await EmailSimGroup.findOne({ _id: req.params.id, createdBy: req.user._id })
    if (!g) return res.status(404).json({ error: 'Group not found' })

    if (Array.isArray(req.body?.rows)) {
      const collected = []
      for (const row of req.body.rows) {
        const obj = row && typeof row === 'object' ? row : {}
        const email = String(obj.email || obj.Email || '').trim().toLowerCase()
        if (!email.includes('@')) continue
        const mergeVars = { ...obj }
        delete mergeVars.email
        delete mergeVars.Email
        await EmailSimGroupMember.findOneAndUpdate(
          { groupId: g._id, email },
          { $set: { mergeVars } },
          { upsert: true },
        )
        collected.push({ email, mergeVars })
      }
      const contactsMirrored = await mirrorContactsFromGroupRows(req.user._id, collected)
      return res.json({ upserted: collected.length, contactsMirrored })
    }

    const email = String(req.body?.email || '').trim().toLowerCase()
    if (!email.includes('@')) return res.status(400).json({ error: 'email required' })
    const mergeVars =
      req.body?.mergeVars && typeof req.body.mergeVars === 'object' ? req.body.mergeVars : {}
    await EmailSimGroupMember.findOneAndUpdate(
      { groupId: g._id, email },
      { $set: { mergeVars } },
      { upsert: true },
    )
    const contactsMirrored = await mirrorContactsFromGroupRows(req.user._id, [{ email, mergeVars }])
    res.status(201).json({ ok: true, contactsMirrored })
  } catch (e) {
    next(e)
  }
})

router.post('/groups/:id/members/import', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const g = await EmailSimGroup.findOne({ _id: req.params.id, createdBy: req.user._id })
    if (!g) return res.status(404).json({ error: 'Group not found' })
    let rows = []
    if (Array.isArray(req.body?.rows)) {
      rows = req.body.rows
        .map((row) => {
          const obj = row && typeof row === 'object' ? row : {}
          const em = String(obj.email || obj.Email || '').trim().toLowerCase()
          const mergeVars = { ...obj }
          delete mergeVars.email
          delete mergeVars.Email
          return { email: em, mergeVars }
        })
        .filter((r) => r.email.includes('@'))
    } else if (typeof req.body?.csv === 'string') {
      rows = parseCsvToInjectRows(req.body.csv)
    } else {
      return res.status(400).json({ error: 'Provide csv or rows' })
    }
    let upserted = 0
    for (const r of rows) {
      await EmailSimGroupMember.findOneAndUpdate(
        { groupId: g._id, email: r.email },
        { $set: { mergeVars: r.mergeVars && typeof r.mergeVars === 'object' ? r.mergeVars : {} } },
        { upsert: true },
      )
      upserted++
    }
    const contactsMirrored = await mirrorContactsFromGroupRows(req.user._id, rows)
    res.json({ upserted, contactsMirrored })
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message })
    next(e)
  }
})

router.delete('/groups/:id/members/:memberId', write, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id) || !mongoose.Types.ObjectId.isValid(req.params.memberId)) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const g = await EmailSimGroup.findOne({ _id: req.params.id, createdBy: req.user._id })
    if (!g) return res.status(404).json({ error: 'Group not found' })
    await EmailSimGroupMember.deleteOne({ _id: req.params.memberId, groupId: g._id })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

router.post('/send-one', write, async (req, res, next) => {
  try {
    const { templateId, smtpProfileId, to, mergeVars } = req.body || {}
    if (!templateId || !smtpProfileId || !to) return res.status(400).json({ error: 'templateId, smtpProfileId, to required' })
    const out = await sendSingleSimulation(req, req.user._id, { templateId, smtpProfileId, to, mergeVars })
    res.json(out)
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message })
    next(e)
  }
})

export default router
