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

export function isRpFortinetSdwanStore(store) {
  return isRpStore(store) && deriveGroups(store).includes('SD-WAN Group')
}

/** Matched snapshot stores for configured manual codes (Store Monitor parity). */
export function buildManualRopStoreList(snapshot, manualCodes) {
  const codes = Array.isArray(manualCodes) ? manualCodes : []
  if (!codes.length) return []
  const used = new Set()
  const result = []
  for (const code of codes) {
    const match = (snapshot || []).find(
      (s) => s?.storeTag && !used.has(s.storeTag) && storeMatchesManualCode(s, code),
    )
    if (match) {
      used.add(match.storeTag)
      result.push(match)
    }
  }
  return result
}

/**
 * ROP group buckets — mirrors Store Monitor ROP Groups sub-tabs.
 * @returns {{ rp, rp_sdwan, rp_no_sdwan, manual_sdwan, counts }}
 */
export function buildRopGroupBuckets(snapshot, manualCodes = null) {
  const codes = manualCodes || []
  const manualStores = buildManualRopStoreList(snapshot, codes)
  const manualTags = new Set(manualStores.map((s) => s.storeTag))

  const rp = new Set()
  const rpSdwan = new Set()
  const rpOnly = new Set()

  for (const s of snapshot || []) {
    if (!s?.storeTag || !isRpStore(s)) continue
    rp.add(s.storeTag)
    if (deriveGroups(s).includes('SD-WAN Group')) rpSdwan.add(s.storeTag)
    else rpOnly.add(s.storeTag)
  }

  const rpNoSdwan = [...rpOnly].filter((tag) => !manualTags.has(tag))
  const manualSdwan = manualStores.map((s) => s.storeTag)

  return {
    rp: [...rp],
    rp_sdwan: [...rpSdwan],
    rp_no_sdwan: rpNoSdwan,
    manual_sdwan: manualSdwan,
    counts: {
      rp: rp.size,
      rp_sdwan: rpSdwan.size,
      rp_no_sdwan: rpNoSdwan.length,
      manual_sdwan: manualSdwan.length,
      manualCodesConfigured: codes.length,
      manualMatched: manualSdwan.length,
    },
  }
}

const RP_GROUP_KEYS = new Set(['rp', 'all', 'rp_sdwan', 'sdwan_rop', 'rp_no_sdwan', 'no_sdwan', 'manual_sdwan'])

export function isRpGroupKey(groupKey) {
  return RP_GROUP_KEYS.has(String(groupKey || 'rp').toLowerCase())
}

/** Resolve store tags for dashboard groupKey (RP sub-groups + POS / SD-WAN). */
export function resolveGroupTags(snapshot, groupKey, manualCodes = null) {
  const key = String(groupKey || 'rp').toLowerCase()
  const rpBuckets = buildRopGroupBuckets(snapshot, manualCodes)

  if (key === 'rp' || key === 'all') return rpBuckets.rp
  if (key === 'rp_sdwan' || key === 'sdwan_rop') return rpBuckets.rp_sdwan
  if (key === 'rp_no_sdwan' || key === 'no_sdwan') return rpBuckets.rp_no_sdwan
  if (key === 'manual_sdwan') return rpBuckets.manual_sdwan

  const pos = []
  const sdwan = []
  for (const s of snapshot || []) {
    if (!s?.storeTag) continue
    const h = String(s.hostname || '').toUpperCase()
    if (h.startsWith('LK')) pos.push(s.storeTag)
    if (
      vendorIsFortinet(s.gatewayVendor, s.isFortinet)
      || vendorIsFortinet(s.lastGatewayVendor, s.lastIsFortinet)
    ) sdwan.push(s.storeTag)
  }
  const legacy = {
    pos: [...new Set(pos)],
    sdwan: [...new Set(sdwan)],
  }
  return legacy[key] || rpBuckets.rp
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

/**
 * BH downtime + disconnect totals by RP segment for the selected range.
 * @param {object[]} perStoreMetrics — { storeTag, bizDownMin, disconnects }
 */
export function buildRpSegmentBhSummary({ perStoreMetrics, snapshot, manualCodes }) {
  const { sdwanTags, nonSdwanTags } = partitionRpStores(snapshot, manualCodes)
  const byTag = new Map((perStoreMetrics || []).map((m) => [m.storeTag, m]))

  function sumForTags(tagSet) {
    let totalDowntimeMin = 0
    let totalDisconnects = 0
    let storeCount = 0
    for (const tag of tagSet) {
      const m = byTag.get(tag)
      if (!m) continue
      storeCount += 1
      totalDowntimeMin += m.bizDownMin || 0
      totalDisconnects += m.disconnects || 0
    }
    return { totalStores: storeCount, totalDowntimeMin, totalDisconnects }
  }

  return {
    rpSdwan: {
      segment: RP_SEGMENT.SDWAN,
      label: 'ROP SD-WAN',
      ...sumForTags(sdwanTags),
    },
    rpNonSdwan: {
      segment: RP_SEGMENT.NON_SDWAN,
      label: 'ROP Non SD-WAN',
      ...sumForTags(nonSdwanTags),
    },
  }
}
