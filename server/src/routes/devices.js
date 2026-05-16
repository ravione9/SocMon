import { Router } from 'express'
import Device from '../models/Device.js'
import DeviceUserCredential from '../models/DeviceUserCredential.js'
import { authenticate } from '../middleware/auth.js'
import { probeMgmtBase, buildBasicAuthUrl } from '../utils/deviceMgmtProbe.js'
import {
  syncDeviceUserCredential,
  getPlainMgmtForUser,
  credentialsByDeviceForUser,
} from '../utils/deviceUserCredential.js'

const router = Router()

router.use(authenticate)

function toDeviceDto(doc, userCred) {
  const o = doc.toObject ? doc.toObject() : { ...doc }
  const u = userCred || null
  o.mgmtUsername = u?.mgmtUsername ?? ''
  o.hasMgmtPassword = Boolean(u?.mgmtPasswordEnc)
  return o
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.filter(Boolean).map(String)
  if (typeof tags === 'string' && tags.trim()) return tags.split(',').map(s => s.trim()).filter(Boolean)
  return undefined
}

function buildDevicePayload(body) {
  const {
    name,
    ip,
    type,
    site,
    status,
    syslogPort,
    notes,
    tags,
    sshPort,
    httpsPort,
    rdpPort,
    rdpDomain,
  } = body

  const out = {}
  if (name !== undefined) out.name = name
  if (ip !== undefined) out.ip = ip
  if (type !== undefined) out.type = type
  if (site !== undefined) out.site = site
  if (status !== undefined) out.status = status
  if (syslogPort !== undefined) out.syslogPort = syslogPort
  if (notes !== undefined) out.notes = notes
  const t = normalizeTags(tags)
  if (t !== undefined) out.tags = t
  if (sshPort !== undefined) out.sshPort = Number(sshPort) > 0 ? Number(sshPort) : 22
  if (httpsPort !== undefined) out.httpsPort = Number(httpsPort) > 0 ? Number(httpsPort) : 443
  if (rdpPort !== undefined) out.rdpPort = Number(rdpPort) > 0 ? Number(rdpPort) : 3389
  if (rdpDomain !== undefined) out.rdpDomain = rdpDomain == null ? '' : String(rdpDomain)

  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined))
}

router.get('/', async (req, res) => {
  try {
    // .lean() returns plain objects so toDeviceDto's `doc.toObject ? ... : { ...doc }` branch kicks in.
    const devices = await Device.find().populate('site', 'name location').sort({ name: 1 }).lean()
    const uid = req.user._id
    const credMap = await credentialsByDeviceForUser(uid, devices.map((d) => d._id))
    res.json(devices.map((d) => toDeviceDto(d, credMap.get(String(d._id)))))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/:id/credentials', async (req, res) => {
  try {
    const d = await Device.findById(req.params.id).select('name')
    if (!d) return res.status(404).json({ error: 'Device not found' })
    const plain = await getPlainMgmtForUser(req.user._id, d._id)
    res.json({
      username: plain.mgmtUsername || '',
      password: plain.password || '',
      hasPassword: plain.hasPassword,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/:id/mgmt-probe', async (req, res) => {
  try {
    const d = await Device.findById(req.params.id).select('name ip httpsPort')
    if (!d) return res.status(404).json({ error: 'Device not found' })
    const plain = await getPlainMgmtForUser(req.user._id, d._id)
    const probe = await probeMgmtBase(d.ip, d.httpsPort ?? 443, 80)
    let basicAuthUrl = null
    if (plain.mgmtUsername && plain.password) {
      try {
        basicAuthUrl = buildBasicAuthUrl(plain.mgmtUsername, plain.password, probe.baseUrl)
      } catch {
        /* ignore */
      }
    }
    res.json({
      deviceId: String(d._id),
      deviceName: d.name,
      username: plain.mgmtUsername || '',
      hasPassword: plain.hasPassword,
      ...probe,
      basicAuthUrl,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const device = await Device.findById(req.params.id).populate('site', 'name location')
    if (!device) return res.status(404).json({ error: 'Device not found' })
    const cred = await DeviceUserCredential.findOne({ user: req.user._id, device: device._id }).lean()
    res.json(toDeviceDto(device, cred))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/', async (req, res) => {
  try {
    const payload = buildDevicePayload(req.body)
    const device = await Device.create(payload)
    await syncDeviceUserCredential(req.user._id, device._id, req.body)
    await device.populate('site', 'name location')
    const cred = await DeviceUserCredential.findOne({ user: req.user._id, device: device._id }).lean()
    res.status(201).json(toDeviceDto(device, cred))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const patch = buildDevicePayload(req.body)
    const device = await Device.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true })
    if (!device) return res.status(404).json({ error: 'Device not found' })
    await syncDeviceUserCredential(req.user._id, device._id, req.body)
    await device.populate('site', 'name location')
    const cred = await DeviceUserCredential.findOne({ user: req.user._id, device: device._id }).lean()
    res.json(toDeviceDto(device, cred))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id
    await DeviceUserCredential.deleteMany({ device: id })
    await Device.findByIdAndDelete(id)
    res.json({ message: 'Device deleted' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
