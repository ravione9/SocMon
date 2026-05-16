/**
 * Active Directory computer detail — properties, account flags, member-of, edit description.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAdComputerDetail,
  getAdStatus,
  modifyAdComputer,
  setAdComputerAccount,
} from '../../api/ad'
import { idcsCx, idcsBtnGhost, idcsBtnPrimary, idcsInputClass } from '../idcs/idcsTheme'
import {
  AdModalShell,
  DetailRows,
  ErrorBanner,
  TabStrip,
  WriteDisabledBanner,
  fmtTs,
  shortOuPath,
} from './adModalShared.jsx'

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'os', label: 'Operating system' },
  { id: 'account', label: 'Account' },
  { id: 'memberOf', label: 'Member Of' },
  { id: 'spn', label: 'SPNs' },
  { id: 'edit', label: 'Edit attributes' },
  { id: 'actions', label: 'Actions' },
  { id: 'more', label: 'Object' },
]

const EDIT_FIELDS = [
  { key: 'displayName', label: 'Display name' },
  { key: 'description', label: 'Description' },
  { key: 'location', label: 'Location' },
  { key: 'managedBy', label: 'Managed by (DN)' },
]

function emptyDraft() {
  return Object.fromEntries(EDIT_FIELDS.map((f) => [f.key, '']))
}

function draftFromDetail(detail) {
  const d = emptyDraft()
  if (!detail) return d
  const g = detail.general || {}
  d.displayName = g.displayName || ''
  d.description = g.description || ''
  d.location = g.location || ''
  d.managedBy = detail.managedBy?.dn || ''
  return d
}

export default function AdComputerDetailModal({ dn, preview, onClose, onChanged }) {
  const [tab, setTab] = useState('general')
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [writesEnabled, setWritesEnabled] = useState(true)
  const [editDraft, setEditDraft] = useState(emptyDraft)
  const [editSaving, setEditSaving] = useState(false)
  const [editMsg, setEditMsg] = useState('')
  const [acctBusy, setAcctBusy] = useState(false)
  const [acctMsg, setAcctMsg] = useState('')
  const baselineRef = useRef(emptyDraft())

  const refreshDetail = useCallback(() => {
    return getAdComputerDetail({ dn }).then((r) => {
      setDetail(r.detail || null)
      return r.detail
    })
  }, [dn])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setDetail(null)
    setTab('general')
    setEditMsg('')
    setAcctMsg('')
    getAdComputerDetail({ dn })
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
  }, [dn])

  useEffect(() => {
    getAdStatus()
      .then((s) => setWritesEnabled(Boolean(s.adLdapWritesEnabled)))
      .catch(() => setWritesEnabled(true))
  }, [])

  useEffect(() => {
    if (!detail) return
    const b = draftFromDetail(detail)
    baselineRef.current = b
    setEditDraft({ ...b })
  }, [detail])

  const headerTitle = detail?.general?.name || preview?.name || preview?.cn || 'Computer'
  const headerSub = detail?.general?.dnsHostName || preview?.dnsHostName || ''
  const monoChip = detail?.account?.samAccountName || preview?.samAccountName || ''

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
      await modifyAdComputer({ dn: detail.dn, patch })
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

  const setDisabled = async (disabled) => {
    if (!detail?.dn || !writesEnabled) return
    if (disabled && !window.confirm('Disable this computer account?')) return
    setAcctBusy(true)
    setAcctMsg('')
    try {
      await setAdComputerAccount({ dn: detail.dn, disabled })
      setAcctMsg(disabled ? 'Computer account disabled.' : 'Computer account enabled.')
      onChanged?.()
      await refreshDetail()
    } catch (e) {
      const d = e.response?.data
      setAcctMsg(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
    } finally {
      setAcctBusy(false)
    }
  }

  let body = null
  if (loading) {
    body = <p className={`text-sm ${idcsCx.text3}`}>Loading computer details…</p>
  } else if (error) {
    body = <ErrorBanner text={error} />
  } else if (detail) {
    const g = detail.general
    const acc = detail.account
    body = (
      <>
        <WriteDisabledBanner writesEnabled={writesEnabled} />
        <TabStrip tabs={TABS} value={tab} onChange={setTab} />
        <div className="mt-4 space-y-4 min-h-[200px]">
          {tab === 'general' && (
            <DetailRows
              rows={[
                ['Computer name', g?.name],
                ['Display name', g?.displayName],
                ['Description', g?.description],
                ['DNS host name', g?.dnsHostName],
                ['Location', g?.location],
                ['Managed by', detail.managedBy ? detail.managedBy.displayName : null],
                ['Container', shortOuPath(detail.containerDn)],
              ]}
            />
          )}
          {tab === 'os' && (
            <DetailRows
              rows={[
                ['Operating system', g?.os],
                ['OS version', g?.osVersion],
                ['OS service pack', g?.osServicePack],
              ]}
            />
          )}
          {tab === 'account' && (
            <DetailRows
              rows={[
                ['SAM account name', acc?.samAccountName],
                ['Account status', acc?.disabled ? 'Disabled' : 'Enabled'],
                ['Trusted for delegation', acc?.trustedForDelegation ? 'Yes' : 'No'],
                ['Password last set', fmtTs(acc?.pwdLastSet)],
                ['Last logon (DC)', fmtTs(acc?.lastLogon)],
                ['Last logon (timestamp)', fmtTs(acc?.lastLogonTimestamp)],
                ['Logon count', acc?.logonCount != null ? String(acc.logonCount) : '—'],
                ['Created', fmtTs(acc?.whenCreated)],
                ['Modified', fmtTs(acc?.whenChanged)],
              ]}
            />
          )}
          {tab === 'memberOf' && (
            <div className={`max-h-72 overflow-y-auto rounded-lg border divide-y ${idcsCx.border} ${idcsCx.divide}`}>
              {(detail.memberOf || []).length === 0 ? (
                <div className={`px-3 py-6 text-sm text-center ${idcsCx.text3}`}>No memberOf entries returned.</div>
              ) : (
                detail.memberOf.map((gr) => (
                  <div key={gr.dn} className={`px-3 py-2 ${idcsCx.bg3}`}>
                    <div className={`text-sm ${idcsCx.text}`}>{gr.name}</div>
                    <div className={`text-[11px] font-mono break-all mt-0.5 ${idcsCx.text3}`}>{gr.dn}</div>
                  </div>
                ))
              )}
            </div>
          )}
          {tab === 'spn' && (
            <div className={`max-h-72 overflow-y-auto rounded-lg border divide-y ${idcsCx.border} ${idcsCx.divide}`}>
              {(detail.servicePrincipalNames || []).length === 0 ? (
                <div className={`px-3 py-6 text-sm text-center ${idcsCx.text3}`}>No service principal names.</div>
              ) : (
                detail.servicePrincipalNames.map((spn) => (
                  <div key={spn} className={`px-3 py-2 text-[12px] font-mono break-all ${idcsCx.bg3} ${idcsCx.text2}`}>
                    {spn}
                  </div>
                ))
              )}
            </div>
          )}
          {tab === 'edit' && (
            <div className="space-y-3">
              <p className={`text-xs ${idcsCx.text2}`}>
                Editable computer attributes. Empty value removes the attribute when allowed by the schema.
              </p>
              {EDIT_FIELDS.map((f) => (
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
              {editMsg && (
                <p className={`text-xs ${editMsg.startsWith('[') ? 'text-[var(--red)]' : idcsCx.text2}`}>{editMsg}</p>
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
          {tab === 'actions' && (
            <div className={`rounded-lg border p-4 space-y-3 ${idcsCx.border} ${idcsCx.bg3}`}>
              <div className={`text-xs font-semibold uppercase tracking-wide ${idcsCx.text3}`}>Computer account</div>
              <p className={`text-xs ${idcsCx.text2}`}>
                Disabling a computer account prevents the machine from authenticating to the domain. Re-enable from here
                or from ADUC.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!writesEnabled || acctBusy || acc?.disabled}
                  className={`text-xs ${idcsBtnGhost()}`}
                  onClick={() => setDisabled(true)}
                >
                  Disable account
                </button>
                <button
                  type="button"
                  disabled={!writesEnabled || acctBusy || !acc?.disabled}
                  className={`text-xs ${idcsBtnGhost()}`}
                  onClick={() => setDisabled(false)}
                >
                  Enable account
                </button>
              </div>
              {acctMsg && (
                <p className={`text-xs ${acctMsg.startsWith('[') ? 'text-[var(--red)]' : idcsCx.text2}`}>{acctMsg}</p>
              )}
            </div>
          )}
          {tab === 'more' && (
            <DetailRows
              rows={[
                ['Distinguished name', detail.dn],
                ['Current container', shortOuPath(detail.containerDn)],
                ['Container DN', detail.containerDn],
              ]}
            />
          )}
        </div>
      </>
    )
  }

  return (
    <AdModalShell title={headerTitle} subtitle={headerSub} monoChip={monoChip} dn={detail?.dn || dn} onClose={onClose}>
      {body}
    </AdModalShell>
  )
}
