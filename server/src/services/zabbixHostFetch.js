/** Shared Zabbix host inventory helpers (REST routes + AI context). */

export const ZABBIX_HOST_FETCH_MAX = 10000
export const ZABBIX_HOST_DETAIL_CHUNK = 500

export async function monitoredHostCount(zabbixRpc) {
  try {
    return Number(await zabbixRpc('host.get', { monitored_hosts: true, countOutput: true })) || 0
  } catch (e) {
    if (e.code !== 'ZABBIX_API_ERROR') throw e
    return Number(await zabbixRpc('host.get', { countOutput: true })) || 0
  }
}

/**
 * Fetch monitored hosts, paginating by hostid when inventory exceeds maxTotal.
 * @param {Function} zabbixRpc
 * @param {object} [baseParams]
 * @param {{ maxTotal?: number, chunkSize?: number }} [opts]
 */
export async function fetchAllMonitoredHosts(zabbixRpc, baseParams = {}, { maxTotal = ZABBIX_HOST_FETCH_MAX, chunkSize = ZABBIX_HOST_DETAIL_CHUNK } = {}) {
  const total = await monitoredHostCount(zabbixRpc)
  if (total <= maxTotal) {
    const rows = await zabbixRpc('host.get', {
      monitored_hosts: true,
      sortfield: 'hostid',
      sortorder: 'ASC',
      limit: maxTotal,
      ...baseParams,
    })
    return { rows: rows || [], total, truncated: false }
  }

  const idRows = await zabbixRpc('host.get', {
    monitored_hosts: true,
    output: ['hostid'],
    sortfield: 'hostid',
    sortorder: 'ASC',
    limit: maxTotal,
  })
  const ids = (idRows || []).map((h) => String(h.hostid)).filter(Boolean)
  const truncated = ids.length < total
  const all = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const hostids = ids.slice(i, i + chunkSize)
    const batch = await zabbixRpc('host.get', {
      monitored_hosts: true,
      hostids,
      limit: chunkSize,
      ...baseParams,
    })
    all.push(...(batch || []))
  }
  return { rows: all, total, truncated }
}
