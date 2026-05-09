import { Router } from 'express'
import Site from '../models/Site.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()
router.use(authenticate)

router.get('/', async (req, res) => {
  try {
    const sites = await Site.find()
    res.json(sites)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/', async (req, res) => {
  try {
    const site = await Site.create(req.body)
    res.status(201).json(site)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/:id', async (req, res) => {
  try {
    const site = await Site.findByIdAndUpdate(req.params.id, req.body, { new: true })
    res.json(site)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.delete('/:id', async (req, res) => {
  try {
    await Site.findByIdAndDelete(req.params.id)
    res.json({ message: 'Site deleted' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router
