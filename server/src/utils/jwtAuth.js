import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import UserApiToken from '../models/UserApiToken.js'

const MAX_ACTIVE_TOKENS_PER_USER = 10

export function signLoginJwt(userId) {
  return jwt.sign({ id: userId, typ: 'session' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  })
}

function parseExpiresIn(raw, fallback = '90d') {
  const v = String(raw || fallback).trim()
  if (!v) return fallback
  return v
}

export async function resolveUserFromBearerToken(token) {
  let decoded
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return null
  }

  const user = await User.findById(decoded.id)
  if (!user || !user.active) return null

  if (decoded.typ === 'api') {
    if (!user.apiAccessEnabled) return null
    const jti = String(decoded.jti || '').trim()
    if (!jti) return null
    const record = await UserApiToken.findOne({
      jti,
      userId: user._id,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
    if (!record) return null
    UserApiToken.updateOne({ _id: record._id }, { lastUsedAt: new Date() }).catch(() => {})
    return { user, authMethod: 'api_jwt', apiTokenRecord: record }
  }

  return { user, authMethod: 'session_jwt' }
}

export function isApiJwtPayload(decoded) {
  return decoded?.typ === 'api'
}

export async function listUserApiTokens(userId) {
  return UserApiToken.find({
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .select('label jti expiresAt lastUsedAt createdAt')
    .lean()
}

export async function createUserApiToken(user, { label, expiresIn } = {}) {
  if (!user?.apiAccessEnabled) {
    throw Object.assign(new Error('API access is not enabled for your account. Ask an administrator.'), {
      status: 403,
      code: 'API_ACCESS_DISABLED',
    })
  }

  const name = String(label || '').trim()
  if (!name) {
    throw Object.assign(new Error('A label is required for the API token'), { status: 400 })
  }

  const activeCount = await UserApiToken.countDocuments({
    userId: user._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
  if (activeCount >= MAX_ACTIVE_TOKENS_PER_USER) {
    throw Object.assign(
      new Error(`You can have at most ${MAX_ACTIVE_TOKENS_PER_USER} active API tokens. Revoke one first.`),
      { status: 400, code: 'API_TOKEN_LIMIT' },
    )
  }

  const jti = crypto.randomUUID()
  const exp = parseExpiresIn(expiresIn, process.env.JWT_API_EXPIRES_IN || '90d')
  const token = jwt.sign({ id: user._id, typ: 'api', jti }, process.env.JWT_SECRET, { expiresIn: exp })

  const decoded = jwt.decode(token)
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)

  const record = await UserApiToken.create({
    userId: user._id,
    label: name,
    jti,
    expiresAt,
  })

  return {
    jwt: token,
    meta: {
      id: record._id,
      label: record.label,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    },
  }
}

export async function revokeUserApiToken(userId, tokenId) {
  const record = await UserApiToken.findOne({ _id: tokenId, userId, revokedAt: null })
  if (!record) {
    throw Object.assign(new Error('API token not found'), { status: 404 })
  }
  record.revokedAt = new Date()
  await record.save()
  return { ok: true }
}
