import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import { resolveUserFromBearerToken } from '../utils/jwtAuth.js'

let cachedAgentUser = null

/** Comma-separated NETPULSE_AGENT_API_KEYS or single NETPULSE_AGENT_API_KEY */
export function getConfiguredAgentApiKeys() {
  const keys = new Set()
  const multi = String(process.env.NETPULSE_AGENT_API_KEYS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  for (const k of multi) keys.add(k)
  const single = String(process.env.NETPULSE_AGENT_API_KEY || '').trim()
  if (single) keys.add(single)
  return [...keys]
}

export function isAgentApiKeyConfigured() {
  return getConfiguredAgentApiKeys().length > 0
}

function extractBearerToken(req) {
  const auth = req.headers.authorization
  if (!auth || !/^Bearer\s+/i.test(auth)) return null
  return auth.replace(/^Bearer\s+/i, '').trim()
}

function extractAgentKeyHeader(req) {
  return String(
    req.headers['x-netpulse-agent-key']
      || req.headers['x-agent-api-key']
      || '',
  ).trim() || null
}

function looksLikeJwt(token) {
  return String(token || '').split('.').length >= 3
}

async function loadAgentServiceUser() {
  if (cachedAgentUser?.active) return cachedAgentUser

  const id = String(process.env.NETPULSE_AGENT_USER_ID || '').trim()
  const email = String(process.env.NETPULSE_AGENT_USER_EMAIL || '').trim().toLowerCase()

  let user = null
  if (id) user = await User.findById(id)
  if (!user && email) user = await User.findOne({ email, active: true })

  if (!user || !user.active) {
    throw Object.assign(
      new Error(
        'Agent API key is configured but no service user is set. Set NETPULSE_AGENT_USER_EMAIL (or NETPULSE_AGENT_USER_ID) to an active NetPulse user with the pages this agent should access.',
      ),
      { status: 503, code: 'AGENT_USER_NOT_CONFIGURED' },
    )
  }

  cachedAgentUser = user
  return user
}

async function authenticateAgentKey(req, res, next) {
  try {
    const keys = getConfiguredAgentApiKeys()
    if (!keys.length) {
      return res.status(503).json({
        error: 'External agent API is not configured. Set NETPULSE_AGENT_API_KEY on the server.',
        code: 'AGENT_KEY_NOT_CONFIGURED',
      })
    }

    const provided = extractAgentKeyHeader(req) || extractBearerToken(req)
    if (!provided || !keys.includes(provided)) {
      return res.status(401).json({ error: 'Invalid agent API key', code: 'AGENT_KEY_INVALID' })
    }

    req.user = await loadAgentServiceUser()
    req.authMethod = 'agent_key'
    next()
  } catch (err) {
    const status = err.status || 500
    res.status(status).json({ error: err.message, code: err.code })
  }
}

async function authenticateJwt(req, res, next) {
  try {
    const token = extractBearerToken(req)
    if (!token) return res.status(401).json({ error: 'No token provided' })
    const resolved = await resolveUserFromBearerToken(token)
    if (!resolved) return res.status(401).json({ error: 'Invalid or expired token' })
    req.user = resolved.user
    req.authMethod = resolved.authMethod === 'api_jwt' ? 'api_jwt' : 'jwt'
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

/**
 * External agents: X-Netpulse-Agent-Key or Bearer <agent-key>.
 * Analysts/scripts: Bearer <NetPulse JWT> (same as UI).
 */
export async function authenticateUserOrAgent(req, res, next) {
  const agentHeader = extractAgentKeyHeader(req)
  if (agentHeader) return authenticateAgentKey(req, res, next)

  const bearer = extractBearerToken(req)
  if (!bearer) {
    return res.status(401).json({
      error: 'Provide Authorization: Bearer <JWT> or X-Netpulse-Agent-Key',
      code: 'AUTH_REQUIRED',
    })
  }

  if (looksLikeJwt(bearer)) return authenticateJwt(req, res, next)

  const keys = getConfiguredAgentApiKeys()
  if (keys.includes(bearer)) return authenticateAgentKey(req, res, next)

  return authenticateJwt(req, res, next)
}
