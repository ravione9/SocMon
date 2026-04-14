import { Router } from 'express'
import User from '../models/User.js'
import { sanitizeAllowedPages } from '../constants/appPages.js'

const router = Router()

function pickUserPayload(body) {
  const {
    name,
    email,
    password,
    role,
    active,
    allowedPages: rawPages,
    avatar,
  } = body
  const out = { name, email, role, active, avatar }
  if (password) out.password = password
  const pages = sanitizeAllowedPages(rawPages)
  if (pages !== undefined && role !== 'admin') out.allowedPages = pages
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined))
}

router.get('/', async (req, res) => {
  try {
    const users = await User.find()
    res.json(users)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/', async (req, res) => {
  try {
    const user = await User.create(pickUserPayload(req.body))
    res.status(201).json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      allowedPages: user.allowedPages,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/:id', async (req, res) => {
  try {
    const payload = pickUserPayload(req.body)
    const user = await User.findByIdAndUpdate(req.params.id, payload, { new: true })
    res.json(user)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.delete('/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id)
    res.json({ message: 'User deleted' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router
