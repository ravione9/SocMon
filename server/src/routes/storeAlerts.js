import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAppPage } from '../middleware/requireAppPage.js'
import StoreAlertRule from '../models/StoreAlertRule.js'
import StoreAlertEvent from '../models/StoreAlertEvent.js'
import { testChannel } from '../services/storeAlertNotify.js'
import { runStoreAlertEval, getEvalStatus } from '../services/storeAlertEngine.js'
import { getKafkaStatus, publishAlertEvent, TOPICS } from '../services/kafkaProducer.js'

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

/* Alert event history */
router.get('/events', async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(String(req.query.limit  || '100'), 10) || 100, 500)
    const skip   = parseInt(String(req.query.skip || '0'), 10) || 0
    const ruleId = req.query.ruleId || null
    const filter = ruleId ? { ruleId } : {}
    const [events, total] = await Promise.all([
      StoreAlertEvent.find(filter).sort({ firedAt: -1 }).skip(skip).limit(limit).lean(),
      StoreAlertEvent.countDocuments(filter),
    ])
    res.json({ events, total, limit, skip })
  } catch (e) { next(e) }
})

/* Delete alert history */
router.delete('/events', async (_req, res, next) => {
  try {
    const result = await StoreAlertEvent.deleteMany({})
    res.json({ deleted: result.deletedCount })
  } catch (e) { next(e) }
})

/* ── Kafka connector status ────────────────────────────── */
router.get('/kafka-status', (_req, res) => {
  res.json(getKafkaStatus())
})

/* Replay a stored alert event to Kafka (re-publish by ID) */
router.post('/events/:id/publish-kafka', async (req, res, next) => {
  try {
    const event = await StoreAlertEvent.findById(req.params.id).lean()
    if (!event) return res.status(404).json({ error: 'Event not found' })
    const ok = await publishAlertEvent({
      _id:           event._id,
      ruleId:        event.ruleId,
      ruleName:      event.ruleName,
      severity:      event.severity,
      group:         event.group,
      condition:     event.condition,
      affectedCount: event.affectedCount,
      stores:        event.stores,
      hasMore:       event.hasMore,
      firedAt:       event.firedAt?.toISOString?.() ?? event.firedAt,
    })
    res.json({ ok, topic: TOPICS.ALERTS })
  } catch (e) { next(e) }
})

export default router
