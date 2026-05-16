/**
 * Fire-and-forget audit logger for Active Directory mutations.
 *
 * - NEVER throws — a failed audit write must not break the LDAP operation
 *   the operator just performed.
 * - Strips known secret fields from `details` so we don't end up with
 *   plaintext passwords in Mongo.
 * - Derives the actor from req.user populated by middleware/auth.js.
 *
 * Usage (inside a route handler):
 *   logAdAudit(req, {
 *     action: 'AD_USER_PASSWORD_RESET',
 *     status: 'SUCCESS',
 *     target: { kind: 'user', dn },
 *     details: { mustChangeNextLogon },
 *   })
 */
import AdAuditLog from '../models/AdAuditLog.js'

const SECRET_KEYS = new Set([
  'password',
  'newpassword',
  'oldpassword',
  'currentpassword',
  'pwd',
  'secret',
  'token',
  'authorization',
  'cookie',
])

function sanitize(value, depth = 0) {
  if (value == null) return value
  if (depth > 4) return '[truncated]'
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1))
  if (typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(String(k).toLowerCase())) {
      out[k] = '[redacted]'
    } else {
      out[k] = sanitize(v, depth + 1)
    }
  }
  return out
}

function performerFromReq(req) {
  const u = req?.user
  if (!u) return undefined
  return {
    userId:   u._id != null ? String(u._id) : undefined,
    email:    u.email || undefined,
    username: u.username || u.email || undefined,
  }
}

function ipFromReq(req) {
  if (!req) return undefined
  // Express resolves req.ip via trust proxy; fall back to the raw socket
  // address so localhost / direct-connect setups still capture something.
  return req.ip || req.connection?.remoteAddress || undefined
}

/**
 * Persist one audit entry. Returns the Promise so tests can await it,
 * but callers normally fire-and-forget.
 *
 * @param {import('express').Request} req
 * @param {{
 *   action: string,
 *   status: 'SUCCESS' | 'FAILED',
 *   target?: { kind?: string, dn?: string, name?: string, parentDn?: string },
 *   details?: any,
 *   errorCode?: string,
 * }} entry
 */
export function logAdAudit(req, entry) {
  try {
    return AdAuditLog.create({
      action: entry.action,
      status: entry.status,
      performedBy: performerFromReq(req),
      target: entry.target || undefined,
      details: entry.details != null ? sanitize(entry.details) : undefined,
      errorCode: entry.errorCode || undefined,
      ipAddress: ipFromReq(req),
    }).catch((e) => {
      console.error('[ad audit]', e.message)
    })
  } catch (e) {
    console.error('[ad audit/sync]', e.message)
    return Promise.resolve()
  }
}
