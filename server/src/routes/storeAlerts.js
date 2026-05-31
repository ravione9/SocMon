import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAppPage } from '../middleware/requireAppPage.js'
import StoreAlertRule from '../models/StoreAlertRule.js'
import { testChannel } from '../services/storeAlertNotify.js'
import { runStoreAlertEval, getEvalStatus } from '../services/storeAlertEngine.js'

const router = Router()
router.use(authenticate, requireAppPage('storeMonitor'))

/* ── CRUD ─────────────────────────────────────────────── */
router.get('/', async (_req, res, next) => {
  try {
    const rules = await StoreAlertRule.find().sort({ createdAt: -1 }).lean()
    res.json(rules)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const rule = await StoreAlertRule.create({ ...req.body, createdBy: req.user?._id })
    res.status(201).json(rule)
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const rule = await StoreAlertRule.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!rule) return res.status(404).json({ error: 'Not found' })
    res.json(rule)
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await StoreAlertRule.findByIdAndDelete(req.params.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/* ── Test notification channel ─────────────────────────── */
router.post('/test-channel', async (req, res, next) => {
  try {
    const result = await testChannel(req.body)
    res.json(result)
  } catch (e) { next(e) }
})

/* ── Manual fire / evaluate all rules ─────────────────── */
/* Manual evaluate (same engine, called on-demand) */
router.post('/evaluate', async (_req, res, next) => {
  try {
    const result = await runStoreAlertEval()
    res.json(result)
  } catch (e) { next(e) }
})

/* Status — last evaluation time + stats */
router.get('/status', async (_req, res) => {
  res.json(getEvalStatus())
})

export default router
