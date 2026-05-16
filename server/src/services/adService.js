/**
 * Active Directory queries via LDAP against domain controllers.
 * Configuration uses DNS domain + DC hostnames (no DC=… env paths); searches use normal AD base DN derived from the domain.
 */

import { createRequire } from 'module'
import dns from 'dns/promises'
import net from 'net'
import tls from 'tls'

const require = createRequire(import.meta.url)
const ldap = require('ldapjs')

function trim(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/** DNS name → LDAP base DN (DC=lenskart,DC=in) */
export function fqdnToBaseDn(fqdn) {
  const parts = fqdn
    .toLowerCase()
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean)
  return parts
    .map((p) => {
      const escaped = p.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/\+/g, '\\+')
      return `DC=${escaped}`
    })
    .join(',')
}

export function getAdConnectionUrl() {
  const legacy = trim(process.env.AD_LDAP_URL)
  if (legacy) return legacy
  const host = trim(
    process.env.AD_DOMAIN_CONTROLLER || process.env.AD_DC_HOST || process.env.AD_WRITABLE_DC,
  )
  if (!host) return ''
  const useLdaps = ['1', 'true', 'yes'].includes(String(process.env.AD_USE_LDAPS || '').toLowerCase())
  const portStr = trim(process.env.AD_LDAP_PORT)
  const port = portStr || (useLdaps ? '636' : '389')
  const proto = useLdaps ? 'ldaps' : 'ldap'
  return `${proto}://${host}:${port}`
}

export function adIntegrationConfigured() {
  const domainFqdn = trim(process.env.AD_DOMAIN_FQDN || process.env.AD_DOMAIN)
  const dcHost = trim(
    process.env.AD_DOMAIN_CONTROLLER || process.env.AD_DC_HOST || process.env.AD_WRITABLE_DC,
  )
  const legacyUrl = trim(process.env.AD_LDAP_URL)
  return Boolean((domainFqdn && dcHost) || legacyUrl)
}

export function adCredentialsConfigured() {
  const user =
    trim(process.env.AD_SERVICE_USERNAME) ||
    trim(process.env.AD_BIND_DN) ||
    trim(process.env.AD_USER)
  const pass =
    trim(process.env.AD_SERVICE_PASSWORD) ||
    trim(process.env.AD_BIND_PASSWORD) ||
    trim(process.env.AD_PASSWORD)
  return Boolean(user && pass)
}

/** LDAP modifies (password, unlock, attribute edits). Off only when AD_LDAP_WRITES=0|false|no|off */
export function adLdapWritesEnabled() {
  const v = trim(process.env.AD_LDAP_WRITES).toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(v)
}

