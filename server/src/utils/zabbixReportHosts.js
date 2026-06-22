/**
 * Resolve Zabbix hosts for Custom Dashboard / Reports-tab markdown exports.
 * Reports tab scopes stores via Influx storeTag + hostname — not always equal to
 * the Zabbix technical `host` field — so we fetch the whole Zabbix group and
 * fuzzy-match against store refs (store codes, prefixes, synthetic tags).
 */
import { ZABBIX_HOST_FETCH_MAX } from '../services/zabbixHostFetch.js'
import { fetchAllMonitoredHosts } from '../services/zabbixHostFetch.js'
import { buildStoreHostAliases, extractStoreCode } from '../services/ai/queryContext.js'

/** Try these Zabbix hostgroup names in order (deployments differ). */
const ZABBIX_GROUP_ALIASES = {
  rp: ['RP Group', 'RP'],
  all: ['RP Group', 'RP'],
  rp_sdwan: ['RP Group', 'RP'],
  rp_no_sdwan: ['RP Group', 'RP'],
  manual_sdwan: ['RP Group', 'RP'],
  pos: ['POS System Group', 'POS'],
  sdwan: ['SD-WAN Group', 'SD-WAN'],
}

function norm(s) {
  return String(s || '').trim().toUpperCase()
}

/** Influx synthetic tag: hs:RP4710-ABC|serial */
function parseSyntheticStoreTag(tag) {
  const s = String(tag || '')
  if (!s.startsWith('hs:')) return null
  const body = s.slice(3)
  const idx = body.indexOf('|')
  if (idx < 0) return { hostname: body || '', serial: '' }
  return {
    hostname: body.slice(0, idx) || '',
    serial: body.slice(idx + 1) || '',
  }
}

/** Expand a ROP perStore row into search terms for Zabbix host/name matching. */
export function storeRefSearchTerms(ref) {
  const terms = new Set()
  let storeTag = String(ref?.storeTag || '').trim()
  let hostname = String(ref?.hostname || '').trim()

  const synthetic = parseSyntheticStoreTag(storeTag)
  if (synthetic?.hostname) {
    if (!hostname) hostname = synthetic.hostname
    if (synthetic.serial) terms.add(synthetic.serial)
    storeTag = synthetic.hostname
  }

  for (const raw of [hostname, storeTag]) {
    if (!raw) continue
    terms.add(raw)
    for (const alias of buildStoreHostAliases(raw)) terms.add(alias)
    const code = extractStoreCode(raw)
    if (code) {
      terms.add(code)
      terms.add(`RP${code}`)
      terms.add(`RP${String(code).padStart(3, '0')}`)
      terms.add(`LK${code}`)
      terms.add(`LKST${code}`)
    }
  }
  return [...terms].map((t) => String(t || '').trim()).filter(Boolean)
}

function hostStoreCode(zHost) {
  return extractStoreCode(zHost?.host) || extractStoreCode(zHost?.name)
}

/** True when a Zabbix host row matches a store ref from the ROP uptime table. */
export function zabbixHostMatchesStoreRef(zHost, ref) {
  return zabbixHostMatchesTerms(zHost, storeRefSearchTerms(ref))
}

export function zabbixHostMatchesTerms(zHost, terms) {
  const hu = norm(zHost?.host)
  const nu = norm(zHost?.name)
  const hostCode = hostStoreCode(zHost)

  for (const term of terms || []) {
    const t = norm(term)
    if (!t) continue
    if (hu === t || nu === t) return true
    if (hu.startsWith(`${t}-`) || nu.startsWith(`${t}-`)) return true
    if (hu.startsWith(t) || nu.startsWith(t)) return true
    if (t.length >= 4 && (hu.includes(t) || nu.includes(t))) return true

    const termCode = extractStoreCode(term)
    if (termCode && hostCode && termCode === hostCode) return true
  }
  return false
}

