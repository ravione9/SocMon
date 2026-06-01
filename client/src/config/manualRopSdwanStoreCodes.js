/** Default manual ROP + SD-WAN store codes (override via server env or browser localStorage). */
export const DEFAULT_MANUAL_ROP_SDWAN_STORE_CODES = []

export const MANUAL_ROP_CODES_STORAGE_KEY = 'sm-manual-rop-sdwan-codes'

/** Parse comma / newline / semicolon separated store codes. */
export function parseManualStoreCodes(text) {
  if (Array.isArray(text)) {
    return [...new Set(text.map(normalizeStoreCode).filter(Boolean))]
  }
  return [...new Set(
    String(text || '')
      .split(/[\n,;|\t]+/)
      .map(normalizeStoreCode)
      .filter(Boolean),
  )]
}

export function normalizeStoreCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/^STORE[-_\s]*/i, '')
}

function storeCodeCandidates(store) {
  const out = new Set()
  const tag = normalizeStoreCode(store?.storeTag)
  const host = String(store?.hostname || '').trim().toUpperCase()
  const serial = String(store?.serial || '').trim().toUpperCase()
  if (tag) out.add(tag)
  if (host) {
    out.add(host)
    const m = host.match(/^(RP|LK)([A-Z0-9-]+)/)
    if (m) {
      out.add(m[2])
      out.add(`${m[1]}${m[2]}`)
      const num = m[2].match(/^(\d+)/)
      if (num) out.add(num[1])
    }
  }
  if (serial) out.add(serial)
  return out
}

export function storeMatchesManualCode(store, code) {
  const norm = normalizeStoreCode(code)
  if (!norm) return false
  const candidates = storeCodeCandidates(store)
  if (candidates.has(norm)) return true
  return [store?.storeTag, store?.hostname, store?.serial].some((v) =>
    String(v || '').toUpperCase().includes(norm),
  )
}

export function placeholderManualStore(code) {
  const norm = normalizeStoreCode(code)
  return {
    storeTag: `manual:${norm}`,
    storeCode: norm,
    hostname: norm,
    serial: '—',
    online: false,
    lastSeen: null,
    connState: 'unknown',
    activeInterface: '',
    gatewayIp: '',
    gatewayVendor: '',
    isPlaceholder: true,
    systemGroups: ['RP Group', 'SD-WAN Group'],
    systemGroup: 'RP Group',
    ping: {},
    dns: {},
    http: {},
    cpuPct: null,
    memPct: null,
    downloadMbps: null,
    uploadMbps: null,
    issues: [{ severity: 'warning', code: 'no_data', message: 'No monitoring data for this store code' }],
    issueCount: 1,
    severity: 'warning',
  }
}

/** One row per configured code — live store when matched, placeholder otherwise. */
export function buildManualRopStoreList(stores, codes) {
  const list = parseManualStoreCodes(codes)
  if (!list.length) return []
  const used = new Set()
  return list.map((code) => {
    const norm = normalizeStoreCode(code)
    const match = stores.find((s) => !used.has(s.storeTag) && storeMatchesManualCode(s, code))
    if (match) {
      used.add(match.storeTag)
      return { ...match, storeCode: norm }
    }
    return placeholderManualStore(norm)
  })
}

export function loadManualStoreCodesFromStorage() {
  try {
    const raw = localStorage.getItem(MANUAL_ROP_CODES_STORAGE_KEY)
    if (!raw) return null
    const parsed = parseManualStoreCodes(raw)
    return parsed.length ? parsed : null
  } catch {
    return null
  }
}

export function saveManualStoreCodesToStorage(text) {
  try {
    localStorage.setItem(MANUAL_ROP_CODES_STORAGE_KEY, String(text || ''))
  } catch { /* ignore quota errors */ }
}
