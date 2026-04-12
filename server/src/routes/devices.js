import { Router } from 'express'
import Device from '../models/Device.js'
import Site from '../models/Site.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const devices = await Device.find().populate('site', 'name')
    res.json(devices)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/', async (req, res) => {
  try {
    const device = await Device.create(req.body)
    res.status(201).json(device)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/:id', async (req, res) => {
  try {
    const device = await Device.findByIdAndUpdate(req.params.id, req.body, { new: true })
    res.json(device)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.delete('/:id', async (req, res) => {
  try {
    await Device.findByIdAndDelete(req.params.id)
    res.json({ message: 'Device deleted' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router