function hostFromLdapUrl(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** TLS options for ldapjs (ldaps + StartTLS). servername fixes many DC certificate / SNI mismatches. */
function clientTlsOptions(url) {
  const hostname = hostFromLdapUrl(url) || trim(process.env.AD_DOMAIN_CONTROLLER || '')
  const servername = trim(process.env.AD_TLS_SERVERNAME) || hostname || undefined
  return {
    ...tlsOpts(),
    ...(servername ? { servername } : {}),
  }
}

function tlsOpts() {
  const insecure = ['1', 'true', 'yes'].includes(String(process.env.AD_TLS_INSECURE || '').toLowerCase())
  const opts = {}
  if (insecure || process.env.AD_TLS_REJECT_UNAUTHORIZED === '0') opts.rejectUnauthorized = false

  // Many on-prem DCs (Windows 2008 R2 / 2012 / WS2016 with default schannel) negotiate only
  // TLS 1.0/1.1 with legacy ciphers; modern Node rejects those and the socket gets RST during
  // handshake. Allow operators to relax both — automatically lowered when AD_TLS_INSECURE=1
  // so it matches what `ldapsearch -ZZ` / ManageEngine ADManager do in mixed environments.
  const minVersion = trim(process.env.AD_TLS_MIN_VERSION) || (insecure ? 'TLSv1' : '')
  if (minVersion) opts.minVersion = minVersion
  const maxVersion = trim(process.env.AD_TLS_MAX_VERSION)
  if (maxVersion) opts.maxVersion = maxVersion
  const ciphers = trim(process.env.AD_TLS_CIPHERS) || (insecure ? 'DEFAULT:@SECLEVEL=0' : '')
  if (ciphers) opts.ciphers = ciphers

  return opts
}

/** Plain ldap:// (389): upgrade with StartTLS before bind unless explicitly disabled. */
function startTlsEnabledForPlainLdap() {
  const v = trim(process.env.AD_STARTTLS).toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return true
}

function isStrongAuthRequired(err) {
  if (!err) return false
  const msg = String(err.message || err.lde_message || '')
  if (/strong auth required/i.test(msg)) return true
  const c = err.code ?? err.lde_code
  return c === 8 || c === '8'
}

/** Plain ldap:// bind failed — retry once with StartTLS (common when AD_STARTTLS=0 but DC requires signing/TLS). */
function shouldRetryPlainBindWithStartTls(err) {
  if (!err) return false
  if (isStrongAuthRequired(err)) return true
  const msg = String(err.message || err.lde_message || '')
  if (/unavailable/i.test(msg)) return true
  const c = err.code ?? err.lde_code
  if (c === 52 || c === '52') return true
  return false
}

function enrichAdLdapError(err) {
  const original = String(err.message || err.lde_message || err || 'LDAP error')
  const msg = isStrongAuthRequired(err)
    ? 'Strong authentication required (LDAP error 8): Active Directory is rejecting a cleartext bind. Use LDAPS (set AD_USE_LDAPS=1, typically port 636), or keep ldap:// — Netpulse uses StartTLS on port 389 by default. If the DC uses a private CA, set AD_TLS_INSECURE=1 only for testing or install the CA on this server.'
    : original
  const wrapped = new Error(msg)
  wrapped.code = isStrongAuthRequired(err) ? 'AD_STRONG_AUTH_REQUIRED' : 'AD_LDAP_ERROR'
  wrapped.cause = err
  return wrapped
}

function unbindQuiet(client) {
  return new Promise((resolve) => {
    try {
      if (!client) return resolve()
      client.unbind(() => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * Wrap ldap.createClient with safe error/timeout listeners.
 *
 * ldapjs Client is an EventEmitter that emits 'error' / 'connectError' /
 * 'socketTimeout' asynchronously on socket failures. With no listener Node
 * treats those as unhandled and crashes the entire process (the symptom is
 * net::ERR_EMPTY_RESPONSE on subsequent API calls). We always attach safe
 * loggers so failures surface through per-request callbacks instead.
 */
function makeLdapClient(opts) {
  const client = ldap.createClient(opts)
  const onErr = (label) => (err) => {
    const msg = err && (err.message || err.lde_message || String(err))
    console.warn('[ad/ldapjs] %s for %s: %s', label, opts.url, msg || '(no message)')
  }
  client.on('error', onErr('client error'))
  client.on('connectError', onErr('connect error'))
  client.on('socketTimeout', onErr('socket timeout'))
  client.on('timeout', onErr('request timeout'))
  return client
}

function ldapBind(client, user, password) {
  return new Promise((resolve, reject) => {
    client.bind(user, password, (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * ldapjs 3.x requires Change instances whose modification is an Attribute ({ type, values }).
 * Historically this codebase passed `{ operation, modification: { attrName: value } }`.
 */
function legacyChangeToLdapChange(ch) {
  if (ldap.Change.isChange(ch)) {
    return ch
  }
  const operation = ch.operation || ch.type || 'replace'
  const modification = ch.modification
  if (!modification || typeof modification !== 'object') {
    throw Object.assign(new Error('LDAP change.modification (object) required.'), {
      code: 'AD_LDAP_MODIFY_INVALID',
    })
  }
  const keys = Object.keys(modification)
  if (keys.length !== 1) {
    throw Object.assign(new Error('Each LDAP change must target exactly one attribute.'), {
      code: 'AD_LDAP_MODIFY_INVALID',
    })
  }
  const type = keys[0]
  const raw = modification[type]
  const values = Array.isArray(raw) ? raw : [raw]
  return new ldap.Change({
    operation,
    modification: new ldap.Attribute({ type, values }),
  })
}

function ldapModify(client, dn, changeOrArray) {
  const list = Array.isArray(changeOrArray) ? changeOrArray : [changeOrArray]
  const changes = list.map(legacyChangeToLdapChange)
  const payload = changes.length === 1 ? changes[0] : changes
  return new Promise((resolve, reject) => {
    client.modify(dn, payload, (err, res) => (err ? reject(err) : resolve(res)))
  })
}

function ldapStartTls(client, url) {
  const opts = clientTlsOptions(url)
  return new Promise((resolve, reject) => {
    client.starttls(opts, [], (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * Connect + bind. ldaps:// encrypts at connect; ldap:// uses StartTLS first when enabled (default).
 */
async function createAdBoundClient(url, user, password) {
  const clientOpts = {
    url,
    timeout: parseInt(String(process.env.AD_CLIENT_TIMEOUT_MS || '120000'), 10) || 120000,
    connectTimeout: parseInt(String(process.env.AD_CONNECT_TIMEOUT_MS || '20000'), 10) || 20000,
    tlsOptions: clientTlsOptions(url),
  }

  const isPlainLdap = /^ldap:\/\//i.test(url)

  const tryBind = async (client, withStartTls, ldapUrl) => {
    try {
      if (isPlainLdap && withStartTls) {
        await ldapStartTls(client, ldapUrl)
      }
      await ldapBind(client, user, password)
      return client
    } catch (e) {
      await unbindQuiet(client)
      throw e
    }
  }

  if (!isPlainLdap) {
    const client = makeLdapClient(clientOpts)
    try {
      await ldapBind(client, user, password)
      return client
    } catch (e) {
      await unbindQuiet(client)
      throw enrichAdLdapError(e)
    }
  }

  if (startTlsEnabledForPlainLdap()) {
    const client = makeLdapClient(clientOpts)
    try {
      return await tryBind(client, true, url)
    } catch (e) {
      throw enrichAdLdapError(e)
    }
  }

  const plainFirst = makeLdapClient(clientOpts)
  try {
    return await tryBind(plainFirst, false, url)
  } catch (e) {
    if (!shouldRetryPlainBindWithStartTls(e)) {
      throw enrichAdLdapError(e)
    }
    console.warn(
      '[ad] ldap:// bind without StartTLS failed (%s); retrying with StartTLS (omit AD_STARTTLS=0 to prefer TLS first)',
      String(e.message || e.lde_message || e),
    )
    const retry = makeLdapClient(clientOpts)
    try {
      return await tryBind(retry, true, url)
    } catch (e2) {
      throw enrichAdLdapError(e2)
    }
  }
}

const AD_FATAL_CODES = new Set([
  'AD_NOT_CONFIGURED',
  'AD_CREDENTIALS_MISSING',
  'AD_NO_URL',
  'AD_PAGE_ERROR',
  'AD_BASE_DN_UNKNOWN',
])

/**
 * Map low-level TLS / network / LDAP errors into stable codes + readable messages for the API UI.
 */
export function mapAdStatsFailure(err) {
  if (err?.code && AD_FATAL_CODES.has(err.code)) return err
  if (err?.code === 'AD_STRONG_AUTH_REQUIRED') return err

  const raw = err?.cause || err
  const msg = String(raw.message || raw.lde_message || err.message || err)

  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET/i.test(msg)) {
    return Object.assign(
      new Error(
        `Cannot reach the domain controller (${msg}). From the machine running Netpulse, check VPN/firewall, DNS for AD_DOMAIN_CONTROLLER, and that LDAP (389) or LDAPS (636) is allowed.`,
      ),
      { code: 'AD_NETWORK', cause: err },
    )
  }

  if (/certificate|UNABLE_TO_VERIFY|SELF_SIGNED_CERT_IN_CHAIN|unable to verify the first certificate|Hostname\/IP mismatch|IP address mismatch/i.test(msg)) {
    return Object.assign(
      new Error(
        `TLS error: ${msg}. Try AD_TLS_INSECURE=1 on a lab DC, set AD_TLS_SERVERNAME to match the DC certificate CN/SAN, install your CA (NODE_EXTRA_CA_CERTS), or use LDAPS with AD_USE_LDAPS=1.`,
      ),
      { code: 'AD_TLS', cause: err },
    )
  }

  if (/invalid credentials|InvalidCredentials|LDAP_INVALID_CREDENTIALS|\b49\b|52e|775/i.test(msg)) {
    return Object.assign(new Error(`LDAP bind failed — check AD_SERVICE_USERNAME / AD_SERVICE_PASSWORD. (${msg})`), {
      code: 'AD_BIND_AUTH',
      cause: err,
    })
  }

  if (
    /unavailable/i.test(msg) ||
    /\b52\b/.test(msg) ||
    /LDAP_UNAVAILABLE|0x34/i.test(msg)
  ) {
    return Object.assign(
      new Error(
        `LDAP unavailable (${msg}). With ldap:// and AD_STARTTLS=0 the server retries once using StartTLS; if this message persists, remove AD_STARTTLS=0 or set AD_USE_LDAPS=1 and AD_LDAP_PORT=636. Confirm outbound access from this host to ${trim(process.env.AD_DOMAIN_CONTROLLER || 'the DC')} on 389 or 636.`,
      ),
      { code: 'AD_LDAP_UNAVAILABLE', cause: err },
    )
  }

  if (err?.code && String(err.code).startsWith('AD_')) return err

  return enrichAdLdapError(raw)
}

function bindIdentity() {
  const user =
    trim(process.env.AD_SERVICE_USERNAME) ||
    trim(process.env.AD_BIND_DN) ||
    trim(process.env.AD_USER)
  const password =
    trim(process.env.AD_SERVICE_PASSWORD) ||
    trim(process.env.AD_BIND_PASSWORD) ||
    trim(process.env.AD_PASSWORD)
  return { user, password }
}

/**
 * @returns {Promise<string>}
 */
async function resolveBaseDn(client) {
  const explicit = trim(process.env.AD_BASE_DN)
  if (explicit) return explicit
  const domainFqdn = trim(process.env.AD_DOMAIN_FQDN || process.env.AD_DOMAIN)
  if (domainFqdn) return fqdnToBaseDn(domainFqdn)

  const rows = await searchEntries(client, '', {
    scope: 'base',
    filter: '(objectClass=*)',
    attributes: ['defaultNamingContext'],
    paged: false,
  })
  const first = rows[0]
  const dnc = firstAttrValue(first, 'defaultNamingContext')
  if (!dnc) {
    throw Object.assign(new Error('Could not resolve AD base DN. Set AD_DOMAIN or AD_BASE_DN.'), {
      code: 'AD_BASE_DN_UNKNOWN',
    })
  }
  return String(dnc)
}

function firstAttrValue(entry, name) {
  if (!entry?.attributes?.length) return undefined
  const want = name.toLowerCase()
  for (const attr of entry.attributes) {
    const type = String(attr.type || '').toLowerCase()
    if (type !== want) continue
    const vals = attr.values
    if (!vals?.length) return undefined
    return vals[0]
  }
  return undefined
}

function parseBigIntAttr(val) {
  if (val == null) return null
  if (Buffer.isBuffer(val)) {
    if (val.length >= 8) {
      return val.readBigInt64LE()
    }
    return BigInt('0x' + val.toString('hex'))
  }
  const s = String(val).trim()
  if (!s) return null
  try {
    return BigInt(s)
  } catch {
    return null
  }
}

function nowFiletime() {
  const unixMs = BigInt(Date.now())
  return (unixMs + 11644473600000n) * 10000n
}

/** Sentinel / “never logged on” values sometimes returned for lastLogon on DCs. */
const LDAP_UNUSED_FILETIME = 9223372036854775807n

function isMeaningfulLogonFt(n) {
  return n != null && n !== 0n && n !== LDAP_UNUSED_FILETIME
}

/**
 * Prefer the later of non-replicated lastLogon (accurate for this DC) and replicated lastLogonTimestamp.
 */
function latestLogonFiletime(lastLogonRaw, lastLogonTsRaw) {
  const a = parseBigIntAttr(lastLogonRaw)
  const b = parseBigIntAttr(lastLogonTsRaw)
  let best = null
  if (isMeaningfulLogonFt(a)) best = a
  if (isMeaningfulLogonFt(b) && (!best || b > best)) best = b
  return best
}

function latestLogonIso(lastLogonRaw, lastLogonTsRaw) {
  const ft = latestLogonFiletime(lastLogonRaw, lastLogonTsRaw)
  return ft != null ? fileTimeToIso(ft) : null
}

/**
 * Domain maxPwdAge is stored as a negative 100-ns interval.
 * Expiry filetime = pwdLastSet − maxPwdAgeTicks (= pwdLastSet + |maxPwdAge|).
 */
function passwordExpiryFiletime(pwdLastSet, maxPwdAgeTicks) {
  if (pwdLastSet == null || pwdLastSet === 0n || maxPwdAgeTicks == null || maxPwdAgeTicks === 0n) return null
  return pwdLastSet - maxPwdAgeTicks
}

function parseMaxPwdAgeTicks(entry) {
  const raw = firstAttrValue(entry, 'maxPwdAge')
  const n = parseBigIntAttr(raw)
  if (n === null || n === 0n) return null
  return n
}

/**
 * @param {import('ldapjs').Client} client
 */
function searchEntries(client, base, opts) {
  return new Promise((resolve, reject) => {
    const rows = []
    client.search(base, opts, (err, res) => {
      if (err) return reject(err)
      res.on('searchEntry', (msg) => rows.push(msg))
      res.on('error', reject)
      res.on('end', () => resolve(rows))
      res.on('pageError', () =>
        reject(
          Object.assign(new Error('Paged LDAP results not supported by server response.'), {
            code: 'AD_PAGE_ERROR',
          }),
        ),
      )
    })
  })
}

/**
 * @param {import('ldapjs').Client} client
 */
async function searchCount(client, baseDn, filter, extra = {}) {
  const pageSize = Math.min(
    Math.max(parseInt(String(process.env.AD_STATS_PAGE_SIZE || '500'), 10) || 500, 50),
    2000,
  )
  let count = 0
  await new Promise((resolve, reject) => {
    client.search(
      baseDn,
      {
        scope: 'sub',
        filter,
        attributes: ['dn'],
        timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
        paged: { pageSize },
        ...extra,
      },
      (err, res) => {
        if (err) return reject(err)
        res.on('searchEntry', () => {
          count++
        })
        res.on('error', reject)
        res.on('end', () => resolve())
        res.on('pageError', reject)
      },
    )
  })
  return count
}

// ─── Object-listing helpers (Users / Groups / Computers / OUs) ───────────────

function escapeLdapFilter(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\u0000/g, '\\00')
}

/** Convert a SearchResultEntry into a plain JS object (binary attrs returned as base64). */
function entryToObject(entry, options = {}) {
  const wantBinary = new Set((options.binaryAttributes || []).map((a) => a.toLowerCase()))
  const out = {
    dn: String(entry?.objectName?.toString?.() || entry?._dn?.toString?.() || ''),
  }
  for (const attr of entry?.attributes || []) {
    const name = attr.type
    if (!name) continue
    const lower = name.toLowerCase()
    if (wantBinary.has(lower)) {
      const bufs = attr.buffers || []
      out[name] = bufs.length > 1 ? bufs.map((b) => b.toString('base64')) : (bufs[0]?.toString('base64') || null)
      continue
    }
    const vals = attr.values || []
    if (!vals.length) continue
    out[name] = vals.length === 1 ? vals[0] : vals
  }
  return out
}

function fileTimeToIso(val) {
  const n = parseBigIntAttr(val)
  if (n == null || n === 0n || n === LDAP_UNUSED_FILETIME) return null
  const unixMs = Number((n - 116444736000000000n) / 10000n)
  if (!Number.isFinite(unixMs) || unixMs <= 0) return null
  try { return new Date(unixMs).toISOString() } catch { return null }
}

function parentDnFromDn(dn) {
  if (!dn) return ''
  const idx = String(dn).indexOf(',')
  return idx >= 0 ? dn.slice(idx + 1) : ''
}

function uacFlags(uacRaw) {
  const n = Number(uacRaw)
  if (!Number.isFinite(n)) return {}
  return {
    disabled: Boolean(n & 0x0002),
    lockout: Boolean(n & 0x0010),
    passwordNotRequired: Boolean(n & 0x0020),
    dontExpirePassword: Boolean(n & 0x10000),
    passwordExpired: Boolean(n & 0x800000),
    smartcardRequired: Boolean(n & 0x40000),
    trustedForDelegation: Boolean(n & 0x80000),
  }
}

/**
 * Paged sub-tree search returning normalized entries.
 * @param {import('ldapjs').Client} client
 */
async function searchEntriesPaged(client, baseDn, filter, attributes, { limit = 1000 } = {}) {
  const pageSize = Math.min(
    Math.max(parseInt(String(process.env.AD_STATS_PAGE_SIZE || '500'), 10) || 500, 50),
    2000,
  )
  const rows = []
  let truncated = false
  await new Promise((resolve, reject) => {
    client.search(
      baseDn,
      {
        scope: 'sub',
        filter,
        attributes,
        timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
        paged: { pageSize },
      },
      (err, res) => {
        if (err) return reject(err)
        res.on('searchEntry', (msg) => {
          if (rows.length >= limit) { truncated = true; return }
          rows.push(msg)
        })
        res.on('error', reject)
        res.on('end', () => resolve())
        res.on('pageError', reject)
      },
    )
  })
  return { rows, truncated }
}

/**
 * Run a callback against a bound AD client (handles connect / bind / auto-LDAPS fallback / unbind).
 */
async function withAdClient(fn) {
  if (!adIntegrationConfigured()) {
    throw Object.assign(new Error('Active Directory is not configured on the server.'), { code: 'AD_NOT_CONFIGURED' })
  }
  if (!adCredentialsConfigured()) {
    throw Object.assign(new Error('AD service account is not configured on the server.'), { code: 'AD_CREDENTIALS_MISSING' })
  }
  const url = getAdConnectionUrl()
  if (!url) throw Object.assign(new Error('No LDAP URL configured.'), { code: 'AD_NO_URL' })
  const { user, password } = bindIdentity()
  let client
  try {
    client = await createAdBoundClient(url, user, password)
  } catch (e) {
    const isPlain = /^ldap:\/\//i.test(url)
    const host = hostFromLdapUrl(url) || trim(process.env.AD_DOMAIN_CONTROLLER)
    if (isPlain && host && shouldRetryPlainBindWithStartTls(e?.cause || e)) {
      try {
        client = await createAdBoundClient(`ldaps://${host}:636`, user, password)
      } catch (e2) {
        throw mapAdStatsFailure(e2)
      }
    } else {
      throw mapAdStatsFailure(e)
    }
  }
  try {
    const baseDn = await resolveBaseDn(client)
    return await fn(client, baseDn)
  } catch (e) {
    throw mapAdStatsFailure(e)
  } finally {
    await unbindQuiet(client)
  }
}

export async function listAdUsers({ search = '', limit = 500, parentDn = '' } = {}) {
  const safe = escapeLdapFilter(search.trim())
  const where = safe
    ? `(|(samAccountName=*${safe}*)(cn=*${safe}*)(displayName=*${safe}*)(mail=*${safe}*)(userPrincipalName=*${safe}*)(sn=*${safe}*)(givenName=*${safe}*))`
    : ''
  const filter = `(&(objectCategory=person)(objectClass=user)${where})`
  const attrs = [
    'samAccountName', 'cn', 'displayName', 'givenName', 'sn',
    'mail', 'userPrincipalName', 'department', 'title', 'telephoneNumber', 'mobile',
    'userAccountControl', 'lockoutTime', 'badPwdCount', 'pwdLastSet',
    'lastLogon', 'lastLogonTimestamp', 'whenCreated', 'whenChanged',
    'memberOf',
  ]
  return withAdClient(async (client, baseDn) => {
    let searchBase = baseDn
    const parent = String(parentDn || '').trim()
    if (parent) {
      assertDnUnderBase(parent, baseDn)
      searchBase = parent
    }
    const { rows, truncated } = await searchEntriesPaged(client, searchBase, filter, attrs, { limit })
    const users = rows.map((entry) => {
      const o = entryToObject(entry)
      const uac = uacFlags(o.userAccountControl)
      const lockoutFt = parseBigIntAttr(o.lockoutTime)
      const locked = Boolean(lockoutFt && lockoutFt !== 0n)
      const memberOf = Array.isArray(o.memberOf) ? o.memberOf : o.memberOf ? [o.memberOf] : []
      return {
        dn: o.dn,
        samAccountName: o.samAccountName || null,
        displayName: o.displayName || o.cn || null,
        givenName: o.givenName || null,
        sn: o.sn || null,
        mail: o.mail || null,
        upn: o.userPrincipalName || null,
        department: o.department || null,
        title: o.title || null,
        phone: o.telephoneNumber || null,
        mobile: o.mobile || null,
        ou: parentDnFromDn(o.dn),
        disabled: uac.disabled || false,
        locked,
        dontExpirePassword: uac.dontExpirePassword || false,
        passwordExpired: uac.passwordExpired || false,
        badPwdCount: o.badPwdCount ? Number(o.badPwdCount) : 0,
        lastLogon: latestLogonIso(o.lastLogon, o.lastLogonTimestamp),
        pwdLastSet: fileTimeToIso(o.pwdLastSet),
        whenCreated: o.whenCreated || null,
        whenChanged: o.whenChanged || null,
        groupCount: memberOf.length,
      }
    })
    return { users, total: users.length, truncated, baseDn, searchBase }
  })
}

export async function listAdGroups({ search = '', limit = 500 } = {}) {
  const safe = escapeLdapFilter(search.trim())
  const where = safe ? `(|(samAccountName=*${safe}*)(cn=*${safe}*)(description=*${safe}*))` : ''
  const filter = `(&(objectCategory=group)${where})`
  const attrs = ['samAccountName', 'cn', 'description', 'groupType', 'managedBy', 'whenCreated', 'whenChanged', 'member;range=0-0']
  return withAdClient(async (client, baseDn) => {
    const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, { limit })
    const groups = rows.map((entry) => {
      const o = entryToObject(entry)
      const gt = Number(o.groupType)
      const isSecurity = Number.isFinite(gt) ? Boolean(gt & 0x80000000) : null
      let scope = null
      if (Number.isFinite(gt)) {
        if (gt & 0x02) scope = 'Global'
        else if (gt & 0x04) scope = 'DomainLocal'
        else if (gt & 0x08) scope = 'Universal'
      }
      return {
        dn: o.dn,
        samAccountName: o.samAccountName || null,
        cn: o.cn || null,
        description: o.description || null,
        type: isSecurity === null ? null : (isSecurity ? 'Security' : 'Distribution'),
        scope,
        ou: parentDnFromDn(o.dn),
        managedBy: o.managedBy || null,
        whenCreated: o.whenCreated || null,
        whenChanged: o.whenChanged || null,
      }
    })
    return { groups, total: groups.length, truncated, baseDn }
  })
}

export async function listAdComputers({ search = '', limit = 500 } = {}) {
  const safe = escapeLdapFilter(search.trim())
  const where = safe ? `(|(samAccountName=*${safe}*)(cn=*${safe}*)(dNSHostName=*${safe}*)(operatingSystem=*${safe}*))` : ''
  const filter = `(&(objectCategory=computer)${where})`
  const attrs = [
    'samAccountName', 'cn', 'dNSHostName', 'operatingSystem', 'operatingSystemVersion',
    'userAccountControl', 'lastLogon', 'lastLogonTimestamp', 'whenCreated',
  ]
  return withAdClient(async (client, baseDn) => {
    const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, { limit })
    const computers = rows.map((entry) => {
      const o = entryToObject(entry)
      const uac = uacFlags(o.userAccountControl)
      return {
        dn: o.dn,
        name: (o.samAccountName || '').replace(/\$$/, '') || o.cn || null,
        dnsHostName: o.dNSHostName || null,
        os: o.operatingSystem || null,
        osVersion: o.operatingSystemVersion || null,
        disabled: uac.disabled || false,
        ou: parentDnFromDn(o.dn),
        lastLogon: latestLogonIso(o.lastLogon, o.lastLogonTimestamp),
        whenCreated: o.whenCreated || null,
      }
    })
    return { computers, total: computers.length, truncated, baseDn }
  })
}

export async function listAdOus({ limit = 2000 } = {}) {
  const filter = '(|(objectClass=organizationalUnit)(objectClass=container))'
  const attrs = ['ou', 'name', 'description', 'whenCreated']
  return withAdClient(async (client, baseDn) => {
    const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, { limit })
    const ous = rows.map((entry) => {
      const o = entryToObject(entry)
      return {
        dn: o.dn,
        name: o.ou || o.name || null,
        description: o.description || null,
        parent: parentDnFromDn(o.dn),
        whenCreated: o.whenCreated || null,
        depth: (o.dn.match(/,/g) || []).length,
        isContainer: /^CN=/i.test(o.dn),
      }
    })
    ous.sort((a, b) => a.dn.split(',').reverse().join(',').localeCompare(b.dn.split(',').reverse().join(',')))
    return { ous, total: ous.length, truncated, baseDn }
  })
}

// ─── Single user detail (AD Users & Computers–style fields) ─────────────────

function normalizeDnSegments(dn) {
  return String(dn || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',')
    .toLowerCase()
}

function assertDnUnderBase(dn, baseDn) {
  const d = normalizeDnSegments(dn)
  const b = normalizeDnSegments(baseDn)
  if (!d || !b) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  if (d === b) {
    throw Object.assign(new Error('Invalid user distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  if (!d.endsWith(',' + b)) {
    throw Object.assign(
      new Error('DN is outside the configured Active Directory naming context.'),
      { code: 'AD_DN_OUT_OF_BASE' },
    )
  }
}

/** First RDN value for display (e.g. CN=Domain Users → Domain Users). */
function groupLabelFromDn(groupDn) {
  const s = String(groupDn || '')
  const m = s.match(/^CN=([^,]+)/i)
  if (m) return m[1].replace(/\\,/g, ',').replace(/\\\\/g, '\\')
  const m2 = s.match(/^([^=]+)=([^,]+)/)
  return m2 ? m2[2].replace(/\\,/g, ',').replace(/\\\\/g, '\\') : s
}

function readObjectSidBuffer(entry) {
  for (const attr of entry?.attributes || []) {
    if (String(attr.type || '').toLowerCase() !== 'objectsid') continue
    const bufs = attr.buffers || []
    if (bufs?.[0]) return bufs[0]
  }
  return null
}

function parseWindowsSid(buf) {
  if (!buf || buf.length < 8) return null
  const revision = buf.readUInt8(0)
  const count = buf.readUInt8(1)
  const identifierAuthority = buf.readUIntBE(2, 6)
  const subAuthorities = []
  let o = 8
  for (let i = 0; i < count; i++) {
    if (o + 4 > buf.length) return null
    subAuthorities.push(buf.readUInt32LE(o))
    o += 4
  }
  return { revision, identifierAuthority, subAuthorities }
}

function encodeWindowsSid({ revision, identifierAuthority, subAuthorities }) {
  const count = subAuthorities.length
  const out = Buffer.alloc(8 + count * 4)
  out.writeUInt8(revision, 0)
  out.writeUInt8(count, 1)
  out.writeUIntBE(identifierAuthority, 2, 6)
  let o = 8
  for (const s of subAuthorities) {
    out.writeUInt32LE(s >>> 0, o)
    o += 4
  }
  return out
}

function buildPrimaryGroupSidBuffer(userSidBuf, primaryGroupRid) {
  const p = parseWindowsSid(userSidBuf)
  const rid = Number(primaryGroupRid)
  if (!p || p.subAuthorities.length < 2 || !Number.isFinite(rid)) return null
  const domainSubs = p.subAuthorities.slice(0, -1)
  return encodeWindowsSid({
    revision: p.revision,
    identifierAuthority: p.identifierAuthority,
    subAuthorities: [...domainSubs, rid >>> 0],
  })
}

function ldapBinarySidFilterEscape(buf) {
  let s = ''
  for (let i = 0; i < buf.length; i++) {
    s += '\\' + buf.subarray(i, i + 1).toString('hex')
  }
  return s
}

function accountExpiresIso(raw) {
  const n = parseBigIntAttr(raw)
  if (n == null || n === 0n || n === 9223372036854775807n) return null
  return fileTimeToIso(raw)
}

async function lookupEntityLabel(client, baseDn, entityDn) {
  if (!trim(entityDn)) return null
  try {
    assertDnUnderBase(entityDn, baseDn)
  } catch {
    return { dn: entityDn, displayName: groupLabelFromDn(entityDn) }
  }
  const rows = await searchEntries(client, entityDn, {
    scope: 'base',
    filter: '(objectClass=*)',
    attributes: ['displayName', 'cn', 'samAccountName'],
    paged: false,
    timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
  })
  if (!rows.length) return { dn: entityDn, displayName: groupLabelFromDn(entityDn) }
  const o = entryToObject(rows[0])
  return {
    dn: entityDn,
    displayName: o.displayName || o.cn || o.samAccountName || groupLabelFromDn(entityDn),
  }
}

async function resolvePrimaryGroupByToken(client, baseDn, primaryGroupId) {
  const token = Number(primaryGroupId)
  if (!Number.isFinite(token) || token < 0) return null
  const rows = await searchEntries(client, baseDn, {
    scope: 'sub',
    filter: `(&(objectCategory=group)(primaryGroupToken=${token}))`,
    attributes: ['cn', 'samAccountName'],
    paged: false,
    timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
  })
  if (!rows.length) return null
  const go = entryToObject(rows[0])
  return { dn: go.dn, cn: go.cn || null, samAccountName: go.samAccountName || null }
}

/** Prefer primaryGroupToken search; fall back to objectSid + RID when DC returns LDAP error 18 / filter quirks. */
async function resolvePrimaryGroupSmart(client, baseDn, primaryGroupId, userSearchEntry) {
  try {
    const byToken = await resolvePrimaryGroupByToken(client, baseDn, primaryGroupId)
    if (byToken) return byToken
  } catch (e) {
    console.warn('[ad] primaryGroupToken lookup failed:', e.message || e)
  }
  try {
    const sidBuf = readObjectSidBuffer(userSearchEntry)
    const rid = Number(primaryGroupId)
    const groupSidBuf = sidBuf && Number.isFinite(rid) ? buildPrimaryGroupSidBuffer(sidBuf, rid) : null
    if (!groupSidBuf) return null
    const esc = ldapBinarySidFilterEscape(groupSidBuf)
    const rows = await searchEntries(client, baseDn, {
      scope: 'sub',
      filter: `(objectSid=${esc})`,
      attributes: ['cn', 'samAccountName'],
      paged: false,
      timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
    })
    if (!rows.length) return null
    const go = entryToObject(rows[0])
    return { dn: go.dn, cn: go.cn || null, samAccountName: go.samAccountName || null }
  } catch (e2) {
    console.warn('[ad] primary group SID fallback failed:', e2.message || e2)
    return null
  }
}

/**
 * Full LDAP read for one user (base search). Caller must pass the object's DN.
 * @param {string} dnRaw
 */
export async function getAdUserDetail(dnRaw) {
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }

  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)

    const attrs = [
      'samAccountName',
      'userPrincipalName',
      'cn',
      'displayName',
      'givenName',
      'initials',
      'sn',
      'description',
      'mail',
      'telephoneNumber',
      'mobile',
      'homePhone',
      'ipPhone',
      'facsimileTelephoneNumber',
      'otherTelephone',
      'physicalDeliveryOfficeName',
      'title',
      'department',
      'company',
      'manager',
      'streetAddress',
      'l',
      'st',
      'postalCode',
      'c',
      'co',
      'countryCode',
      'profilePath',
      'scriptPath',
      'homeDirectory',
      'homeDrive',
      'userAccountControl',
      'accountExpires',
      'pwdLastSet',
      'lastLogon',
      'lastLogonTimestamp',
      'logonCount',
      'badPwdCount',
      'badPasswordTime',
      'lockoutTime',
      'whenCreated',
      'whenChanged',
      'memberOf',
      'primaryGroupID',
      'distinguishedName',
      'proxyAddresses',
      'objectSid',
    ]

    const rows = await searchEntries(client, dn, {
      scope: 'base',
      filter: '(objectClass=user)',
      attributes: attrs,
      paged: false,
      timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
    })

    if (!rows.length) {
      throw Object.assign(new Error('User not found or not a directory user object.'), {
        code: 'AD_USER_NOT_FOUND',
      })
    }

    const o = entryToObject(rows[0])
    const uac = uacFlags(o.userAccountControl)
    const lockoutFt = parseBigIntAttr(o.lockoutTime)
    const locked = Boolean(lockoutFt && lockoutFt !== 0n)

    const rawMemberOf = Array.isArray(o.memberOf) ? o.memberOf : o.memberOf ? [o.memberOf] : []
    const memberOf = rawMemberOf
      .map((gdn) => ({ dn: gdn, name: groupLabelFromDn(gdn) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

    const proxyAddresses = Array.isArray(o.proxyAddresses)
      ? o.proxyAddresses
      : o.proxyAddresses
        ? [o.proxyAddresses]
        : []

    let primaryGroup = null
    if (o.primaryGroupID != null) {
      primaryGroup = await resolvePrimaryGroupSmart(client, baseDn, o.primaryGroupID, rows[0])
    }

    let manager = null
    if (o.manager) {
      try {
        manager = await lookupEntityLabel(client, baseDn, o.manager)
      } catch (e) {
        console.warn('[ad] manager lookup failed:', e.message || e)
        manager = { dn: o.manager, displayName: groupLabelFromDn(o.manager) }
      }
    }

    const otherTel = Array.isArray(o.otherTelephone)
      ? o.otherTelephone
      : o.otherTelephone
        ? [o.otherTelephone]
        : []

    const resolvedDn = o.distinguishedName || dn
    const detail = {
      dn: resolvedDn,
      containerDn: parentDnFromDn(resolvedDn),
      general: {
        cn: o.cn || null,
        displayName: o.displayName || null,
        givenName: o.givenName || null,
        initials: o.initials || null,
        sn: o.sn || null,
        description: o.description || null,
        mail: o.mail || null,
        proxyAddresses,
        telephoneNumber: o.telephoneNumber || null,
        mobile: o.mobile || null,
        homePhone: o.homePhone || null,
        ipPhone: o.ipPhone || null,
        facsimileTelephoneNumber: o.facsimileTelephoneNumber || null,
        otherTelephone: otherTel,
        physicalDeliveryOfficeName: o.physicalDeliveryOfficeName || null,
      },
      address: {
        streetAddress: o.streetAddress || null,
        city: o.l || null,
        state: o.st || null,
        postalCode: o.postalCode || null,
        countryCode: o.countryCode || null,
        country: o.co || o.c || null,
      },
      organization: {
        title: o.title || null,
        department: o.department || null,
        company: o.company || null,
        manager,
      },
      account: {
        samAccountName: o.samAccountName || null,
        userPrincipalName: o.userPrincipalName || null,
        disabled: uac.disabled || false,
        locked,
        lockoutTime: fileTimeToIso(o.lockoutTime),
        dontExpirePassword: uac.dontExpirePassword || false,
        passwordExpired: uac.passwordExpired || false,
        passwordNotRequired: uac.passwordNotRequired || false,
        smartcardRequired: uac.smartcardRequired || false,
        trustedForDelegation: uac.trustedForDelegation || false,
        accountExpires: accountExpiresIso(o.accountExpires),
        pwdLastSet: fileTimeToIso(o.pwdLastSet),
        lastLogon: fileTimeToIso(o.lastLogon),
        lastLogonTimestamp: fileTimeToIso(o.lastLogonTimestamp),
        lastLogonEffective: latestLogonIso(o.lastLogon, o.lastLogonTimestamp),
        badPwdCount: o.badPwdCount != null ? Number(o.badPwdCount) : 0,
        badPasswordTime: fileTimeToIso(o.badPasswordTime),
        logonCount: o.logonCount != null ? Number(o.logonCount) : null,
        whenCreated: o.whenCreated || null,
        whenChanged: o.whenChanged || null,
        primaryGroupId: o.primaryGroupID != null ? Number(o.primaryGroupID) : null,
      },
      profile: {
        profilePath: o.profilePath || null,
        scriptPath: o.scriptPath || null,
        homeDirectory: o.homeDirectory || null,
        homeDrive: o.homeDrive || null,
      },
      memberOf,
      primaryGroup,
    }

    return { detail }
  })
}

/** Maps LDAP attribute names from API patch keys (camelCase UI fields). */
const AD_USER_PATCH_ATTRS = {
  displayName: 'displayName',
  givenName: 'givenName',
  sn: 'sn',
  initials: 'initials',
  description: 'description',
  mail: 'mail',
  telephoneNumber: 'telephoneNumber',
  mobile: 'mobile',
  physicalDeliveryOfficeName: 'physicalDeliveryOfficeName',
  title: 'title',
  department: 'department',
  company: 'company',
  manager: 'manager',
  streetAddress: 'streetAddress',
  city: 'l',
  state: 'st',
  postalCode: 'postalCode',
  countryCode: 'countryCode',
  country: 'co',
  c: 'c',
  profilePath: 'profilePath',
  scriptPath: 'scriptPath',
  homeDirectory: 'homeDirectory',
  homeDrive: 'homeDrive',
}

function encodeUnicodePwdForAd(password) {
  return Buffer.from(`"${String(password)}"`, 'utf16le')
}

function mapLdapWriteError(err) {
  const code = err?.code ?? err?.lde_code
  const msg = String(err?.message || err?.lde_message || err || '')
  if (code === 53 || code === '53' || /unwilling to perform/i.test(msg)) {
    return Object.assign(
      new Error(
        'The directory refused this operation (password changes usually require LDAP over TLS and Reset Password rights).',
      ),
      { code: 'AD_LDAP_UNWILLING', cause: err },
    )
  }
  if (code === 19 || code === '19' || /constraint violation/i.test(msg)) {
    return Object.assign(new Error(msg.trim() || 'LDAP constraint violation.'), {
      code: 'AD_LDAP_CONSTRAINT',
      cause: err,
    })
  }
  if (code === 50 || code === '50' || /insufficient access/i.test(msg)) {
    return Object.assign(new Error('Insufficient LDAP permissions for this operation.'), {
      code: 'AD_LDAP_INSUFFICIENT_ACCESS',
      cause: err,
    })
  }
  return enrichAdLdapError(err)
}

async function ldapModifyAd(client, dn, changes) {
  try {
    await ldapModify(client, dn, changes)
  } catch (e) {
    throw mapLdapWriteError(e)
  }
}

async function readUserAttrScalar(client, dn, attrName) {
  const rows = await searchEntries(client, dn, {
    scope: 'base',
    filter: '(objectClass=user)',
    attributes: [attrName],
    paged: false,
    timeLimit: 60,
  })
  if (!rows.length) {
    throw Object.assign(new Error('User not found.'), { code: 'AD_USER_NOT_FOUND' })
  }
  const o = entryToObject(rows[0])
  return o[attrName]
}

/**
 * Set AD account password (unicodePwd). Requires encrypted LDAP (LDAPS or StartTLS).
 */
export async function resetAdUserPassword({ dn: dnRaw, newPassword, mustChangeNextLogon = false }) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const pwd = String(newPassword ?? '')
  if (pwd.length < 1 || pwd.length > 127) {
    throw Object.assign(new Error('Password must be between 1 and 127 characters.'), {
      code: 'AD_PASSWORD_INVALID',
    })
  }
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)
    await ldapModifyAd(client, dn, {
      operation: 'replace',
      modification: { unicodePwd: encodeUnicodePwdForAd(pwd) },
    })
    if (mustChangeNextLogon) {
      await ldapModifyAd(client, dn, {
        operation: 'replace',
        modification: { pwdLastSet: '0' },
      })
    }
    return { ok: true }
  })
}

/** Partial attribute updates (allow-listed). Empty string removes optional attribute where supported. */
export async function modifyAdUserPatch({ dn: dnRaw, patch }) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  const p = patch && typeof patch === 'object' ? patch : {}
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)
    const changes = []
    for (const [key, rawVal] of Object.entries(p)) {
      const ldapAttr = AD_USER_PATCH_ATTRS[key]
      if (!ldapAttr || rawVal === undefined) continue
      if (ldapAttr === 'manager') {
        const v = String(rawVal ?? '').trim()
        if (!v) {
          changes.push({ operation: 'delete', modification: { manager: [] } })
        } else {
          assertDnUnderBase(v, baseDn)
          changes.push({ operation: 'replace', modification: { manager: v } })
        }
        continue
      }
      const v = rawVal === null ? '' : String(rawVal).trim()
      if (v === '') {
        changes.push({ operation: 'delete', modification: { [ldapAttr]: [] } })
      } else {
        changes.push({ operation: 'replace', modification: { [ldapAttr]: v } })
      }
    }
    if (!changes.length) {
      throw Object.assign(new Error('No modifiable fields supplied.'), { code: 'AD_PATCH_EMPTY' })
    }
    await ldapModifyAd(client, dn, changes)
    return { ok: true }
  })
}

// ─── Group / Computer / OU detail + modify helpers ──────────────────────────

async function lookupEntryByDn(client, baseDn, entryDn, attrs) {
  if (!trim(entryDn)) return null
  try {
    assertDnUnderBase(entryDn, baseDn)
  } catch {
    return null
  }
  const rows = await searchEntries(client, entryDn, {
    scope: 'base',
    filter: '(objectClass=*)',
    attributes: attrs,
    paged: false,
    timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
  })
  if (!rows.length) return null
  return entryToObject(rows[0])
}

function decodeGroupType(gt) {
  const n = Number(gt)
  if (!Number.isFinite(n)) return { scope: null, type: null, raw: gt ?? null }
  let scope = null
  if (n & 0x02) scope = 'Global'
  else if (n & 0x04) scope = 'DomainLocal'
  else if (n & 0x08) scope = 'Universal'
  const isSecurity = Boolean(n & 0x80000000)
  return { scope, type: isSecurity ? 'Security' : 'Distribution', raw: n }
}

/**
 * Full group detail: members (with displayName + samAccountName) and managedBy.
 * Uses LDAP range retrieval to get all members regardless of MaxValRange.
 */
export async function getAdGroupDetail(dnRaw) {
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }

  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)

    const attrs = [
      'cn', 'samAccountName', 'description', 'displayName', 'mail', 'info',
      'groupType', 'managedBy', 'memberOf', 'whenCreated', 'whenChanged',
      'distinguishedName',
    ]
    const rows = await searchEntries(client, dn, {
      scope: 'base',
      filter: '(objectClass=group)',
      attributes: attrs,
      paged: false,
      timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
    })
    if (!rows.length) {
      throw Object.assign(new Error('Group not found.'), { code: 'AD_GROUP_NOT_FOUND' })
    }
    const o = entryToObject(rows[0])
    const memberDns = await readAllGroupMembers(client, baseDn, dn)

    const detail = {
      dn: o.distinguishedName || dn,
      containerDn: parentDnFromDn(o.distinguishedName || dn),
      general: {
        cn: o.cn || null,
        samAccountName: o.samAccountName || null,
        displayName: o.displayName || null,
        description: o.description || null,
        notes: o.info || null,
        mail: o.mail || null,
        ...decodeGroupType(o.groupType),
      },
      managedBy: o.managedBy
        ? await lookupEntityLabel(client, baseDn, o.managedBy)
        : null,
      memberOf: (Array.isArray(o.memberOf) ? o.memberOf : o.memberOf ? [o.memberOf] : [])
        .map((g) => ({ dn: g, name: groupLabelFromDn(g) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      members: memberDns,
      memberCount: memberDns.length,
      whenCreated: o.whenCreated || null,
      whenChanged: o.whenChanged || null,
    }
    return { detail }
  })
}

const GROUP_MEMBER_PAGE = 1500

async function readAllGroupMembers(client, baseDn, groupDn) {
  const collected = []
  let start = 0
  let done = false
  while (!done) {
    const end = start + GROUP_MEMBER_PAGE - 1
    const attrName = `member;range=${start}-${end}`
    const rows = await searchEntries(client, groupDn, {
      scope: 'base',
      filter: '(objectClass=group)',
      attributes: [attrName, 'member'],
      paged: false,
      timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
    })
    if (!rows.length) break
    let foundRange = null
    let foundValues = []
    for (const attr of rows[0].attributes || []) {
      const t = String(attr.type || '').toLowerCase()
      if (t === 'member' && !attr.values?.length) continue
      if (t.startsWith('member;range=')) {
        foundRange = t
        foundValues = attr.values || []
        break
      }
      if (t === 'member') {
        foundValues = attr.values || []
      }
    }
    if (!foundValues.length && !foundRange) {
      break
    }
    collected.push(...foundValues)
    if (!foundRange) break
    if (/;range=\d+-\*$/.test(foundRange)) {
      done = true
      break
    }
    const m = foundRange.match(/;range=\d+-(\d+)$/)
    if (!m) break
    const lastIndex = Number(m[1])
    if (!Number.isFinite(lastIndex)) break
    start = lastIndex + 1
    if (foundValues.length < GROUP_MEMBER_PAGE) {
      done = true
      break
    }
  }
  const labelLimit = Math.min(
    Math.max(parseInt(String(process.env.AD_GROUP_MEMBER_RESOLVE_LIMIT || '500'), 10) || 500, 50),
    5000,
  )
  const resolved = []
  for (let i = 0; i < collected.length; i++) {
    const mdn = collected[i]
    if (i >= labelLimit) {
      resolved.push({ dn: mdn, displayName: groupLabelFromDn(mdn) })
      continue
    }
    try {
      const m = await lookupEntryByDn(client, baseDn, mdn, ['displayName', 'cn', 'samAccountName', 'objectClass'])
      if (m) {
        const oc = Array.isArray(m.objectClass) ? m.objectClass : [m.objectClass].filter(Boolean)
        const kind = oc.map((c) => String(c).toLowerCase())
        let category = 'object'
        if (kind.includes('user')) category = 'user'
        else if (kind.includes('group')) category = 'group'
        else if (kind.includes('computer')) category = 'computer'
        resolved.push({
          dn: mdn,
          displayName: m.displayName || m.cn || m.samAccountName || groupLabelFromDn(mdn),
          samAccountName: m.samAccountName || null,
          category,
        })
      } else {
        resolved.push({ dn: mdn, displayName: groupLabelFromDn(mdn) })
      }
    } catch {
      resolved.push({ dn: mdn, displayName: groupLabelFromDn(mdn) })
    }
  }
  resolved.sort((a, b) =>
    String(a.displayName).localeCompare(String(b.displayName), undefined, { sensitivity: 'base' }),
  )
  return resolved
}

const AD_GROUP_PATCH_ATTRS = {
  description: 'description',
  notes: 'info',
  displayName: 'displayName',
  mail: 'mail',
}

/**
 * Create an AD group via LDAP add. groupCategory: 'security' | 'distribution',
 * groupScope: 'global' | 'domainLocal' | 'universal'.
 */
export async function createAdGroup({
  parentDn: parentRaw,
  cn: cnRaw,
  samAccountName,
  description,
  mail,
  groupCategory = 'security',
  groupScope = 'global',
}) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const parentDn = String(parentRaw || '').trim()
  const cnVal = String(cnRaw || '').trim()
  const sam = String(samAccountName || cnVal).trim()
  if (!parentDn || /\x00/.test(parentDn)) {
    throw Object.assign(new Error('Target OU/container DN is required.'), { code: 'AD_DN_INVALID' })
  }
  if (!cnVal) {
    throw Object.assign(new Error('Group name (CN) is required.'), { code: 'AD_BODY_INVALID' })
  }
  if (!sam) {
    throw Object.assign(new Error('samAccountName is required.'), { code: 'AD_BODY_INVALID' })
  }
  if (sam.length > 256) {
    throw Object.assign(new Error('samAccountName is too long.'), { code: 'AD_BODY_INVALID' })
  }

  const scopeBits = {
    global: 0x00000002,
    domainlocal: 0x00000004,
    universal: 0x00000008,
  }
  const scopeKey = String(groupScope || 'global').toLowerCase().replace(/[\s_-]/g, '')
  const scopeBit = scopeBits[scopeKey]
  if (!scopeBit) {
    throw Object.assign(new Error('groupScope must be global, domainLocal, or universal.'), {
      code: 'AD_BODY_INVALID',
    })
  }
  const isSecurity = String(groupCategory || 'security').toLowerCase() !== 'distribution'
  // groupType is a signed 32-bit; security flag is 0x80000000 which is negative as int32.
  // We send as int32 string (signed) so AD accepts it.
  const groupTypeNum = isSecurity ? scopeBit | 0x80000000 : scopeBit
  // Cast to signed 32-bit string
  const groupTypeStr = (groupTypeNum | 0).toString()

  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(parentDn, baseDn)
    const groupDn = `CN=${escapeDnRdnValue(cnVal)},${parentDn}`
    const entry = {
      objectClass: ['top', 'group'],
      cn: cnVal,
      samAccountName: sam,
      groupType: groupTypeStr,
    }
    if (description) entry.description = String(description).trim()
    if (mail) entry.mail = String(mail).trim()
    try {
      await new Promise((resolve, reject) => {
        client.add(groupDn, entry, (err) => (err ? reject(err) : resolve()))
      })
    } catch (e) {
      throw mapLdapWriteError(e)
    }
    return { ok: true, dn: groupDn }
  })
}

