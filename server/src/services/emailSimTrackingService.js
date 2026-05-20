/**
 * Resolve the public HTTP origin used in outbound HTML (tracking pixels, links).
 * Prefer EMAIL_SIM_PUBLIC_ORIGIN when the API is internal but recipients must hit a public URL.
 */

function normalizeOrigin(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`)
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

export function resolveTrackingOriginFromEnv() {
  const explicit = normalizeOrigin(process.env.EMAIL_SIM_PUBLIC_ORIGIN)
  if (explicit) return explicit
  return normalizeOrigin(process.env.PUBLIC_APP_URL)
}

/** Origin for redirects/HTML bodies when handling a browser request (fallback). */
export function resolveOriginFromRequest(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  if (!host) return ''
  return normalizeOrigin(`${proto}://${host}`)
}

export function resolveTrackingOrigin(req) {
  return resolveTrackingOriginFromEnv() || resolveOriginFromRequest(req)
}

/** Allowed redirect targets from tracked click URLs — blocks javascript: etc. */
export function isSafeHttpUrl(href) {
  try {
    const u = new URL(href)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Returns null if the origin is publicly reachable enough for recipient inboxes
 * (Gmail, Outlook, etc.) to fetch the open pixel / click link. Otherwise returns
 * a short reason string so callers can warn users before they hit “Launch”.
 *
 * Gmail in particular routes every image through GoogleImageProxy on Google's
 * servers — so loopback / private IPs / .local hosts will never be reached.
 */
export function describeTrackingOriginIssue(origin) {
  const s = String(origin || '').trim()
  if (!s) return 'Tracking origin is not set. Configure EMAIL_SIM_PUBLIC_ORIGIN (or PUBLIC_APP_URL) with a publicly reachable HTTPS URL.'
  let u
  try {
    u = new URL(s)
  } catch {
    return 'EMAIL_SIM_PUBLIC_ORIGIN is not a valid URL.'
  }
  const host = (u.hostname || '').toLowerCase()
  if (!host) return 'Tracking origin has no host.'
  if (host === 'localhost' || host === '0.0.0.0') {
    return `Tracking origin "${u.host}" points at localhost. Gmail/Outlook image proxies cannot reach it, so opens & clicks will not record. Use a publicly reachable HTTPS URL.`
  }
  if (/^127\./.test(host)) {
    return `Tracking origin "${u.host}" is a loopback address. Gmail/Outlook image proxies cannot reach it, so opens & clicks will not record.`
  }
  if (/^10\./.test(host) || /^192\.168\./.test(host)) {
    return `Tracking origin "${u.host}" is a private LAN address. External mailboxes (Gmail/Outlook) cannot reach it.`
  }
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) {
    return `Tracking origin "${u.host}" is a private LAN address. External mailboxes (Gmail/Outlook) cannot reach it.`
  }
  if (host.endsWith('.local')) {
    return `Tracking origin "${u.host}" uses a .local hostname. External mailboxes cannot resolve it.`
  }
  if (u.protocol !== 'https:') {
    return `Tracking origin is HTTP. Gmail proxies images aggressively and may block insecure trackers — prefer HTTPS for reliable open tracking.`
  }
  return null
}
