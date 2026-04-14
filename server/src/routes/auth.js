import { Router } from 'express'
import jwt from 'jsonwebtoken'
import User from '../models/User.js'

const router = Router()

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

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

    const user = await User.findOne({ email, active: true }).select('+password')
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })

    const valid = await user.comparePassword(password)
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' })

    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() })

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        allowedPages: user.allowedPages,
        ...userThemePayload(user),
      },
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(decoded.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      allowedPages: user.allowedPages,
      ...userThemePayload(user),
    })
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
})

router.patch('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ error: 'No token' })
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(decoded.id)
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

    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      allowedPages: user.allowedPages,
      ...userThemePayload(user),
    })
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
