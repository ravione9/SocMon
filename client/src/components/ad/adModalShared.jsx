/**
 * Shared building blocks for AD detail modals (Users / Groups / Computers / OUs).
 */

import { useState } from 'react'
import { idcsCx, idcsBtnGhost } from '../idcs/idcsTheme'

export function fmtTs(iso) {
  if (!iso) return '—'
  try {
    const t = Date.parse(iso)
    if (!Number.isNaN(t)) return new Date(t).toLocaleString()
    return String(iso)
  } catch {
    return String(iso)
  }
}

export function shortOuPath(dn) {
  if (!dn) return '—'
  const parts = String(dn).split(',').filter(Boolean)
  const named = parts.filter((p) => /^(OU|CN)=/i.test(p))
  if (!named.length) return dn
  return named.map((p) => p.replace(/^OU=|^CN=/i, '')).join(' / ')
}

export function DetailRows({ rows }) {
  return (
    <div className={`rounded-lg border divide-y ${idcsCx.border} ${idcsCx.divide}`}>
      {rows.map(([label, value]) => (
        <div key={label} className={`grid grid-cols-[minmax(7rem,32%)_1fr] gap-x-3 px-3 py-2 text-sm`}>
          <div className={`font-medium whitespace-nowrap ${idcsCx.text3}`}>{label}</div>
          <div className={`break-all ${idcsCx.text}`}>{value ?? '—'}</div>
        </div>
      ))}
    </div>
  )
}

export function ErrorBanner({ text }) {
  if (!text) return null
  return (
    <div
      className={`text-sm rounded-lg px-3 py-2 border ${idcsCx.border}`}
      style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
    >
      {text}
    </div>
  )
}

export function WriteDisabledBanner({ writesEnabled }) {
  if (writesEnabled) return null
  return (
    <div
      className={`text-xs rounded-lg px-3 py-2 border mb-3 ${idcsCx.border}`}
      style={{ background: 'color-mix(in srgb, var(--amber) 14%, var(--bg3))', color: 'var(--amber)' }}
    >
      LDAP writes are disabled on the server (AD_LDAP_WRITES=off). Edits and actions are blocked.
    </div>
  )
}

/**
 * Modal frame (header + scrollable content). Children render the tab strip and body.
 */
export function AdModalShell({ title, subtitle, monoChip, onClose, dn, children }) {
  const [copied, setCopied] = useState(false)
  const copyDn = async () => {
    try {
      await navigator.clipboard.writeText(dn || '')
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm p-4"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col border ${idcsCx.border} ${idcsCx.bg2}`}
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="px-5 py-4 flex items-start justify-between gap-3 shrink-0"
          style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent2))' }}
        >
          <div className="min-w-0 pr-2 flex-1">
            <h2 className="font-semibold text-lg text-[var(--on-accent)] truncate">{title || '—'}</h2>
            {subtitle ? <p className="text-xs opacity-90 text-[var(--on-accent)] mt-1 break-all">{subtitle}</p> : null}
            {monoChip ? (
              <p className="text-[11px] opacity-85 text-[var(--on-accent)] mt-1 font-mono break-all" title={monoChip}>
                {monoChip}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--on-accent)] opacity-90 hover:opacity-100 text-xl leading-none shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="p-5 overflow-y-auto flex-1 flex flex-col">
          <div className={`flex flex-wrap items-center gap-2 mb-3 shrink-0`}>
            <button type="button" onClick={copyDn} className={`text-xs ${idcsBtnGhost()}`}>
              {copied ? 'Copied DN' : 'Copy DN'}
            </button>
            {dn ? (
              <span className={`text-[11px] font-mono truncate max-w-full ${idcsCx.text3}`} title={dn}>
                {dn}
              </span>
            ) : null}
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

export function TabStrip({ tabs, value, onChange }) {
  return (
    <div className={`flex gap-1 overflow-x-auto pb-2 border-b ${idcsCx.border} shrink-0`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`text-xs px-3 py-1.5 rounded-md whitespace-nowrap font-medium transition-colors ${
            value === t.id
              ? 'bg-[color-mix(in_srgb,var(--accent)_22%,var(--bg3))] text-[var(--accent)]'
              : `${idcsCx.text2} hover:bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg3))]`
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