/**
 * Create an organizational unit via LDAP add.
 */
export async function createAdOu({
  parentDn: parentRaw,
  name,
  description,
  managedBy,
}) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const parentDn = String(parentRaw || '').trim()
  const ouName = String(name || '').trim()
  if (!parentDn || /\x00/.test(parentDn)) {
    throw Object.assign(new Error('Parent DN is required.'), { code: 'AD_DN_INVALID' })
  }
  if (!ouName) {
    throw Object.assign(new Error('OU name is required.'), { code: 'AD_BODY_INVALID' })
  }
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(parentDn, baseDn)
    const ouDn = `OU=${escapeDnRdnValue(ouName)},${parentDn}`
    const entry = {
      objectClass: ['top', 'organizationalUnit'],
      ou: ouName,
    }
    if (description) entry.description = String(description).trim()
    if (managedBy) {
      const m = String(managedBy).trim()
      assertDnUnderBase(m, baseDn)
      entry.managedBy = m
    }
    try {
      await new Promise((resolve, reject) => {
        client.add(ouDn, entry, (err) => (err ? reject(err) : resolve()))
      })
    } catch (e) {
      throw mapLdapWriteError(e)
    }
    return { ok: true, dn: ouDn }
  })
}

export async function modifyAdGroupPatch({ dn: dnRaw, patch }) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  const p = patch && typeof patch === 'object' ? patch : {}
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)
    const changes = []
    for (const [key, rawVal] of Object.entries(p)) {
      if (key === 'managedBy') {
        const v = String(rawVal ?? '').trim()
        if (!v) changes.push({ operation: 'delete', modification: { managedBy: [] } })
        else {
          assertDnUnderBase(v, baseDn)
          changes.push({ operation: 'replace', modification: { managedBy: v } })
        }
        continue
      }
      const ldapAttr = AD_GROUP_PATCH_ATTRS[key]
      if (!ldapAttr || rawVal === undefined) continue
      const v = rawVal === null ? '' : String(rawVal).trim()
      if (v === '') {
        changes.push({ operation: 'delete', modification: { [ldapAttr]: [] } })
      } else {
        changes.push({ operation: 'replace', modification: { [ldapAttr]: v } })
      }
    }
    if (!changes.length) {
      throw Object.assign(new Error('No modifiable fields supplied.'), { code: 'AD_PATCH_EMPTY' })
    }
    await ldapModifyAd(client, dn, changes)
    return { ok: true }
  })
}

