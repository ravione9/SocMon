/** Zabbix host-group aliases for RP System deployments (names differ per instance). */
export const RP_SYSTEM_GROUP_ALIASES = ['RP System', 'RPSystem', 'RP Group', 'RP']

function normGroupName(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, '')
}

/** Pick the live Zabbix group label that best matches `wanted`. */
export function resolveZabbixHostGroup(wanted, availableNames = []) {
  const candidates = [wanted, ...RP_SYSTEM_GROUP_ALIASES].filter(Boolean)
  for (const name of availableNames) {
    const n = normGroupName(name)
    if (!n) continue
    if (candidates.some((c) => {
      const cn = normGroupName(c)
      return cn === n || n.includes(cn) || cn.includes(n)
    })) return name
  }
  return String(wanted || '').trim()
}

/** True when a host row belongs to the wanted Zabbix group (fuzzy). */
export function hostMatchesZabbixGroup(host, groupWanted) {
  if (!groupWanted) return true
  const aliases = [groupWanted, ...RP_SYSTEM_GROUP_ALIASES].map(normGroupName).filter(Boolean)
  return (host?.groups || []).some((g) => {
    const gn = normGroupName(g)
    if (!gn) return false
    return aliases.some((a) => gn === a || gn.includes(a) || a.includes(gn))
  })
}