async function tryResolveGroupByName(zabbixRpc, groupName) {
  const name = String(groupName || '').trim()
  if (!name) return { groupFound: false, groupName: name, hosts: [] }

  let groups = await zabbixRpc('hostgroup.get', {
    output: ['groupid', 'name'],
    filter: { name },
  }).catch(() => [])
  if (!groups?.length) {
    groups = await zabbixRpc('hostgroup.get', {
      output: ['groupid', 'name'],
      search: { name },
      searchWildcardsEnabled: true,
    }).catch(() => [])
    groups = (groups || []).filter((g) => norm(g.name) === norm(name))
  }
  if (!groups?.length) return { groupFound: false, groupName: name, hosts: [] }

  const hosts = await zabbixRpc('host.get', {
    groupids: groups.map((g) => g.groupid),
    monitored_hosts: true,
    output: ['hostid', 'host', 'name'],
    sortfield: 'name',
    limit: ZABBIX_HOST_FETCH_MAX,
  }).catch(() => [])
  return {
    groupFound: true,
    groupName: groups[0].name || name,
    hosts: hosts || [],
  }
}

export async function resolveZabbixGroupHosts(zabbixRpc, groupKeyOrName) {
  const key = String(groupKeyOrName || 'rp').toLowerCase()
  const aliases = ZABBIX_GROUP_ALIASES[key] || ZABBIX_GROUP_ALIASES.rp

  let last = { groupFound: false, groupName: aliases[0], hosts: [] }
  for (const alias of aliases) {
    const result = await tryResolveGroupByName(zabbixRpc, alias)
    last = result
    if (result.groupFound && result.hosts.length) return result
  }
  return last
}

function buildHostMatchIndex(hosts) {
  const byCode = new Map()
  const byExact = new Map()
  for (const h of hosts || []) {
    const code = hostStoreCode(h)
    if (code && !byCode.has(code)) byCode.set(code, h)
    for (const field of [h.host, h.name]) {
      const u = norm(field)
      if (u && !byExact.has(u)) byExact.set(u, h)
    }
  }
  return { byCode, byExact, all: hosts || [] }
}

function matchRefToHost(ref, index) {
  const terms = storeRefSearchTerms(ref)
  for (const term of terms) {
    const exact = index.byExact.get(norm(term))
    if (exact) return exact
  }
  for (const term of terms) {
    const code = extractStoreCode(term)
    if (code && index.byCode.has(code)) return index.byCode.get(code)
  }
  for (const term of terms) {
    const hit = index.all.find((h) => zabbixHostMatchesTerms(h, [term]))
    if (hit) return hit
  }
  return null
}

/** Wildcard host.get for refs still unmatched after group scan. */
async function resolveRefsByWildcardSearch(zabbixRpc, refs, excludeIds = new Set()) {
  const matched = []
  const seen = new Set(excludeIds)
  for (const ref of refs) {
    const terms = storeRefSearchTerms(ref)
    const probe = terms.find((t) => t.length >= 3) || terms[0]
    if (!probe) continue

    const searches = [
      probe.includes('*') ? probe : `${probe}*`,
      ...terms.filter((t) => t !== probe && t.length >= 3).slice(0, 4).map((t) => (t.includes('*') ? t : `${t}*`)),
    ]

    let row = null
    for (const pattern of searches) {
      const rows = await zabbixRpc('host.get', {
        output: ['hostid', 'host', 'name'],
        search: { host: pattern },
        searchWildcardsEnabled: true,
        monitored_hosts: true,
        limit: 50,
      }).catch(() => [])
      row = (rows || []).find((h) => zabbixHostMatchesTerms(h, terms))
      if (row) break
      if (!row && rows?.length === 1) row = rows[0]
    }
    if (!row) continue
    const hid = String(row.hostid)
    if (seen.has(hid)) continue
    seen.add(hid)
    matched.push({
      hostid: hid,
      name: row.name || row.host || hid,
      host: row.host || null,
    })
  }
  return matched
}