function normalizeDnList(input) {
  let raw
  if (Array.isArray(input)) raw = input
  else if (typeof input === 'string') raw = input.split(/[\r\n]+/g)
  else raw = []
  return raw
    .map((s) => String(s ?? '').trim())
    .filter((s) => s && !/\x00/.test(s))
}

export async function addAdGroupMembers({ dn: groupDnRaw, members }) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const groupDn = String(groupDnRaw || '').trim()
  const list = normalizeDnList(members)
  if (!groupDn) {
    throw Object.assign(new Error('Group DN is required.'), { code: 'AD_DN_INVALID' })
  }
  if (!list.length) {
    throw Object.assign(new Error('Provide at least one member DN.'), { code: 'AD_GROUP_MEMBERS_EMPTY' })
  }
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(groupDn, baseDn)
    for (const m of list) assertDnUnderBase(m, baseDn)
    await ldapModifyAd(client, groupDn, {
      operation: 'add',
      modification: { member: list },
    })
    return { ok: true, added: list.length }
  })
}

export async function removeAdGroupMembers({ dn: groupDnRaw, members }) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const groupDn = String(groupDnRaw || '').trim()
  const list = normalizeDnList(members)
  if (!groupDn) {
    throw Object.assign(new Error('Group DN is required.'), { code: 'AD_DN_INVALID' })
  }
  if (!list.length) {
    throw Object.assign(new Error('Provide at least one member DN.'), { code: 'AD_GROUP_MEMBERS_EMPTY' })
  }
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(groupDn, baseDn)
    for (const m of list) assertDnUnderBase(m, baseDn)
    await ldapModifyAd(client, groupDn, {
      operation: 'delete',
      modification: { member: list },
    })
    return { ok: true, removed: list.length }
  })
}

