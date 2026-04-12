import { Router } from 'express'
import User from '../models/User.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const users = await User.find()
    res.json(users)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/', async (req, res) => {
  try {
    const user = await User.create(req.body)
    res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/:id', async (req, res) => {
  try {
    const { password, ...rest } = req.body
    const user = await User.findByIdAndUpdate(req.params.id, rest, { new: true })
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
