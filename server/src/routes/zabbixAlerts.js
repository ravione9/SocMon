import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAppPage } from '../middleware/requireAppPage.js'
import ZabbixAlertRule from '../models/ZabbixAlertRule.js'
import ZabbixAlertEvent from '../models/ZabbixAlertEvent.js'
import { testZabbixAlertChannel } from '../services/zabbixAlertNotify.js'
import {
  runZabbixAlertEval,
  getZabbixAlertEvalStatus,
  fetchZabbixAlertDashboard,
} from '../services/zabbixAlertEngine.js'
import { runInstantSlaCheck } from '../services/zabbixAlertInstant.js'
import { createZabbixClient } from '../services/zabbix.js'

const storeClient = createZabbixClient('STORE_ZABBIX')
const { zabbixRpc, isZabbixConfigured } = storeClient

const router = Router()
router.use(authenticate, requireAppPage('storeZabbix'))

router.get('/dashboard', async (_req, res, next) => {
  try {
    const data = await fetchZabbixAlertDashboard()
    res.json(data)
  } catch (e) { next(e) }
})

router.get('/groups', async (_req, res, next) => {
  try {
    if (!isZabbixConfigured()) return res.status(503).json({ error: 'Store Zabbix not configured' })
    const rows = await zabbixRpc('hostgroup.get', { output: ['groupid', 'name'], sortfield: 'name' })
    res.json({ groups: (rows || []).map((g) => g.name).sort() })
  } catch (e) { next(e) }
})

router.get('/rules', async (_req, res, next) => {
  try {
    const rules = await ZabbixAlertRule.find().sort({ createdAt: -1 }).lean()
    res.json(rules)
  } catch (e) { next(e) }
})

router.post('/rules', async (req, res, next) => {
  try {
    const rule = await ZabbixAlertRule.create({ ...req.body, createdBy: req.user?._id })
    res.status(201).json(rule)
  } catch (e) { next(e) }
})

router.put('/rules/:id', async (req, res, next) => {
  try {
    const rule = await ZabbixAlertRule.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!rule) return res.status(404).json({ error: 'Not found' })
    res.json(rule)
  } catch (e) { next(e) }
})

router.delete('/rules/:id', async (req, res, next) => {
  try {
    await ZabbixAlertRule.findByIdAndDelete(req.params.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.post('/test-channel', async (req, res, next) => {
  try {
    const result = await testZabbixAlertChannel(req.body)
    res.json(result)
  } catch (e) { next(e) }
})

router.post('/evaluate', async (_req, res, next) => {
  try {
    const result = await runZabbixAlertEval()
    res.json(result)
  } catch (e) { next(e) }
})

router.post('/evaluate/instant', async (_req, res, next) => {
  try {
    const result = await runInstantSlaCheck()
    res.json(result)
  } catch (e) { next(e) }
})

router.get('/status', (_req, res) => {
  res.json(getZabbixAlertEvalStatus())
})

router.get('/events', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500)
    const skip = parseInt(String(req.query.skip || '0'), 10) || 0
    const ruleId = req.query.ruleId || null
    const filter = ruleId ? { ruleId } : {}
    const [events, total] = await Promise.all([
      ZabbixAlertEvent.find(filter).sort({ firedAt: -1 }).skip(skip).limit(limit).lean(),
      ZabbixAlertEvent.countDocuments(filter),
    ])
    res.json({ events, total, limit, skip })
  } catch (e) { next(e) }
})

router.delete('/events', async (_req, res, next) => {
  try {
    const result = await ZabbixAlertEvent.deleteMany({})
    res.json({ deleted: result.deletedCount })
  } catch (e) { next(e) }
})

export default router
