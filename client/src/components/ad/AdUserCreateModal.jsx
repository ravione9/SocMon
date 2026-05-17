/**
 * Create an AD user. Two-step UI (Identity → Account & options) shown inline.
 */

import { useCallback, useState } from 'react'
import { createAdUser } from '../../api/ad'
import { idcsCx, idcsBtnGhost, idcsBtnPrimary, idcsInputClass } from '../idcs/idcsTheme'
import { AdModalShell, ErrorBanner } from './adModalShared.jsx'
import AdOuPicker from './AdOuPicker.jsx'
import { computePasswordStrength, generateRandomPassword } from '../../utils/idcsStylePassword.js'

function deriveUpn(sam, upnSuffix) {
  if (!sam || !upnSuffix) return ''
  return `${sam}@${upnSuffix.replace(/^@/, '')}`
}

export default function AdUserCreateModal({ defaultParentDn = '', domainFqdn = '', onClose, onCreated }) {
  const [form, setForm] = useState({
    parentDn: defaultParentDn || '',
    samAccountName: '',
    cn: '',
    displayName: '',
    givenName: '',
    sn: '',
    userPrincipalName: '',
    mail: '',
    description: '',
    password: '',
    confirmPassword: '',
    enabled: true,
    dontExpirePassword: false,
    mustChangeNextLogon: false,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')
  const [pwdShow, setPwdShow] = useState(true)

  const applyGeneratedPassword = useCallback(() => {
    const pw = generateRandomPassword()
    setForm((f) => ({ ...f, password: pw, confirmPassword: pw }))
    setErr('')
    setPwdShow(true)
  }, [])

  const set = (key) => (e) => {
    const val = e?.target?.type === 'checkbox' ? e.target.checked : e?.target?.value ?? e
    setForm((f) => ({ ...f, [key]: val }))
  }

  const onSamBlur = () => {
    setForm((f) => {
      const next = { ...f }
      if (!next.cn) next.cn = next.displayName || next.samAccountName
      if (!next.userPrincipalName && domainFqdn) {
        next.userPrincipalName = deriveUpn(next.samAccountName, domainFqdn)
      }
      return next
    })
  }

  const submit = async () => {
    setErr('')
    setDone('')
    if (!form.parentDn) {
      setErr('Pick a destination OU.')
      return
    }
    if (!form.samAccountName.trim()) {
      setErr('samAccountName is required.')
      return
    }
    if (!form.cn.trim() && !form.displayName.trim()) {
      setErr('Enter at least Display name or CN.')
      return
    }
    if (form.password && form.password !== form.confirmPassword) {
      setErr('Password and confirmation do not match.')
      return
    }
    if (form.password && form.password.length < 8) {
      setErr('Password must be at least 8 characters.')
      return
    }
    if (form.enabled && !form.password) {
      setErr('Set a password to create an enabled account (otherwise uncheck Enabled).')
      return
    }
    setBusy(true)
    try {
      const r = await createAdUser({
        parentDn: form.parentDn.trim(),
        samAccountName: form.samAccountName.trim(),
        cn: form.cn.trim() || form.displayName.trim() || form.samAccountName.trim(),
        displayName: form.displayName.trim() || undefined,
        givenName: form.givenName.trim() || undefined,
        sn: form.sn.trim() || undefined,
        userPrincipalName: form.userPrincipalName.trim() || undefined,
        mail: form.mail.trim() || undefined,
        description: form.description.trim() || undefined,
        password: form.password || undefined,
        enabled: form.enabled,
        dontExpirePassword: form.dontExpirePassword,
        mustChangeNextLogon: form.mustChangeNextLogon,
      })
      setDone(`Created ${r.dn || form.samAccountName}.`)
      onCreated?.(r.dn || null)
    } catch (e) {
      const d = e.response?.data
      setErr(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdModalShell
      title="Create user"
      subtitle={domainFqdn ? `Domain: ${domainFqdn}` : ''}
      monoChip={''}
      dn={form.parentDn}
      onClose={onClose}
    >
      <div className="space-y-4">
        <div>
          <div className={`text-xs font-semibold uppercase tracking-wide mb-1 ${idcsCx.text3}`}>Destination OU</div>
          <AdOuPicker value={form.parentDn} onChange={(v) => setForm((f) => ({ ...f, parentDn: v }))} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>First name</span>
            <input type="text" className={`mt-0.5 ${idcsInputClass('w-full')}`} value={form.givenName} onChange={set('givenName')} autoComplete="off" />
          </label>
          <label className="block">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>Last name</span>
            <input type="text" className={`mt-0.5 ${idcsInputClass('w-full')}`} value={form.sn} onChange={set('sn')} autoComplete="off" />
          </label>
          <label className="block sm:col-span-2">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>Display name</span>
            <input type="text" className={`mt-0.5 ${idcsInputClass('w-full')}`} value={form.displayName} onChange={set('displayName')} autoComplete="off" />
          </label>
          <label className="block">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>SAM account name *</span>
            <input
              type="text"
              className={`mt-0.5 ${idcsInputClass('w-full')}`}
              value={form.samAccountName}
              onChange={set('samAccountName')}
              onBlur={onSamBlur}
              required
              autoComplete="off"
              placeholder="e.g. jdoe"
            />
          </label>
          <label className="block">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>User principal name (UPN)</span>
            <input type="text" className={`mt-0.5 ${idcsInputClass('w-full')}`} value={form.userPrincipalName} onChange={set('userPrincipalName')} placeholder="user@corp.example.com" autoComplete="off" />
          </label>
          <label className="block">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>CN (folder name)</span>
            <input type="text" className={`mt-0.5 ${idcsInputClass('w-full')}`} value={form.cn} onChange={set('cn')} autoComplete="off" placeholder="defaults to Display name" />
          </label>
          <label className="block">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>E-mail</span>
            <input type="email" className={`mt-0.5 ${idcsInputClass('w-full')}`} value={form.mail} onChange={set('mail')} autoComplete="off" />
          </label>
          <label className="block sm:col-span-2">
            <span className={`text-[11px] font-medium ${idcsCx.text3}`}>Description</span>
            <input type="text" className={`mt-0.5 ${idcsInputClass('w-full')}`} value={form.description} onChange={set('description')} autoComplete="off" />
          </label>
        </div>

        <div className={`rounded-lg border p-3 space-y-2 ${idcsCx.border} ${idcsCx.bg3}`}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className={`text-xs font-semibold uppercase tracking-wide ${idcsCx.text3}`}>Password</div>
            <button
              type="button"
              onClick={applyGeneratedPassword}
              disabled={busy}
              className={`text-xs font-semibold px-2 py-1 rounded-md border ${idcsCx.border} ${idcsCx.bg2} hover:opacity-90 disabled:opacity-50`}
              style={{ color: 'var(--accent)' }}
            >
              Generate password
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="relative">
              <input
                type={pwdShow ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Password"
                className={idcsInputClass('w-full pr-10')}
                value={form.password}
                onChange={set('password')}
              />
              <button
                type="button"
                className={`absolute right-2 top-1/2 -translate-y-1/2 text-sm ${idcsCx.text3}`}
                tabIndex={-1}
                onClick={() => setPwdShow((v) => !v)}
              >
                {pwdShow ? '🙈' : '👁'}
              </button>
            </div>
            <input
              type={pwdShow ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="Confirm password"
              className={idcsInputClass('w-full')}
              value={form.confirmPassword}
              onChange={set('confirmPassword')}
            />
          </div>
          {(() => {
            const st = computePasswordStrength(form.password)
            if (!st) return null
            return (
              <div className="mt-1">
                <div className={`h-1.5 rounded-full overflow-hidden ${idcsCx.bg2}`}>
                  <div className="h-full rounded-full transition-all" style={{ background: st.bar, width: st.pct }} />
                </div>
                <p className={`text-[11px] mt-0.5 font-medium ${idcsCx.text3}`}>{st.label}</p>
              </div>
            )
          })()}
          <p className={`text-[11px] ${idcsCx.text3}`}>Sets <code className="font-mono">unicodePwd</code> over your encrypted LDAP session.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label className={`flex items-center gap-2 text-xs ${idcsCx.text2}`}>
            <input type="checkbox" checked={form.enabled} onChange={set('enabled')} />
            Enable account on creation
          </label>
          <label className={`flex items-center gap-2 text-xs ${idcsCx.text2}`}>
            <input type="checkbox" checked={form.dontExpirePassword} onChange={set('dontExpirePassword')} />
            Password never expires
          </label>
          <label className={`flex items-center gap-2 text-xs ${idcsCx.text2}`}>
            <input type="checkbox" checked={form.mustChangeNextLogon} onChange={set('mustChangeNextLogon')} />
            Must change password at next logon
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
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </div>
    </AdModalShell>
  )
}
