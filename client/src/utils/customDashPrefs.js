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

export async function fetchSavedFilters(scope) {
  const { data } = await api.get('/api/auth/me/ui-prefs/custom-dashboard/saved', {
    params: { scope },
  })
  return {
    filters: Array.isArray(data?.filters) ? data.filters : [],
    limits: data?.limits || { maxFilters: 30, maxNameLen: 60 },
  }
}

export async function createSavedFilter(scope, name, prefs) {
  const { data } = await api.post('/api/auth/me/ui-prefs/custom-dashboard/saved', {
    scope,
    name,
    prefs,
  })
  return {
    filters: Array.isArray(data?.filters) ? data.filters : [],
    created: data?.created || null,
  }
}

export async function updateSavedFilter(scope, id, patch) {
  const { data } = await api.put(`/api/auth/me/ui-prefs/custom-dashboard/saved/${encodeURIComponent(id)}`, {
    scope,
    ...patch,
  })
  return {
    filters: Array.isArray(data?.filters) ? data.filters : [],
    updated: data?.updated || null,
  }
}

export async function deleteSavedFilter(scope, id) {
  const { data } = await api.delete(`/api/auth/me/ui-prefs/custom-dashboard/saved/${encodeURIComponent(id)}`, {
    params: { scope },
  })
  return Array.isArray(data?.filters) ? data.filters : []
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
