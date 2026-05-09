import DeviceUserCredential from '../models/DeviceUserCredential.js'
import { encryptPassword, decryptPassword } from './deviceCrypto.js'

/**
 * Apply POST/PUT body fields to this user's credential row for the device.
 * Mirrors legacy device password rules: savePassword false removes stored creds;
 * non-empty mgmtPassword encrypts; empty password does not clear existing secret.
 */
export async function syncDeviceUserCredential(userId, deviceId, body) {
  if (!userId || !deviceId) return

  const saveOff = body.savePassword === false || body.savePassword === 'false'
  if (saveOff) {
    await DeviceUserCredential.deleteOne({ user: userId, device: deviceId })
    return
  }

  const pw = body.mgmtPassword != null ? String(body.mgmtPassword) : ''
  const set = {}

  if (body.mgmtUsername !== undefined) {
    set.mgmtUsername = body.mgmtUsername == null ? '' : String(body.mgmtUsername)
  }
  if (pw.length > 0) {
    set.mgmtPasswordEnc = encryptPassword(pw)
  }

  if (Object.keys(set).length === 0) return

  await DeviceUserCredential.findOneAndUpdate(
    { user: userId, device: deviceId },
    { $set: set },
    { upsert: true, new: true, runValidators: true },
  )
}

/** Username + decrypted password for the given user/device (empty strings if none). */
export async function getPlainMgmtForUser(userId, deviceId) {
  const c = await DeviceUserCredential.findOne({ user: userId, device: deviceId })
    .select('mgmtUsername mgmtPasswordEnc')
    .lean()
  if (!c) {
    return { mgmtUsername: '', password: '', hasPassword: false }
  }
  let password = ''
  if (c.mgmtPasswordEnc) {
    try {
      password = decryptPassword(c.mgmtPasswordEnc) || ''
    } catch {
      password = ''
    }
  }
  return {
    mgmtUsername: c.mgmtUsername || '',
    password,
    hasPassword: Boolean(c.mgmtPasswordEnc && password),
  }
}

/** Map deviceId string -> lean credential doc for batch listing. */
export async function credentialsByDeviceForUser(userId, deviceIds) {
  const ids = [...new Set((deviceIds || []).filter(Boolean).map((id) => String(id)))]
  if (!userId || ids.length === 0) return new Map()
  const rows = await DeviceUserCredential.find({
    user: userId,
    device: { $in: ids },
  }).lean()
  const m = new Map()
  for (const r of rows) {
    m.set(String(r.device), r)
  }
  return m
}
