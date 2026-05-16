/**
 * Active Directory OU / container detail — properties, child counts, edit description / address / managedBy.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getAdOuDetail, getAdStatus, modifyAdOu } from '../../api/ad'
import { idcsCx, idcsBtnPrimary, idcsInputClass } from '../idcs/idcsTheme'
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
  { id: 'address', label: 'Address' },
  { id: 'edit', label: 'Edit attributes' },
  { id: 'more', label: 'Object' },
]

const EDIT_FIELDS = [
  { key: 'description', label: 'Description', section: 'General' },
  { key: 'managedBy', label: 'Managed by (DN)', section: 'General' },
  { key: 'street', label: 'Street', section: 'Address' },
  { key: 'city', label: 'City', section: 'Address' },
  { key: 'state', label: 'State / province', section: 'Address' },
  { key: 'postalCode', label: 'ZIP / Postal code', section: 'Address' },
  { key: 'country', label: 'Country (2-letter code)', section: 'Address' },
]

function emptyDraft() {
  return Object.fromEntries(EDIT_FIELDS.map((f) => [f.key, '']))
}

function draftFromDetail(detail) {
  const d = emptyDraft()
  if (!detail) return d
  const g = detail.general || {}
  d.description = g.description || ''
  d.street = g.street || ''
  d.city = g.city || ''
  d.state = g.state || ''
  d.postalCode = g.postalCode || ''
  d.country = g.country || ''
  d.managedBy = detail.managedBy?.dn || ''
  return d
}

export default function AdOuDetailModal({ dn, preview, onClose, onChanged }) {
  const [tab, setTab] = useState('general')
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [writesEnabled, setWritesEnabled] = useState(true)
  const [editDraft, setEditDraft] = useState(emptyDraft)
  const [editSaving, setEditSaving] = useState(false)
  const [editMsg, setEditMsg] = useState('')
  const baselineRef = useRef(emptyDraft())

  const refreshDetail = useCallback(() => {
    return getAdOuDetail({ dn }).then((r) => {
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
    getAdOuDetail({ dn })
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

  const isContainer = !!detail?.isContainer
  const headerTitle = detail?.general?.name || preview?.name || (isContainer ? 'Container' : 'Organizational Unit')
  const headerSub = detail?.general?.description || preview?.description || ''
  const monoChip = isContainer ? 'CN container' : 'Organizational Unit'

  const applyPatch = async () => {
    if (!detail?.dn || !writesEnabled || isContainer) return
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
      await modifyAdOu({ dn: detail.dn, patch })
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

  let body = null
  if (loading) {
    body = <p className={`text-sm ${idcsCx.text3}`}>Loading container details…</p>
  } else if (error) {
    body = <ErrorBanner text={error} />
  } else if (detail) {
    const g = detail.general
    const c = detail.counts || {}
    const containerNote = isContainer ? (
      <div
        className={`text-[11px] rounded-lg px-3 py-2 border ${idcsCx.border}`}
        style={{ background: 'color-mix(in srgb, var(--amber) 10%, var(--bg3))', color: 'var(--amber)' }}
      >
        Built-in containers (CN=…) cannot be edited from Netpulse.
      </div>
    ) : null

    body = (
      <>
        <WriteDisabledBanner writesEnabled={writesEnabled} />
        <TabStrip tabs={TABS} value={tab} onChange={setTab} />
        <div className="mt-4 space-y-4 min-h-[200px]">
          {tab === 'general' && (
            <>
              <DetailRows
                rows={[
                  ['Name', g?.name],
                  ['Description', g?.description],
                  ['Managed by', detail.managedBy ? detail.managedBy.displayName : null],
                  ['Managed by DN', detail.managedBy?.dn],
                  ['GPO linked', detail.gpoLinked ? 'Yes' : 'No'],
                  ['Created', fmtTs(detail.whenCreated)],
                  ['Modified', fmtTs(detail.whenChanged)],
                  ['Parent container', shortOuPath(detail.containerDn)],
                ]}
              />
              <DetailRows
                rows={[
                  ['Direct child users', c.users != null ? String(c.users) : '—'],
                  ['Direct child groups', c.groups != null ? String(c.groups) : '—'],
                  ['Direct child computers', c.computers != null ? String(c.computers) : '—'],
                  ['Direct child OUs', c.organizationalUnits != null ? String(c.organizationalUnits) : '—'],
                ]}
              />
            </>
          )}
          {tab === 'address' && (
            <DetailRows
              rows={[
                ['Street', g?.street],
                ['City', g?.city],
                ['State / province', g?.state],
                ['ZIP / Postal code', g?.postalCode],
                ['Country (2-letter)', g?.country],
              ]}
            />
          )}
          {tab === 'edit' && (
            <div className="space-y-3">
              {containerNote}
              <p className={`text-xs ${idcsCx.text2}`}>
                Editable container attributes. Empty value removes the attribute when allowed by the schema.
              </p>
              {[...new Set(EDIT_FIELDS.map((f) => f.section))].map((section) => (
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
                          disabled={!writesEnabled || editSaving || isContainer}
                          onChange={(e) => setEditDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                          autoComplete="off"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {editMsg && (
                <p className={`text-xs ${editMsg.startsWith('[') ? 'text-[var(--red)]' : idcsCx.text2}`}>{editMsg}</p>
              )}
              <button
                type="button"
                disabled={!writesEnabled || editSaving || isContainer}
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
                ['Type', isContainer ? 'Container (CN=)' : 'Organizational Unit (OU=)'],
                ['Parent container', shortOuPath(detail.containerDn)],
                ['Parent DN', detail.containerDn],
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
