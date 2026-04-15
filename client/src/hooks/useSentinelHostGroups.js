import { useState, useEffect, useMemo } from 'react'
import api from '../api/client'

function normalizeScope(scope) {
  const s = String(scope || 'all').toLowerCase()
  if (s === 'bluetooth_only') return 'bt_only'
  if (s === 'no_usb' || s === 'usb_only' || s === 'bt_only') return s
  return 'all'
}

/**
 * Loads distinct Sentinel host group names from Elasticsearch logs for the given time range and scope.
 */
export function useSentinelHostGroups(range, scope) {
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const scopeParam = useMemo(() => normalizeScope(scope), [scope])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const p = new URLSearchParams()
        p.set('range', range?.value || '')
        if (range?.from) p.set('from', range.from)
        if (range?.to) p.set('to', range.to)
        p.set('scope', scopeParam)
        const { data } = await api.get(`/api/sentinel/host-groups?${p.toString()}`)
        if (!cancelled) setGroups(Array.isArray(data?.groups) ? data.groups : [])
      } catch (e) {
        if (!cancelled) {
          setError(e.response?.data?.error || e.message || 'Failed to load host groups')
          setGroups([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [range?.value, range?.from, range?.to, scopeParam])

  return { groups, loading, error, scopeParam }
}
