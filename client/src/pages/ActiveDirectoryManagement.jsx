/** Active Directory management UI (server-side LDAP configuration). */

import { Children, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  getAdStatus,
  getAdStats,
  diagnoseAd,
  testAdUserBind,
  listAdUsers,
  listAdGroups,
  listAdComputers,
  listAdOus,
} from '../api/ad'
import {
  idcsCx,
  idcsInputClass,
  idcsBtnPrimary,
  idcsBtnGhost,
} from '../components/idcs/idcsTheme'
import AdUserDetailModal from '../components/ad/AdUserDetailModal.jsx'
import AdGroupDetailModal from '../components/ad/AdGroupDetailModal.jsx'
import AdComputerDetailModal from '../components/ad/AdComputerDetailModal.jsx'
import AdOuDetailModal from '../components/ad/AdOuDetailModal.jsx'
import AdUserMoveModal from '../components/ad/AdUserMoveModal.jsx'
import AdUserCreateModal from '../components/ad/AdUserCreateModal.jsx'
import AdGroupCreateModal from '../components/ad/AdGroupCreateModal.jsx'
import AdOuCreateModal from '../components/ad/AdOuCreateModal.jsx'
import AdBulkPanel from '../components/ad/AdBulkPanel.jsx'
import AdReportsPanel from '../components/ad/AdReportsPanel.jsx'

const NAV_GROUPS = [
  {
    title: 'Management',
    items: [
      { id: 'overview', label: 'Overview', icon: '📊', hint: 'Domain dashboard & KPIs' },
      { id: 'users', label: 'Users', icon: '👤', hint: 'Accounts, unlock, password expiry' },
      { id: 'groups', label: 'Groups', icon: '🗂️', hint: 'Security & distribution groups' },
      { id: 'computers', label: 'Computers', icon: '💻', hint: 'Workstations & servers' },
      { id: 'ous', label: 'Organizational Units', icon: '🌳', hint: 'OU hierarchy & delegation' },
    ],
  },
  {
    title: 'Automation',
    items: [{ id: 'bulk', label: 'Bulk management', icon: '📦', hint: 'CSV modify / templates' }],
  },
  {
    title: 'Compliance',
    items: [
      { id: 'reports', label: 'Reports', icon: '📑', hint: 'Pre-built exportable reports' },
      { id: 'audit', label: 'Audit trail', icon: '📋', hint: 'Directory change history' },
    ],
  },
]

function StatTile({ icon, label, value, sub, accent = 'var(--accent)', onClick }) {
  const clickable = Boolean(onClick)
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={onClick}
      className={`text-left rounded-xl border p-4 transition-opacity ${idcsCx.border} ${idcsCx.bg3} ${
        clickable ? 'hover:opacity-95 cursor-pointer' : 'opacity-90 cursor-default'
      }`}
      style={{
        background: clickable
          ? `color-mix(in srgb, ${accent} 12%, var(--bg3))`
          : undefined,
      }}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl select-none">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-2xl font-bold tabular-nums" style={{ color: accent }}>
            {value ?? <span className={`text-lg animate-pulse ${idcsCx.text3}`}>—</span>}
          </div>
          <div className={`text-xs font-semibold uppercase tracking-wide mt-1 ${idcsCx.text2}`}>{label}</div>
          {sub && <div className={`text-xs mt-0.5 ${idcsCx.text3}`}>{sub}</div>}
        </div>
      </div>
    </button>
  )
}

