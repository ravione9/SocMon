import { resolveUserFromBearerToken } from '../utils/jwtAuth.js'

export async function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ error: 'No token provided' })
    const resolved = await resolveUserFromBearerToken(token)
    if (!resolved) return res.status(401).json({ error: 'Invalid or expired token' })
    req.user = resolved.user
    req.authMethod = resolved.authMethod
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

export function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }
    next()
  }
}
