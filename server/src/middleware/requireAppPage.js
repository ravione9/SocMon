import { computeUserPageAccess } from '../utils/computeUserPageAccess.js'

/**
 * After authenticate — ensures `req.user` may access this app section by page key.
 * Sets req.pageAccessLevel to 'read' | 'full' for downstream write guards.
 */
export function requireAppPage(pageKey) {
  return async (req, res, next) => {
    try {
      const u = req.user
      if (!u) return res.status(401).json({ error: 'Unauthorized' })
      const { allowedPages, pageAccess } = await computeUserPageAccess(u)
      if (u.role !== 'admin' && !allowedPages.includes(pageKey)) {
        return res.status(403).json({ error: 'Forbidden' })
      }
      req.pageAccessLevel = u.role === 'admin' ? 'full' : pageAccess[pageKey] || 'read'
      next()
    } catch (e) {
      next(e)
    }
  }
}

/** Use after requireAppPage — blocks viewers (read-only). */
export function requirePageWrite(pageKey) {
  return (req, res, next) => {
    void pageKey
    if (req.user?.role === 'admin') return next()
    if (req.pageAccessLevel === 'full') return next()
    return res.status(403).json({ error: 'Read-only access' })
  }
}