function PlaceholderTable({ columns, emptyTitle, emptyBody }) {
  return (
    <div className={`rounded-xl border overflow-hidden ${idcsCx.border}`}>
      <table className="min-w-full text-sm">
        <thead className={`${idcsCx.bg3} text-xs uppercase tracking-wide ${idcsCx.text3}`}>
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-4 py-3 text-left font-semibold">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={columns.length} className={`px-6 py-16 text-center ${idcsCx.text3}`}>
              <div className={`text-base font-medium ${idcsCx.text}`}>{emptyTitle}</div>
              <p className="text-sm mt-2 max-w-lg mx-auto">{emptyBody}</p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function ConnectionDiagnosticsPanel({ canTest }) {
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState(null)
  const [err, setErr] = useState('')

  const run = async () => {
    setRunning(true)
    setErr('')
    setReport(null)
    try {
      const r = await diagnoseAd()
      setReport(r.report)
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Diagnose failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className={`rounded-xl border p-5 ${idcsCx.border} ${idcsCx.bg2}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className={`text-sm font-semibold ${idcsCx.text}`}>Test directory connection</h3>
          <p className={`text-sm mt-0.5 ${idcsCx.text2}`}>
            DNS, TCP, TLS, and LDAP bind checks for each configured endpoint.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={!canTest || running}
          className={`text-sm ${idcsBtnPrimary()}`}
        >
          {running ? 'Running…' : 'Run test'}
        </button>
      </div>

      {err && (
        <div
          className={`mt-4 text-sm rounded-lg px-4 py-3 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {err}
        </div>
      )}

      {report && (
        <div className="mt-4 space-y-3">
          <div
            className={`rounded-lg px-4 py-3 text-sm border ${idcsCx.border}`}
            style={{
              background: report.ok
                ? 'color-mix(in srgb, var(--green) 12%, var(--bg3))'
                : 'color-mix(in srgb, var(--amber) 14%, var(--bg3))',
              color: report.ok ? 'var(--green)' : 'var(--amber)',
            }}
          >
            <strong>{report.ok ? '✓ All checks passed' : '✗ One or more checks failed'}</strong>
            <div className={`mt-1 ${idcsCx.text2}`}>{report.summary}</div>
          </div>

          <ul className={`rounded-lg border divide-y ${idcsCx.border} ${idcsCx.divide} overflow-hidden`}>
            {report.steps.map((s) => (
              <li
                key={s.id}
                className={`flex items-start gap-3 px-4 py-2.5 text-sm ${idcsCx.bg3}`}
              >
                <span
                  className="mt-0.5 shrink-0 font-bold tabular-nums"
                  style={{ color: s.ok ? 'var(--green)' : 'var(--red)' }}
                >
                  {s.ok ? '✓' : '✗'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={`font-medium ${idcsCx.text}`}>{s.label}</div>
                  <div className={`text-xs mt-0.5 break-words ${idcsCx.text3}`}>{s.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function useDebounced(value, delay = 350) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return v
}

function StatusPill({ tone = 'green', children }) {
  const map = {
    green: { bg: 'color-mix(in srgb, var(--green) 16%, var(--bg3))', fg: 'var(--green)' },
    red: { bg: 'color-mix(in srgb, var(--red) 16%, var(--bg3))', fg: 'var(--red)' },
    amber: { bg: 'color-mix(in srgb, var(--amber) 16%, var(--bg3))', fg: 'var(--amber)' },
    accent: { bg: 'color-mix(in srgb, var(--accent) 16%, var(--bg3))', fg: 'var(--accent)' },
    muted: { bg: 'var(--bg3)', fg: 'var(--text2)' },
  }
  const c = map[tone] || map.muted
  return (
    <span
      className="text-[11px] px-2 py-0.5 rounded font-medium border border-[var(--border)]"
      style={{ background: c.bg, color: c.fg }}
    >
      {children}
    </span>
  )
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return String(iso)
  }
}

function shortOu(dn) {
  if (!dn) return '—'
  const parts = String(dn).split(',').filter(Boolean)
  const named = parts.filter((p) => /^(OU|CN)=/i.test(p))
  if (!named.length) return dn
  return named.map((p) => p.replace(/^OU=|^CN=/i, '')).slice(0, 3).join(' / ')
}

function TableShell({ columns, loading, empty, children, count, truncated }) {
  const rowCount = typeof count === 'number' ? count : Children.count(children)
  const showEmptyRow = !loading && rowCount === 0

  return (
    <div className={`rounded-xl border overflow-hidden ${idcsCx.border}`}>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className={`${idcsCx.bg3} text-xs uppercase tracking-wide ${idcsCx.text3}`}>
            <tr>
              {columns.map((c) => (
                <th key={c} className="px-4 py-3 text-left font-semibold whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={`divide-y ${idcsCx.divide}`}>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className={`text-center py-10 ${idcsCx.text3}`}>
                  Loading…
                </td>
              </tr>
            ) : showEmptyRow ? (
              <tr>
                <td colSpan={columns.length} className={`text-center py-10 ${idcsCx.text3}`}>
                  {empty ?? 'No results.'}
                </td>
              </tr>
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
      {!loading && typeof count === 'number' && count > 0 && (
        <div
          className={`px-4 py-2 text-xs border-t ${idcsCx.border} ${idcsCx.bg3} flex items-center justify-between`}
        >
          <span className={idcsCx.text3}>{count} row{count !== 1 ? 's' : ''}</span>
          {truncated && (
            <StatusPill tone="amber">Result capped — narrow your search to see more</StatusPill>
          )}
        </div>
      )}
    </div>
  )
}

const USER_STATUS_FILTERS = [
  { id: 'all', label: 'All statuses', test: () => true },
  { id: 'enabled', label: 'Enabled only', test: (u) => !u.disabled },
  { id: 'disabled', label: 'Disabled only', test: (u) => u.disabled },
  { id: 'locked', label: 'Locked', test: (u) => u.locked },
  { id: 'pwdExpired', label: 'Password expired', test: (u) => u.passwordExpired },
  { id: 'pwdNoExpiry', label: 'Password never expires', test: (u) => u.dontExpirePassword },
]

function csvCell(v) {
  if (v == null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(filename, rows) {
  const csv = rows.map((cols) => cols.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function UsersPanel({ statusFilterDefault = 'all', domainFqdn = '', domainUsersTotal = null }) {
  const [search, setSearch] = useState('')
  const debounced = useDebounced(search)
  const [data, setData] = useState({ users: [], total: 0, truncated: false, searchBase: '' })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [selectedUser, setSelectedUser] = useState(null)
  const [moveTarget, setMoveTarget] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState(statusFilterDefault)
  const [ouFilter, setOuFilter] = useState('all')
  /** Fixed-position portal menu — absolute dropdown is clipped by TableShell overflow-hidden / overflow-x-auto */
  const [userRowMenu, setUserRowMenu] = useState(null)
  const [allOus, setAllOus] = useState([])

  useEffect(() => {
    setStatusFilter(statusFilterDefault || 'all')
  }, [statusFilterDefault])

  useEffect(() => {
    listAdOus({ limit: 2000 })
      .then((r) => setAllOus(r.ous || []))
      .catch(() => {})
  }, [])

  // Use a higher limit when scoped to a single OU so we never miss users
  // (the unscoped browse stays at 500 to keep the DC happy on huge domains).
  const effectiveLimit = ouFilter === 'all' ? 500 : 5000
  const effectiveParent = ouFilter === 'all' ? '' : ouFilter

  const refreshUserTable = useCallback(() => {
    listAdUsers({ search: debounced, limit: effectiveLimit, parentDn: effectiveParent })
      .then((r) =>
        setData({
          users: r.users || [],
          total: r.total || 0,
          truncated: !!r.truncated,
          searchBase: r.searchBase || '',
        }),
      )
      .catch(() => {})
  }, [debounced, effectiveLimit, effectiveParent])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr('')
    listAdUsers({ search: debounced, limit: effectiveLimit, parentDn: effectiveParent })
      .then((r) => {
        if (cancelled) return
        setData({
          users: r.users || [],
          total: r.total || 0,
          truncated: !!r.truncated,
          searchBase: r.searchBase || '',
        })
      })
      .catch((e) => {
        if (cancelled) return
        const d = e.response?.data
        setErr(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [debounced, effectiveLimit, effectiveParent])

  useEffect(() => {
    if (!userRowMenu) return
    const onKey = (e) => {
      if (e.key === 'Escape') setUserRowMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [userRowMenu])

  /** All OUs from /api/ad/ous, indented by depth, sorted alphabetically. */
  const ouOptions = useMemo(() => {
    if (!allOus.length) return []
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
    return allOus
      .slice()
      .sort((a, b) =>
        collator.compare(String(shortOu(a.dn) || a.dn), String(shortOu(b.dn) || b.dn)),
      )
      .map((o) => ({
        dn: o.dn,
        label: shortOu(o.dn) || o.name || o.dn,
        isContainer: o.isContainer,
      }))
  }, [allOus])

  const filtered = useMemo(() => {
    const sFilter = USER_STATUS_FILTERS.find((f) => f.id === statusFilter) || USER_STATUS_FILTERS[0]
    return data.users.filter((u) => sFilter.test(u))
  }, [data.users, statusFilter])

  const selectedOuLabel = useMemo(() => {
    if (ouFilter === 'all') return null
    return shortOu(ouFilter) || ouFilter
  }, [ouFilter])

  const exportCsv = () => {
    const headers = [
      'Display name', 'samAccountName', 'UPN', 'Email', 'OU', 'Disabled', 'Locked',
      'Pwd Expired', 'Pwd Never Expires', 'Bad Pwd Count', 'Group Count',
      'Last Logon', 'Pwd Last Set', 'Created', 'DN',
    ]
    const rows = [headers]
    for (const u of filtered) {
      rows.push([
        u.displayName || '',
        u.samAccountName || '',
        u.upn || '',
        u.mail || '',
        u.ou || '',
        u.disabled ? 'yes' : 'no',
        u.locked ? 'yes' : 'no',
        u.passwordExpired ? 'yes' : 'no',
        u.dontExpirePassword ? 'yes' : 'no',
        u.badPwdCount ?? 0,
        u.groupCount ?? 0,
        u.lastLogon || '',
        u.pwdLastSet || '',
        u.whenCreated || '',
        u.dn || '',
      ])
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    downloadCsv(`ad-users-${stamp}.csv`, rows)
  }

  const openDetail = (u, opts = {}) =>
    setSelectedUser({
      dn: u.dn,
      preview: {
        displayName: u.displayName,
        samAccountName: u.samAccountName,
        mail: u.mail,
        upn: u.upn,
      },
      shortOu: u.ou,
      initialTab: opts.initialTab,
    })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Search samAccountName, name, email, UPN…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={idcsInputClass('max-w-sm flex-1 min-w-[14rem]')}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className={`${idcsInputClass('text-sm')} !w-auto`}
        >
          {USER_STATUS_FILTERS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <select
          value={ouFilter}
          onChange={(e) => setOuFilter(e.target.value)}
          className={`${idcsInputClass('text-sm max-w-xs')} !w-auto`}
          title="Filter to users under a specific OU (server-side scoped search)"
        >
          <option value="all">All OUs (domain)</option>
          {ouOptions.map((o) => (
            <option key={o.dn} value={o.dn}>
              {o.label}
            </option>
          ))}
        </select>
        {ouFilter !== 'all' && (
          <button
            type="button"
            onClick={() => setOuFilter('all')}
            className={`text-xs ${idcsBtnGhost()}`}
            title="Clear OU filter"
          >
            Clear OU
          </button>
        )}
        <button
          type="button"
          onClick={() => setSearch((s) => s + '')}
          className={`text-sm ${idcsBtnGhost()}`}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          type="button"
          onClick={exportCsv}
          disabled={loading || !filtered.length}
          className={`text-sm ${idcsBtnGhost()}`}
          title="Download visible rows as CSV"
        >
          Export CSV
        </button>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className={`text-sm ${idcsBtnPrimary()}`}
        >
          New user
        </button>
      </div>
      <div className={`text-xs flex flex-wrap items-center gap-x-2 gap-y-1 ${idcsCx.text3}`}>
        <span>
          Showing <span className={idcsCx.text}>{filtered.length}</span> of{' '}
          <span className={idcsCx.text}>{data.users.length}</span>{' '}
          {ouFilter === 'all' ? 'loaded' : `under ${selectedOuLabel}`}
        </span>
        {typeof domainUsersTotal === 'number' && (
          <span className={idcsCx.text3}>
            · Domain users total:{' '}
            <span className={idcsCx.text}>{domainUsersTotal.toLocaleString()}</span>
          </span>
        )}
        {data.truncated && (
          <span style={{ color: 'var(--amber)' }}>
            · server result capped at {effectiveLimit} — narrow your search
          </span>
        )}
      </div>
      {err && (
        <div
          className={`text-sm rounded-lg px-4 py-3 border whitespace-pre-wrap ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {err}
        </div>
      )}
      <TableShell
        columns={['Name', 'Logon', 'OU', 'Status', 'Groups', 'Last logon', '']}
        loading={loading}
        count={filtered.length}
        truncated={data.truncated}
        empty={
          err
            ? 'Failed to load — see error above.'
            : !loading && filtered.length === 0
              ? data.users.length === 0
                ? 'No matching users.'
                : 'No users match the filter.'
              : null
        }
      >
        {filtered.map((u) => {
          const moveFor = () =>
            setMoveTarget({
              dn: u.dn,
              preview: { displayName: u.displayName, samAccountName: u.samAccountName },
            })
          return (
            <tr
              key={u.dn}
              className="hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg2))]"
            >
              <td
                className={`px-4 py-2 cursor-pointer`}
                onClick={() => openDetail(u)}
              >
                <div className={`font-medium ${idcsCx.text}`}>{u.displayName || u.samAccountName || u.dn}</div>
                <div className={`text-xs ${idcsCx.text3}`}>{u.mail || u.upn || '—'}</div>
              </td>
              <td className={`px-4 py-2 ${idcsCx.text2} cursor-pointer`} onClick={() => openDetail(u)}>
                {u.samAccountName || '—'}
              </td>
              <td className={`px-4 py-2 ${idcsCx.text2} cursor-pointer`} onClick={() => openDetail(u)} title={u.ou || ''}>
                {shortOu(u.ou)}
              </td>
              <td className="px-4 py-2 space-x-1 whitespace-nowrap cursor-pointer" onClick={() => openDetail(u)}>
                {u.disabled ? (
                  <StatusPill tone="red">Disabled</StatusPill>
                ) : (
                  <StatusPill tone="green">Enabled</StatusPill>
                )}
                {u.locked && <StatusPill tone="amber">Locked</StatusPill>}
                {u.passwordExpired && <StatusPill tone="amber">Pwd Expired</StatusPill>}
                {u.dontExpirePassword && <StatusPill tone="muted">No Expiry</StatusPill>}
              </td>
              <td className={`px-4 py-2 text-xs ${idcsCx.text2} cursor-pointer`} onClick={() => openDetail(u)}>
                {u.groupCount}
              </td>
              <td className={`px-4 py-2 text-xs ${idcsCx.text3} cursor-pointer`} onClick={() => openDetail(u)}>
                {fmtDate(u.lastLogon)}
              </td>
              <td className="px-2 py-2 text-right">
                <button
                  type="button"
                  className={`text-xs px-2 py-1 rounded border ${idcsCx.border} ${idcsCx.text2} hover:bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg3))]`}
                  title="Actions"
                  onClick={(e) => {
                    e.stopPropagation()
                    const btn = e.currentTarget
                    const rect = btn.getBoundingClientRect()
                    setUserRowMenu((cur) =>
                      cur?.dn === u.dn ? null : { dn: u.dn, user: u, top: rect.bottom + 4, right: rect.right },
                    )
                  }}
                >
                  ⋯
                </button>
              </td>
            </tr>
          )
        })}
      </TableShell>
      {userRowMenu &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[140]"
              aria-hidden
              style={{ background: 'transparent' }}
              onClick={() => setUserRowMenu(null)}
            />
            <div
              role="menu"
              className={`fixed z-[150] min-w-[11rem] rounded-md border py-1 shadow-xl ${idcsCx.border} ${idcsCx.bg2}`}
              style={{
                top: userRowMenu.top,
                right: Math.max(8, window.innerWidth - userRowMenu.right),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const rowUser = userRowMenu.user
                  setUserRowMenu(null)
                  setMoveTarget({
                    dn: rowUser.dn,
                    preview: { displayName: rowUser.displayName, samAccountName: rowUser.samAccountName },
                  })
                }}
                className={`block w-full text-left px-3 py-2 text-xs ${idcsCx.text2} hover:bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg3))]`}
              >
                Move to OU…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const rowUser = userRowMenu.user
                  setUserRowMenu(null)
                  openDetail(rowUser)
                }}
                className={`block w-full text-left px-3 py-2 text-xs ${idcsCx.text2} hover:bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg3))]`}
              >
                Open properties
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const rowUser = userRowMenu.user
                  setUserRowMenu(null)
                  openDetail(rowUser, { initialTab: 'actions' })
                }}
                className={`block w-full text-left px-3 py-2 text-xs ${idcsCx.text2} hover:bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg3))]`}
              >
                Password & account…
              </button>
            </div>
          </>,
          document.body,
        )}
      {selectedUser && (
        <AdUserDetailModal
          dn={selectedUser.dn}
          preview={selectedUser.preview}
          shortOu={selectedUser.shortOu}
          initialTab={selectedUser.initialTab}
          onClose={() => setSelectedUser(null)}
          onChanged={refreshUserTable}
        />
      )}
      {moveTarget && (
        <AdUserMoveModal
          dn={moveTarget.dn}
          preview={moveTarget.preview}
          onClose={() => setMoveTarget(null)}
          onMoved={() => {
            setMoveTarget(null)
            refreshUserTable()
          }}
        />
      )}
      {createOpen && (
        <AdUserCreateModal
          domainFqdn={domainFqdn}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            refreshUserTable()
          }}
        />
      )}
    </div>
  )
}

function GroupsPanel() {
  const [search, setSearch] = useState('')
  const debounced = useDebounced(search)
  const [data, setData] = useState({ groups: [], total: 0, truncated: false })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [selected, setSelected] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)

  const refresh = useCallback(() => {
    listAdGroups({ search: debounced, limit: 500 })
      .then((r) => setData({ groups: r.groups || [], total: r.total || 0, truncated: !!r.truncated }))
      .catch(() => {})
  }, [debounced])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr('')
    listAdGroups({ search: debounced, limit: 500 })
      .then((r) => {
        if (cancelled) return
        setData({ groups: r.groups || [], total: r.total || 0, truncated: !!r.truncated })
      })
      .catch((e) => {
        if (cancelled) return
        const d = e.response?.data
        setErr(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [debounced])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Search group name or description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={idcsInputClass('max-w-md flex-1 min-w-[14rem]')}
        />
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className={`text-sm ${idcsBtnPrimary()}`}
        >
          New group
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
      <TableShell
        columns={['Group', 'Type', 'Scope', 'OU', 'Description']}
        loading={loading}
        count={data.groups.length}
        truncated={data.truncated}
        empty={
          err
            ? 'Failed to load — see error above.'
            : !loading && data.groups.length === 0
              ? 'No groups found.'
              : null
        }
      >
        {data.groups.map((g) => {
          const open = () =>
            setSelected({
              dn: g.dn,
              preview: { displayName: g.cn, samAccountName: g.samAccountName, description: g.description },
            })
          return (
            <tr
              key={g.dn}
              role="button"
              tabIndex={0}
              title="Open group properties"
              className="hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg2))] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset"
              onClick={open}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  open()
                }
              }}
            >
              <td className="px-4 py-2">
                <div className={`font-medium ${idcsCx.text}`}>{g.cn || g.samAccountName || g.dn}</div>
                <div className={`text-xs ${idcsCx.text3}`}>{g.samAccountName || ''}</div>
              </td>
              <td className="px-4 py-2">
                {g.type === 'Security' ? (
                  <StatusPill tone="accent">Security</StatusPill>
                ) : g.type === 'Distribution' ? (
                  <StatusPill tone="muted">Distribution</StatusPill>
                ) : (
                  <span className={`text-xs ${idcsCx.text3}`}>—</span>
                )}
              </td>
              <td className={`px-4 py-2 text-xs ${idcsCx.text2}`}>{g.scope || '—'}</td>
              <td className={`px-4 py-2 ${idcsCx.text2}`} title={g.ou || ''}>
                {shortOu(g.ou)}
              </td>
              <td className={`px-4 py-2 text-xs max-w-xs truncate ${idcsCx.text3}`} title={g.description || ''}>
                {g.description || '—'}
              </td>
            </tr>
          )
        })}
      </TableShell>
      {selected && (
        <AdGroupDetailModal
          dn={selected.dn}
          preview={selected.preview}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
      {createOpen && (
        <AdGroupCreateModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function ComputersPanel() {
  const [search, setSearch] = useState('')
  const debounced = useDebounced(search)
  const [data, setData] = useState({ computers: [], total: 0, truncated: false })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [selected, setSelected] = useState(null)

  const refresh = useCallback(() => {
    listAdComputers({ search: debounced, limit: 500 })
      .then((r) => setData({ computers: r.computers || [], total: r.total || 0, truncated: !!r.truncated }))
      .catch(() => {})
  }, [debounced])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr('')
    listAdComputers({ search: debounced, limit: 500 })
      .then((r) => {
        if (cancelled) return
        setData({ computers: r.computers || [], total: r.total || 0, truncated: !!r.truncated })
      })
      .catch((e) => {
        if (cancelled) return
        const d = e.response?.data
        setErr(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [debounced])

  return (
    <div className="space-y-3">
      <input
        type="search"
        placeholder="Search computer name, DNS host or OS…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className={idcsInputClass('max-w-md')}
      />
      {err && (
        <div
          className={`text-sm rounded-lg px-4 py-3 border whitespace-pre-wrap ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {err}
        </div>
      )}
      <TableShell
        columns={['Computer', 'DNS hostname', 'Operating system', 'OU', 'Status', 'Last logon']}
        loading={loading}
        count={data.computers.length}
        truncated={data.truncated}
        empty={
          err
            ? 'Failed to load — see error above.'
            : !loading && data.computers.length === 0
              ? 'No computers found.'
              : null
        }
      >
        {data.computers.map((c) => {
          const open = () =>
            setSelected({
              dn: c.dn,
              preview: { name: c.name, cn: c.name, dnsHostName: c.dnsHostName, samAccountName: c.name },
            })
          return (
            <tr
              key={c.dn}
              role="button"
              tabIndex={0}
              title="Open computer properties"
              className="hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg2))] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset"
              onClick={open}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  open()
                }
              }}
            >
              <td className={`px-4 py-2 font-medium ${idcsCx.text}`}>{c.name || c.dn}</td>
              <td className={`px-4 py-2 text-xs ${idcsCx.text2}`}>{c.dnsHostName || '—'}</td>
              <td className={`px-4 py-2 text-xs ${idcsCx.text2}`}>
                {c.os || '—'}
                {c.osVersion && <span className={`ml-1 ${idcsCx.text3}`}>({c.osVersion})</span>}
              </td>
              <td className={`px-4 py-2 ${idcsCx.text2}`} title={c.ou || ''}>
                {shortOu(c.ou)}
              </td>
              <td className="px-4 py-2">
                {c.disabled ? <StatusPill tone="red">Disabled</StatusPill> : <StatusPill tone="green">Enabled</StatusPill>}
              </td>
              <td className={`px-4 py-2 text-xs ${idcsCx.text3}`}>{fmtDate(c.lastLogon)}</td>
            </tr>
          )
        })}
      </TableShell>
      {selected && (
        <AdComputerDetailModal
          dn={selected.dn}
          preview={selected.preview}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

function normalizeOuDn(s) {
  return String(s || '')
    .toLowerCase()
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(',')
}

function OuTreePanel() {
  const [data, setData] = useState({ ous: [], total: 0, truncated: false })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())
  const [autoExpandedDone, setAutoExpandedDone] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const load = () => {
    setLoading(true)
    setErr('')
    setAutoExpandedDone(false)
    listAdOus({ limit: 2000 })
      .then((r) => setData({ ous: r.ous || [], total: r.total || 0, truncated: !!r.truncated }))
      .catch((e) => {
        const d = e.response?.data
        setErr(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message}`)
      })
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const { byParent, dnByNorm, roots, dnsWithChildren, allDns } = useMemo(() => {
    const known = new Set()
    const map = new Map()
    for (const o of data.ous) known.add(normalizeOuDn(o.dn))
    const childMap = new Map()
    for (const o of data.ous) {
      map.set(normalizeOuDn(o.dn), o)
      const parentKey = known.has(normalizeOuDn(o.parent))
        ? normalizeOuDn(o.parent)
        : '__root__'
      if (!childMap.has(parentKey)) childMap.set(parentKey, [])
      childMap.get(parentKey).push(o)
    }
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
    for (const [, list] of childMap) {
      list.sort((a, b) => collator.compare(String(a.name || a.dn), String(b.name || b.dn)))
    }
    const haveKids = new Set()
    for (const [parentKey] of childMap) {
      if (parentKey !== '__root__') haveKids.add(parentKey)
    }
    return {
      byParent: childMap,
      dnByNorm: map,
      roots: childMap.get('__root__') || [],
      dnsWithChildren: haveKids,
      allDns: known,
    }
  }, [data.ous])

  useEffect(() => {
    if (autoExpandedDone) return
    if (!data.ous.length) return
    setExpanded(new Set(roots.map((r) => normalizeOuDn(r.dn))))
    setAutoExpandedDone(true)
  }, [data.ous.length, roots, autoExpandedDone])

  const filterSet = useMemo(() => {
    if (!filter.trim()) return null
    const q = filter.toLowerCase()
    const matches = new Set()
    for (const o of data.ous) {
      if (
        (o.name || '').toLowerCase().includes(q) ||
        (o.dn || '').toLowerCase().includes(q) ||
        (o.description || '').toLowerCase().includes(q)
      ) {
        matches.add(normalizeOuDn(o.dn))
      }
    }
    const visible = new Set(matches)
    for (const dnNorm of matches) {
      let cur = dnByNorm.get(dnNorm)
      while (cur) {
        visible.add(normalizeOuDn(cur.dn))
        const parentNorm = normalizeOuDn(cur.parent)
        const next = dnByNorm.get(parentNorm)
        if (!next || next === cur) break
        cur = next
      }
    }
    return visible
  }, [filter, data.ous, dnByNorm])

  const minDepth = useMemo(
    () =>
      data.ous.reduce(
        (m, o) => (Number.isFinite(o.depth) ? Math.min(m, o.depth) : m),
        Infinity,
      ),
    [data.ous],
  )

  const rendered = useMemo(() => {
    if (!data.ous.length) return []
    const out = []
    const filtered = filterSet
    const isExpanded = (dnNorm) => (filtered ? true : expanded.has(dnNorm))
    const walk = (node) => {
      const dnNorm = normalizeOuDn(node.dn)
      if (filtered && !filtered.has(dnNorm)) return
      out.push(node)
      const children = byParent.get(dnNorm)
      if (!children || !children.length) return
      if (!isExpanded(dnNorm)) return
      for (const c of children) walk(c)
    }
    for (const r of roots) walk(r)
    return out
  }, [byParent, roots, expanded, filterSet, data.ous.length])

  const toggle = (dnNorm) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dnNorm)) next.delete(dnNorm)
      else next.add(dnNorm)
      return next
    })
  }
  const expandAll = () => setExpanded(new Set(dnsWithChildren))
  const collapseAll = () => setExpanded(new Set())

  const visibleCount = rendered.length
  const totalNodes = allDns.size

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Filter OU name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={idcsInputClass('max-w-md')}
        />
        <button type="button" onClick={load} disabled={loading} className={`text-sm ${idcsBtnGhost()}`}>
          {loading ? 'Loading…' : 'Reload'}
        </button>
        <button
          type="button"
          onClick={expandAll}
          disabled={loading || !data.ous.length || !!filterSet}
          className={`text-sm ${idcsBtnGhost()}`}
          title={filterSet ? 'Tree is auto-expanded while filtering' : 'Expand every OU with children'}
        >
          Expand all
        </button>
        <button
          type="button"
          onClick={collapseAll}
          disabled={loading || !data.ous.length || !!filterSet}
          className={`text-sm ${idcsBtnGhost()}`}
          title={filterSet ? 'Tree is auto-expanded while filtering' : 'Collapse every node'}
        >
          Collapse all
        </button>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className={`text-sm ${idcsBtnPrimary()}`}
        >
          New OU
        </button>
        <span className={`text-xs ml-auto ${idcsCx.text3}`}>
          {visibleCount}/{totalNodes} object{totalNodes !== 1 ? 's' : ''}
          {data.truncated && <> · result capped</>}
        </span>
      </div>
      {err && (
        <div
          className={`text-sm rounded-lg px-4 py-3 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {err}
        </div>
      )}
      <div className={`rounded-xl border p-3 ${idcsCx.border} ${idcsCx.bg3} max-h-[60vh] overflow-auto`}>
        {loading && !data.ous.length ? (
          <div className={`text-sm py-6 text-center ${idcsCx.text3}`}>Loading directory tree…</div>
        ) : rendered.length === 0 ? (
          <div className={`text-sm py-6 text-center ${idcsCx.text3}`}>No OUs match.</div>
        ) : (
          <ul className="font-mono text-xs leading-relaxed">
            {rendered.map((o) => {
              const indent = Math.max(0, (o.depth - minDepth) * 16)
              const dnNorm = normalizeOuDn(o.dn)
              const hasKids = dnsWithChildren.has(dnNorm)
              const open = () =>
                setSelected({ dn: o.dn, preview: { name: o.name, description: o.description } })
              const isOpen = filterSet ? true : expanded.has(dnNorm)
              return (
                <li
                  key={o.dn}
                  className={`flex items-center gap-1 rounded ${idcsCx.text2} hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg2))]`}
                  style={{ paddingLeft: indent }}
                >
                  {hasKids ? (
                    <button
                      type="button"
                      onClick={() => toggle(dnNorm)}
                      title={isOpen ? 'Collapse' : 'Expand'}
                      aria-label={isOpen ? 'Collapse' : 'Expand'}
                      className={`shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-[10px] ${idcsCx.text3} hover:bg-[color-mix(in_srgb,var(--accent)_14%,var(--bg3))] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]`}
                    >
                      {isOpen ? '▼' : '▶'}
                    </button>
                  ) : (
                    <span className="shrink-0 w-5 h-5" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    title={o.dn}
                    onClick={open}
                    className={`flex-1 min-w-0 flex items-baseline gap-2 py-0.5 text-left cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset rounded`}
                  >
                    <span style={{ color: o.isContainer ? 'var(--text3)' : 'var(--accent)' }}>
                      {o.isContainer ? '📁' : '🌳'}
                    </span>
                    <span className={`${idcsCx.text} truncate`}>{o.name || o.dn}</span>
                    {o.description && (
                      <span className={`text-[11px] truncate ${idcsCx.text3}`}>— {o.description}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {selected && (
        <AdOuDetailModal
          dn={selected.dn}
          preview={selected.preview}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}
      {createOpen && (
        <AdOuCreateModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            load()
          }}
        />
      )}
    </div>
  )
}

function UserBindTestWidget({ configured, domainFqdnHint }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const runTest = async () => {
    setResult(null)
    setBusy(true)
    try {
      const data = await testAdUserBind({ username: username.trim(), password })
      const principal = data?.bindPrincipal
      setResult({
        ok: true,
        text: principal
          ? `Password accepted — LDAP bind succeeded as ${principal}.`
          : 'Password accepted — Active Directory confirmed these credentials.',
      })
      setPassword('')
    } catch (e) {
      const d = e.response?.data
      setResult({
        ok: false,
        text: `${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message || 'Request failed'}`,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`rounded-xl border p-5 ${idcsCx.border} ${idcsCx.bg2}`}>
      <h3 className={`text-sm font-semibold ${idcsCx.text}`}>Test user credentials</h3>
      <p className={`text-sm mt-1 leading-relaxed ${idcsCx.text2}`}>
        Runs one LDAP bind against your configured domain controller — same encryption rules as the rest of Netpulse AD.
        Credentials are sent only for this request and are not saved.
      </p>
      <p className={`text-xs mt-2 ${idcsCx.text3}`}>
        Username: UPN (<span className="font-mono text-[11px]">you@domain.com</span>),{' '}
        <span className="font-mono text-[11px]">DOMAIN\samAccountName</span>, full DN, or logon name
        {domainFqdnHint ? (
          <>
            {' '}
            (bare logon is tried as <span className="font-mono text-[11px]">{`logon@${domainFqdnHint}`}</span>)
          </>
        ) : (
          <> — configure AD_DOMAIN on the server to auto-append DNS suffix</>
        )}
        .
      </p>

      {!configured ? (
        <p className={`text-sm mt-4 ${idcsCx.text3}`}>Connect Active Directory on the server to enable this check.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 max-w-md">
          <label className="block">
            <span className={`text-[11px] font-semibold uppercase tracking-wide ${idcsCx.text3}`}>Username</span>
            <input
              type="text"
              autoComplete="off"
              className={`mt-1 ${idcsInputClass('w-full')}`}
              value={username}
              disabled={busy}
              onChange={(e) => {
                setUsername(e.target.value)
                setResult(null)
              }}
              placeholder="e.g. jdoe or jdoe@contoso.com"
            />
          </label>
          <label className="block">
            <span className={`text-[11px] font-semibold uppercase tracking-wide ${idcsCx.text3}`}>Password</span>
            <input
              type="password"
              autoComplete="off"
              className={`mt-1 ${idcsInputClass('w-full')}`}
              value={password}
              disabled={busy}
              onChange={(e) => {
                setPassword(e.target.value)
                setResult(null)
              }}
              placeholder="User password"
            />
          </label>
          <button
            type="button"
            disabled={busy || !username.trim() || !password}
            className={`text-sm self-start ${idcsBtnPrimary()}`}
            onClick={runTest}
          >
            {busy ? 'Testing…' : 'Test credentials'}
          </button>
          {result && (
            <div
              className={`text-sm rounded-lg px-3 py-2.5 border ${idcsCx.border}`}
              role="status"
              aria-live="polite"
              style={{
                background: result.ok
                  ? 'color-mix(in srgb, var(--green) 12%, var(--bg3))'
                  : 'color-mix(in srgb, var(--red) 12%, var(--bg3))',
                color: result.ok ? 'var(--green)' : 'var(--red)',
              }}
            >
              {result.text}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function OverviewPanel({
  configured,
  credentialsConfigured,
  domainLabel,
  domainFqdnHint,
  stats,
  statsLoading,
  statsErr,
  onJump,
}) {
  const accentMuted = configured ? 'var(--accent)' : 'var(--text3)'

  const metric = (n) => {
    if (!configured) return null
    if (!credentialsConfigured) return '—'
    if (statsLoading) return null
    if (statsErr) return '—'
    if (typeof n !== 'number') return '—'
    return n
  }

  const pwdExp = stats?.passwordsExpiring30d
  const pwdTileValue =
    !configured ? null
    : !credentialsConfigured ? '—'
    : statsLoading ? null
    : statsErr ? '—'
    : pwdExp === null || pwdExp === undefined ? '—'
    : pwdExp

  const pwdSub =
    stats && !statsLoading && !statsErr && credentialsConfigured && configured && (pwdExp === null || pwdExp === undefined)
      ? stats.maxPasswordAgeDays == null
        ? 'No max password age (unlimited)'
        : 'Could not evaluate'
      : 'Click to open expiring-passwords report'

  return (
    <div className="space-y-6">
      <p className={`text-sm ${idcsCx.text2}`}>
        Scope: <span className={`font-medium ${idcsCx.text}`}>{domainLabel}</span>
      </p>

      {configured && credentialsConfigured && statsErr && (
        <div
          className={`text-sm rounded-lg px-4 py-3 border whitespace-pre-wrap ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {statsErr}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        <StatTile
          icon="👥"
          label="Domain users"
          value={metric(stats?.usersTotal)}
          sub={
            !credentialsConfigured && configured
              ? 'Service account required'
              : configured
                ? 'Synced from AD — click to open'
                : 'Connect domain + DC on server to load counts'
          }
          accent={accentMuted}
          onClick={configured && credentialsConfigured ? () => onJump('users', { filter: 'all' }) : undefined}
        />
        <StatTile
          icon="🚫"
          label="Disabled accounts"
          value={metric(stats?.usersDisabled)}
          sub={
            !credentialsConfigured && configured ? 'Service account required' : 'Click to filter disabled users'
          }
          accent="var(--amber)"
          onClick={
            configured && credentialsConfigured ? () => onJump('users', { filter: 'disabled' }) : undefined
          }
        />
        <StatTile
          icon="🔒"
          label="Locked / bad pwd"
          value={metric(stats?.usersLockedOrBadPwd)}
          sub={
            !credentialsConfigured && configured
              ? 'Service account required'
              : 'Click to filter locked accounts'
          }
          accent="var(--red)"
          onClick={
            configured && credentialsConfigured ? () => onJump('users', { filter: 'locked' }) : undefined
          }
        />
        <StatTile
          icon="🗂️"
          label="Security groups"
          value={metric(stats?.securityGroups)}
          sub={
            !credentialsConfigured && configured ? 'Service account required' : 'Click to open Groups'
          }
          accent="var(--accent2)"
          onClick={configured && credentialsConfigured ? () => onJump('groups') : undefined}
        />
        <StatTile
          icon="💻"
          label="Computer objects"
          value={metric(stats?.computers)}
          sub={
            !credentialsConfigured && configured ? 'Service account required' : 'Click to open Computers'
          }
          accent="var(--cyan)"
          onClick={configured && credentialsConfigured ? () => onJump('computers') : undefined}
        />
        <StatTile
          icon="⏳"
          label="Passwords expiring (30d)"
          value={pwdTileValue}
          sub={!credentialsConfigured && configured ? 'Service account required' : pwdSub}
          accent="var(--green)"
          onClick={
            configured && credentialsConfigured
              ? () => onJump('reports', { report: 'password_expiring' })
              : undefined
          }
        />
      </div>

      {configured && <ConnectionDiagnosticsPanel canTest={configured && credentialsConfigured} />}

      <UserBindTestWidget configured={configured} domainFqdnHint={domainFqdnHint || ''} />

      <div className={`rounded-xl border p-5 ${idcsCx.border} ${idcsCx.bg2}`}>
        <h3 className={`text-sm font-semibold ${idcsCx.text}`}>Shortcuts</h3>
        <div className="flex flex-wrap gap-2 mt-4">
          <button type="button" className={`text-sm ${idcsBtnPrimary()}`} onClick={() => onJump('users')}>
            User workspace
          </button>
          <button type="button" className={`text-sm ${idcsBtnGhost()}`} onClick={() => onJump('bulk')}>
            Bulk CSV
          </button>
          <button type="button" className={`text-sm ${idcsBtnGhost()}`} onClick={() => onJump('reports')}>
            Reports
          </button>
          <button type="button" className={`text-sm ${idcsBtnGhost()}`} onClick={() => onJump('audit')}>
            Audit trail
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ActiveDirectoryManagement() {
  const [section, setSection] = useState('overview')
  const [reportsPresetId, setReportsPresetId] = useState(null)
  const [usersFilterDefault, setUsersFilterDefault] = useState('all')
  const [status, setStatus] = useState(null)
  const [statusErr, setStatusErr] = useState('')
  const [stats, setStats] = useState(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsErr, setStatsErr] = useState('')

  const clearReportsPreset = useCallback(() => setReportsPresetId(null), [])

  useEffect(() => {
    if (section !== 'reports') setReportsPresetId(null)
  }, [section])

  const jumpTo = useCallback((nextSection, options = {}) => {
    if (nextSection === 'users' && options.filter) {
      setUsersFilterDefault(options.filter)
    }
    if (nextSection === 'reports' && options.report) {
      setReportsPresetId(options.report)
    }
    setSection(nextSection)
  }, [])

  const refreshAll = useCallback(async () => {
    setStatusErr('')
    setStatsErr('')
    try {
      const s = await getAdStatus()
      setStatus(s)
      if (s.configured && s.credentialsConfigured) {
        setStatsLoading(true)
        try {
          const r = await getAdStats()
          setStats(r.stats)
          setStatsErr('')
        } catch (e) {
          setStats(null)
          const d = e.response?.data
          const line =
            [d?.code ? `[${d.code}] ` : '', d?.error || d?.message || e.message || 'Failed to load directory statistics']
              .join('')
              .trim()
          setStatsErr(d?.detail ? `${line}\n\n${d.detail}` : line)
        } finally {
          setStatsLoading(false)
        }
      } else {
        setStats(null)
        setStatsLoading(false)
      }
    } catch (e) {
      setStatus(null)
      setStats(null)
      setStatusErr(e.response?.data?.error || e.message || 'Failed to load AD status')
    }
  }, [])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  const configured = Boolean(status?.configured)
  const credentialsConfigured = Boolean(status?.credentialsConfigured)
  const domainLabel =
    status?.domainNetbios || status?.domainFqdn || 'Active Directory'

  const breadcrumb = ['Active Directory', NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === section)?.label || section]

  const panelTitle = (title, subtitle) => (
    <div className="mb-4">
      <h2 className={`text-lg font-semibold ${idcsCx.text}`}>{title}</h2>
      {subtitle && <p className={`text-sm mt-0.5 ${idcsCx.text2}`}>{subtitle}</p>}
    </div>
  )

  let main = null
  if (section === 'overview') {
    main = (
      <>
        {panelTitle('Domain overview')}
        <OverviewPanel
          configured={configured}
          credentialsConfigured={credentialsConfigured}
          domainLabel={domainLabel}
          domainFqdnHint={status?.domainFqdn || ''}
          stats={stats}
          statsLoading={statsLoading}
          statsErr={statsErr}
          onJump={jumpTo}
        />
      </>
    )
  } else if (section === 'users') {
    main = (
      <>
        {panelTitle('Users & contacts')}
        {configured && credentialsConfigured ? (
          <UsersPanel
            statusFilterDefault={usersFilterDefault}
            domainFqdn={status?.domainFqdn || ''}
            domainUsersTotal={typeof stats?.usersTotal === 'number' ? stats.usersTotal : null}
          />
        ) : (
          <PlaceholderTable
            columns={['Name', 'Logon name', 'OU', 'Status', 'Groups', 'Last logon']}
            emptyTitle="Directory not connected"
            emptyBody="Configure AD_DOMAIN, AD_DOMAIN_CONTROLLER, and AD_SERVICE_USERNAME/PASSWORD on the Netpulse server."
          />
        )}
      </>
    )
  } else if (section === 'groups') {
    main = (
      <>
        {panelTitle('Groups')}
        {configured && credentialsConfigured ? (
          <GroupsPanel />
        ) : (
          <PlaceholderTable
            columns={['Group', 'Type', 'Scope', 'OU', 'Description']}
            emptyTitle="Directory not connected"
            emptyBody={status?.message || 'Connect Active Directory to load groups.'}
          />
        )}
      </>
    )
  } else if (section === 'computers') {
    main = (
      <>
        {panelTitle('Computers')}
        {configured && credentialsConfigured ? (
          <ComputersPanel />
        ) : (
          <PlaceholderTable
            columns={['Computer', 'DNS hostname', 'Operating system', 'OU', 'Status', 'Last logon']}
            emptyTitle="Directory not connected"
            emptyBody="Connect AD on the server to load computer objects."
          />
        )}
      </>
    )
  } else if (section === 'ous') {
    main = (
      <>
        {panelTitle('Organizational units')}
        {configured && credentialsConfigured ? (
          <OuTreePanel />
        ) : (
          <div className={`rounded-xl border p-6 ${idcsCx.border} ${idcsCx.bg3}`}>
            <pre className={`text-xs font-mono whitespace-pre leading-relaxed ${idcsCx.text2}`}>
              {`${domainLabel}\n└── (connect domain + DC to load live OU tree)`}
            </pre>
          </div>
        )}
      </>
    )
  } else if (section === 'bulk') {
    main = (
      <>
        {panelTitle('Bulk management')}
        {configured && credentialsConfigured ? (
          <AdBulkPanel />
        ) : (
          <div className={`rounded-xl border p-6 ${idcsCx.border} ${idcsCx.bg3} text-sm ${idcsCx.text2}`}>
            Connect Active Directory on the server first (AD_DOMAIN, AD_DOMAIN_CONTROLLER, service account).
          </div>
        )}
      </>
    )
  } else if (section === 'reports') {
    main = (
      <>
        {panelTitle('Reports')}
        {configured && credentialsConfigured ? (
          <AdReportsPanel presetReportId={reportsPresetId} onPresetConsumed={clearReportsPreset} />
        ) : (
          <div className={`rounded-xl border p-6 ${idcsCx.border} ${idcsCx.bg3} text-sm ${idcsCx.text2}`}>
            Connect Active Directory on the server first (AD_DOMAIN, AD_DOMAIN_CONTROLLER, service account).
          </div>
        )}
      </>
    )
  } else if (section === 'audit') {
    main = (
      <>
        {panelTitle('Audit trail')}
        <PlaceholderTable
          columns={['Time', 'Actor', 'Action', 'Target', 'Status']}
          emptyTitle="No audit entries yet"
          emptyBody="Directory change events from Netpulse will appear here when auditing is available."
        />
      </>
    )
  }

  return (
    <div className="flex gap-0 min-h-0 -m-4 md:-m-6 flex-col lg:flex-row">
      {/* Sidebar navigation */}
      <aside
        className={`shrink-0 w-full lg:w-56 border-b lg:border-b-0 lg:border-r ${idcsCx.border} ${idcsCx.bg3}`}
      >
        <div className="p-4 border-b border-[var(--border)]">
          <div className={`text-[11px] font-bold uppercase tracking-widest ${idcsCx.text3}`}>Directory</div>
          <div className={`text-sm font-semibold mt-0.5 ${idcsCx.text}`}>AD workspace</div>
        </div>
        <nav className="p-2 pb-6 flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="flex lg:flex-col gap-1 shrink-0">
              <div className={`hidden lg:block px-2 pt-3 pb-1 text-[10px] uppercase font-bold tracking-wide ${idcsCx.text3}`}>
                {group.title}
              </div>
              {group.items.map((item) => {
                const active = section === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    title={item.hint}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      if (item.id === 'reports') setReportsPresetId(null)
                      setSection(item.id)
                    }}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-left whitespace-nowrap transition-colors ${
                      active
                        ? 'bg-[color-mix(in_srgb,var(--accent)_18%,var(--bg2))] text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_35%,var(--border))]'
                        : `${idcsCx.text2} hover:bg-[var(--bg2)] border border-transparent`
                    }`}
                  >
                    <span>{item.icon}</span>
                    <span className="font-medium">{item.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 space-y-5 p-4 md:p-6 lg:p-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className={`text-xs font-medium uppercase tracking-wide ${idcsCx.text3}`}>
              {breadcrumb.join(' → ')}
            </div>
            <h1 className={`text-xl font-bold mt-1 ${idcsCx.text}`}>Active Directory management</h1>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-2">
            <span
              className="text-xs px-3 py-1 rounded-full font-medium border border-[var(--border)]"
              style={{
                background:
                  configured && credentialsConfigured
                    ? 'color-mix(in srgb, var(--green) 16%, var(--bg3))'
                    : configured
                      ? 'color-mix(in srgb, var(--amber) 16%, var(--bg3))'
                      : 'color-mix(in srgb, var(--amber) 16%, var(--bg3))',
                color:
                  configured && credentialsConfigured ? 'var(--green)' : 'var(--amber)',
              }}
            >
              {configured && credentialsConfigured
                ? `● Connected · ${domainLabel}`
                : configured
                  ? `◐ Domain set · add service account`
                  : '○ AD not configured'}
            </span>
            <button
              type="button"
              onClick={() => refreshAll()}
              className={`text-xs ${idcsBtnGhost()}`}
              style={{ padding: '6px 12px' }}
            >
              Refresh
            </button>
          </div>
        </div>

        {statusErr && (
          <div
            className={`text-sm rounded-lg px-4 py-3 border ${idcsCx.border}`}
            style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
          >
            {statusErr}
          </div>
        )}

        {configured && !credentialsConfigured && status && (
          <div className={`rounded-xl border px-4 py-3 text-sm ${idcsCx.border} ${idcsCx.bg2}`}>
            <span className={`font-medium ${idcsCx.text}`}>Directory queries disabled — </span>
            <span className={idcsCx.text2}>{status.message}</span>
          </div>
        )}

        {!configured && status && (
          <div className={`rounded-xl border px-4 py-3 text-sm ${idcsCx.border} ${idcsCx.bg2}`}>
            <span className={`font-medium ${idcsCx.text}`}>Next step — </span>
            <span className={idcsCx.text2}>{status.message}</span>
          </div>
        )}

        <div>{main}</div>
      </div>
    </div>
  )
}
