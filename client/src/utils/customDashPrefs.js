import api from '../api/client'

const SCOPES = { '/api/store-zabbix': 'store-zabbix', '/api/zabbix': 'zabbix' }

export function customDashPrefsScope(apiBase = '/api/store-zabbix') {
  const base = String(apiBase || '').replace(/\/$/, '')
  if (SCOPES[base]) return SCOPES[base]
  if (base.includes('store-zabbix')) return 'store-zabbix'
  return 'zabbix'
}

export function serializeCustomDashPrefs(state) {
  const {
    selectedHosts,
    range,
    customEpoch,
    customFrom,
    customTo,
    bhEnabled,
    bhStart,
    bhEnd,
    bhDays,
    eventLimit,
    activeWidget,
  } = state || {}
  return {
    v: 1,
    selectedHostIds: (selectedHosts || []).map((h) => String(h.hostid)).filter(Boolean),
    range: range || '24h',
    customEpoch: customEpoch?.from && customEpoch?.to
      ? { from: Number(customEpoch.from), to: Number(customEpoch.to) }
      : null,
    customFrom: customFrom || '',
    customTo: customTo || '',
    bhEnabled: !!bhEnabled,
    bhStart: Number(bhStart) || 9,
    bhEnd: Number(bhEnd) || 18,
    bhDays: [...(bhDays || new Set([1, 2, 3, 4, 5]))].sort((a, b) => a - b),
    eventLimit: Number(eventLimit) || 2000,
    activeWidget: activeWidget || null,
  }
}

export async function fetchCustomDashPrefs(scope) {
  const { data } = await api.get('/api/auth/me/ui-prefs/custom-dashboard', {
    params: { scope },
  })
  return data?.prefs || null
}

export async function saveCustomDashPrefs(scope, prefs) {
  await api.put('/api/auth/me/ui-prefs/custom-dashboard', { scope, prefs })
}

export function resolveHostsByIds(hosts, hostIds) {
  if (!hosts?.length || !hostIds?.length) return []
  const map = new Map(hosts.map((h) => [String(h.hostid), h]))
  const out = []
  for (const id of hostIds) {
    const h = map.get(String(id))
    if (h) out.push(h)
  }
  return out
}
