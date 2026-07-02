/**
 * LKST store code ↔ RP/LK Zabbix hostname alias resolution.
 * LKST336 in user input → query RP336-* (and siblings) in NetPulse/Zabbix.
 */
export const STORE_DISPLAY_PREFIX = 'LKST'

/** Canonical numeric store code from LKST336, RP336, RP0336, LK336, or 336. */
export function extractNumericStoreCode(text) {
  const raw = String(text || '').trim().toUpperCase()
  const prefixed = raw.match(/\b(?:LKST|LK|RP)\s*0*(\d{2,6})(?:-[A-Z0-9]{2,})?\b/)
  if (prefixed?.[1]) return String(Number.parseInt(prefixed[1], 10))

  const digitsOnly = raw.match(/^(\d{2,6})$/)
  if (digitsOnly?.[1]) return String(Number.parseInt(digitsOnly[1], 10))

  const lkst = raw.match(/^LKST(\d{2,6})$/)
  if (lkst?.[1]) return String(Number.parseInt(lkst[1], 10))

  return null
}

/** Display code for reports (always LKST prefix). */
export function normalizeStoreCode(code) {
  const numeric = extractNumericStoreCode(code)
  if (numeric) return `${STORE_DISPLAY_PREFIX}${numeric}`
  const raw = String(code || '').trim().toUpperCase()
  if (!raw) return raw
  if (raw.startsWith(STORE_DISPLAY_PREFIX)) return raw
  return `${STORE_DISPLAY_PREFIX}${raw}`
}

export function normalizeStoreCodes(codes) {
  return (codes || []).map(normalizeStoreCode)
}

/**
 * Resolve identity + Zabbix query aliases for one store input.
 * @returns {{ displayCode, numericCode, zabbixPrimary, queryTerms, queryPhrase }}
 */
export function resolveStoreIdentity(input) {
  const numericCode = extractNumericStoreCode(input)
  if (!numericCode) {
    const displayCode = normalizeStoreCode(input)
    return {
      displayCode,
      numericCode: null,
      zabbixPrimary: displayCode,
      queryTerms: [displayCode],
      queryPhrase: displayCode,
    }
  }

  const pad3 = numericCode.padStart(3, '0')
  const displayCode = `${STORE_DISPLAY_PREFIX}${numericCode}`
  const zabbixPrimary = `RP${numericCode}`
  const queryTerms = [displayCode, zabbixPrimary, `LK${numericCode}`]
  if (pad3 !== numericCode) {
    queryTerms.push(`RP${pad3}`, `LK${pad3}`)
  }

  return {
    displayCode,
    numericCode,
    zabbixPrimary,
    queryTerms: [...new Set(queryTerms)],
    queryPhrase: [displayCode, zabbixPrimary, pad3 !== numericCode ? `RP${pad3}` : null]
      .filter(Boolean)
      .join(' '),
  }
}

/** True if a hostname/tag belongs to the same numeric store code. */
export function hostMatchesStoreCode(fieldValue, numericCode) {
  if (!fieldValue || numericCode == null) return false
  const extracted = extractNumericStoreCode(fieldValue)
  return extracted === String(numericCode)
}
