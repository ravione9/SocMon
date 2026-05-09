import { Router } from 'express'
import SshSession from '../models/SshSession.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()
router.use(authenticate)

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const sessions = await SshSession.find()
      .sort({ startedAt: -1 })
      .limit(limit)
      .populate('user', 'name email')
      .populate('device', 'name ip type')
      .lean()
    res.json(sessions)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const s = await SshSession.findById(req.params.id).populate('user', 'name email').populate('device', 'name ip type').lean()
    if (!s) return res.status(404).json({ error: 'Session not found' })
    res.json(s)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
