/**
 * Active Directory audit trail.
 *
 * Lists every mutation written to the ad_audit_logs Mongo collection by
 * routes/ad.js. Supports filtering by action / status / free-text +
 * pagination, and exports the current filtered slice to CSV. Detail
 * column shows a compact summary per action, with the raw details
 * payload available on a per-row toggle (so passwords stay redacted on
 * the wire AND in the UI).
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { listAdAudit } from '../../api/ad'
import { idcsCx, idcsBtnGhost, idcsBtnPrimary, idcsInputClass } from '../idcs/idcsTheme'
import { fmtTs, shortOuPath } from './adModalShared'

const PAGE_SIZE = 50

const ACTION_LABELS = {
  AD_USER_CREATE:             'Create user',
  AD_USER_MODIFY:             'Modify user',
  AD_USER_PASSWORD_RESET:     'Reset password',
  AD_USER_ACCOUNT_FLAGS:      'User account flags',
  AD_USER_MOVE:               'Move user',
  AD_GROUP_CREATE:            'Create group',
  AD_GROUP_MODIFY:            'Modify group',
  AD_GROUP_MEMBER_ADD:        'Add group members',
  AD_GROUP_MEMBER_REMOVE:     'Remove group members',
  AD_COMPUTER_MODIFY:         'Modify computer',
  AD_COMPUTER_ACCOUNT_FLAGS:  'Computer account flags',
  AD_OU_CREATE:               'Create OU',
  AD_OU_MODIFY:               'Modify OU',
}

function actionLabel(action) {
  return ACTION_LABELS[action] || String(action || '')
}

function actorLabel(performedBy) {
  if (!performedBy) return '—'
  return performedBy.email || performedBy.username || performedBy.userId || '—'
}

function targetLabel(target) {
  if (!target) return '—'
  if (target.dn)   return shortOuPath(target.dn)
  if (target.name) return target.name
  return '—'
}

// Compact human summary per action — keeps the table scannable. The full
// details JSON is available via the toggle row.
function detailSummary(entry) {
  const d = entry.details || {}
  switch (entry.action) {
    case 'AD_USER_PASSWORD_RESET':
      return d.mustChangeNextLogon ? 'Must change at next logon' : 'Password set'
    case 'AD_USER_MODIFY':
    case 'AD_GROUP_MODIFY':
    case 'AD_COMPUTER_MODIFY':
    case 'AD_OU_MODIFY': {
      const fields = Array.isArray(d.fields) ? d.fields : []
      return fields.length ? `Fields: ${fields.join(', ')}` : '—'
    }
    case 'AD_USER_ACCOUNT_FLAGS': {
      const bits = []
      if (d.unlock) bits.push('unlock')
      if (d.disabled === true) bits.push('disable')
      if (d.disabled === false) bits.push('enable')
      if (d.mustChangePassword) bits.push('must change pwd')
      if (d.dontExpirePassword === true) bits.push('don’t expire pwd')
      if (d.dontExpirePassword === false) bits.push('expire pwd')
      return bits.length ? bits.join(', ') : '—'
    }
    case 'AD_USER_MOVE':
      return d.toParent ? `→ ${shortOuPath(d.toParent)}` : '—'
    case 'AD_USER_CREATE':
      return d.samAccountName || d.userPrincipalName || d.displayName || '—'
    case 'AD_GROUP_CREATE':
      return [d.samAccountName, d.groupScope, d.groupCategory].filter(Boolean).join(' · ') || '—'
    case 'AD_GROUP_MEMBER_ADD':
    case 'AD_GROUP_MEMBER_REMOVE':
      return typeof d.count === 'number' ? `${d.count} member${d.count === 1 ? '' : 's'}` : '—'
    case 'AD_COMPUTER_ACCOUNT_FLAGS':
      if (d.disabled === true) return 'disable'
      if (d.disabled === false) return 'enable'
      return '—'
    case 'AD_OU_CREATE':
      return d.name || '—'
    default:
      return '—'
  }
}

function statusBadge(status) {
  const isOk = status === 'SUCCESS'
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border"
      style={{
        background: `color-mix(in srgb, var(${isOk ? '--green' : '--red'}) 14%, transparent)`,
        borderColor: `color-mix(in srgb, var(${isOk ? '--green' : '--red'}) 32%, transparent)`,
        color: `var(${isOk ? '--green' : '--red'})`,
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: `var(${isOk ? '--green' : '--red'})` }}
      />
      {status}
    </span>
  )
}

function csvCell(v) {
  if (v == null) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(filename, labels, rows, keyMaps) {
  const lines = [
    labels.map(csvCell).join(','),
    ...rows.map((row) => keyMaps.map((mapFn) => csvCell(mapFn(row))).join(',')),
  ]
  const blob = new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function AdAuditPanel() {
  const [filters, setFilters] = useState({ action: '', status: '', q: '' })
  const [page, setPage] = useState(1)
  const [data, setData] = useState({ logs: [], total: 0, actions: [] })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [expandedId, setExpandedId] = useState(null)

  const fetchPage = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const params = { page, limit: PAGE_SIZE }
      if (filters.action) params.action = filters.action
      if (filters.status) params.status = filters.status
      if (filters.q)      params.q = filters.q
      const r = await listAdAudit(params)
      setData({
        logs: r.logs || [],
        total: r.total || 0,
        actions: r.actions || [],
      })
    } catch (e) {
      const d = e.response?.data
      setErr(d?.error || e.message || 'Failed to load audit log')
    } finally {
      setLoading(false)
    }
  }, [filters.action, filters.status, filters.q, page])

  useEffect(() => {
    fetchPage()
  }, [fetchPage])

  // Reset to page 1 whenever a filter changes (so we don't sit on page 7
  // of an empty result set after narrowing the query).
  const setFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
    setPage(1)
  }

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
  const showing = data.logs.length
  const rangeStart = data.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const rangeEnd = (page - 1) * PAGE_SIZE + showing

  const actionOptions = useMemo(() => {
    return [{ value: '', label: 'All actions' }, ...data.actions.map((a) => ({ value: a, label: actionLabel(a) }))]
  }, [data.actions])

  const exportCsv = () => {
    if (!data.logs.length) return
    downloadCsv(
      `ad-audit-page${page}.csv`,
      ['Time', 'Actor', 'Action', 'Target DN', 'Target name', 'Status', 'Error code', 'IP', 'Details'],
      data.logs,
      [
        (r) => fmtTs(r.createdAt),
        (r) => actorLabel(r.performedBy),
        (r) => actionLabel(r.action),
        (r) => r.target?.dn || '',
        (r) => r.target?.name || '',
        (r) => r.status,
        (r) => r.errorCode || '',
        (r) => r.ipAddress || '',
        (r) => r.details || '',
      ],
    )
  }

  return (
    <div className="space-y-4">
      <p className={`text-sm ${idcsCx.text2}`}>
        Every directory mutation performed through Netpulse — create / modify / move / password reset / group membership / OU changes — is recorded here with the actor, target DN, status, and IP. Secrets like passwords are stripped before the entry is written.
      </p>

      {/* Filters */}
      <div className={`rounded-xl border p-4 flex flex-wrap items-end gap-3 ${idcsCx.border} ${idcsCx.bg2}`}>
        <label className={`text-sm ${idcsCx.text}`}>
          <span className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${idcsCx.text3}`}>Action</span>
          <select
            value={filters.action}
            onChange={(e) => setFilter('action', e.target.value)}
            className={idcsInputClass()}
            style={{ minWidth: 220 }}
          >
            {actionOptions.map((opt) => (
              <option key={opt.value || 'all'} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>

        <label className={`text-sm ${idcsCx.text}`}>
          <span className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${idcsCx.text3}`}>Status</span>
          <select
            value={filters.status}
            onChange={(e) => setFilter('status', e.target.value)}
            className={idcsInputClass()}
            style={{ minWidth: 140 }}
          >
            <option value="">All</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILED">Failed</option>
          </select>
        </label>

        <label className={`text-sm flex-1 ${idcsCx.text}`} style={{ minWidth: 220 }}>
          <span className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${idcsCx.text3}`}>Search</span>
          <input
            type="search"
            placeholder="Actor email, target DN or name…"
            value={filters.q}
            onChange={(e) => setFilter('q', e.target.value)}
            className={idcsInputClass()}
          />
        </label>

        <button type="button" disabled={loading} className={`text-sm ${idcsBtnPrimary()}`} onClick={fetchPage}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button
          type="button"
          disabled={!data.logs.length}
          className={`text-sm ${idcsBtnGhost()}`}
          onClick={exportCsv}
        >
          Export CSV
        </button>
      </div>

      {err && (
        <div
          className={`text-sm rounded-lg px-4 py-3 border whitespace-pre-wrap ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {err}
        </div>
      )}

      {/* Result meta + pagination */}
      <div className={`flex flex-wrap items-center justify-between gap-3 text-xs ${idcsCx.text3}`}>
        <div>
          {data.total === 0
            ? loading ? 'Loading…' : 'No audit entries match the current filters.'
            : `Showing ${rangeStart}–${rangeEnd} of ${data.total} · Page ${page} of ${totalPages}`}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={loading || page <= 1}
            className={`px-3 py-1.5 rounded-md text-sm border ${idcsCx.border} ${idcsCx.bg3} ${idcsCx.text2} disabled:opacity-50`}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ‹ Prev
          </button>
          <button
            type="button"
            disabled={loading || page >= totalPages}
            className={`px-3 py-1.5 rounded-md text-sm border ${idcsCx.border} ${idcsCx.bg3} ${idcsCx.text2} disabled:opacity-50`}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next ›
          </button>
        </div>
      </div>

      <div className={`rounded-xl border overflow-hidden ${idcsCx.border}`}>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className={`${idcsCx.bg3} text-xs uppercase tracking-wide ${idcsCx.text3}`}>
              <tr>
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Time</th>
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Actor</th>
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Action</th>
                <th className="px-3 py-2 text-left font-semibold">Target</th>
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Status</th>
                <th className="px-3 py-2 text-left font-semibold">Details</th>
              </tr>
            </thead>
            <tbody className={idcsCx.divide}>
              {data.logs.map((entry) => {
                const id = String(entry._id)
                const expanded = expandedId === id
                return (
                  <Fragment key={id}>
                    <tr
                      className={`border-t ${idcsCx.border} cursor-pointer hover:bg-[var(--bg3)]`}
                      onClick={() => setExpandedId(expanded ? null : id)}
                      title="Click to view raw details"
                    >
                      <td className={`px-3 py-2 align-top whitespace-nowrap ${idcsCx.text2}`}>{fmtTs(entry.createdAt)}</td>
                      <td className={`px-3 py-2 align-top whitespace-nowrap ${idcsCx.text}`}>{actorLabel(entry.performedBy)}</td>
                      <td className={`px-3 py-2 align-top whitespace-nowrap ${idcsCx.text}`}>{actionLabel(entry.action)}</td>
                      <td className={`px-3 py-2 align-top break-all ${idcsCx.text2}`} title={entry.target?.dn || ''}>
                        {targetLabel(entry.target)}
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap">{statusBadge(entry.status)}</td>
                      <td className={`px-3 py-2 align-top ${idcsCx.text2}`}>{detailSummary(entry)}</td>
                    </tr>
                    {expanded && (
                      <tr className={idcsCx.bg3}>
                        <td colSpan={6} className="px-3 py-3">
                          <pre
                            className={`text-xs whitespace-pre-wrap break-all rounded-md border p-3 ${idcsCx.border} ${idcsCx.bg2} ${idcsCx.text2}`}
                            style={{ maxHeight: 260, overflow: 'auto' }}
                          >
{JSON.stringify(
  {
    _id: entry._id,
    createdAt: entry.createdAt,
    action: entry.action,
    status: entry.status,
    performedBy: entry.performedBy,
    target: entry.target,
    errorCode: entry.errorCode || null,
    ipAddress: entry.ipAddress || null,
    details: entry.details || null,
  },
  null,
  2,
)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        {!loading && data.logs.length === 0 && (
          <div className={`px-4 py-10 text-center text-sm ${idcsCx.text3}`}>
            No audit entries yet. Directory changes made through Netpulse — create / modify / move users, password resets, group membership, OU edits — will appear here.
          </div>
        )}
      </div>
    </div>
  )
}
