import { Router } from 'express'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import User from '../models/User.js'
import { sanitizeAllowedPages } from '../constants/appPages.js'
import { toClientUserPayload } from '../utils/computeUserPageAccess.js'

const router = Router()

function trim(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/** @param {object} body @param {{ existingUser?: object }} [opts] */
function pickUserPayload(body, opts = {}) {
  const {
    name,
    email,
    password,
    role,
    active,
    allowedPages: rawPages,
    avatar,
    customRoleId: rawCr,
    authKind: rawAuthKind,
    adLoginIdentity: rawAdIdentity,
  } = body
  const existingUser = opts.existingUser
  const out = { name, email, role, active, avatar }

  if (!existingUser) {
    const authKind = rawAuthKind === 'ad' ? 'ad' : 'local'
    out.authKind = authKind
    if (authKind === 'ad') {
      out.adLoginIdentity = trim(rawAdIdentity)
    } else {
      out.adLoginIdentity = ''
      if (!password || String(password).length < 1) {
        throw new Error('Password is required for local accounts')
      }
      out.password = password
    }
  } else {
    const ak = existingUser.authKind || 'local'
    if (ak === 'ad') {
      if (password) throw new Error('Cannot set a portal password on an Active Directory–linked account.')
      if (rawAdIdentity !== undefined) out.adLoginIdentity = trim(rawAdIdentity)
    } else if (password) {
      out.password = password
    }
  }

  if (role === 'role_template') {
    const raw = rawCr ?? body.customRoleId
    const id = raw !== undefined && raw !== null ? String(raw).trim() : ''
    if (!id || !mongoose.isValidObjectId(id)) {
      throw new Error('A valid custom role must be selected')
    }
    out.customRoleId = id
    out.allowedPages = []
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined))
  }

  out.customRoleId = null

  const pages = sanitizeAllowedPages(rawPages)
  if (pages !== undefined && role !== 'admin') out.allowedPages = pages

  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined))
}

router.get('/', async (_req, res) => {
  try {
    const users = await User.find()
    const list = await Promise.all(users.map((u) => toClientUserPayload(u)))
    res.json(list)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/', async (req, res) => {
  try {
    let payload
    try {
      payload = pickUserPayload(req.body)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
    const user = await User.create(payload)
    const dto = await toClientUserPayload(user)
    res.status(201).json(dto)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const existing = await User.findById(req.params.id)
    if (!existing) return res.status(404).json({ error: 'User not found' })
    let payload
    try {
      payload = pickUserPayload(req.body, { existingUser: existing })
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
    if (payload.password) {
      payload.password = await bcrypt.hash(payload.password, 12)
    }
    const user = await User.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true }).select(
      '-password',
    )
    if (!user) return res.status(404).json({ error: 'User not found' })
    const dto = await toClientUserPayload(user)
    res.json(dto)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id)
    res.json({ message: 'User deleted' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
