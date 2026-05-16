/**
 * Reusable OU/container picker. Renders an expandable tree backed by /api/ad/ous.
 * Calls onChange(dn) when the user selects a node.
 */

import { useEffect, useMemo, useState } from 'react'
import { listAdOus } from '../../api/ad'
import { idcsCx, idcsInputClass } from '../idcs/idcsTheme'

function normDn(s) {
  return String(s || '')
    .toLowerCase()
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(',')
}

export default function AdOuPicker({
  value,
  onChange,
  excludeDn,
  allowContainers = true,
  height = '12rem',
}) {
  const [ous, setOus] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())
  const [autoExpanded, setAutoExpanded] = useState(false)

  useEffect(() => {
    setLoading(true)
    setErr('')
    listAdOus({ limit: 2000 })
      .then((r) => setOus(r.ous || []))
      .catch((e) => {
        const d = e.response?.data
        setErr(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
      })
      .finally(() => setLoading(false))
  }, [])

  const { byParent, dnByNorm, roots, dnsWithChildren } = useMemo(() => {
    const known = new Set(ous.map((o) => normDn(o.dn)))
    const map = new Map()
    const childMap = new Map()
    for (const o of ous) {
      map.set(normDn(o.dn), o)
      const parentKey = known.has(normDn(o.parent)) ? normDn(o.parent) : '__root__'
      if (!childMap.has(parentKey)) childMap.set(parentKey, [])
      childMap.get(parentKey).push(o)
    }
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
    for (const [, list] of childMap) {
      list.sort((a, b) => collator.compare(String(a.name || a.dn), String(b.name || b.dn)))
    }
    const haveKids = new Set()
    for (const [k] of childMap) {
      if (k !== '__root__') haveKids.add(k)
    }
    return {
      byParent: childMap,
      dnByNorm: map,
      roots: childMap.get('__root__') || [],
      dnsWithChildren: haveKids,
    }
  }, [ous])

  useEffect(() => {
    if (autoExpanded) return
    if (!ous.length) return
    setExpanded(new Set(roots.map((r) => normDn(r.dn))))
    setAutoExpanded(true)
  }, [ous.length, roots, autoExpanded])

  const filterSet = useMemo(() => {
    if (!filter.trim()) return null
    const q = filter.toLowerCase()
    const matches = new Set()
    for (const o of ous) {
      if ((o.name || '').toLowerCase().includes(q) || (o.dn || '').toLowerCase().includes(q)) {
        matches.add(normDn(o.dn))
      }
    }
    const visible = new Set(matches)
    for (const dnNorm of matches) {
      let cur = dnByNorm.get(dnNorm)
      while (cur) {
        visible.add(normDn(cur.dn))
        const next = dnByNorm.get(normDn(cur.parent))
        if (!next || next === cur) break
        cur = next
      }
    }
    return visible
  }, [filter, ous, dnByNorm])

  const minDepth = useMemo(
    () => ous.reduce((m, o) => (Number.isFinite(o.depth) ? Math.min(m, o.depth) : m), Infinity),
    [ous],
  )

  const rendered = useMemo(() => {
    if (!ous.length) return []
    const filtered = filterSet
    const out = []
    const isOpen = (dnNorm) => (filtered ? true : expanded.has(dnNorm))
    const walk = (node) => {
      const dnNorm = normDn(node.dn)
      if (filtered && !filtered.has(dnNorm)) return
      out.push(node)
      const kids = byParent.get(dnNorm)
      if (!kids || !kids.length) return
      if (!isOpen(dnNorm)) return
      for (const c of kids) walk(c)
    }
    for (const r of roots) walk(r)
    return out
  }, [byParent, roots, expanded, filterSet, ous.length])

  const toggle = (dnNorm) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dnNorm)) next.delete(dnNorm)
      else next.add(dnNorm)
      return next
    })
  }

  const selectedNorm = normDn(value)
  const excludeNorm = normDn(excludeDn)

  return (
    <div className="space-y-2">
      <input
        type="search"
        placeholder="Filter OU / container…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className={idcsInputClass('w-full')}
      />
      {err && (
        <div
          className={`text-xs rounded-lg px-3 py-2 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {err}
        </div>
      )}
      <div
        className={`rounded-lg border overflow-auto ${idcsCx.border} ${idcsCx.bg3}`}
        style={{ height }}
      >
        {loading && !ous.length ? (
          <div className={`text-sm py-6 text-center ${idcsCx.text3}`}>Loading directory tree…</div>
        ) : rendered.length === 0 ? (
          <div className={`text-sm py-6 text-center ${idcsCx.text3}`}>No OUs match.</div>
        ) : (
          <ul className="font-mono text-xs leading-relaxed py-1">
            {rendered.map((o) => {
              const indent = Math.max(0, (o.depth - minDepth) * 14)
              const dnNorm = normDn(o.dn)
              const hasKids = dnsWithChildren.has(dnNorm)
              const selected = selectedNorm && dnNorm === selectedNorm
              const disabled =
                (excludeNorm && dnNorm === excludeNorm) || (!allowContainers && o.isContainer)
              const isOpen = filterSet ? true : expanded.has(dnNorm)
              return (
                <li
                  key={o.dn}
                  className="flex items-center gap-1 rounded"
                  style={{ paddingLeft: indent }}
                >
                  {hasKids ? (
                    <button
                      type="button"
                      onClick={() => toggle(dnNorm)}
                      title={isOpen ? 'Collapse' : 'Expand'}
                      className={`shrink-0 w-5 h-5 inline-flex items-center justify-center text-[10px] ${idcsCx.text3} hover:bg-[color-mix(in_srgb,var(--accent)_14%,var(--bg3))] rounded`}
                    >
                      {isOpen ? '▼' : '▶'}
                    </button>
                  ) : (
                    <span className="shrink-0 w-5 h-5" />
                  )}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(o.dn)}
                    title={o.dn}
                    className={`flex-1 min-w-0 flex items-baseline gap-2 py-0.5 px-1 text-left rounded ${
                      selected
                        ? 'bg-[color-mix(in_srgb,var(--accent)_22%,var(--bg3))] text-[var(--accent)]'
                        : disabled
                          ? 'opacity-40 cursor-not-allowed'
                          : `${idcsCx.text2} hover:bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg2))] cursor-pointer`
                    }`}
                  >
                    <span style={{ color: o.isContainer ? 'var(--text3)' : 'var(--accent)' }}>
                      {o.isContainer ? '📁' : '🌳'}
                    </span>
                    <span className={`truncate ${idcsCx.text}`}>{o.name || o.dn}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className={`text-[11px] font-mono break-all ${idcsCx.text3}`}>{value || '— select an OU above —'}</div>
    </div>
  )
}
