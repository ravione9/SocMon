/**
 * Move an AD user (or other object) to a different OU/container.
 */

import { useState } from 'react'
import { moveAdUser } from '../../api/ad'
import { idcsCx, idcsBtnGhost, idcsBtnPrimary } from '../idcs/idcsTheme'
import { AdModalShell, ErrorBanner } from './adModalShared.jsx'
import AdOuPicker from './AdOuPicker.jsx'

function parentDnOf(dn) {
  if (!dn) return ''
  const idx = String(dn).indexOf(',')
  return idx >= 0 ? dn.slice(idx + 1) : ''
}

export default function AdUserMoveModal({ dn, preview, onClose, onMoved }) {
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')

  const currentParent = parentDnOf(dn)

  const apply = async () => {
    if (!target) {
      setErr('Select a destination OU.')
      return
    }
    setBusy(true)
    setErr('')
    setDone('')
    try {
      const r = await moveAdUser({ dn, newParentDn: target })
      setDone(`Moved successfully. New DN:\n${r.dn || `(under ${target})`}`)
      onMoved?.(r.dn || null)
    } catch (e) {
      const d = e.response?.data
      setErr(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdModalShell
      title="Move to OU"
      subtitle={preview?.displayName || preview?.samAccountName || ''}
      monoChip={preview?.samAccountName || ''}
      dn={dn}
      onClose={onClose}
    >
      <div className="space-y-3">
        <div className={`rounded-lg border px-3 py-2 text-xs ${idcsCx.border} ${idcsCx.bg3}`}>
          <div className={idcsCx.text3}>Current container</div>
          <div className={`mt-0.5 font-mono break-all ${idcsCx.text}`}>{currentParent || '—'}</div>
        </div>

        <div className={`text-xs font-semibold uppercase tracking-wide ${idcsCx.text3}`}>Destination</div>
        <AdOuPicker value={target} onChange={setTarget} excludeDn={currentParent} />

        <ErrorBanner text={err} />
        {done && (
          <pre
            className={`text-xs whitespace-pre-wrap rounded-lg border px-3 py-2 ${idcsCx.border}`}
            style={{
              background: 'color-mix(in srgb, var(--green) 12%, var(--bg3))',
              color: 'var(--green)',
            }}
          >
            {done}
          </pre>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" className={`text-sm ${idcsBtnGhost()}`} onClick={onClose} disabled={busy}>
            Close
          </button>
          <button type="button" className={`text-sm ${idcsBtnPrimary()}`} onClick={apply} disabled={busy || !target}>
            {busy ? 'Moving…' : 'Move'}
          </button>
        </div>
      </div>
    </AdModalShell>
  )
}