/**
 * Full computer detail (account flags, OS, DNS, last logon, memberOf).
 */
export async function getAdComputerDetail(dnRaw) {
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)
    const attrs = [
      'cn', 'samAccountName', 'displayName', 'description', 'dNSHostName',
      'operatingSystem', 'operatingSystemVersion', 'operatingSystemServicePack',
      'userAccountControl', 'pwdLastSet', 'lastLogon', 'lastLogonTimestamp', 'logonCount',
      'whenCreated', 'whenChanged', 'memberOf', 'managedBy',
      'servicePrincipalName', 'location', 'distinguishedName',
    ]
    const rows = await searchEntries(client, dn, {
      scope: 'base',
      filter: '(objectClass=computer)',
      attributes: attrs,
      paged: false,
      timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
    })
    if (!rows.length) {
      throw Object.assign(new Error('Computer not found.'), { code: 'AD_COMPUTER_NOT_FOUND' })
    }
    const o = entryToObject(rows[0])
    const uac = uacFlags(o.userAccountControl)
    const memberOf = (Array.isArray(o.memberOf) ? o.memberOf : o.memberOf ? [o.memberOf] : [])
      .map((g) => ({ dn: g, name: groupLabelFromDn(g) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    const spns = Array.isArray(o.servicePrincipalName)
      ? o.servicePrincipalName
      : o.servicePrincipalName ? [o.servicePrincipalName] : []
    const detail = {
      dn: o.distinguishedName || dn,
      containerDn: parentDnFromDn(o.distinguishedName || dn),
      general: {
        name: (o.samAccountName || '').replace(/\$$/, '') || o.cn || null,
        cn: o.cn || null,
        displayName: o.displayName || null,
        description: o.description || null,
        dnsHostName: o.dNSHostName || null,
        os: o.operatingSystem || null,
        osVersion: o.operatingSystemVersion || null,
        osServicePack: o.operatingSystemServicePack || null,
        location: o.location || null,
      },
      account: {
        samAccountName: o.samAccountName || null,
        disabled: uac.disabled || false,
        trustedForDelegation: uac.trustedForDelegation || false,
        pwdLastSet: fileTimeToIso(o.pwdLastSet),
        lastLogon: fileTimeToIso(o.lastLogon),
        lastLogonTimestamp: fileTimeToIso(o.lastLogonTimestamp),
        logonCount: o.logonCount != null ? Number(o.logonCount) : null,
        whenCreated: o.whenCreated || null,
        whenChanged: o.whenChanged || null,
      },
      managedBy: o.managedBy ? await lookupEntityLabel(client, baseDn, o.managedBy) : null,
      memberOf,
      servicePrincipalNames: spns,
    }
    return { detail }
  })
}

const AD_COMPUTER_PATCH_ATTRS = {
  description: 'description',
  displayName: 'displayName',
  location: 'location',
}

export async function modifyAdComputerPatch({ dn: dnRaw, patch }) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  const p = patch && typeof patch === 'object' ? patch : {}
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)
    const changes = []
    for (const [key, rawVal] of Object.entries(p)) {
      if (key === 'managedBy') {
        const v = String(rawVal ?? '').trim()
        if (!v) changes.push({ operation: 'delete', modification: { managedBy: [] } })
        else {
          assertDnUnderBase(v, baseDn)
          changes.push({ operation: 'replace', modification: { managedBy: v } })
        }
        continue
      }
      const ldapAttr = AD_COMPUTER_PATCH_ATTRS[key]
      if (!ldapAttr || rawVal === undefined) continue
      const v = rawVal === null ? '' : String(rawVal).trim()
      if (v === '') {
        changes.push({ operation: 'delete', modification: { [ldapAttr]: [] } })
      } else {
        changes.push({ operation: 'replace', modification: { [ldapAttr]: v } })
      }
    }
    if (!changes.length) {
      throw Object.assign(new Error('No modifiable fields supplied.'), { code: 'AD_PATCH_EMPTY' })
    }
    await ldapModifyAd(client, dn, changes)
    return { ok: true }
  })
}

export async function setAdComputerAccountFlags({ dn: dnRaw, disabled }) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  if (typeof disabled !== 'boolean') {
    throw Object.assign(new Error('disabled (boolean) is required.'), { code: 'AD_ACCOUNT_ACTION_EMPTY' })
  }
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)
    let uac = Number(await readUserAttrScalar(client, dn, 'userAccountControl'))
    if (!Number.isFinite(uac)) uac = 0
    const UAC_DISABLED = 0x0002
    if (disabled) uac |= UAC_DISABLED
    else uac &= ~UAC_DISABLED
    await ldapModifyAd(client, dn, {
      operation: 'replace',
      modification: { userAccountControl: String(uac) },
    })
    return { ok: true }
  })
}

/**
 * OU / container detail: own attrs + direct child counts (users / groups / computers / sub-OUs).
 */
export async function getAdOuDetail(dnRaw) {
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)
    const attrs = [
      'ou', 'name', 'cn', 'description', 'street', 'l', 'st', 'postalCode', 'c',
      'managedBy', 'whenCreated', 'whenChanged', 'gPLink', 'distinguishedName',
    ]
    const rows = await searchEntries(client, dn, {
      scope: 'base',
      filter: '(|(objectClass=organizationalUnit)(objectClass=container))',
      attributes: attrs,
      paged: false,
      timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
    })
    if (!rows.length) {
      throw Object.assign(new Error('OU/container not found.'), { code: 'AD_OU_NOT_FOUND' })
    }
    const o = entryToObject(rows[0])

    const isContainer = /^CN=/i.test(dn)
    const childCount = async (filter) => {
      try {
        return await searchCount(client, dn, filter, { scope: 'one' })
      } catch (e) {
        console.warn('[ad] OU child count failed:', e.message || e)
        return null
      }
    }
    const [userCount, groupCount, computerCount, ouCount] = await Promise.all([
      childCount('(&(objectCategory=person)(objectClass=user))'),
      childCount('(objectCategory=group)'),
      childCount('(objectCategory=computer)'),
      childCount('(objectClass=organizationalUnit)'),
    ])

    const detail = {
      dn: o.distinguishedName || dn,
      containerDn: parentDnFromDn(o.distinguishedName || dn),
      isContainer,
      general: {
        name: o.ou || o.name || o.cn || null,
        description: o.description || null,
        street: o.street || null,
        city: o.l || null,
        state: o.st || null,
        postalCode: o.postalCode || null,
        country: o.c || null,
      },
      managedBy: o.managedBy ? await lookupEntityLabel(client, baseDn, o.managedBy) : null,
      counts: {
        users: userCount,
        groups: groupCount,
        computers: computerCount,
        organizationalUnits: ouCount,
      },
      gpoLinked: !!o.gPLink,
      whenCreated: o.whenCreated || null,
      whenChanged: o.whenChanged || null,
    }
    return { detail }
  })
}

const AD_OU_PATCH_ATTRS = {
  description: 'description',
  street: 'street',
  city: 'l',
  state: 'st',
  postalCode: 'postalCode',
  country: 'c',
}

export async function modifyAdOuPatch({ dn: dnRaw, patch }) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  if (/^CN=/i.test(dn)) {
    throw Object.assign(new Error('Built-in containers (CN=…) cannot be edited via this endpoint.'), {
      code: 'AD_OU_CONTAINER_READONLY',
    })
  }
  const p = patch && typeof patch === 'object' ? patch : {}
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)
    const changes = []
    for (const [key, rawVal] of Object.entries(p)) {
      if (key === 'managedBy') {
        const v = String(rawVal ?? '').trim()
        if (!v) changes.push({ operation: 'delete', modification: { managedBy: [] } })
        else {
          assertDnUnderBase(v, baseDn)
          changes.push({ operation: 'replace', modification: { managedBy: v } })
        }
        continue
      }
      const ldapAttr = AD_OU_PATCH_ATTRS[key]
      if (!ldapAttr || rawVal === undefined) continue
      const v = rawVal === null ? '' : String(rawVal).trim()
      if (v === '') {
        changes.push({ operation: 'delete', modification: { [ldapAttr]: [] } })
      } else {
        changes.push({ operation: 'replace', modification: { [ldapAttr]: v } })
      }
    }
    if (!changes.length) {
      throw Object.assign(new Error('No modifiable fields supplied.'), { code: 'AD_PATCH_EMPTY' })
    }
    await ldapModifyAd(client, dn, changes)
    return { ok: true }
  })
}

/**
 * Account-level LDAP writes: unlock, enable/disable, force password change, password-never-expires flag.
 * Combines all UAC mutations into a single read+write so disabled & dontExpirePassword can be toggled together.
 */
export async function setAdUserAccountFlags({
  dn: dnRaw,
  unlock,
  disabled,
  mustChangePassword,
  dontExpirePassword,
}) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const dn = String(dnRaw || '').trim()
  if (!dn || /\x00/.test(dn)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)
    const changes = []
    if (unlock === true) {
      changes.push({ operation: 'replace', modification: { lockoutTime: '0' } })
    }
    const uacChange = typeof disabled === 'boolean' || typeof dontExpirePassword === 'boolean'
    if (uacChange) {
      let uac = Number(await readUserAttrScalar(client, dn, 'userAccountControl'))
      if (!Number.isFinite(uac)) uac = 0
      const UAC_DISABLED = 0x0002
      const UAC_DONT_EXPIRE_PASSWORD = 0x10000
      if (typeof disabled === 'boolean') {
        if (disabled) uac |= UAC_DISABLED
        else uac &= ~UAC_DISABLED
      }
      if (typeof dontExpirePassword === 'boolean') {
        if (dontExpirePassword) uac |= UAC_DONT_EXPIRE_PASSWORD
        else uac &= ~UAC_DONT_EXPIRE_PASSWORD
      }
      changes.push({ operation: 'replace', modification: { userAccountControl: String(uac) } })
    }
    if (mustChangePassword === true) {
      changes.push({ operation: 'replace', modification: { pwdLastSet: '0' } })
    }
    if (!changes.length) {
      throw Object.assign(
        new Error('Specify unlock, disabled, mustChangePassword, and/or dontExpirePassword.'),
        { code: 'AD_ACCOUNT_ACTION_EMPTY' },
      )
    }
    await ldapModifyAd(client, dn, changes)
    return { ok: true }
  })
}

