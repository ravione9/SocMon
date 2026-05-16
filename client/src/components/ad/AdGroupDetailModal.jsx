/**
 * Active Directory group detail — properties, members, member-of, edit + member add/remove.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAdGroupDetail,
  getAdStatus,
  modifyAdGroup,
  addAdGroupMembers,
  removeAdGroupMembers,
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
  { id: 'members', label: 'Members' },
  { id: 'memberOf', label: 'Member Of' },
  { id: 'edit', label: 'Edit attributes' },
  { id: 'more', label: 'Object' },
]

const EDIT_FIELDS = [
  { key: 'displayName', label: 'Display name' },
  { key: 'description', label: 'Description' },
  { key: 'mail', label: 'E-mail' },
  { key: 'notes', label: 'Notes (info)' },
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
  d.mail = g.mail || ''
  d.notes = g.notes || ''
  d.managedBy = detail.managedBy?.dn || ''
  return d
}

export default function AdGroupDetailModal({ dn, preview, onClose, onChanged }) {
  const [tab, setTab] = useState('general')
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [writesEnabled, setWritesEnabled] = useState(true)
  const [editDraft, setEditDraft] = useState(emptyDraft)
  const [editSaving, setEditSaving] = useState(false)
  const [editMsg, setEditMsg] = useState('')
  const [addText, setAddText] = useState('')
  const [memberBusy, setMemberBusy] = useState(false)
  const [memberMsg, setMemberMsg] = useState('')
  const [memberFilter, setMemberFilter] = useState('')
  const baselineRef = useRef(emptyDraft())

  const refreshDetail = useCallback(() => {
    return getAdGroupDetail({ dn }).then((r) => {
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
    setMemberMsg('')
    setAddText('')
    getAdGroupDetail({ dn })
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

  const headerTitle =
    detail?.general?.displayName || detail?.general?.cn || preview?.displayName || preview?.samAccountName || 'Group'
  const headerSub = detail?.general?.description || preview?.description || ''
  const monoChip = detail?.general?.samAccountName || preview?.samAccountName || ''

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
      await modifyAdGroup({ dn: detail.dn, patch })
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

  const addMembers = async () => {
    if (!detail?.dn || !writesEnabled) return
    const raw = addText.trim()
    if (!raw) {
      setMemberMsg('Paste one or more distinguished names (one per line).')
      return
    }
    setMemberBusy(true)
    setMemberMsg('')
    try {
      const r = await addAdGroupMembers({ dn: detail.dn, members: raw })
      setMemberMsg(`Added ${r.added ?? ''} member(s).`.trim())
      setAddText('')
      onChanged?.()
      await refreshDetail()
    } catch (e) {
      const d = e.response?.data
      setMemberMsg(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
    } finally {
      setMemberBusy(false)
    }
  }

  const removeMember = async (memberDn) => {
    if (!detail?.dn || !writesEnabled) return
    if (!window.confirm(`Remove this member from ${detail.general?.cn || 'group'}?\n${memberDn}`)) return
    setMemberBusy(true)
    setMemberMsg('')
    try {
      await removeAdGroupMembers({ dn: detail.dn, members: [memberDn] })
      setMemberMsg('Member removed.')
      onChanged?.()
      await refreshDetail()
    } catch (e) {
      const d = e.response?.data
      setMemberMsg(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
    } finally {
      setMemberBusy(false)
    }
  }

  const filteredMembers = (() => {
    const list = detail?.members || []
    const q = memberFilter.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (m) =>
        String(m.displayName || '').toLowerCase().includes(q) ||
        String(m.samAccountName || '').toLowerCase().includes(q) ||
        String(m.dn || '').toLowerCase().includes(q),
    )
  })()

  let body = null
  if (loading) {
    body = <p className={`text-sm ${idcsCx.text3}`}>Loading group details…</p>
  } else if (error) {
    body = <ErrorBanner text={error} />
  } else if (detail) {
    const g = detail.general
    body = (
      <>
        <WriteDisabledBanner writesEnabled={writesEnabled} />
        <TabStrip tabs={TABS} value={tab} onChange={setTab} />
        <div className="mt-4 space-y-4 min-h-[200px]">
          {tab === 'general' && (
            <DetailRows
              rows={[
                ['Group name', g?.cn],
                ['Display name', g?.displayName],
                ['Pre-Windows 2000 name', g?.samAccountName],
                ['Description', g?.description],
                ['Notes', g?.notes],
                ['E-mail', g?.mail],
                ['Group type', g?.type],
                ['Group scope', g?.scope],
                ['Managed by', detail.managedBy ? detail.managedBy.displayName : null],
                ['Managed by DN', detail.managedBy?.dn],
                ['Created', fmtTs(detail.whenCreated)],
                ['Modified', fmtTs(detail.whenChanged)],
                ['Container', shortOuPath(detail.containerDn)],
              ]}
            />
          )}
          {tab === 'members' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="search"
                  placeholder="Filter members…"
                  value={memberFilter}
                  onChange={(e) => setMemberFilter(e.target.value)}
                  className={idcsInputClass('max-w-xs')}
                />
                <span className={`text-xs ${idcsCx.text3}`}>
                  {filteredMembers.length} / {detail.memberCount ?? 0}
                </span>
              </div>
              <div className={`max-h-72 overflow-y-auto rounded-lg border divide-y ${idcsCx.border} ${idcsCx.divide}`}>
                {filteredMembers.length === 0 ? (
                  <div className={`px-3 py-6 text-sm text-center ${idcsCx.text3}`}>
                    {detail.memberCount === 0 ? 'No members.' : 'No members match the filter.'}
                  </div>
                ) : (
                  filteredMembers.map((m) => (
                    <div
                      key={m.dn}
                      className={`flex items-center justify-between gap-3 px-3 py-2 ${idcsCx.bg3}`}
                    >
                      <div className="min-w-0">
                        <div className={`text-sm ${idcsCx.text}`}>
                          {m.displayName || m.dn}
                          {m.category && (
                            <span className={`ml-2 text-[10px] uppercase ${idcsCx.text3}`}>{m.category}</span>
                          )}
                        </div>
                        <div className={`text-[11px] font-mono break-all mt-0.5 ${idcsCx.text3}`}>{m.dn}</div>
                      </div>
                      <button
                        type="button"
                        disabled={!writesEnabled || memberBusy}
                        onClick={() => removeMember(m.dn)}
                        className={`text-xs shrink-0 ${idcsBtnGhost()}`}
                      >
                        Remove
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className={`rounded-lg border p-3 space-y-2 ${idcsCx.border} ${idcsCx.bg3}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${idcsCx.text3}`}>Add members</div>
                <p className={`text-[11px] ${idcsCx.text2}`}>
                  Paste one distinguished name per line (e.g. <code className="font-mono">CN=User,OU=Users,DC=corp,DC=example,DC=com</code>).
                </p>
                <textarea
                  rows={3}
                  value={addText}
                  disabled={!writesEnabled || memberBusy}
                  onChange={(e) => setAddText(e.target.value)}
                  className={`${idcsInputClass('w-full font-mono text-xs')} resize-y`}
                />
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    disabled={!writesEnabled || memberBusy || !addText.trim()}
                    onClick={addMembers}
                    className={`text-sm ${idcsBtnPrimary()}`}
                  >
                    {memberBusy ? 'Working…' : 'Add to group'}
                  </button>
                  {memberMsg && (
                    <span className={`text-xs ${memberMsg.startsWith('[') ? 'text-[var(--red)]' : idcsCx.text2}`}>
                      {memberMsg}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
          {tab === 'memberOf' && (
            <div className={`max-h-72 overflow-y-auto rounded-lg border divide-y ${idcsCx.border} ${idcsCx.divide}`}>
              {(detail.memberOf || []).length === 0 ? (
                <div className={`px-3 py-6 text-sm text-center ${idcsCx.text3}`}>This group is not a member of any group.</div>
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
          {tab === 'edit' && (
            <div className="space-y-3">
              <p className={`text-xs ${idcsCx.text2}`}>
                Only attributes in this form are sent to the directory. Empty value removes the attribute when allowed.
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
          {tab === 'more' && (
            <DetailRows
              rows={[
                ['Distinguished name', detail.dn],
                ['Current container', shortOuPath(detail.containerDn)],
                ['Container DN', detail.containerDn],
                ['Member count', String(detail.memberCount ?? 0)],
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
