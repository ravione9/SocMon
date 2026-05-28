import User from '../models/User.js'
import CustomRole from '../models/CustomRole.js'
import { normalizeAllowedPages } from '../constants/appPages.js'

function sameStringArray(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function normalizeRolePages(pages) {
  if (!Array.isArray(pages)) return []
  const out = []
  const seen = new Set()
  for (const entry of pages) {
    const pageKey = entry?.pageKey === 'network' ? 'solarwinds' : entry?.pageKey
    const access = entry?.access
    if ((access !== 'read' && access !== 'full') || !pageKey || seen.has(pageKey)) continue
    seen.add(pageKey)
    out.push({ pageKey, access })
  }
  return out
}

/** One-time-safe migration: network → solarwinds in Mongo on every startup. */
export async function migrateLegacyPageKeys() {
  let usersUpdated = 0
  let rolesUpdated = 0

  const users = await User.find({ allowedPages: 'network' }).select('allowedPages').lean()
  for (const u of users) {
    const normalized = normalizeAllowedPages(u.allowedPages)
    if (!sameStringArray(normalized, u.allowedPages || [])) {
      await User.updateOne({ _id: u._id }, { $set: { allowedPages: normalized } })
      usersUpdated++
    }
  }

  const roles = await CustomRole.find({ 'pages.pageKey': 'network' }).lean()
  for (const cr of roles) {
    const normalized = normalizeRolePages(cr.pages)
    const changed =
      normalized.length !== (cr.pages?.length || 0) ||
      normalized.some((p, i) => p.pageKey !== cr.pages[i]?.pageKey)
    if (changed) {
      await CustomRole.updateOne({ _id: cr._id }, { $set: { pages: normalized } })
      rolesUpdated++
    }
  }

  if (usersUpdated || rolesUpdated) {
    console.log(`[migrate] legacy page keys: ${usersUpdated} user(s), ${rolesUpdated} role(s) updated`)
  }
}
