import { Router } from 'express'
import AlertRule from '../models/AlertRule.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const rules = await AlertRule.find()
    res.json(rules)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/', async (req, res) => {
  try {
    const rule = await AlertRule.create(req.body)
    res.status(201).json(rule)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/:id', async (req, res) => {
  try {
    const rule = await AlertRule.findByIdAndUpdate(req.params.id, req.body, { new: true })
    res.json(rule)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.delete('/:id', async (req, res) => {
  try {
    await AlertRule.findByIdAndDelete(req.params.id)
    res.json({ message: 'Rule deleted' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router
