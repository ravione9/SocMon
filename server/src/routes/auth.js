import { Router } from 'express'
import User from '../models/User.js'
import { verifyAdPortalPassword } from '../services/adService.js'
import { toClientUserPayload } from '../utils/computeUserPageAccess.js'
import { authenticate } from '../middleware/auth.js'
import {
  signLoginJwt,
  resolveUserFromBearerToken,
  listUserApiTokens,
  createUserApiToken,
  revokeUserApiToken,
} from '../utils/jwtAuth.js'

const router = Router()

async function requireSessionUser(req, res, next) {
  if (req.authMethod === 'api_jwt') {
    return res.status(403).json({
      error: 'Sign in to the portal to manage API tokens. API JWTs cannot create or revoke other tokens.',
      code: 'SESSION_REQUIRED',
    })
  }
  next()
}

const THEME_IDS = [
  'midnight',
  'ocean',
  'forest',
  'dawn',
  'paper',
  'sand',
  'ember',
  'arctic',
  'rose',
  'slate',
  'nebula',
  'mono',
  'ruby',
]

function userThemePayload(doc) {
  return {
    theme: doc.themeSaveToProfile ? doc.theme : null,
    themeSaveToProfile: !!doc.themeSaveToProfile,
  }
}

async function authMeJson(userDoc) {
  const dto = await toClientUserPayload(userDoc)
  return {
    id: dto.id,
    name: dto.name,
    email: dto.email,
    authKind: dto.authKind || 'local',
    role: dto.role,
    allowedPages: dto.allowedPages,
    pageAccess: dto.pageAccess,
    customRoleId: dto.customRoleId,
    customRoleName: dto.customRoleName,
    apiAccessEnabled: !!dto.apiAccessEnabled,
    ...userThemePayload(userDoc),
  }
}

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

    const emailNorm = String(email).trim().toLowerCase()
    const user = await User.findOne({ email: emailNorm, active: true }).select('+password')
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })

    const authKind = user.authKind || 'local'
    let valid = false
    if (authKind === 'ad') {
      const bindIdentity = String(user.adLoginIdentity || '').trim() || user.email
      try {
        valid = await verifyAdPortalPassword(bindIdentity, password)
      } catch (e) {
        console.warn('[auth] AD portal login:', e?.message || e)
        const msg =
          e?.code === 'AD_NOT_CONFIGURED'
            ? 'Directory sign-in is not configured on this server.'
            : 'Cannot reach Active Directory to verify sign-in right now.'
        return res.status(503).json({ error: msg })
      }
    } else {
      valid = await user.comparePassword(password)
    }
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

    const token = signLoginJwt(user._id)

    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() })
    user.lastLogin = new Date()

    res.json({
      token,
      user: await authMeJson(user),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body
    const exists = await User.findOne({ email })
    if (exists) return res.status(400).json({ error: 'Email already registered' })
    const user = await User.create({ name, email, password, role: role || 'viewer' })
    res.status(201).json({ message: 'User created', id: user._id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ error: 'No token' })
    const resolved = await resolveUserFromBearerToken(token)
    if (!resolved) return res.status(401).json({ error: 'Invalid token' })
    res.json(await authMeJson(resolved.user))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/me', authenticate, requireSessionUser, async (req, res) => {
  try {
    const user = req.user
    if (!user) return res.status(404).json({ error: 'User not found' })

    const { theme, themeSaveToProfile } = req.body

    if (typeof themeSaveToProfile === 'boolean') {
      user.themeSaveToProfile = themeSaveToProfile
      if (!themeSaveToProfile) {
        user.theme = null
      }
    }

    if (theme !== undefined && theme !== null) {
      if (!THEME_IDS.includes(theme)) {
        return res.status(400).json({ error: 'Invalid theme' })
      }
      if (user.themeSaveToProfile) {
        user.theme = theme
      }
    }

    if (themeSaveToProfile === true && !user.theme) {
      return res.status(400).json({ error: 'Pick a theme before saving to profile' })
    }

    await user.save()

    res.json(await authMeJson(user))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/api-tokens', authenticate, requireSessionUser, async (req, res) => {
  try {
    const tokens = await listUserApiTokens(req.user._id)
    res.json({
      apiAccessEnabled: !!req.user.apiAccessEnabled,
      tokens: tokens.map((t) => ({
        id: t._id,
        label: t.label,
        expiresAt: t.expiresAt,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
      })),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/api-tokens', authenticate, requireSessionUser, async (req, res) => {
  try {
    const { jwt: token, meta } = await createUserApiToken(req.user, {
      label: req.body?.label,
      expiresIn: req.body?.expiresIn,
    })
    res.status(201).json({
      token,
      ...meta,
      message: 'Copy this token now. It will not be shown again.',
    })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code })
  }
})

router.delete('/api-tokens/:id', authenticate, requireSessionUser, async (req, res) => {
  try {
    await revokeUserApiToken(req.user._id, req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

export default router
