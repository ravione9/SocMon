/**
 * Active Directory user detail — property sheets + allow-listed edits + password/account actions.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  getAdUserDetail,
  getAdStatus,
  resetAdUserPassword,
  modifyAdUser,
  setAdUserAccount,
} from '../../api/ad'
import { idcsCx, idcsBtnGhost, idcsBtnPrimary, idcsInputClass } from '../idcs/idcsTheme'
import { computePasswordStrength, generateRandomPassword } from '../../utils/idcsStylePassword.js'

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'address', label: 'Address' },
  { id: 'organization', label: 'Organization' },
  { id: 'account', label: 'Account' },
  { id: 'profile', label: 'Profile' },
  { id: 'memberOf', label: 'Member Of' },
  { id: 'edit', label: 'Edit attributes' },
  { id: 'actions', label: 'Password & account' },
  { id: 'more', label: 'Object' },
]

/** Keys must match server AD_USER_PATCH_ATTRS */
const EDIT_FIELDS = [
  { key: 'displayName', label: 'Display name', section: 'General' },
  { key: 'givenName', label: 'First name', section: 'General' },
  { key: 'sn', label: 'Last name', section: 'General' },
  { key: 'initials', label: 'Initials', section: 'General' },
  { key: 'description', label: 'Description', section: 'General' },
  { key: 'mail', label: 'E-mail', section: 'General' },
  { key: 'telephoneNumber', label: 'Telephone', section: 'General' },
  { key: 'mobile', label: 'Mobile', section: 'General' },
  { key: 'physicalDeliveryOfficeName', label: 'Office', section: 'General' },
  { key: 'streetAddress', label: 'Street', section: 'Address' },
  { key: 'city', label: 'City', section: 'Address' },
  { key: 'state', label: 'State / province', section: 'Address' },
  { key: 'postalCode', label: 'ZIP / Postal code', section: 'Address' },
  { key: 'countryCode', label: 'Country code', section: 'Address' },
  { key: 'country', label: 'Country/region', section: 'Address' },
  { key: 'c', label: 'Country (ISO 2-letter)', section: 'Address' },
  { key: 'title', label: 'Title', section: 'Organization' },
  { key: 'department', label: 'Department', section: 'Organization' },
  { key: 'company', label: 'Company', section: 'Organization' },
  { key: 'manager', label: 'Manager DN', section: 'Organization' },
  { key: 'profilePath', label: 'Profile path', section: 'Profile' },
  { key: 'scriptPath', label: 'Logon script', section: 'Profile' },
  { key: 'homeDirectory', label: 'Home folder (local path)', section: 'Profile' },
  { key: 'homeDrive', label: 'Home drive', section: 'Profile' },
]

function emptyDraft() {
  return Object.fromEntries(EDIT_FIELDS.map((f) => [f.key, '']))
}

function draftFromDetail(detail) {
  const d = emptyDraft()
  if (!detail) return d
  const g = detail.general || {}
  const addr = detail.address || {}
  const org = detail.organization || {}
  const prof = detail.profile || {}
  d.displayName = g.displayName || ''
  d.givenName = g.givenName || ''
  d.sn = g.sn || ''
  d.initials = g.initials || ''
  d.description = g.description || ''
  d.mail = g.mail || ''
  d.telephoneNumber = g.telephoneNumber || ''
  d.mobile = g.mobile || ''
  d.physicalDeliveryOfficeName = g.physicalDeliveryOfficeName || ''
  d.streetAddress = addr.streetAddress || ''
  d.city = addr.city || ''
  d.state = addr.state || ''
  d.postalCode = addr.postalCode || ''
  d.countryCode = addr.countryCode || ''
  d.country = addr.country || ''
  d.c = ''
  d.title = org.title || ''
  d.department = org.department || ''
  d.company = org.company || ''
  d.manager = org.manager?.dn || ''
  d.profilePath = prof.profilePath || ''
  d.scriptPath = prof.scriptPath || ''
  d.homeDirectory = prof.homeDirectory || ''
  d.homeDrive = prof.homeDrive || ''
  return d
}

