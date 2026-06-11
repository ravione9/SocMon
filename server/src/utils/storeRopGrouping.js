/**
 * Shared RP store grouping — mirrors Store Monitor hostname / SD-WAN rules.
 * Used by ROP Dashboard outage widgets and offline history reports.
 */
import { vendorIsFortinet } from '../services/influxStore.js'
import {
  normalizeStoreCode,
  storeMatchesManualCode,
} from './manualRopStoreCodes.js'

/** All groups a device belongs to (additive: RP + Fortinet → both groups). */
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

export function derivePrimaryGroup(store) {
  return deriveGroups(store)[0]
}

export function isRpStore(store) {
  return deriveGroups(store).includes('RP Group')
}

/**
 * RP store on SD-WAN side: Fortinet/SD-WAN inventory OR manual ROP+SD-WAN code match.
 * @param {object} store snapshot row
 * @param {Set<string>|string[]} [manualCodes] normalized store codes
 */
export function isRpSdwanStore(store, manualCodes = null) {
  if (!store || !isRpStore(store)) return false
  const groups = deriveGroups(store)
  if (groups.includes('SD-WAN Group')) return true
  if (manualCodes?.size > 0 || (Array.isArray(manualCodes) && manualCodes.length)) {
    return storeMatchesManualCode(store, manualCodes)
  }
  return false
}

export function isRpNonSdwanStore(store, manualCodes = null) {
  return isRpStore(store) && !isRpSdwanStore(store, manualCodes)
}

export const RP_SEGMENT = {
  SDWAN: 'rp_sdwan',
  NON_SDWAN: 'rp_non_sdwan',
}

export function classifyRpSegment(store, manualCodes = null) {
  if (!isRpStore(store)) return null
  return isRpSdwanStore(store, manualCodes) ? RP_SEGMENT.SDWAN : RP_SEGMENT.NON_SDWAN
}

/**
 * Partition RP stores from a snapshot into SD-WAN vs Non SD-WAN buckets.
 * @returns {{ sdwan: object[], nonSdwan: object[], sdwanTags: Set<string>, nonSdwanTags: Set<string> }}
 */
export function partitionRpStores(snapshot, manualCodes = null) {
  const sdwan = []
  const nonSdwan = []
  const sdwanTags = new Set()
  const nonSdwanTags = new Set()
  for (const s of snapshot || []) {
    if (!s?.storeTag || !isRpStore(s)) continue
    const seg = classifyRpSegment(s, manualCodes)
    if (seg === RP_SEGMENT.SDWAN) {
      sdwan.push(s)
      sdwanTags.add(s.storeTag)
    } else {
      nonSdwan.push(s)
      nonSdwanTags.add(s.storeTag)
    }
  }
  return { sdwan, nonSdwan, sdwanTags, nonSdwanTags }
}

/**
 * Build outage summary for dashboard cards (current offline only).
 * @param {object} opts
 * @param {object[]} opts.snapshot
 * @param {Set<string>} opts.activeOfflineTags storeTags with active offline problem
 * @param {Map<string, object>} opts.activeOfflineByTag optional detail by tag
 * @param {string[]|Set<string>} opts.manualCodes
 */
export function buildRpOutageSummary({ snapshot, activeOfflineTags, activeOfflineByTag, manualCodes }) {
  const { sdwan, nonSdwan, sdwanTags, nonSdwanTags } = partitionRpStores(snapshot, manualCodes)
  const offlineTagSet = activeOfflineTags instanceof Set ? activeOfflineTags : new Set(activeOfflineTags || [])

  function isCurrentlyOut(store) {
    if (!store?.storeTag) return false
    if (offlineTagSet.has(store.storeTag)) return true
    return store.online === false
  }

  function mapOfflineStore(store) {
    const rec = activeOfflineByTag?.get(store.storeTag)
    const firstSeenMs = rec?.firstSeenAt ? new Date(rec.firstSeenAt).getTime() : null
    return {
      storeTag: store.storeTag,
      hostname: store.hostname || rec?.hostname || '',
      serial: store.serial || rec?.serial || '',
      offlineSinceMs: firstSeenMs,
      source: rec ? 'history' : (store.online === false ? 'snapshot' : 'history'),
    }
  }

  function summarize(stores, segment, totalTags) {
    const offline = stores.filter(isCurrentlyOut).map(mapOfflineStore)
    offline.sort((a, b) => (b.offlineSinceMs || 0) - (a.offlineSinceMs || 0))
    return {
      segment,
      totalStores: stores.length,
      outageCount: offline.length,
      offlineStores: offline,
      storeTags: [...totalTags],
    }
  }

  return {
    rpSdwan: summarize(sdwan, RP_SEGMENT.SDWAN, sdwanTags),
    rpNonSdwan: summarize(nonSdwan, RP_SEGMENT.NON_SDWAN, nonSdwanTags),
  }
}
