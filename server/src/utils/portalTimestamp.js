/** Portal display timezone — defaults to IST for Lenskart ops. */
export function getPortalTimezone() {
  return process.env.PORTAL_TIMEZONE || 'Asia/Kolkata'
}

/**
 * Format a timestamp for user-facing portal / AI replies (always explicit TZ).
 * @param {Date|string|number} [value]
 * @param {{ timeZone?: string }} [opts]
 */
export function formatPortalTimestamp(value = new Date(), opts = {}) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value ?? '')

  const timeZone = opts.timeZone || getPortalTimezone()
  return new Intl.DateTimeFormat('en-IN', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(d)
}
