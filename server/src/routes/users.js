import { Router } from 'express'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import User from '../models/User.js'
import CustomRole from '../models/CustomRole.js'
import { sanitizeAllowedPages, APP_PAGE_KEY_SET, APP_PAGE_KEYS } from '../constants/appPages.js'
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
    // .lean() avoids per-doc Mongoose hydration; toClientUserPayload tolerates plain objects.
    const users = await User.find().lean()
    // Pre-fetch all referenced custom roles in a single query (instead of N findById in toClientUserPayload).
    const roleIds = [
      ...new Set(
        users
          .filter((u) => u.role === 'role_template' && u.customRoleId)
          .map((u) => String(u.customRoleId)),
      ),
    ]
    const roles = roleIds.length
      ? await CustomRole.find({ _id: { $in: roleIds } }).select('name pages').lean()
      : []
    const roleMap = new Map(roles.map((r) => [String(r._id), r]))

    const ALL = [...APP_PAGE_KEYS]
    const list = users.map((u) => {
      const out = {
        _id: u._id,
        id: u._id,
        name: u.name,
        email: u.email,
        authKind: u.authKind || 'local',
        adLoginIdentity: u.authKind === 'ad' ? u.adLoginIdentity || '' : '',
        role: u.role,
        active: u.active,
        lastLogin: u.lastLogin,
        avatar: u.avatar,
        customRoleId: u.customRoleId,
        customRoleName: null,
        theme: u.theme,
        themeSaveToProfile: u.themeSaveToProfile,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      }
      if (u.role === 'admin') {
        out.allowedPages = [...ALL]
        out.pageAccess = Object.fromEntries(ALL.map((k) => [k, 'full']))
        return out
      }
      if (u.role === 'role_template') {
        const cr = u.customRoleId ? roleMap.get(String(u.customRoleId)) : null
        out.customRoleName = cr?.name ?? null
        const pageAccess = {}
        if (cr?.pages?.length) {
          for (const { pageKey, access } of cr.pages) {
            if (APP_PAGE_KEY_SET.has(pageKey) && (access === 'read' || access === 'full')) {
              pageAccess[pageKey] = access
            }
          }
        }
        out.pageAccess = pageAccess
        out.allowedPages = Object.keys(pageAccess)
        return out
      }
      if (u.role === 'custom_admin') {
        const allowed = Array.isArray(u.allowedPages)
          ? [...new Set(u.allowedPages.filter((k) => APP_PAGE_KEY_SET.has(k)))]
          : []
        out.allowedPages = allowed
        out.pageAccess = Object.fromEntries(allowed.map((k) => [k, 'full']))
        return out
      }
      // analyst / viewer fallback (legacy implicit-grant semantics live in computeUserPageAccess.js;
      // for the list view we return the stored allowedPages — admin UI never needs the implicit grant
      // behaviour and bulk-list perf matters more here).
      const allowed = Array.isArray(u.allowedPages)
        ? [...new Set(u.allowedPages.filter((k) => APP_PAGE_KEY_SET.has(k)))]
        : [...ALL]
      const level = u.role === 'viewer' ? 'read' : 'full'
      out.allowedPages = allowed
      out.pageAccess = Object.fromEntries(allowed.map((k) => [k, level]))
      return out
    })
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