/**
 * Match ROP Reports-tab store rows to Zabbix hosts inside the group for groupKey.
 * @param {Function} zabbixRpc
 * @param {string} groupKey — rp | rp_sdwan | pos | sdwan | …
 * @param {Array<{ storeTag?: string, hostname?: string }>} storeRefs
 */
export async function resolveReportHostsByGroup(zabbixRpc, groupKey, storeRefs) {
  const refs = (storeRefs || [])
    .map((r) => ({
      storeTag: String(r?.storeTag || '').trim(),
      hostname: String(r?.hostname || '').trim(),
    }))
    .filter((r) => r.storeTag || r.hostname)
  if (!refs.length) return []

  const { groupFound, hosts: groupHosts } = await resolveZabbixGroupHosts(zabbixRpc, groupKey)
  let pool = groupHosts

  /* If hostgroup missing or empty, scan monitored RP/LK hosts by prefix. */
  if (!pool.length) {
    const prefix = (() => {
      const k = String(groupKey || 'rp').toLowerCase()
      if (k === 'pos') return 'LK*'
      if (k === 'sdwan') return null
      return 'RP*'
    })()
    if (prefix) {
      pool = await zabbixRpc('host.get', {
        output: ['hostid', 'host', 'name'],
        search: { host: prefix },
        searchWildcardsEnabled: true,
        monitored_hosts: true,
        sortfield: 'name',
        limit: ZABBIX_HOST_FETCH_MAX,
      }).catch(() => [])
    } else if (!groupFound) {
      const inv = await fetchAllMonitoredHosts(zabbixRpc, {
        output: ['hostid', 'host', 'name'],
        sortfield: 'name',
      }).catch(() => ({ rows: [] }))
      pool = inv.rows || []
    }
  }

  const index = buildHostMatchIndex(pool)
  const matched = []
  const seen = new Set()
  const unmatchedRefs = []

  for (const ref of refs) {
    const row = matchRefToHost(ref, index)
    if (!row) {
      unmatchedRefs.push(ref)
      continue
    }
    const hid = String(row.hostid)
    if (seen.has(hid)) continue
    seen.add(hid)
    matched.push({
      hostid: hid,
      name: row.name || row.host || hid,
      host: row.host || null,
    })
  }

  if (unmatchedRefs.length) {
    const extra = await resolveRefsByWildcardSearch(zabbixRpc, unmatchedRefs, seen)
    matched.push(...extra)
  }

  return matched
}

/** Exact host/name filter resolution (Custom Dashboard host picker fallback). */
export async function resolveReportHostsByNames(zabbixRpc, hostnames) {
  const wanted = [...new Set((hostnames || []).map((s) => String(s || '').trim()).filter(Boolean))]
  if (!wanted.length) return []

  const CHUNK = 200
  const resolvedById = new Map()
  const matched = new Set()
  const tryFilter = async (field, list) => {
    if (!list.length) return
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK)
      const rows = await zabbixRpc('host.get', {
        output: ['hostid', 'host', 'name'],
        filter: { [field]: chunk },
        monitored_hosts: true,
      }).catch(() => [])
      for (const r of rows || []) {
        resolvedById.set(String(r.hostid), r)
        const h = String(r.host || '').trim()
        const n = String(r.name || '').trim()
        if (h) matched.add(h)
        if (n) matched.add(n)
      }
    }
  }
  await tryFilter('host', wanted)
  const stillUnmatched = wanted.filter((w) => !matched.has(w))
  if (stillUnmatched.length) await tryFilter('name', stillUnmatched)

  const finalUnmatched = wanted.filter((w) => !matched.has(w))
  if (finalUnmatched.length) {
    const extra = await resolveRefsByWildcardSearch(
      zabbixRpc,
      finalUnmatched.map((w) => ({ storeTag: w, hostname: w })),
      new Set(resolvedById.keys()),
    )
    for (const r of extra) resolvedById.set(r.hostid, r)
  }

  return [...resolvedById.values()].map((r) => ({
    hostid: String(r.hostid),
    name: r.name || r.host || String(r.hostid),
    host: r.host || null,
  }))
}