function fmtTs(iso) {
  if (!iso) return '—'
  try {
    const t = Date.parse(iso)
    if (!Number.isNaN(t)) return new Date(t).toLocaleString()
    return String(iso)
  } catch {
    return String(iso)
  }
}

function shortOuPath(dn) {
  if (!dn) return '—'
  const parts = String(dn).split(',').filter(Boolean)
  const named = parts.filter((p) => /^(OU|CN)=/i.test(p))
  if (!named.length) return dn
  return named.map((p) => p.replace(/^OU=|^CN=/i, '')).join(' / ')
}

function ActionNotice({ notice }) {
  if (!notice?.text) return null
  const ok = notice.type === 'success'
  return (
    <div
      role="status"
      aria-live="polite"
      className={`text-xs rounded-lg px-3 py-2 border ${idcsCx.border}`}
      style={{
        background: ok
          ? 'color-mix(in srgb, var(--green) 14%, var(--bg3))'
          : 'color-mix(in srgb, var(--red) 12%, var(--bg3))',
        color: ok ? 'var(--green)' : 'var(--red)',
      }}
    >
      {notice.text}
    </div>
  )
}

function DetailRows({ rows }) {
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

export default function AdUserDetailModal({
  dn,
  preview,
  shortOu: previewOu,
  initialTab: initialTabProp,
  onClose,
  onChanged,
}) {
  const [tab, setTab] = useState('general')
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [writesEnabled, setWritesEnabled] = useState(true)
  const [editDraft, setEditDraft] = useState(emptyDraft)
  const [editSaving, setEditSaving] = useState(false)
  const [editMsg, setEditMsg] = useState('')
  const [pwd1, setPwd1] = useState('')
  const [pwd2, setPwd2] = useState('')
  const [pwdMustChange, setPwdMustChange] = useState(false)
  const [pwdBusy, setPwdBusy] = useState(false)
  const [pwdNotice, setPwdNotice] = useState(null)
  const [pwdShow, setPwdShow] = useState(true)
  const [pwdNeedsAutoGen, setPwdNeedsAutoGen] = useState(true)
  const [acctBusy, setAcctBusy] = useState(false)
  const [acctNotice, setAcctNotice] = useState(null)
  /** Shown under modal header so password success is visible on every tab */
  const [passwordChangedAck, setPasswordChangedAck] = useState(false)
  const baselineRef = useRef(emptyDraft())

  const refreshDetail = useCallback(() => {
    return getAdUserDetail({ dn }).then((r) => {
      setDetail(r.detail || null)
      return r.detail
    })
  }, [dn])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setDetail(null)
    const tabFromProp =
      initialTabProp && TABS.some((t) => t.id === initialTabProp) ? initialTabProp : 'general'
    setTab(tabFromProp)
    setEditMsg('')
    setPwdNotice(null)
    setAcctNotice(null)
    setPasswordChangedAck(false)
    setPwd1('')
    setPwd2('')
    setPwdMustChange(false)
    setPwdShow(true)
    setPwdNeedsAutoGen(true)
    getAdUserDetail({ dn })
      .then((r) => {
        if (!cancelled) setDetail(r.detail || null)
      })
      .catch((e) => {
        if (!cancelled) {
          const d = e.response?.data
          setError(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [dn, initialTabProp])

  useEffect(() => {
    getAdStatus()
      .then((s) => setWritesEnabled(Boolean(s.adLdapWritesEnabled)))
      .catch(() => setWritesEnabled(true))
  }, [])

  useEffect(() => {
    if (!detail?.dn || !writesEnabled) return
    if (tab !== 'actions' || !pwdNeedsAutoGen) return
    const pw = generateRandomPassword()
    setPwd1(pw)
    setPwd2(pw)
    setPwdShow(true)
    setPwdNotice(null)
    setPwdNeedsAutoGen(false)
  }, [tab, detail?.dn, writesEnabled, pwdNeedsAutoGen])

  useEffect(() => {
    if (!detail) return
    const b = draftFromDetail(detail)
    baselineRef.current = b
    setEditDraft({ ...b })
  }, [detail])

  const headerTitle =
    detail?.general?.displayName ||
    preview?.displayName ||
    preview?.samAccountName ||
    detail?.general?.cn ||
    'User'

  const headerSub =
    detail?.general?.mail || preview?.mail || detail?.account?.userPrincipalName || preview?.upn || ''

  const copyDn = async () => {
    const text = detail?.dn || dn
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const applyPatch = async () => {
    if (!detail?.dn || !writesEnabled) return
    setEditSaving(true)
    setEditMsg('')
    const patch = {}
    const base = baselineRef.current || {}
    for (const f of EDIT_FIELDS) {
      const k = f.key
      const nv = editDraft[k] ?? ''
      const ov = base[k] ?? ''
      if (nv !== ov) patch[k] = nv
    }
    if (!Object.keys(patch).length) {
      setEditMsg('No changes to save.')
      setEditSaving(false)
      return
    }
    try {
      await modifyAdUser({ dn: detail.dn, patch })
      setEditMsg('Saved.')
      onChanged?.()
      await refreshDetail()
    } catch (e) {
      const d = e.response?.data
      setEditMsg(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
    } finally {
      setEditSaving(false)
    }
  }

  const applyGeneratedPassword = useCallback(() => {
    const pw = generateRandomPassword()
    setPwd1(pw)
    setPwd2(pw)
    setPwdShow(true)
    setPwdNotice(null)
    setPwdNeedsAutoGen(false)
  }, [])

  function noticeLine(code, errMsg) {
    const prefix = code ? `[${code}] ` : ''
    return `${prefix}${errMsg || 'Request failed'}`
  }

  const applyPassword = async () => {
    setAcctNotice(null)
    if (!detail?.dn) {
      setPwdNotice({ type: 'error', text: 'User details are still loading. Wait and try again.' })
      return
    }
    if (!writesEnabled) {
      setPwdNotice({
        type: 'error',
        text: 'LDAP writes are off on the server (AD_LDAP_WRITES). Password reset cannot run.',
      })
      return
    }
    setPwdNotice(null)
    if (pwd1 !== pwd2) {
      setPwdNotice({ type: 'error', text: 'Passwords do not match.' })
      return
    }
    if (!pwd1.length) {
      setPwdNotice({ type: 'error', text: 'Enter a new password.' })
      return
    }
    if (pwd1.length < 8) {
      setPwdNotice({ type: 'error', text: 'Password must be at least 8 characters.' })
      return
    }
    setPwdBusy(true)
    try {
      await resetAdUserPassword({
        dn: detail.dn,
        newPassword: pwd1,
        mustChangeNextLogon: pwdMustChange,
      })
      const userLabel =
        detail?.general?.displayName ||
        preview?.displayName ||
        detail?.account?.samAccountName ||
        preview?.samAccountName ||
        detail?.general?.cn ||
        'Account'
      setPwdNotice({
        type: 'success',
        text: pwdMustChange
          ? 'Password was reset. The user must pick a new password at next sign-in.'
          : 'Password was reset successfully.',
      })
      toast.success(
        pwdMustChange
          ? `Password updated in Active Directory for ${userLabel}. User must change password at next sign-in.`
          : `Password updated in Active Directory for ${userLabel}.`,
        { duration: 5000 },
      )
      setPasswordChangedAck(true)
      setPwdNeedsAutoGen(true)
      setPwd1('')
      setPwd2('')
      setPwdMustChange(false)
      onChanged?.()
      await refreshDetail()
    } catch (e) {
      const d = e.response?.data
      setPwdNotice({
        type: 'error',
        text: noticeLine(d?.code, d?.error || e.message),
      })
    } finally {
      setPwdBusy(false)
    }
  }

  const runAccount = async (body, successLabel) => {
    setPwdNotice(null)
    if (!detail?.dn) {
      setAcctNotice({ type: 'error', text: 'User details are still loading. Wait and try again.' })
      return
    }
    if (!writesEnabled) {
      setAcctNotice({
        type: 'error',
        text: 'LDAP writes are off on the server (AD_LDAP_WRITES). Account changes cannot run.',
      })
      return
    }
    setAcctBusy(true)
    setAcctNotice(null)
    try {
      await setAdUserAccount({ dn: detail.dn, ...body })
      setAcctNotice({
        type: 'success',
        text: successLabel || 'Account settings were updated in Active Directory.',
      })
      onChanged?.()
      await refreshDetail()
    } catch (e) {
      const d = e.response?.data
      setAcctNotice({
        type: 'error',
        text: noticeLine(d?.code, d?.error || e.message),
      })
    } finally {
      setAcctBusy(false)
    }
  }

  const g = detail?.general
  const addr = detail?.address
  const org = detail?.organization
  const acc = detail?.account
  const prof = detail?.profile
  const container = detail?.containerDn || previewOu || ''

  const writeGuard = !writesEnabled ? (
    <div
      className={`text-xs rounded-lg px-3 py-2 border mb-3 ${idcsCx.border}`}
      style={{ background: 'color-mix(in srgb, var(--amber) 14%, var(--bg3))', color: 'var(--amber)' }}
    >
      LDAP writes are disabled on the server (AD_LDAP_WRITES=off). Password reset and edits are blocked.
    </div>
  ) : null

  let body = null
  if (loading) {
    body = <p className={`text-sm ${idcsCx.text3}`}>Loading directory properties…</p>
  } else if (error) {
    body = (
      <div
        className={`text-sm rounded-lg px-3 py-2 border ${idcsCx.border}`}
        style={{
          background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))',
          color: 'var(--red)',
        }}
      >
        {error}
      </div>
    )
  } else if (detail) {
    const sections = [...new Set(EDIT_FIELDS.map((f) => f.section))]
    body = (
      <>
        {writeGuard}
        <div className={`flex gap-1 overflow-x-auto pb-2 border-b ${idcsCx.border} shrink-0`}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`text-xs px-3 py-1.5 rounded-md whitespace-nowrap font-medium transition-colors ${
                tab === t.id
                  ? 'bg-[color-mix(in_srgb,var(--accent)_22%,var(--bg3))] text-[var(--accent)]'
                  : `${idcsCx.text2} hover:bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg3))]`
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-4 min-h-[200px]">
          {tab === 'general' && (
            <DetailRows
              rows={[
                ['Display name', g?.displayName],
                ['First name', g?.givenName],
                ['Initials', g?.initials],
                ['Last name', g?.sn],
                ['Description', g?.description],
                ['Office', g?.physicalDeliveryOfficeName],
                ['E-mail', g?.mail],
                ['Aliases', Array.isArray(g?.proxyAddresses) && g.proxyAddresses.length ? g.proxyAddresses.join(', ') : null],
                ['Telephone', g?.telephoneNumber],
                ['Mobile', g?.mobile],
                ['Home phone', g?.homePhone],
                ['IP phone', g?.ipPhone],
                ['Fax', g?.facsimileTelephoneNumber],
                ['Other phones', Array.isArray(g?.otherTelephone) && g.otherTelephone.length ? g.otherTelephone.join(', ') : null],
              ]}
            />
          )}
          {tab === 'address' && (
            <DetailRows
              rows={[
                ['Street', addr?.streetAddress],
                ['City', addr?.city],
                ['State / province', addr?.state],
                ['ZIP / Postal code', addr?.postalCode],
                ['Country code', addr?.countryCode],
                ['Country/region', addr?.country || addr?.countryCode],
              ]}
            />
          )}
          {tab === 'organization' && (
            <DetailRows
              rows={[
                ['Title', org?.title],
                ['Department', org?.department],
                ['Company', org?.company],
                ['Manager', org?.manager ? `${org.manager.displayName}` : null],
                ['Manager DN', org?.manager?.dn],
              ]}
            />
          )}
          {tab === 'account' && (
            <DetailRows
              rows={[
                ['User logon name', acc?.userPrincipalName],
                ['Account expires', acc?.accountExpires == null ? 'Never' : fmtTs(acc.accountExpires)],
                ['SAM account name', acc?.samAccountName],
                ['Account status', acc?.disabled ? 'Disabled' : 'Enabled'],
                ['Locked', acc?.locked ? 'Yes' : 'No'],
                ['Smartcard required', acc?.smartcardRequired ? 'Yes' : 'No'],
                ['Password never expires', acc?.dontExpirePassword ? 'Yes' : 'No'],
                ['User must change password at next logon', acc?.passwordExpired ? 'Yes (pwdExpired flag)' : '—'],
                ['Password not required', acc?.passwordNotRequired ? 'Yes' : 'No'],
                ['Trusted for delegation', acc?.trustedForDelegation ? 'Yes' : 'No'],
                ['Last logon (timestamp)', fmtTs(acc?.lastLogonTimestamp)],
                ['Last logon (DC)', fmtTs(acc?.lastLogon)],
                ['Last logon (effective)', fmtTs(acc?.lastLogonEffective)],
                ['Password last set', fmtTs(acc?.pwdLastSet)],
                ['Bad password count', String(acc?.badPwdCount ?? '—')],
                ['Bad password time', fmtTs(acc?.badPasswordTime)],
                ['Logon count', acc?.logonCount != null ? String(acc.logonCount) : '—'],
                ['Primary group ID (RID)', acc?.primaryGroupId != null ? String(acc.primaryGroupId) : '—'],
                ['Created', fmtTs(acc?.whenCreated)],
                ['Modified', fmtTs(acc?.whenChanged)],
              ]}
            />
          )}
          {tab === 'profile' && (
            <DetailRows
              rows={[
                ['Profile path', prof?.profilePath],
                ['Logon script', prof?.scriptPath],
                ['Local path', prof?.homeDirectory],
                ['Connect drive', prof?.homeDrive],
              ]}
            />
          )}
          {tab === 'memberOf' && (
            <div className="space-y-3">
              {detail.primaryGroup && (
                <div>
                  <div className={`text-xs font-semibold uppercase tracking-wide mb-1 ${idcsCx.text3}`}>
                    Primary group
                  </div>
                  <div className={`rounded-lg border px-3 py-2 text-sm ${idcsCx.border} ${idcsCx.bg3}`}>
                    <div className={idcsCx.text}>{detail.primaryGroup.cn || detail.primaryGroup.samAccountName}</div>
                    <div className={`text-xs mt-0.5 font-mono break-all ${idcsCx.text3}`}>{detail.primaryGroup.dn}</div>
                  </div>
                </div>
              )}
              <div>
                <div className={`text-xs font-semibold uppercase tracking-wide mb-1 ${idcsCx.text3}`}>
                  Group membership ({detail.memberOf?.length ?? 0})
                </div>
                <div className={`max-h-52 overflow-y-auto rounded-lg border divide-y ${idcsCx.border} ${idcsCx.divide}`}>
                  {(detail.memberOf || []).length === 0 ? (
                    <div className={`px-3 py-4 text-sm text-center ${idcsCx.text3}`}>No memberOf entries returned.</div>
                  ) : (
                    detail.memberOf.map((gr) => (
                      <div key={gr.dn} className={`px-3 py-2 ${idcsCx.bg3}`}>
                        <div className={`text-sm ${idcsCx.text}`}>{gr.name}</div>
                        <div className={`text-[11px] font-mono break-all mt-0.5 ${idcsCx.text3}`}>{gr.dn}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
          {tab === 'edit' && (
            <div className="space-y-4">
              <p className={`text-xs ${idcsCx.text2}`}>
                Only attributes in this form are sent to the directory. Clearing a field removes that attribute when the
                server allows it. SAM account name / UPN changes are not exposed here.
              </p>
              {sections.map((section) => (
                <div key={section}>
                  <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${idcsCx.text3}`}>{section}</div>
                  <div className="space-y-2">
                    {EDIT_FIELDS.filter((f) => f.section === section).map((f) => (
                      <label key={f.key} className="block">
                        <span className={`text-[11px] font-medium ${idcsCx.text3}`}>{f.label}</span>
                        <input
                          type="text"
                          className={`mt-0.5 ${idcsInputClass('w-full')}`}
                          value={editDraft[f.key] ?? ''}
                          disabled={!writesEnabled || editSaving}
                          onChange={(e) => setEditDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                          autoComplete="off"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {editMsg && (
                <p className={`text-xs ${editMsg.startsWith('[') || editMsg.includes('failed') ? 'text-[var(--red)]' : idcsCx.text2}`}>
                  {editMsg}
                </p>
              )}
              <button
                type="button"
                disabled={!writesEnabled || editSaving}
                className={`text-sm ${idcsBtnPrimary()}`}
                onClick={applyPatch}
              >
                {editSaving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          )}
          {tab === 'actions' && (() => {
            const pwdStrength = computePasswordStrength(pwd1)
            return (
            <div className="space-y-6">
              <div className={`rounded-lg border p-4 space-y-3 ${idcsCx.border} ${idcsCx.bg3}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${idcsCx.text3}`}>Reset password</div>
                <p className={`text-xs ${idcsCx.text2}`}>
                  Requires LDAPS or StartTLS and directory permission to reset passwords.
                </p>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className={`block text-sm font-medium ${idcsCx.text}`}>New password</label>
                    <button
                      type="button"
                      onClick={applyGeneratedPassword}
                      disabled={!writesEnabled || pwdBusy || acctBusy}
                      className={`text-xs font-semibold shrink-0 px-2 py-1 rounded-md border ${idcsCx.border} ${idcsCx.bg2} hover:opacity-90 disabled:opacity-50`}
                      style={{ color: 'var(--accent)' }}
                    >
                      Generate password
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      type={pwdShow ? 'text' : 'password'}
                      className={idcsInputClass('w-full pr-10')}
                      placeholder="New password"
                      value={pwd1}
                      disabled={!writesEnabled || pwdBusy || acctBusy}
                      onChange={(e) => {
                        setPwd1(e.target.value)
                        setPwdNotice(null)
                      }}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setPwdShow((v) => !v)}
                      className={`absolute right-3 top-1/2 -translate-y-1/2 text-sm hover:opacity-90 ${idcsCx.text3}`}
                      tabIndex={-1}
                      aria-label={pwdShow ? 'Hide password' : 'Show password'}
                    >
                      {pwdShow ? '🙈' : '👁'}
                    </button>
                  </div>
                  {pwdStrength && (
                    <div className="mt-1.5">
                      <div className={`h-1.5 rounded-full overflow-hidden ${idcsCx.bg2}`}>
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ background: pwdStrength.bar, width: pwdStrength.pct }}
                        />
                      </div>
                      <p
                        className="text-xs mt-0.5 font-medium"
                        style={{
                          color:
                            pwdStrength.label === 'Weak'
                              ? 'var(--red)'
                              : pwdStrength.label === 'Fair'
                                ? 'var(--amber)'
                                : pwdStrength.label === 'Good'
                                  ? 'var(--accent)'
                                  : 'var(--green)',
                        }}
                      >
                        {pwdStrength.label}
                      </p>
                    </div>
                  )}
                </div>
                <div>
                  <label className={`block text-sm font-medium mb-1 ${idcsCx.text}`}>Confirm password</label>
                  <input
                    type={pwdShow ? 'text' : 'password'}
                    className={idcsInputClass('w-full')}
                    placeholder="Confirm password"
                    value={pwd2}
                    disabled={!writesEnabled || pwdBusy || acctBusy}
                    onChange={(e) => {
                      setPwd2(e.target.value)
                      setPwdNotice(null)
                    }}
                    autoComplete="new-password"
                  />
                </div>
                <label className={`flex items-center gap-2 text-xs ${idcsCx.text2}`}>
                  <input
                    type="checkbox"
                    checked={pwdMustChange}
                    disabled={!writesEnabled || pwdBusy || acctBusy}
                    onChange={(e) => setPwdMustChange(e.target.checked)}
                  />
                  User must change password at next logon
                </label>
                <ActionNotice notice={pwdNotice} />
                <button
                  type="button"
                  disabled={!writesEnabled || pwdBusy || acctBusy}
                  className={`text-sm ${idcsBtnPrimary()}`}
                  onClick={applyPassword}
                >
                  {pwdBusy ? 'Applying…' : 'Set password'}
                </button>
              </div>

              <div className={`rounded-lg border p-4 space-y-3 ${idcsCx.border} ${idcsCx.bg3}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${idcsCx.text3}`}>Account control</div>
                <p className={`text-xs leading-relaxed ${idcsCx.text2}`}>
                  Actions apply immediately in AD (subject to LDAP writes). Unlock clears lockout from failed logons.
                  Disable blocks sign-in; Enable restores it. &quot;Require password change…&quot; sets the flag without changing the password here.
                  Password never expires toggles the &quot;don&apos;t expire&quot; flag (matches Account tab).
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!writesEnabled || acctBusy || pwdBusy || !acc?.locked}
                    title={!acc?.locked ? 'Account is not locked.' : 'Clear lockout (failed logon threshold).'}
                    className={`text-xs ${idcsBtnGhost()}`}
                    onClick={() =>
                      runAccount({ unlock: true }, 'Account unlocked — lockout counters cleared in Active Directory.')
                    }
                  >
                    Unlock account
                  </button>
                  <button
                    type="button"
                    disabled={!writesEnabled || acctBusy || pwdBusy || acc?.disabled}
                    title={acc?.disabled ? 'Account is already disabled.' : 'Prevent this user from signing in.'}
                    className={`text-xs ${idcsBtnGhost()}`}
                    onClick={() => {
                      if (!window.confirm('Disable this account in Active Directory?')) return
                      runAccount({ disabled: true }, 'Account disabled — user cannot sign in until re-enabled.')
                    }}
                  >
                    Disable account
                  </button>
                  <button
                    type="button"
                    disabled={!writesEnabled || acctBusy || pwdBusy || !acc?.disabled}
                    title={!acc?.disabled ? 'Account is already enabled.' : 'Allow this user to sign in again.'}
                    className={`text-xs ${idcsBtnGhost()}`}
                    onClick={() =>
                      runAccount({ disabled: false }, 'Account enabled — user can sign in (subject to lockout/password policy).')
                    }
                  >
                    Enable account
                  </button>
                  <button
                    type="button"
                    disabled={!writesEnabled || acctBusy || pwdBusy}
                    title='Sets pwdLastSet so Windows asks for a new password at next logon — does not set a password now.'
                    className={`text-xs ${idcsBtnGhost()}`}
                    onClick={() => {
                      if (!window.confirm('Set "must change password at next logon" without changing password now?')) return
                      runAccount(
                        { mustChangePassword: true },
                        '"Must change password at next logon" is now set in Active Directory.',
                      )
                    }}
                  >
                    Require password change at next logon
                  </button>
                  <button
                    type="button"
                    disabled={!writesEnabled || acctBusy || pwdBusy || acc?.dontExpirePassword}
                    title={
                      acc?.dontExpirePassword
                        ? 'Already set — password policy will not force expiry for this user.'
                        : 'Turn on “password never expires” for this account.'
                    }
                    className={`text-xs ${idcsBtnGhost()}`}
                    onClick={() =>
                      runAccount(
                        { dontExpirePassword: true },
                        '"Password never expires" is now enabled for this account.',
                      )
                    }
                  >
                    Set password never expires
                  </button>
                  <button
                    type="button"
                    disabled={!writesEnabled || acctBusy || pwdBusy || !acc?.dontExpirePassword}
                    title={
                      !acc?.dontExpirePassword
                        ? 'Not set — nothing to clear.'
                        : 'Restore normal domain password expiry policy for this user.'
                    }
                    className={`text-xs ${idcsBtnGhost()}`}
                    onClick={() =>
                      runAccount(
                        { dontExpirePassword: false },
                        '"Password never expires" has been cleared — domain expiry rules apply again.',
                      )
                    }
                  >
                    Clear password never expires
                  </button>
                </div>
                <ActionNotice notice={acctNotice} />
              </div>
            </div>
            )
          })()}
          {tab === 'more' && (
            <div className="space-y-4">
              <DetailRows
                rows={[
                  ['Distinguished name', detail.dn],
                  ['Current container', shortOuPath(container)],
                  ['Container DN', container],
                ]}
              />
              <p className={`text-xs ${idcsCx.text3}`}>
                Moving an object to another OU uses LDAP <code className="font-mono">modrdn</code> with a new superior —
                not wired here yet to avoid accidental mass moves.
              </p>
            </div>
          )}
        </div>
      </>
    )
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
        aria-labelledby="ad-user-detail-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="px-5 py-4 flex items-start justify-between gap-3 shrink-0"
          style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent2))' }}
        >
          <div className="min-w-0 pr-2 flex-1">
            <h2 id="ad-user-detail-title" className="font-semibold text-lg text-[var(--on-accent)] truncate">
              {headerTitle}
            </h2>
            {headerSub ? (
              <p className="text-xs opacity-90 text-[var(--on-accent)] mt-1 break-all">{headerSub}</p>
            ) : null}
            <p className="text-[11px] opacity-85 text-[var(--on-accent)] mt-1 font-mono break-all" title={dn}>
              {preview?.samAccountName || detail?.account?.samAccountName || '—'}
            </p>
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

        {passwordChangedAck && (
          <div role="status" aria-live="polite" className="shrink-0 px-5 pt-3 border-b border-[color-mix(in_srgb,var(--green)_35%,var(--border))] bg-[color-mix(in_srgb,var(--green)_12%,var(--bg2))]">
            <div className="flex items-center justify-between gap-3 pb-3">
              <p className="text-sm font-semibold" style={{ color: 'var(--green)' }}>
                Password has been changed.
              </p>
              <button
                type="button"
                onClick={() => setPasswordChangedAck(false)}
                className="text-xs font-medium shrink-0 underline opacity-90 hover:opacity-100"
                style={{ color: 'var(--green)' }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <div className="p-5 overflow-y-auto flex-1 flex flex-col">
          <div className={`flex flex-wrap items-center gap-2 mb-3 shrink-0`}>
            <button type="button" onClick={copyDn} className={`text-xs ${idcsBtnGhost()}`}>
              {copied ? 'Copied DN' : 'Copy DN'}
            </button>
            {!loading && !error && detail?.dn ? (
              <span className={`text-[11px] font-mono truncate max-w-full ${idcsCx.text3}`} title={detail.dn}>
                {detail.dn}
              </span>
            ) : null}
          </div>
          {body}
        </div>
      </div>
    </div>
  )
}