function escapeDnRdnValue(value) {
  let s = String(value ?? '').trim()
  s = s.replace(/[\\,+"<>;=]/g, (c) => `\\${c}`)
  if (s.startsWith('#')) s = '\\#' + s.slice(1)
  if (s.startsWith(' ')) s = '\\ ' + s.slice(1)
  if (s.endsWith(' ')) s = s.slice(0, -1) + '\\ '
  return s
}

/**
 * Move a user (or other object) to a different OU/container using LDAP modifyDN
 * with newSuperior. Keeps the original RDN intact.
 */
export async function moveAdUser({ dn: dnRaw, newParentDn: newParentRaw }) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const dn = String(dnRaw || '').trim()
  const newParent = String(newParentRaw || '').trim()
  if (!dn || /\x00/.test(dn) || !newParent || /\x00/.test(newParent)) {
    throw Object.assign(new Error('Invalid distinguished name.'), { code: 'AD_DN_INVALID' })
  }
  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(dn, baseDn)
    assertDnUnderBase(newParent, baseDn)
    const idx = dn.indexOf(',')
    if (idx < 0) {
      throw Object.assign(new Error('Source DN has no parent.'), { code: 'AD_DN_INVALID' })
    }
    const rdn = dn.slice(0, idx).trim()
    const currentParent = dn.slice(idx + 1).trim()
    if (normalizeDnSegments(currentParent) === normalizeDnSegments(newParent)) {
      throw Object.assign(new Error('Object is already in this OU/container.'), { code: 'AD_MOVE_NOOP' })
    }
    const newDn = `${rdn},${newParent}`
    try {
      await new Promise((resolve, reject) => {
        client.modifyDN(dn, newDn, (err) => (err ? reject(err) : resolve()))
      })
    } catch (e) {
      throw mapLdapWriteError(e)
    }
    return { ok: true, dn: newDn }
  })
}

/**
 * Create an AD user account (LDAP add). Optional password sets unicodePwd via modify,
 * then userAccountControl is flipped to enable the account (with optional dontExpirePassword).
 */
export async function createAdUser({
  parentDn: parentRaw,
  samAccountName,
  userPrincipalName,
  cn: cnRaw,
  displayName,
  givenName,
  sn,
  description,
  mail,
  password,
  dontExpirePassword = false,
  mustChangeNextLogon = false,
  enabled = true,
}) {
  if (!adLdapWritesEnabled()) {
    throw Object.assign(new Error('LDAP writes are disabled (AD_LDAP_WRITES=off).'), {
      code: 'AD_WRITES_DISABLED',
    })
  }
  const parentDn = String(parentRaw || '').trim()
  const sam = String(samAccountName || '').trim()
  const cnVal = String(cnRaw || displayName || sam || '').trim()
  if (!parentDn || /\x00/.test(parentDn)) {
    throw Object.assign(new Error('Target OU/container DN is required.'), { code: 'AD_DN_INVALID' })
  }
  if (!cnVal) {
    throw Object.assign(new Error('Common name (CN) is required.'), { code: 'AD_BODY_INVALID' })
  }
  if (!sam) {
    throw Object.assign(new Error('samAccountName is required.'), { code: 'AD_BODY_INVALID' })
  }
  if (sam.length > 20) {
    throw Object.assign(new Error('samAccountName must be 20 characters or fewer.'), {
      code: 'AD_BODY_INVALID',
    })
  }
  if (!/^[A-Za-z0-9._-]+$/.test(sam)) {
    throw Object.assign(
      new Error('samAccountName may only contain letters, digits, dot, underscore, and hyphen.'),
      { code: 'AD_BODY_INVALID' },
    )
  }
  if (userPrincipalName && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(userPrincipalName).trim())) {
    throw Object.assign(new Error('userPrincipalName must look like user@domain.tld.'), {
      code: 'AD_BODY_INVALID',
    })
  }
  if (password != null && password !== '') {
    const p = String(password)
    if (p.length < 1 || p.length > 127) {
      throw Object.assign(new Error('Password must be between 1 and 127 characters.'), {
        code: 'AD_PASSWORD_INVALID',
      })
    }
  }

  return withAdClient(async (client, baseDn) => {
    assertDnUnderBase(parentDn, baseDn)
    const userDn = `CN=${escapeDnRdnValue(cnVal)},${parentDn}`

    const UAC_DISABLED = 0x0002
    const UAC_NORMAL_ACCOUNT = 0x0200
    const UAC_PASSWD_NOTREQD = 0x0020
    const UAC_DONT_EXPIRE_PASSWORD = 0x10000

    const entry = {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      cn: cnVal,
      samAccountName: sam,
      userAccountControl: String(UAC_NORMAL_ACCOUNT | UAC_DISABLED | UAC_PASSWD_NOTREQD),
    }
    if (userPrincipalName) entry.userPrincipalName = String(userPrincipalName).trim()
    if (displayName) entry.displayName = String(displayName).trim()
    if (givenName) entry.givenName = String(givenName).trim()
    if (sn) entry.sn = String(sn).trim()
    if (description) entry.description = String(description).trim()
    if (mail) entry.mail = String(mail).trim()

    try {
      await new Promise((resolve, reject) => {
        client.add(userDn, entry, (err) => (err ? reject(err) : resolve()))
      })
    } catch (e) {
      throw mapLdapWriteError(e)
    }

    if (password) {
      await ldapModifyAd(client, userDn, {
        operation: 'replace',
        modification: { unicodePwd: encodeUnicodePwdForAd(password) },
      })
    }

    let uac = UAC_NORMAL_ACCOUNT
    if (!enabled || !password) uac |= UAC_DISABLED
    if (dontExpirePassword) uac |= UAC_DONT_EXPIRE_PASSWORD
    await ldapModifyAd(client, userDn, {
      operation: 'replace',
      modification: { userAccountControl: String(uac) },
    })

    if (mustChangeNextLogon && password) {
      await ldapModifyAd(client, userDn, {
        operation: 'replace',
        modification: { pwdLastSet: '0' },
      })
    }

    return { ok: true, dn: userDn }
  })
}

async function readDomainMaxPwdAgeTicks(client, baseDn) {
  let domainRows = await searchEntries(client, baseDn, {
    scope: 'base',
    filter: '(objectClass=domainDNS)',
    attributes: ['maxPwdAge'],
    paged: false,
  })
  if (!domainRows.length) {
    domainRows = await searchEntries(client, baseDn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['maxPwdAge'],
      paged: false,
    })
  }
  return domainRows.length > 0 ? parseMaxPwdAgeTicks(domainRows[0]) : null
}

/**
 * Directory KPIs for the AD dashboard.
 * @returns {Promise<object>}
 */
export async function fetchAdOverviewStats() {
  if (!adIntegrationConfigured()) {
    throw Object.assign(new Error('Active Directory is not configured on the server.'), {
      code: 'AD_NOT_CONFIGURED',
    })
  }
  if (!adCredentialsConfigured()) {
    throw Object.assign(
      new Error(
        'Set AD_SERVICE_USERNAME and AD_SERVICE_PASSWORD (or AD_BIND_DN / AD_BIND_PASSWORD) so Netpulse can query the domain.',
      ),
      { code: 'AD_CREDENTIALS_MISSING' },
    )
  }

  const url = getAdConnectionUrl()
  if (!url) {
    throw Object.assign(new Error('No LDAP URL — set AD_DOMAIN_CONTROLLER or AD_LDAP_URL.'), {
      code: 'AD_NO_URL',
    })
  }

  const { user, password } = bindIdentity()

  let client
  try {
    client = await createAdBoundClient(url, user, password)
  } catch (e) {
    // Auto-fallback (ManageEngine-style): if plain LDAP fails with Unavailable/Strong Auth,
    // try LDAPS on 636 against the same DC before giving up.
    const isPlain = /^ldap:\/\//i.test(url)
    const host = hostFromLdapUrl(url) || trim(process.env.AD_DOMAIN_CONTROLLER)
    const allowAutoLdaps = isPlain && host && shouldRetryPlainBindWithStartTls(e?.cause || e)
    if (!allowAutoLdaps) throw mapAdStatsFailure(e)
    const ldapsUrl = `ldaps://${host}:636`
    try {
      console.warn('[ad] %s failed (%s); falling back to %s', url, e.message, ldapsUrl)
      client = await createAdBoundClient(ldapsUrl, user, password)
    } catch (e2) {
      throw mapAdStatsFailure(e2)
    }
  }

  try {
    const baseDn = await resolveBaseDn(client)

    const maxPwdAgeTicks = await readDomainMaxPwdAgeTicks(client, baseDn)

    const F_USER = '(&(objectCategory=person)(objectClass=user))'
    const F_DISABLED =
      '(&(objectCategory=person)(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=2))'
    const F_LOCK_BAD =
      '(&(objectCategory=person)(objectClass=user)(|(lockoutTime>=1)(badPwdCount>=1)))'
    const F_SEC_GROUP =
      '(&(objectCategory=group)(groupType:1.2.840.113556.1.4.803:=2147483648))'
    const F_COMPUTER = '(objectCategory=computer)'

    const usersTotal = await searchCount(client, baseDn, F_USER)
    const usersDisabled = await searchCount(client, baseDn, F_DISABLED)
    const usersLockedOrBadPwd = await searchCount(client, baseDn, F_LOCK_BAD)
    const securityGroups = await searchCount(client, baseDn, F_SEC_GROUP)
    const computers = await searchCount(client, baseDn, F_COMPUTER)

    let passwordsExpiring30d = null
    if (maxPwdAgeTicks != null && maxPwdAgeTicks !== 0n) {
      const DAY = 10000000n * 86400n
      const now = nowFiletime()
      let expiring = 0
      const pageSize = Math.min(
        Math.max(parseInt(String(process.env.AD_STATS_PAGE_SIZE || '500'), 10) || 500, 50),
        2000,
      )
      const filterPwd =
        '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(userAccountControl:1.2.840.113556.1.4.803:=65536))(pwdLastSet>=1))'

      await new Promise((resolve, reject) => {
        client.search(
          baseDn,
          {
            scope: 'sub',
            filter: filterPwd,
            attributes: ['pwdLastSet'],
            timeLimit: parseInt(String(process.env.AD_SEARCH_TIME_LIMIT_SEC || '180'), 10) || 180,
            paged: { pageSize },
          },
          (err, res) => {
            if (err) return reject(err)
            res.on('searchEntry', (msg) => {
              const raw = firstAttrValue(msg, 'pwdLastSet')
              const pwdLastSet = parseBigIntAttr(raw)
              if (pwdLastSet == null || pwdLastSet === 0n) return
              const expiryFt = passwordExpiryFiletime(pwdLastSet, maxPwdAgeTicks)
              if (expiryFt == null) return
              const daysLeft = Math.floor(Number((expiryFt - now) / DAY))
              if (daysLeft > 0 && daysLeft <= 30) expiring++
            })
            res.on('error', reject)
            res.on('end', () => resolve())
            res.on('pageError', reject)
          },
        )
      })
      passwordsExpiring30d = expiring
    }

    return {
      usersTotal,
      usersDisabled,
      usersLockedOrBadPwd,
      securityGroups,
      computers,
      passwordsExpiring30d,
      baseDn,
      maxPasswordAgeDays:
        maxPwdAgeTicks != null && maxPwdAgeTicks !== 0n
          ? Number(-maxPwdAgeTicks / (10000000n * 86400n))
          : null,
    }
  } catch (e) {
    throw mapAdStatsFailure(e)
  } finally {
    await unbindQuiet(client)
  }
}

const AD_REPORT_IDS = new Set([
  'password_expiring',
  'password_expired',
  'disabled_users',
  'password_never_expires',
  'locked_users',
  'stale_logon',
  'last_logon',
  'recently_created_users',
  'inactive_computers',
])

