/** Values often seen on forwarders / collectors mistaken for the FortiGate hostname. */
const BOGUS_FW_HOSTNAME = /^(root|syslog|nobody|user|localhost|elasticsearch|elastic)$/i

export function isPlausibleFirewallHostname(s) {
  if (s == null || typeof s !== 'string') return false
  const t = s.trim()
  if (!t) return false
  return !BOGUS_FW_HOSTNAME.test(t)
}

function fgtField(e, k) {
  return e.fgt?.[k] ?? e[`fgt.${k}`]
}

/** Forti syslog / KV: devname="X" or devname=X */
export function parseFortiKv(msg, key) {
  const s = String(msg || '')
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let m = s.match(new RegExp(`${esc}="([^"]*)"`, 'i'))
  if (m) return m[1].trim()
  m = s.match(new RegExp(`${esc}='([^']*)'`, 'i'))
  if (m) return m[1].trim()
  m = s.match(new RegExp(`\\b${esc}=([^\\s,]+)`, 'i'))
  if (m) return m[1].replace(/^['"]+|['"]+$/g, '').trim()
  return ''
}

function firstScalarIp(val) {
  if (val == null || val === '') return ''
  if (Array.isArray(val)) return String(val.find(Boolean) ?? '')
  return String(val)
}

function pickName(...cands) {
  for (const c of cands) {
    if (typeof c !== 'string') continue
    const t = c.trim()
    if (t && isPlausibleFirewallHostname(t)) return t
  }
  return ''
}

/**
 * FortiGate display name + IP for SOC / log search.
 * Ignores collector host.name when it is a bogus account like "root".
 */
export function firewallIdentityFromEvent(e) {
  const f = e.fgt || {}
  const msg = f.msg || e.message || ''
  const host = e.host || {}
  const obs = e.observer || {}
  const source = e.source || {}
  const device = e.device || {}

  const devn = fgtField(e, 'devname')
  const name =
    pickName(
      typeof e.firewall_name === 'string' ? e.firewall_name : '',
      devn != null && devn !== '' ? String(devn) : '',
      parseFortiKv(msg, 'devname'),
      typeof obs.hostname === 'string' ? obs.hostname : '',
      typeof obs.name === 'string' ? obs.name : '',
      typeof device.name === 'string' ? device.name : '',
      typeof host.hostname === 'string' ? host.hostname : '',
      typeof host.name === 'string' ? host.name : '',
      typeof e.hostname === 'string' ? e.hostname : '',
    ) || '—'

  const devip = fgtField(e, 'devip')
  const ip =
    (typeof e.firewall_ip === 'string' && e.firewall_ip.trim()) ||
    firstScalarIp(host.ip) ||
    firstScalarIp(obs.ip) ||
    firstScalarIp(source.ip) ||
    (devip != null && devip !== '' ? String(devip) : '') ||
    ''
  return { name, ip: String(ip || '').trim() }
}

function scalarStr(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

/** Custom log search / multi-device: ECS device first, then Forti-derived name. */
export function logSearchDeviceLabel(e) {
  const d = e.device || {}
  const ecs =
    scalarStr(d.name) ||
    scalarStr(d.hostname) ||
    scalarStr(e['device.name']) ||
    scalarStr(e['device.hostname'])
  if (ecs) return ecs
  const { name } = firewallIdentityFromEvent(e)
  return name && name !== '—' ? name : ''
}

function ecsUserScalar(u) {
  if (u == null || u === '') return ''
  if (typeof u === 'string') return u.trim()
  if (typeof u === 'object')
    return scalarStr(u.name || u.username || u.full_name || u.id || u.email || u.domain?.user)
  return ''
}

/**
 * VPN / SSL-VPN / auth user for FortiGate docs (fgt.*, ECS user.*, syslog KV).
 */
export function fortigateVpnUserLabel(e) {
  const f = e.fgt || {}
  const flat = k => f[k] ?? e[`fgt.${k}`]
  const fromFgt =
    scalarStr(flat('user')) ||
    scalarStr(flat('authuser')) ||
    scalarStr(flat('client_user')) ||
    scalarStr(flat('remote_user')) ||
    scalarStr(flat('vpnuser')) ||
    scalarStr(flat('un')) ||
    scalarStr(flat('sso_user'))
  const fromEcs =
    ecsUserScalar(e.user) ||
    ecsUserScalar(e.source?.user) ||
    ecsUserScalar(e.client?.user) ||
    ecsUserScalar(e.host?.user)
  const ffw = e.fortinet?.firewall
  const fromFn =
    ffw && typeof ffw === 'object'
      ? scalarStr(ffw.user || ffw.authuser || ffw.saml_user || ffw.vpnuser)
      : scalarStr(e['fortinet.firewall.user'])
  const msg = f.msg || e.message || ''
  const fromMsg =
    parseFortiKv(msg, 'user') ||
    parseFortiKv(msg, 'usr') ||
    parseFortiKv(msg, 'auth_user') ||
    parseFortiKv(msg, 'vpnuser') ||
    parseFortiKv(msg, 'remote_user') ||
    parseFortiKv(msg, 'sso_user')
  const t = (fromFgt || fromEcs || fromFn || fromMsg || '').trim()
  return t || ''
}

/** Best-effort username from Cisco syslog lines (login / AAA failures). */
export function ciscoLoginFailureUserLabel(e) {
  const msg = String(e.cisco_message || e.message || '')
  const patterns = [
    /(?:Authentication failed|authentication failed)[^.]*?user\s+['"]?([A-Za-z0-9._@\\-]+)/i,
    /User\s+([A-Za-z0-9._@\\-]+)\s+(?:fail|invalid|denied|locked)/i,
    /login failed.*?for\s+['"]?([A-Za-z0-9._@\\-]+)/i,
    /for user\s+['"]?([A-Za-z0-9._@\\-]+)/i,
    /username[:=]\s*['"]?([A-Za-z0-9._@\\-]+)/i,
    /by\s+username\s+['"]?([A-Za-z0-9._@\\-]+)/i,
  ]
  for (const re of patterns) {
    const m = msg.match(re)
    if (m?.[1]) return m[1].trim()
  }
  return scalarStr(e.user?.name || e.user?.username || e['user.name'])
}
