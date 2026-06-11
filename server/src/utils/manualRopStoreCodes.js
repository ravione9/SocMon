import StoreMonitorSetting from '../models/StoreMonitorSetting.js'

/** Manual ROP + SD-WAN store codes from MANUAL_ROP_SDWAN_STORE_CODES env (comma/newline separated). */
export function getManualRopSdwanStoreCodes() {
  const raw = String(process.env.MANUAL_ROP_SDWAN_STORE_CODES || '').trim()
  if (!raw) return []
  return parseManualStoreCodes(raw)
}

export function normalizeStoreCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/^STORE[-_\s]*/i, '')
}

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

function storeCodeCandidates(store) {
  const out = new Set()
  const tag = normalizeStoreCode(store?.storeTag)
  const host = String(store?.hostname || '').trim().toUpperCase()
  const serial = String(store?.serial || '').trim().toUpperCase()
  if (tag) out.add(tag)
  if (host) {
    out.add(host)
    const m = host.match(/^(RP|LK)(.+)/)
    if (m) {
      const suffix = m[2]
      out.add(suffix)
      out.add(`${m[1]}${suffix}`)
      const dashIdx = suffix.indexOf('-')
      if (dashIdx > 0) {
        const beforeDash = suffix.slice(0, dashIdx)
        out.add(beforeDash)
        out.add(`${m[1]}${beforeDash}`)
      }
    }
  }
  if (serial) out.add(serial)
  return out
}

/** Exact match only — mirrors client manualRopSdwanStoreCodes.js */
export function storeMatchesManualCode(store, codes) {
  const list = codes instanceof Set ? [...codes] : (Array.isArray(codes) ? codes : parseManualStoreCodes(codes))
  if (!list.length) return false
  const candidates = storeCodeCandidates(store)
  return list.some((code) => candidates.has(normalizeStoreCode(code)))
}

let _manualCodesCache = { codes: [], ts: 0 }
const MANUAL_CODES_CACHE_MS = 30_000

/** Resolved manual codes: Mongo settings override env (same as Store Monitor bundle). */
export async function getManualRopCodeList() {
  const now = Date.now()
  if (now - _manualCodesCache.ts < MANUAL_CODES_CACHE_MS) return _manualCodesCache.codes
  try {
    const doc = await StoreMonitorSetting.findOne().select('manualRopSdwanCodes').lean()
    const rawText = doc?.manualRopSdwanCodes ?? ''
    const codes = rawText.trim() ? parseManualStoreCodes(rawText) : getManualRopSdwanStoreCodes()
    _manualCodesCache = { codes, ts: now }
    return codes
  } catch {
    const codes = getManualRopSdwanStoreCodes()
    _manualCodesCache = { codes, ts: now }
    return codes
  }
}

export function invalidateManualRopCodeCache() {
  _manualCodesCache = { codes: [], ts: 0 }
}