function ldapGeneralizedTimeUtc(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.0Z`
}

/**
 * Pre-built LDAP reports (paged; capped by limit).
 * @param {string} reportIdRaw
 * @param {Record<string, string>} [query]
 */
export async function fetchAdReport(reportIdRaw, query = {}) {
  const reportId = String(reportIdRaw || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')

  if (!AD_REPORT_IDS.has(reportId)) {
    throw Object.assign(new Error('Unknown report ID.'), { code: 'AD_REPORT_UNKNOWN' })
  }

  const defaultDays =
    reportId === 'stale_logon' || reportId === 'inactive_computers'
      ? 90
      : reportId === 'recently_created_users'
        ? 30
        : 30
  const rawDays = query.days != null && String(query.days).trim() !== '' ? Number(query.days) : NaN
  const safeDays = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : defaultDays, 1), 365)

  const defaultLimit =
    reportId === 'password_expiring' || reportId === 'password_expired' || reportId === 'last_logon'
      ? 8000
      : 4000
  const rawLim = query.limit != null && String(query.limit).trim() !== '' ? Number(query.limit) : NaN
  const safeLimit = Math.min(
    Math.max(Number.isFinite(rawLim) ? rawLim : defaultLimit, 50),
    15000,
  )

  const DAY = 10000000n * 86400n

  return withAdClient(async (client, baseDn) => {
    const NOW = nowFiletime()
    /** @type {object} */
    const meta = { reportId, days: safeDays, limit: safeLimit }

    if (reportId === 'password_expiring' || reportId === 'password_expired') {
      const maxPwdAgeTicks = await readDomainMaxPwdAgeTicks(client, baseDn)
      meta.maxPasswordAgeDays =
        maxPwdAgeTicks != null && maxPwdAgeTicks !== 0n ? Number(-maxPwdAgeTicks / DAY) : null

      if (maxPwdAgeTicks == null || maxPwdAgeTicks === 0n) {
        return {
          columns: [
            { key: 'samAccountName', label: 'Logon name' },
            { key: 'displayName', label: 'Display name' },
            { key: 'mail', label: 'Mail' },
            { key: 'pwdLastSet', label: 'Password last set' },
            { key: 'passwordExpires', label: 'Expires (computed)' },
            { key: 'daysLeft', label: 'Days left' },
            { key: 'dn', label: 'DN' },
          ],
          rows: [],
          truncated: false,
          meta: {
            ...meta,
            note:
              'Domain password policy has no maximum password age — password expiry cannot be computed.',
          },
        }
      }

      const filterPwdExpiring =
        '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(userAccountControl:1.2.840.113556.1.4.803:=65536))(pwdLastSet>=1))'

      const filterPwdExpiredBase =
        '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(userAccountControl:1.2.840.113556.1.4.803:=65536)))'

      const attrs = ['samAccountName', 'displayName', 'mail', 'pwdLastSet', 'distinguishedName']
      const filter = reportId === 'password_expiring' ? filterPwdExpiring : filterPwdExpiredBase
      const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, {
        limit: safeLimit,
      })

      const out = []
      for (const entry of rows) {
        const o = entryToObject(entry)
        const pwdLastSet = parseBigIntAttr(o.pwdLastSet)
        const dn = o.distinguishedName || o.dn || ''

        if (reportId === 'password_expired') {
          if (pwdLastSet === 0n) {
            out.push({
              samAccountName: o.samAccountName || '',
              displayName: o.displayName || o.cn || '',
              mail: o.mail || '',
              pwdLastSet: fileTimeToIso(o.pwdLastSet),
              passwordExpires: '',
              daysLeft: '',
              status: 'Must change password at next logon',
              dn,
            })
            continue
          }
        } else if (pwdLastSet == null || pwdLastSet === 0n) {
          continue
        }

        const expiryFt = passwordExpiryFiletime(pwdLastSet, maxPwdAgeTicks)
        if (expiryFt == null) continue
        const daysLeft = Math.floor(Number((expiryFt - NOW) / DAY))

        if (reportId === 'password_expiring') {
          if (daysLeft > 0 && daysLeft <= safeDays) {
            out.push({
              samAccountName: o.samAccountName || '',
              displayName: o.displayName || o.cn || '',
              mail: o.mail || '',
              pwdLastSet: fileTimeToIso(o.pwdLastSet),
              passwordExpires: fileTimeToIso(expiryFt),
              daysLeft,
              dn,
            })
          }
        } else if (daysLeft <= 0) {
          out.push({
            samAccountName: o.samAccountName || '',
            displayName: o.displayName || o.cn || '',
            mail: o.mail || '',
            pwdLastSet: fileTimeToIso(o.pwdLastSet),
            passwordExpires: fileTimeToIso(expiryFt),
            daysLeft,
            status: 'Password expired',
            dn,
          })
        }
      }

      const columns =
        reportId === 'password_expiring'
          ? [
              { key: 'samAccountName', label: 'Logon name' },
              { key: 'displayName', label: 'Display name' },
              { key: 'mail', label: 'Mail' },
              { key: 'pwdLastSet', label: 'Password last set' },
              { key: 'passwordExpires', label: 'Expires (computed)' },
              { key: 'daysLeft', label: 'Days left' },
              { key: 'dn', label: 'DN' },
            ]
          : [
              { key: 'samAccountName', label: 'Logon name' },
              { key: 'displayName', label: 'Display name' },
              { key: 'mail', label: 'Mail' },
              { key: 'pwdLastSet', label: 'Password last set' },
              { key: 'passwordExpires', label: 'Expires (computed)' },
              { key: 'daysLeft', label: 'Days overdue' },
              { key: 'status', label: 'Status' },
              { key: 'dn', label: 'DN' },
            ]

      return { columns, rows: out, truncated, meta }
    }

    if (reportId === 'disabled_users') {
      const filter =
        '(&(objectCategory=person)(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=2))'
      const attrs = ['samAccountName', 'displayName', 'mail', 'whenCreated', 'whenChanged', 'distinguishedName']
      const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, {
        limit: safeLimit,
      })
      const out = rows.map((entry) => {
        const o = entryToObject(entry)
        return {
          samAccountName: o.samAccountName || '',
          displayName: o.displayName || o.cn || '',
          mail: o.mail || '',
          whenCreated: o.whenCreated || '',
          whenChanged: o.whenChanged || '',
          dn: o.distinguishedName || o.dn || '',
        }
      })
      return {
        columns: [
          { key: 'samAccountName', label: 'Logon name' },
          { key: 'displayName', label: 'Display name' },
          { key: 'mail', label: 'Mail' },
          { key: 'whenCreated', label: 'Created' },
          { key: 'whenChanged', label: 'Modified' },
          { key: 'dn', label: 'DN' },
        ],
        rows: out,
        truncated,
        meta,
      }
    }

    if (reportId === 'password_never_expires') {
      const filter =
        '(&(objectCategory=person)(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=65536))'
      const attrs = ['samAccountName', 'displayName', 'mail', 'whenCreated', 'distinguishedName']
      const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, {
        limit: safeLimit,
      })
      const out = rows.map((entry) => {
        const o = entryToObject(entry)
        return {
          samAccountName: o.samAccountName || '',
          displayName: o.displayName || o.cn || '',
          mail: o.mail || '',
          whenCreated: o.whenCreated || '',
          dn: o.distinguishedName || o.dn || '',
        }
      })
      return {
        columns: [
          { key: 'samAccountName', label: 'Logon name' },
          { key: 'displayName', label: 'Display name' },
          { key: 'mail', label: 'Mail' },
          { key: 'whenCreated', label: 'Created' },
          { key: 'dn', label: 'DN' },
        ],
        rows: out,
        truncated,
        meta,
      }
    }

    if (reportId === 'locked_users') {
      const filter =
        '(&(objectCategory=person)(objectClass=user)(lockoutTime>=1))'
      const attrs = ['samAccountName', 'displayName', 'mail', 'lockoutTime', 'badPwdCount', 'distinguishedName']
      const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, {
        limit: safeLimit,
      })
      const out = rows.map((entry) => {
        const o = entryToObject(entry)
        return {
          samAccountName: o.samAccountName || '',
          displayName: o.displayName || o.cn || '',
          mail: o.mail || '',
          lockoutTime: fileTimeToIso(o.lockoutTime),
          badPwdCount: o.badPwdCount != null ? String(o.badPwdCount) : '',
          dn: o.distinguishedName || o.dn || '',
        }
      })
      return {
        columns: [
          { key: 'samAccountName', label: 'Logon name' },
          { key: 'displayName', label: 'Display name' },
          { key: 'mail', label: 'Mail' },
          { key: 'lockoutTime', label: 'Lockout time' },
          { key: 'badPwdCount', label: 'Bad pwd count' },
          { key: 'dn', label: 'DN' },
        ],
        rows: out,
        truncated,
        meta,
      }
    }

    if (reportId === 'stale_logon') {
      const filter =
        '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))'
      const attrs = [
        'samAccountName',
        'displayName',
        'mail',
        'lastLogon',
        'lastLogonTimestamp',
        'whenCreated',
        'distinguishedName',
      ]
      const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, {
        limit: safeLimit,
      })
      const cutoffFt = NOW - BigInt(safeDays) * DAY
      const out = []
      for (const entry of rows) {
        const o = entryToObject(entry)
        const ft = latestLogonFiletime(o.lastLogon, o.lastLogonTimestamp)
        if (ft != null && ft >= cutoffFt) continue
        out.push({
          samAccountName: o.samAccountName || '',
          displayName: o.displayName || o.cn || '',
          mail: o.mail || '',
          lastLogon: latestLogonIso(o.lastLogon, o.lastLogonTimestamp) || '',
          whenCreated: o.whenCreated || '',
          dn: o.distinguishedName || o.dn || '',
        })
      }
      meta.note =
        'Uses max(lastLogon on this DC, lastLogonTimestamp). Accounts with no successful logon appear as blank.'
      return {
        columns: [
          { key: 'samAccountName', label: 'Logon name' },
          { key: 'displayName', label: 'Display name' },
          { key: 'mail', label: 'Mail' },
          { key: 'lastLogon', label: 'Last logon (best)' },
          { key: 'whenCreated', label: 'Created' },
          { key: 'dn', label: 'DN' },
        ],
        rows: out,
        truncated,
        meta,
      }
    }

    if (reportId === 'last_logon') {
      const filter = '(&(objectCategory=person)(objectClass=user))'
      const attrs = [
        'samAccountName',
        'displayName',
        'mail',
        'userAccountControl',
        'lastLogon',
        'lastLogonTimestamp',
        'whenCreated',
        'distinguishedName',
      ]
      const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, {
        limit: safeLimit,
      })
      const out = rows.map((entry) => {
        const o = entryToObject(entry)
        const uac = uacFlags(o.userAccountControl)
        const effective = latestLogonIso(o.lastLogon, o.lastLogonTimestamp) || ''
        return {
          samAccountName: o.samAccountName || '',
          displayName: o.displayName || o.cn || '',
          mail: o.mail || '',
          disabled: uac.disabled ? 'Yes' : 'No',
          lastLogonEffective: effective,
          lastLogonDc: fileTimeToIso(o.lastLogon) || '',
          lastLogonTimestamp: fileTimeToIso(o.lastLogonTimestamp) || '',
          whenCreated: o.whenCreated || '',
          dn: o.distinguishedName || o.dn || '',
        }
      })
      out.sort((a, b) => {
        if (!a.lastLogonEffective && !b.lastLogonEffective) {
          return String(a.samAccountName || '').localeCompare(String(b.samAccountName || ''))
        }
        if (!a.lastLogonEffective) return 1
        if (!b.lastLogonEffective) return -1
        return String(b.lastLogonEffective).localeCompare(String(a.lastLogonEffective))
      })
      meta.note =
        'Effective column is max(lastLogon from this DC, replicated lastLogonTimestamp). Never-logged-on accounts show blank; DC vs timestamp columns help troubleshoot.'
      return {
        columns: [
          { key: 'samAccountName', label: 'Logon name' },
          { key: 'displayName', label: 'Display name' },
          { key: 'mail', label: 'Mail' },
          { key: 'disabled', label: 'Disabled' },
          { key: 'lastLogonEffective', label: 'Last logon (effective)' },
          { key: 'lastLogonDc', label: 'Last logon (this DC)' },
          { key: 'lastLogonTimestamp', label: 'Last logon timestamp' },
          { key: 'whenCreated', label: 'Created' },
          { key: 'dn', label: 'DN' },
        ],
        rows: out,
        truncated,
        meta,
      }
    }

    if (reportId === 'recently_created_users') {
      const cut = new Date(Date.now() - safeDays * 86400000)
      const gt = ldapGeneralizedTimeUtc(cut)
      const filter = `(&(objectCategory=person)(objectClass=user)(whenCreated>=${gt}))`
      const attrs = ['samAccountName', 'displayName', 'mail', 'whenCreated', 'distinguishedName']
      const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, {
        limit: safeLimit,
      })
      const out = rows.map((entry) => {
        const o = entryToObject(entry)
        return {
          samAccountName: o.samAccountName || '',
          displayName: o.displayName || o.cn || '',
          mail: o.mail || '',
          whenCreated: o.whenCreated || '',
          dn: o.distinguishedName || o.dn || '',
        }
      })
      return {
        columns: [
          { key: 'samAccountName', label: 'Logon name' },
          { key: 'displayName', label: 'Display name' },
          { key: 'mail', label: 'Mail' },
          { key: 'whenCreated', label: 'Created' },
          { key: 'dn', label: 'DN' },
        ],
        rows: out,
        truncated,
        meta,
      }
    }

    if (reportId === 'inactive_computers') {
      const filter =
        '(&(objectCategory=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))'
      const attrs = [
        'samAccountName',
        'cn',
        'dNSHostName',
        'operatingSystem',
        'lastLogon',
        'lastLogonTimestamp',
        'whenCreated',
        'distinguishedName',
      ]
      const { rows, truncated } = await searchEntriesPaged(client, baseDn, filter, attrs, {
        limit: safeLimit,
      })
      const cutoffFt = NOW - BigInt(safeDays) * DAY
      const out = []
      for (const entry of rows) {
        const o = entryToObject(entry)
        const ft = latestLogonFiletime(o.lastLogon, o.lastLogonTimestamp)
        if (ft != null && ft >= cutoffFt) continue
        const name = (o.samAccountName || '').replace(/\$$/, '') || o.cn || ''
        out.push({
          name,
          dnsHostName: o.dNSHostName || '',
          operatingSystem: o.operatingSystem || '',
          lastLogon: latestLogonIso(o.lastLogon, o.lastLogonTimestamp) || '',
          whenCreated: o.whenCreated || '',
          dn: o.distinguishedName || o.dn || '',
        })
      }
      meta.note =
        'Enabled computer accounts with no logon in the window (same last-logon merge as user lists).'
      return {
        columns: [
          { key: 'name', label: 'Computer name' },
          { key: 'dnsHostName', label: 'DNS hostname' },
          { key: 'operatingSystem', label: 'Operating system' },
          { key: 'lastLogon', label: 'Last logon (best)' },
          { key: 'whenCreated', label: 'Created' },
          { key: 'dn', label: 'DN' },
        ],
        rows: out,
        truncated,
        meta,
      }
    }

    throw Object.assign(new Error('Report handler missing.'), { code: 'AD_REPORT_INTERNAL' })
  })
}

// ─── Connectivity probe (Test connection button) ─────────────────────────────

function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = new net.Socket()
    let settled = false
    const finish = (ok, err) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolve({ ok, ms: Date.now() - started, error: err ? String(err.message || err) : null })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false, new Error('TCP timeout')))
    socket.once('error', (err) => finish(false, err))
    try {
      socket.connect(port, host)
    } catch (err) {
      finish(false, err)
    }
  })
}

function tlsProbe(host, port, servername, rejectUnauthorized, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const finish = (ok, extra, err) => {
      if (settled) return
      settled = true
      resolve({
        ok,
        ms: Date.now() - started,
        error: err ? String(err.message || err) : null,
        ...extra,
      })
    }
    let sock
    try {
      const baseTls = tlsOpts()
      sock = tls.connect({
        host,
        port,
        servername: servername || host,
        rejectUnauthorized:
          rejectUnauthorized === false ? false : baseTls.rejectUnauthorized !== false,
        timeout: timeoutMs,
        ...(baseTls.minVersion ? { minVersion: baseTls.minVersion } : {}),
        ...(baseTls.maxVersion ? { maxVersion: baseTls.maxVersion } : {}),
        ...(baseTls.ciphers ? { ciphers: baseTls.ciphers } : {}),
      })
    } catch (err) {
      return finish(false, {}, err)
    }
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate(false) || {}
      const subject = cert.subject?.CN || null
      const issuer = cert.issuer?.CN || null
      const validTo = cert.valid_to || null
      try { sock.end() } catch {}
      finish(true, { cert: { subject, issuer, validTo, authorized: sock.authorized } })
    })
    sock.once('error', (err) => {
      try { sock.destroy() } catch {}
      finish(false, {}, err)
    })
    sock.once('timeout', () => {
      try { sock.destroy() } catch {}
      finish(false, {}, new Error('TLS timeout'))
    })
  })
}

/**
 * Turn UI username into an LDAP bind name. AD accepts DN, UPN (user@fqdn), or DOMAIN\sAMAccountName.
 * Plain samAccountName becomes sam@AD_DOMAIN when the DNS domain is configured.
 */
function resolveUserBindPrincipal(rawUsername) {
  const u = trim(rawUsername)
  if (!u) return ''
  const head = u.split(',')[0]?.trim() || ''
  if (/^(CN|OU|DC)=/i.test(head)) return u
  if (u.includes('@')) return u
  if (/\\/.test(u)) return u
  const domainFqdn = trim(process.env.AD_DOMAIN_FQDN || process.env.AD_DOMAIN)
  if (domainFqdn) return `${u}@${domainFqdn}`
  return u
}

function mapUserBindTestFailure(err) {
  const raw = err?.cause || err
  const msg = String(raw.message || raw.lde_message || err?.message || '')
  if (/invalid credentials|InvalidCredentials|LDAP_INVALID_CREDENTIALS|\b49\b|\b52e\b|775/i.test(msg)) {
    return Object.assign(
      new Error(
        'Active Directory rejected this sign-in (wrong password, unknown user, locked/disabled account, or authentication policy).',
      ),
      { code: 'AD_USER_BIND_REJECTED', cause: err },
    )
  }
  if (err?.code === 'AD_USER_BIND_REJECTED') return err
  return mapAdStatsFailure(err)
}

/**
 * LDAP bind using end-user credentials against the configured DC (same TLS/port rules as the service account).
 * Does not persist the password; use for admin verification only.
 */
export async function testAdUserBindCredentials(username, password) {
  if (!adIntegrationConfigured()) {
    throw Object.assign(new Error('Active Directory is not configured on the server.'), { code: 'AD_NOT_CONFIGURED' })
  }
  const url = getAdConnectionUrl()
  if (!url) throw Object.assign(new Error('No LDAP URL configured.'), { code: 'AD_NO_URL' })

  const userInput = trim(username)
  const pass = password != null ? String(password) : ''
  if (!userInput) {
    throw Object.assign(new Error('Username is required.'), { code: 'AD_TEST_BIND_INPUT' })
  }
  if (!pass) {
    throw Object.assign(new Error('Password is required.'), { code: 'AD_TEST_BIND_INPUT' })
  }

  const principal = resolveUserBindPrincipal(userInput)
  let client
  try {
    try {
      client = await createAdBoundClient(url, principal, pass)
    } catch (e) {
      const isPlain = /^ldap:\/\//i.test(url)
      const host = hostFromLdapUrl(url) || trim(process.env.AD_DOMAIN_CONTROLLER)
      if (isPlain && host && shouldRetryPlainBindWithStartTls(e?.cause || e)) {
        client = await createAdBoundClient(`ldaps://${host}:636`, principal, pass)
      } else {
        throw mapUserBindTestFailure(e)
      }
    }
  } catch (e) {
    throw mapUserBindTestFailure(e)
  } finally {
    await unbindQuiet(client)
  }

  return { ok: true, bindPrincipal: principal }
}

