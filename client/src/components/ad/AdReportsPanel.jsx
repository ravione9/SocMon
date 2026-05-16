/**
 * Pre-built Active Directory reports (read-only LDAP queries + CSV export).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAdReport } from '../../api/ad'
import { idcsCx, idcsBtnGhost, idcsBtnPrimary, idcsInputClass } from '../idcs/idcsTheme'

const REPORT_DEFS = [
  {
    id: 'password_expiring',
    title: 'Passwords expiring',
    description:
      'Enabled users — password expires within the selected window (computed from domain max password age and pwdLastSet).',
    usesDays: true,
    defaultDays: 30,
  },
  {
    id: 'password_expired',
    title: 'Passwords expired / must change',
    description:
      'Enabled users — computed expiry in the past, or pwdLastSet cleared (must change at next logon). Excludes “password never expires”.',
    usesDays: false,
    defaultDays: 30,
  },
  {
    id: 'disabled_users',
    title: 'Disabled users',
    description: 'All disabled user accounts in the domain.',
    usesDays: false,
    defaultDays: 30,
  },
  {
    id: 'password_never_expires',
    title: 'Password never expires',
    description: 'Users with “password never expires” set.',
    usesDays: false,
    defaultDays: 30,
  },
  {
    id: 'locked_users',
    title: 'Locked out users',
    description: 'Accounts with an active lockout time.',
    usesDays: false,
    defaultDays: 30,
  },
  {
    id: 'stale_logon',
    title: 'Stale logons (users)',
    description:
      'Enabled users with no successful logon in N days (best of lastLogon on this DC and replicated lastLogonTimestamp).',
    usesDays: true,
    defaultDays: 90,
  },
  {
    id: 'last_logon',
    title: 'User last logon',
    description:
      'All user accounts with effective last logon plus raw DC and replicated timestamps — sorted by newest logon (CSV-friendly).',
    usesDays: false,
    defaultDays: 30,
  },
  {
    id: 'recently_created_users',
    title: 'Recently created users',
    description: 'Users created within the last N days (whenCreated).',
    usesDays: true,
    defaultDays: 30,
  },
  {
    id: 'inactive_computers',
    title: 'Inactive computers',
    description:
      'Enabled computer accounts with no logon in N days (same last-logon merge as user lists).',
    usesDays: true,
    defaultDays: 90,
  },
]

function csvCell(v) {
  if (v == null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(filename, labels, rowObjs, keys) {
  const lines = [
    labels.map(csvCell).join(','),
    ...rowObjs.map((row) => keys.map((k) => csvCell(row[k])).join(',')),
  ]
  const csv = lines.join('\r\n')
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

export default function AdReportsPanel({ presetReportId = null, onPresetConsumed }) {
  const defMap = useMemo(() => new Map(REPORT_DEFS.map((d) => [d.id, d])), [])
  const [selectedId, setSelectedId] = useState(REPORT_DEFS[0].id)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [payload, setPayload] = useState(null)

  const selectedDef = defMap.get(selectedId) || REPORT_DEFS[0]

  useEffect(() => {
    if (!presetReportId) return
    const id = String(presetReportId).replace(/-/g, '_')
    if (defMap.has(id)) {
      setSelectedId(id)
      const d = defMap.get(id)
      if (d?.usesDays && d.defaultDays) setDays(d.defaultDays)
    }
    onPresetConsumed?.()
  }, [presetReportId, defMap, onPresetConsumed])

  useEffect(() => {
    const d = defMap.get(selectedId)
    if (d?.usesDays && d.defaultDays != null) setDays(d.defaultDays)
  }, [selectedId, defMap])

  const run = useCallback(async () => {
    setLoading(true)
    setErr('')
    setPayload(null)
    try {
      const params = {}
      if (selectedDef.usesDays) params.days = days
      const r = await getAdReport(selectedId, params)
      setPayload(r)
    } catch (e) {
      const d = e.response?.data
      setErr(`${d?.code ? `[${d.code}] ` : ''}${d?.error || e.message || 'Report failed'}`)
    } finally {
      setLoading(false)
    }
  }, [selectedId, selectedDef.usesDays, days])

  useEffect(() => {
    run()
  }, [selectedId, days, run])

  const keys = payload?.columns?.map((c) => c.key) || []
  const labels = payload?.columns?.map((c) => c.label) || []

  const exportCsv = () => {
    if (!payload?.rows?.length || !keys.length) return
    const safeName = selectedDef.title.replace(/[^\w\-]+/g, '_')
    downloadCsv(`ad-report-${safeName}.csv`, labels, payload.rows, keys)
  }

  return (
    <div className="space-y-5">
      <p className={`text-sm ${idcsCx.text2}`}>
        Pick a report to query the directory (results may be capped — narrow with filters on large domains).
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {REPORT_DEFS.map((d) => {
          const active = d.id === selectedId
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => {
                setSelectedId(d.id)
                onPresetConsumed?.()
              }}
              className={`text-left rounded-xl border p-4 transition-colors ${idcsCx.border} ${
                active ? idcsCx.bg2 : idcsCx.bg3
              } ${active ? 'ring-1 ring-[color-mix(in_srgb,var(--accent)_45%,transparent)]' : ''}`}
            >
              <div className={`text-sm font-semibold ${idcsCx.text}`}>{d.title}</div>
              <p className={`text-xs mt-1 leading-snug ${idcsCx.text3}`}>{d.description}</p>
            </button>
          )
        })}
      </div>

      <div className={`rounded-xl border p-4 flex flex-wrap items-end gap-3 ${idcsCx.border} ${idcsCx.bg2}`}>
        {selectedDef.usesDays && (
          <label className={`text-sm ${idcsCx.text}`}>
            <span className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${idcsCx.text3}`}>
              Window (days)
            </span>
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(Number(e.target.value) || 1)}
              className={idcsInputClass()}
              style={{ width: '100px' }}
            />
          </label>
        )}
        <button type="button" disabled={loading} className={`text-sm ${idcsBtnPrimary()}`} onClick={() => run()}>
          {loading ? 'Running…' : 'Refresh'}
        </button>
        <button
          type="button"
          disabled={!payload?.rows?.length}
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

      {payload?.meta?.note && (
        <div className={`text-sm rounded-lg px-4 py-3 border ${idcsCx.border} ${idcsCx.bg3} ${idcsCx.text2}`}>
          {payload.meta.note}
        </div>
      )}

      {payload && (
        <div className={`rounded-xl border overflow-hidden ${idcsCx.border}`}>
          <div className={`px-4 py-2 text-xs border-b flex justify-between gap-2 ${idcsCx.border} ${idcsCx.bg3} ${idcsCx.text3}`}>
            <span>
              {payload.rows?.length ?? 0} row{(payload.rows?.length || 0) !== 1 ? 's' : ''}
              {payload.truncated ? ' · Result capped — increase AD_STATS_PAGE_SIZE / narrow scope if needed' : ''}
            </span>
            {payload.meta?.maxPasswordAgeDays != null && (
              <span>Domain max password age: {payload.meta.maxPasswordAgeDays} days</span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className={`${idcsCx.bg3} text-xs uppercase tracking-wide ${idcsCx.text3}`}>
                <tr>
                  {labels.map((lb, i) => (
                    <th key={keys[i] || i} className="px-3 py-2 text-left font-semibold whitespace-nowrap">
                      {lb}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className={idcsCx.divide}>
                {(payload.rows || []).map((row, ri) => (
                  <tr key={ri} className={`border-t ${idcsCx.border}`}>
                    {keys.map((k) => (
                      <td key={k} className={`px-3 py-2 align-top ${idcsCx.text} whitespace-pre-wrap break-all max-w-xs`}>
                        {row[k] === '' || row[k] == null ? '—' : String(row[k])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && (!payload.rows || payload.rows.length === 0) && (
            <div className={`px-4 py-10 text-center text-sm ${idcsCx.text3}`}>No rows matched this report.</div>
          )}
        </div>
      )}
    </div>
  )
}
