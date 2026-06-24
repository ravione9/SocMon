/**
 * Store Zabbix custom ping sensor helpers — RP / Windows workstation hosts.
 * Uses the same item keys as Custom Dashboard and Network Health:
 *   custom.ping.ms[8.8.8.8]     — latency (ms)
 *   custom.ping.jitter[8.8.8.8] — jitter (ms)
 *   custom.ping.loss[8.8.8.8]   — packet loss (%)
 */
export const STORE_PING_KEY_RES = {
  latency: /^custom\.ping\.ms(\b|\[)/i,
  jitter: /^custom\.ping\.jitter(\b|\[)/i,
  packetLoss: /^custom\.ping\.loss(\b|\[)/i,
}

export const DEFAULT_PING_TARGET = '8.8.8.8'

export const STORE_PING_SENSOR_LABELS = {
  latency: 'custom.ping.ms',
  jitter: 'custom.ping.jitter',
  packetLoss: 'custom.ping.loss',
}

export function getStaleAfterSec() {
  const raw = parseInt(process.env.ZABBIX_ALERT_STALE_SEC || process.env.NET_HEALTH_STALE_SEC || '300', 10)
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 60), 3600) : 300
}

/** Index Zabbix items by hostid (filtered by key regex). */
export function indexCustomPingItems(items, keyRe) {
  const map = {}
  for (const it of items || []) {
    const key = String(it.key_ || '')
    if (!keyRe.test(key)) continue
    const hid = String(it.hostid)
    if (!map[hid]) map[hid] = []
    map[hid].push(it)
  }
  return map
}

/**
 * Pick the best custom ping item for a host — prefers custom.ping.*[target],
 * then newest lastclock. Matches Store Zabbix dashboard / fleet report logic.
 */
export function pickCustomPingItem(hostItems, target = DEFAULT_PING_TARGET, nowSec = Math.floor(Date.now() / 1000), staleAfterSec = getStaleAfterSec()) {
  if (!hostItems?.length) {
    return { value: null, key: null, itemid: null, lastclock: null, fresh: false, stale: false }
  }
  const t = String(target || DEFAULT_PING_TARGET).trim() || DEFAULT_PING_TARGET
  const bracket = `[${t}]`
  let best = null

  for (const it of hostItems) {
    const v = parseFloat(it.lastvalue)
    if (!Number.isFinite(v) || v < 0) continue
    const key = String(it.key_ || '')
    const clock = Number(it.lastclock) || 0
    const exact = key.includes(bracket)
    const prev = best?.item
    const prevExact = prev ? String(prev.key_ || '').includes(bracket) : false

    if (!best) {
      best = { item: it, value: v, clock, exact }
      continue
    }
    if (exact && !prevExact) {
      best = { item: it, value: v, clock, exact }
      continue
    }
    if (exact === prevExact && clock >= (best.clock || 0)) {
      best = { item: it, value: v, clock, exact }
    }
  }

  if (!best) {
    return { value: null, key: null, itemid: null, lastclock: null, fresh: false, stale: false }
  }

  const clock = best.clock > 0 ? best.clock : null
  const stale = clock == null || (nowSec - clock) > staleAfterSec
  return {
    value: Math.round(best.value * 100) / 100,
    key: String(best.item.key_ || ''),
    itemid: String(best.item.itemid || ''),
    lastclock: clock,
    fresh: !stale,
    stale,
  }
}

/**
 * Resolve latency / jitter / packet-loss for one host from custom ping sensors.
 */
export function resolveStorePingMetrics(indexes, hostid, target, nowSec, staleAfterSec) {
  const hid = String(hostid)
  const latency = pickCustomPingItem(indexes.latency[hid], target, nowSec, staleAfterSec)
  const jitter = pickCustomPingItem(indexes.jitter[hid], target, nowSec, staleAfterSec)
  const packetLoss = pickCustomPingItem(indexes.packetLoss[hid], target, nowSec, staleAfterSec)
  return {
    latency: latency.fresh ? latency.value : null,
    jitter: jitter.fresh ? jitter.value : null,
    packetLoss: packetLoss.fresh ? packetLoss.value : null,
    itemKeys: {
      latency: latency.key,
      jitter: jitter.key,
      packetLoss: packetLoss.key,
    },
    fresh: {
      latency: latency.fresh,
      jitter: jitter.fresh,
      packetLoss: packetLoss.fresh,
    },
    raw: { latency, jitter, packetLoss },
  }
}

/** Fuzzy host-group match (RPSystem, RP Group, RP, etc.). */
export function hostInGroup(hostGroups, wantedGroup) {
  const gn = String(wantedGroup || '').trim()
  if (!gn) return false
  const want = gn.toLowerCase()
  return (hostGroups || []).some((g) => {
    const name = String(g || '').toLowerCase()
    return name === want || name.includes(want) || want.includes(name)
  })
}

/** RP / store workstation host name pattern. */
export function isRpStoreHost(host) {
  const h = String(host?.host || host?.name || '').trim().toUpperCase()
  return /^RP\d/.test(h)
}
