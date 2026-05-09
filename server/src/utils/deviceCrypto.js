import crypto from 'crypto'

const ALGO = 'aes-256-gcm'

function getKey() {
  const hex = process.env.DEVICE_CREDENTIALS_KEY
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex')
  const secret = process.env.JWT_SECRET || 'dev-insecure'
  return crypto.createHash('sha256').update(`netpulse-device-creds:${secret}`).digest()
}

export function encryptPassword(plain) {
  if (plain == null || plain === '') return ''
  const key = getKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptPassword(blob) {
  if (!blob) return ''
  const raw = Buffer.from(blob, 'base64')
  if (raw.length < 28) return ''
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const data = raw.subarray(28)
  const key = getKey()
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
