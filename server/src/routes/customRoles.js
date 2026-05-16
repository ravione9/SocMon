import { Router } from 'express'
import mongoose from 'mongoose'
import CustomRole from '../models/CustomRole.js'
import User from '../models/User.js'
import { authenticate } from '../middleware/auth.js'
import { APP_PAGE_KEY_SET } from '../constants/appPages.js'
import { userHasAdminConsoleFull } from '../utils/computeUserPageAccess.js'

const router = Router()

router.use(authenticate)

router.use(async (req, res, next) => {
  try {
    if (!(await userHasAdminConsoleFull(req.user))) {
      return res.status(403).json({ error: 'Full access to the Admin console is required' })
    }
    next()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

function sanitizePages(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const row of raw) {
    const pageKey = typeof row?.pageKey === 'string' ? row.pageKey.trim() : ''
    const access = row?.access === 'read' || row?.access === 'full' ? row.access : null
    if (!pageKey || !APP_PAGE_KEY_SET.has(pageKey) || !access || seen.has(pageKey)) continue
    seen.add(pageKey)
    out.push({ pageKey, access })
  }
  return out
}

router.get('/', async (_req, res) => {
  try {
    const roles = await CustomRole.find().sort({ name: 1 }).lean()
    res.json(roles)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/', async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
    if (!name) return res.status(400).json({ error: 'Name is required' })
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : ''
    const pages = sanitizePages(req.body.pages)
    const doc = await CustomRole.create({ name, description, pages })
    res.status(201).json(doc)
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'A role with this name already exists' })
    res.status(500).json({ error: err.message })
  }
})

router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const patch = {}
    if (typeof req.body.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim()
    if (typeof req.body.description === 'string') patch.description = req.body.description.trim()
    if (req.body.pages !== undefined) patch.pages = sanitizePages(req.body.pages)
    const doc = await CustomRole.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true })
    if (!doc) return res.status(404).json({ error: 'Custom role not found' })
    res.json(doc)
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'A role with this name already exists' })
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
    const inUse = await User.countDocuments({ role: 'role_template', customRoleId: req.params.id })
    if (inUse > 0) {
      return res.status(400).json({ error: `This role is assigned to ${inUse} user(s). Reassign them first.` })
    }
    const doc = await CustomRole.findByIdAndDelete(req.params.id)
    if (!doc) return res.status(404).json({ error: 'Custom role not found' })
    res.json({ message: 'Deleted' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
