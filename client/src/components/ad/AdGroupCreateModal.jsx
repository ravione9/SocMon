/**
 * Create an Active Directory group (security/distribution × global/domainLocal/universal).
 */

import { useState } from 'react'
import { createAdGroup } from '../../api/ad'
import { idcsCx, idcsBtnGhost, idcsBtnPrimary, idcsInputClass } from '../idcs/idcsTheme'
import { AdModalShell, ErrorBanner } from './adModalShared.jsx'
import AdOuPicker from './AdOuPicker.jsx'

export default function AdGroupCreateModal({ defaultParentDn = '', onClose, onCreated }) {
  const [form, setForm] = useState({
    parentDn: defaultParentDn || '',
    cn: '',
    samAccountName: '',
    description: '',
    mail: '',
    groupCategory: 'security',
    groupScope: 'global',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')

  const set = (key) => (e) => {
    const val = e?.target?.type === 'checkbox' ? e.target.checked : e?.target?.value ?? e
    setForm((f) => ({ ...f, [key]: val }))
  }
  const onCnBlur = () =>
    setForm((f) => (f.samAccountName ? f : { ...f, samAccountName: f.cn }))

  const submit = async () => {
    setErr('')
    setDone('')
    if (!form.parentDn) {
      setErr('Pick a destination OU.')
      return
    }
    if (!form.cn.trim()) {
      setErr('Group name (CN) is required.')
      return
    }
    setBusy(true)
    try {
      const r = await createAdGroup({
        parentDn: form.parentDn.trim(),
        cn: form.cn.trim(),
        samAccountName: form.samAccountName.trim() || form.cn.trim(),
        description: form.description.trim() || undefined,
        mail: form.mail.trim() || undefined,
        groupCategory: form.groupCategory,
        groupScope: form.groupScope,
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
    <AdModalShell title="Create group" subtitle="" monoChip="" dn={form.parentDn} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <div className={`text-xs font-semibold uppercase tracking-wide mb-1 ${idcsCx.text3}`}>Container</div>
          <AdOuPicker value={form.parentDn} onChange={(v) => setForm((f) => ({ ...f, parentDn: v }))} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block sm:col-span-2">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>Group name (CN) *</span>
            <input
              type="text"
              className={`mt-0.5 ${idcsInputClass('w-full')}`}
              value={form.cn}
              onChange={set('cn')}
              onBlur={onCnBlur}
              required
              autoComplete="off"
            />
          </label>
          <label className="block">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>Pre-Windows 2000 name (samAccountName)</span>
            <input
              type="text"
              className={`mt-0.5 ${idcsInputClass('w-full')}`}
              value={form.samAccountName}
              onChange={set('samAccountName')}
              autoComplete="off"
              placeholder="defaults to CN"
            />
          </label>
          <label className="block">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>E-mail</span>
            <input
              type="email"
              className={`mt-0.5 ${idcsInputClass('w-full')}`}
              value={form.mail}
              onChange={set('mail')}
              autoComplete="off"
            />
          </label>
          <label className="block sm:col-span-2">
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
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>Group type</span>
            <select
              value={form.groupCategory}
              onChange={set('groupCategory')}
              className={`mt-0.5 ${idcsInputClass('w-full')}`}
            >
              <option value="security">Security</option>
              <option value="distribution">Distribution</option>
            </select>
          </label>
          <label className="block">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>Group scope</span>
            <select
              value={form.groupScope}
              onChange={set('groupScope')}
              className={`mt-0.5 ${idcsInputClass('w-full')}`}
            >
              <option value="global">Global</option>
              <option value="domainLocal">Domain Local</option>
              <option value="universal">Universal</option>
            </select>
          </label>
        </div>
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
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      </div>
    </AdModalShell>
  )
}
