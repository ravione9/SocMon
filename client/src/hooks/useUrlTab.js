import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

function toAllowedSet(allowedTabs) {
  if (!allowedTabs) return new Set()
  if (allowedTabs instanceof Set) return allowedTabs
  const list = Array.isArray(allowedTabs) ? allowedTabs : [...allowedTabs]
  return new Set(list.map((t) => (typeof t === 'string' ? t : t?.id)).filter(Boolean))
}

/**
 * Tab state synced to ?tab= (or custom param) so refresh keeps the active section.
 * @param {string} defaultTab
 * @param {string[]|{id:string}[]|Set<string>} allowedTabs
 * @param {string} [paramName='tab']
 * @returns {[string, (id: string | ((prev: string) => string)) => void]}
 */
export function useUrlTab(defaultTab, allowedTabs, paramName = 'tab') {
  const [searchParams, setSearchParams] = useSearchParams()
  const allowed = useMemo(() => toAllowedSet(allowedTabs), [allowedTabs])

  const tab = useMemo(() => {
    const raw = searchParams.get(paramName)
    return raw && allowed.has(raw) ? raw : defaultTab
  }, [searchParams, paramName, allowed, defaultTab])

  const setTab = useCallback(
    (next) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          const curRaw = p.get(paramName)
          const cur = curRaw && allowed.has(curRaw) ? curRaw : defaultTab
          const id = typeof next === 'function' ? next(cur) : next
          if (!allowed.has(id)) return prev
          if (id === defaultTab) p.delete(paramName)
          else p.set(paramName, id)
          return p
        },
        { replace: true },
      )
    },
    [setSearchParams, paramName, allowed, defaultTab],
  )

  return [tab, setTab]
}
