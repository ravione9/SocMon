/**
 * Create an Active Directory organizational unit under a parent OU/container.
 */

import { useState } from 'react'
import { createAdOu } from '../../api/ad'
import { idcsCx, idcsBtnGhost, idcsBtnPrimary, idcsInputClass } from '../idcs/idcsTheme'
import { AdModalShell, ErrorBanner } from './adModalShared.jsx'
import AdOuPicker from './AdOuPicker.jsx'

export default function AdOuCreateModal({ defaultParentDn = '', onClose, onCreated }) {
  const [form, setForm] = useState({
    parentDn: defaultParentDn || '',
    name: '',
    description: '',
    managedBy: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e?.target?.value ?? e }))
  }

  const submit = async () => {
    setErr('')
    setDone('')
    if (!form.parentDn) {
      setErr('Pick a parent OU/container.')
      return
    }
    if (!form.name.trim()) {
      setErr('OU name is required.')
      return
    }
    setBusy(true)
    try {
      const r = await createAdOu({
        parentDn: form.parentDn.trim(),
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        managedBy: form.managedBy.trim() || undefined,
      })
      setDone(`Created ${r.dn}.`)
      onCreated?.(r.dn || null)
    } catch (e) {
      const d = e.response?.data
      setErr(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdModalShell title="Create organizational unit" subtitle="" monoChip="" dn={form.parentDn} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <div className={`text-xs font-semibold uppercase tracking-wide mb-1 ${idcsCx.text3}`}>Parent container</div>
          <AdOuPicker value={form.parentDn} onChange={(v) => setForm((f) => ({ ...f, parentDn: v }))} />
        </div>
        <label className="block">
          <span className={`text-[11px] font-medium ${idcsCx.text3}`}>OU name *</span>
          <input
            type="text"
            className={`mt-0.5 ${idcsInputClass('w-full')}`}
            value={form.name}
            onChange={set('name')}
            placeholder="e.g. Finance"
            required
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className={`text-[11px] font-medium ${idcsCx.text3}`}>Description</span>
          <input
            type="text"
            className={`mt-0.5 ${idcsInputClass('w-full')}`}
            value={form.description}
            onChange={set('description')}
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className={`text-[11px] font-medium ${idcsCx.text3}`}>Managed by (DN, optional)</span>
          <input
            type="text"
            className={`mt-0.5 ${idcsInputClass('w-full font-mono text-xs')}`}
            value={form.managedBy}
            onChange={set('managedBy')}
            autoComplete="off"
            placeholder="CN=Owner,OU=Users,DC=corp,DC=example,DC=com"
          />
        </label>
        <ErrorBanner text={err} />
        {done && (
          <div
            className={`text-xs rounded-lg px-3 py-2 border ${idcsCx.border}`}
            style={{ background: 'color-mix(in srgb, var(--green) 12%, var(--bg3))', color: 'var(--green)' }}
          >
            {done}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={`text-sm ${idcsBtnGhost()}`} onClick={onClose} disabled={busy}>
            Close
          </button>
          <button type="button" className={`text-sm ${idcsBtnPrimary()}`} onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create OU'}
          </button>
        </div>
      </div>
    </AdModalShell>
  )
}
