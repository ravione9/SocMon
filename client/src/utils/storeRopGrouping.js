/**
 * Client-side RP grouping — keep in sync with server/src/utils/storeRopGrouping.js
 * and Store Monitor deriveGroups().
 */
import { storeMatchesManualCode } from '../config/manualRopSdwanStoreCodes.js'

export const RP_SEGMENT = {
  SDWAN: 'rp_sdwan',
  NON_SDWAN: 'rp_non_sdwan',
}

export function vendorIsFortinet(vendor, flag = false) {
  return flag === true || /fortinet|fortigate/i.test(String(vendor || ''))
}

export function deriveGroups(storeOrHost) {
  const s = typeof storeOrHost === 'string'
    ? { hostname: storeOrHost }
    : (storeOrHost || {})
  const h = String(s.hostname || '').toUpperCase()
  const groups = []
  if (h.startsWith('RP')) groups.push('RP Group')
  else if (h.startsWith('LK')) groups.push('POS System Group')
  if (
    vendorIsFortinet(s.gatewayVendor, s.isFortinet)
    || vendorIsFortinet(s.lastGatewayVendor, s.lastIsFortinet)
  ) {
    groups.push('SD-WAN Group')
  }
  if (groups.length === 0) groups.push('General Group')
  return groups
}

export function isRpStore(store) {
  return deriveGroups(store).includes('RP Group')
}

export function isRpSdwanStore(store, manualCodes = null) {
  if (!store || !isRpStore(store)) return false
  if (deriveGroups(store).includes('SD-WAN Group')) return true
  if (!manualCodes?.length) return false
  return storeMatchesManualCode(store, manualCodes)
}

export function classifyRpSegment(store, manualCodes = null) {
  if (!isRpStore(store)) return null
  return isRpSdwanStore(store, manualCodes) ? RP_SEGMENT.SDWAN : RP_SEGMENT.NON_SDWAN
}

export const RP_OUTAGE_LABELS = {
  [RP_SEGMENT.SDWAN]: 'RP SD-WAN',
  [RP_SEGMENT.NON_SDWAN]: 'RP Non SD-WAN',
}

export const ROP_SUBTABS = [
  { id: 'rp', label: 'All ROP', icon: '📡' },
  { id: 'rp_sdwan', label: 'ROP + SD-WAN', icon: '🛡' },
  { id: 'rp_no_sdwan', label: 'ROP without SD-WAN', icon: '🔗' },
  { id: 'manual_sdwan', label: 'Manual ROP + SD-WAN', icon: '📋' },
]

const RP_GROUP_KEYS = new Set(['rp', 'all', 'rp_sdwan', 'rp_no_sdwan', 'manual_sdwan'])

export function isRpGroupKey(groupKey) {
  return RP_GROUP_KEYS.has(String(groupKey || 'rp').toLowerCase())
}
