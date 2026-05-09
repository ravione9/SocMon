/** Route segment keys (match client paths /:key). */
export const APP_PAGE_KEYS = ['soc', 'noc', 'sentinel', 'infra', 'tickets', 'reports', 'ai', 'admin']

export const APP_PAGE_KEY_SET = new Set(APP_PAGE_KEYS)

export function sanitizeAllowedPages(value) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined
  const next = [...new Set(value.filter((k) => typeof k === 'string' && APP_PAGE_KEY_SET.has(k)))]
  return next
}