async function ldapBindProbe(url, user, password, { withStartTls = false } = {}) {
  const started = Date.now()
  const tlsOptions = clientTlsOptions(url)
  const client = makeLdapClient({
    url,
    timeout: 8000,
    connectTimeout: 6000,
    tlsOptions,
  })
  try {
    if (withStartTls) await ldapStartTls(client, url)
    await ldapBind(client, user, password)
    return { ok: true, ms: Date.now() - started, error: null }
  } catch (err) {
    const code = err.code ?? err.lde_code ?? null
    return {
      ok: false,
      ms: Date.now() - started,
      error: String(err.message || err.lde_message || err),
      ldapCode: code,
    }
  } finally {
    await unbindQuiet(client)
  }
}

/**
 * Step-by-step AD connectivity check — DNS, TCP 389/636, plain bind, StartTLS, LDAPS.
 * Same flow ManageEngine ADManager runs in "Test Connection". Returns a structured report.
 */
export async function probeAdConnectivity() {
  const steps = []
  const host = trim(
    process.env.AD_DOMAIN_CONTROLLER || process.env.AD_DC_HOST || process.env.AD_WRITABLE_DC,
  )
  const { user, password } = bindIdentity()
  const portPlainEnv = parseInt(String(process.env.AD_LDAP_PORT || ''), 10)
  const portPlain = Number.isFinite(portPlainEnv) && portPlainEnv > 0 && portPlainEnv !== 636 ? portPlainEnv : 389
  const portLdaps = 636

  if (!host) {
    return {
      ok: false,
      host: null,
      summary: 'AD_DOMAIN_CONTROLLER is not set.',
      steps: [],
    }
  }

  // 1. DNS
  let addresses = []
  let dnsErr = null
  try {
    const res = await dns.lookup(host, { all: true })
    addresses = res.map((r) => r.address)
  } catch (e) {
    dnsErr = e.message || String(e)
  }
  steps.push({
    id: 'dns',
    label: `DNS resolves ${host}`,
    ok: !dnsErr && addresses.length > 0,
    detail: dnsErr || (addresses.length ? `→ ${addresses.join(', ')}` : 'no addresses'),
  })

  // 2. TCP 389
  const tcp389 = await tcpProbe(host, portPlain)
  steps.push({
    id: 'tcp389',
    label: `TCP connect ${host}:${portPlain}`,
    ok: tcp389.ok,
    detail: tcp389.ok ? `${tcp389.ms} ms` : tcp389.error || 'failed',
  })

  // 3. TCP 636
  const tcp636 = await tcpProbe(host, portLdaps)
  steps.push({
    id: 'tcp636',
    label: `TCP connect ${host}:${portLdaps}`,
    ok: tcp636.ok,
    detail: tcp636.ok ? `${tcp636.ms} ms` : tcp636.error || 'failed',
  })

  // 4. TLS handshake on 636 (informational)
  if (tcp636.ok) {
    const rejectUnauthorized = !tlsOpts().hasOwnProperty('rejectUnauthorized') || tlsOpts().rejectUnauthorized !== false
    const tls636 = await tlsProbe(host, portLdaps, host, rejectUnauthorized)
    steps.push({
      id: 'tls636',
      label: `TLS handshake on ${portLdaps}`,
      ok: tls636.ok,
      detail: tls636.ok
        ? `cert CN=${tls636.cert?.subject || '?'}, issuer=${tls636.cert?.issuer || '?'}${tls636.cert?.authorized === false ? ' (untrusted — needs CA or AD_TLS_INSECURE=1)' : ''}`
        : tls636.error || 'failed',
    })
  }

  if (!user || !password) {
    steps.push({
      id: 'bind',
      label: 'LDAP bind',
      ok: false,
      detail: 'AD_SERVICE_USERNAME / AD_SERVICE_PASSWORD missing — skipped.',
    })
    return summarize(host, steps)
  }

  // 5. Plain LDAP bind
  if (tcp389.ok) {
    const plain = await ldapBindProbe(`ldap://${host}:${portPlain}`, user, password)
    steps.push({
      id: 'bindPlain',
      label: `LDAP bind on ${portPlain} (no TLS)`,
      ok: plain.ok,
      detail: plain.ok
        ? `${plain.ms} ms`
        : `${plain.error}${plain.ldapCode != null ? ` (code ${plain.ldapCode})` : ''}`,
    })
  }

  // 6. StartTLS bind
  if (tcp389.ok) {
    const starttls = await ldapBindProbe(`ldap://${host}:${portPlain}`, user, password, { withStartTls: true })
    steps.push({
      id: 'bindStartTls',
      label: `LDAP + StartTLS bind on ${portPlain}`,
      ok: starttls.ok,
      detail: starttls.ok
        ? `${starttls.ms} ms`
        : `${starttls.error}${starttls.ldapCode != null ? ` (code ${starttls.ldapCode})` : ''}`,
    })
  }

  // 7. LDAPS bind
  if (tcp636.ok) {
    const ldaps = await ldapBindProbe(`ldaps://${host}:${portLdaps}`, user, password)
    steps.push({
      id: 'bindLdaps',
      label: `LDAPS bind on ${portLdaps}`,
      ok: ldaps.ok,
      detail: ldaps.ok
        ? `${ldaps.ms} ms`
        : `${ldaps.error}${ldaps.ldapCode != null ? ` (code ${ldaps.ldapCode})` : ''}`,
    })
  }

  return summarize(host, steps)
}

function summarize(host, steps) {
  const ok = steps.every((s) => s.ok)
  const firstBindOk = steps.find((s) => /^bind/.test(s.id) && s.ok)
  let summary = ''
  if (firstBindOk) {
    summary = `Directory bind works via ${firstBindOk.label}. ${ok ? 'All checks passed.' : 'Some channels failed — see steps.'}`
  } else if (steps.find((s) => s.id === 'dns' && !s.ok)) {
    summary = `DNS resolution failed — fix DNS for ${host} on this server (hosts file, DNS forwarder, or use the DC IP).`
  } else if (steps.find((s) => /^tcp/.test(s.id) && s.ok)) {
    summary = `TCP reaches the DC but every bind attempt failed. Likely: wrong credentials, account locked, or LDAP signing/channel-binding policy. Try a different service account or use LDAPS.`
  } else {
    summary = `Cannot reach ${host} on LDAP 389 or LDAPS 636 from this server. Check firewall, routing, and VPN.`
  }
  return { ok, host, summary, steps }
}

/**
 * LDAP bind using an interactive user's identity (UPN user@domain, DOMAIN\samAccount, or DN).
 * Used when a portal User row has authKind "ad": password is verified against the directory, not Mongo.
 *
 * @param {string} bindIdentity
 * @param {string} password
 * @returns {Promise<boolean>} true when bind succeeds
 */
export async function verifyAdPortalPassword(bindIdentity, password) {
  const id = trim(bindIdentity)
  const pwd = typeof password === 'string' ? password : ''
  if (!id || !pwd) return false

  if (!adIntegrationConfigured()) {
    throw Object.assign(
      new Error(
        'Active Directory sign-in is not configured (set AD_DOMAIN with AD_DOMAIN_CONTROLLER, or AD_LDAP_URL).',
      ),
      { code: 'AD_NOT_CONFIGURED' },
    )
  }

  const url = getAdConnectionUrl()
  if (!url) {
    throw Object.assign(new Error('No LDAP URL — cannot reach the domain controller.'), { code: 'AD_NO_URL' })
  }

  let client
  try {
    client = await createAdBoundClient(url, id, pwd)
    await unbindQuiet(client)
    client = null
    return true
  } catch (e) {
    if (client) await unbindQuiet(client).catch(() => {})
    const raw = e?.cause || e
    const msg = String(raw?.message || raw?.lde_message || e?.message || e)
    const code = raw?.code ?? e?.code ?? raw?.lde_code

    const invalidInteractive =
      code === 'InvalidCredentialsError' ||
      code === 49 ||
      /\b52e\b|invalid credentials|InvalidCredentials|\b774\b|\b775\b|\b533\b|\b701\b/i.test(msg)

    if (invalidInteractive) return false

    throw mapAdStatsFailure(e)
  }
}
