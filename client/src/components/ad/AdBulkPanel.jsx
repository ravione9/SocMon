/**
 * Active Directory bulk operations runner.
 * Each operation is a small registered handler with:
 *   - id, label, description
 *   - columns: expected CSV headers (in order)
 *   - sample: array of example rows used to build the downloadable template
 *   - run(row, index): async function that performs ONE row's directory write
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createAdUser,
  moveAdUser,
  addAdGroupMembers,
  removeAdGroupMembers,
  setAdUserAccount,
  resetAdUserPassword,
  modifyAdUser,
  createAdGroup,
  createAdOu,
} from '../../api/ad'
import { idcsCx, idcsBtnGhost, idcsBtnPrimary } from '../idcs/idcsTheme'

// ─── CSV parser ─────────────────────────────────────────────────────────────

function parseCsv(text) {
  const out = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  const src = String(text || '').replace(/^\uFEFF/, '')
  while (i < src.length) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      row.push(field)
      out.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += c
    i++
  }
  // flush last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    out.push(row)
  }
  // drop trailing blank rows
  while (out.length && out[out.length - 1].every((c) => String(c).trim() === '')) {
    out.pop()
  }
  return out
}

function rowsToObjects(rows, expectedCols) {
  if (!rows.length) return { headers: [], data: [], missing: [] }
  const headerRow = rows[0].map((h) => String(h ?? '').trim())
  const lower = headerRow.map((h) => h.toLowerCase())
  const headerMap = new Map()
  for (const col of expectedCols) {
    const idx = lower.indexOf(col.toLowerCase())
    if (idx >= 0) headerMap.set(col, idx)
  }
  const missing = expectedCols.filter((c) => !headerMap.has(c) && c.required !== false)
  const data = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.every((c) => String(c).trim() === '')) continue
    const obj = { _row: r + 1 }
    for (const col of expectedCols) {
      const idx = headerMap.get(col)
      obj[col] = idx == null ? '' : String(row[idx] ?? '').trim()
    }
    data.push(obj)
  }
  return { headers: headerRow, data, missing }
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off'])
function parseBool(v, def) {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return def
  if (TRUE_VALUES.has(s)) return true
  if (FALSE_VALUES.has(s)) return false
  return def
}

function buildCsv(columns, sample) {
  const escape = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [columns.map(escape).join(',')]
  for (const row of sample) {
    lines.push(columns.map((c) => escape(row[c] ?? '')).join(','))
  }
  return '\uFEFF' + lines.join('\r\n')
}

function download(filename, contents) {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ─── Operation registry ─────────────────────────────────────────────────────

const SAMPLE_PARENT = 'OU=Users,DC=corp,DC=example,DC=com'
const SAMPLE_GROUP = 'CN=All Staff,OU=Groups,DC=corp,DC=example,DC=com'
const SAMPLE_TARGET_OU = 'OU=Finance,DC=corp,DC=example,DC=com'
const SAMPLE_USER_DN = 'CN=John Doe,OU=Users,DC=corp,DC=example,DC=com'

const OPERATIONS = [
  {
    id: 'createUsers',
    label: 'Create users',
    icon: '👤',
    description: 'Add new AD user accounts. Password is required to start the account enabled.',
    columns: [
      'samAccountName',
      'givenName',
      'sn',
      'displayName',
      'userPrincipalName',
      'mail',
      'description',
      'password',
      'parentDn',
      'enabled',
      'dontExpirePassword',
      'mustChangeNextLogon',
    ],
    sample: [
      {
        samAccountName: 'jdoe',
        givenName: 'John',
        sn: 'Doe',
        displayName: 'John Doe',
        userPrincipalName: 'jdoe@corp.example.com',
        mail: 'jdoe@corp.example.com',
        description: 'Joiner — Finance',
        password: 'P@ssw0rd!2026',
        parentDn: SAMPLE_PARENT,
        enabled: 'true',
        dontExpirePassword: 'false',
        mustChangeNextLogon: 'true',
      },
      {
        samAccountName: 'asmith',
        givenName: 'Anna',
        sn: 'Smith',
        displayName: 'Anna Smith',
        userPrincipalName: 'asmith@corp.example.com',
        mail: 'asmith@corp.example.com',
        description: '',
        password: 'P@ssw0rd!2026',
        parentDn: SAMPLE_PARENT,
        enabled: 'true',
        dontExpirePassword: 'true',
        mustChangeNextLogon: 'false',
      },
    ],
    run: (row) =>
      createAdUser({
        parentDn: row.parentDn,
        samAccountName: row.samAccountName,
        userPrincipalName: row.userPrincipalName || undefined,
        cn: row.displayName || row.samAccountName,
        displayName: row.displayName || undefined,
        givenName: row.givenName || undefined,
        sn: row.sn || undefined,
        description: row.description || undefined,
        mail: row.mail || undefined,
        password: row.password || undefined,
        enabled: parseBool(row.enabled, true),
        dontExpirePassword: parseBool(row.dontExpirePassword, false),
        mustChangeNextLogon: parseBool(row.mustChangeNextLogon, false),
      }),
    key: (row) => row.samAccountName || row.userPrincipalName || `row ${row._row}`,
  },
  {
    id: 'moveUsers',
    label: 'Move users to OU',
    icon: '➡️',
    description: 'Move (or any object) to a new OU/container using modifyDN.',
    columns: ['dn', 'newParentDn'],
    sample: [
      { dn: SAMPLE_USER_DN, newParentDn: SAMPLE_TARGET_OU },
      { dn: 'CN=Anna Smith,OU=Users,DC=corp,DC=example,DC=com', newParentDn: SAMPLE_TARGET_OU },
    ],
    run: (row) => moveAdUser({ dn: row.dn, newParentDn: row.newParentDn }),
    key: (row) => row.dn || `row ${row._row}`,
  },
  {
    id: 'addToGroup',
    label: 'Add users to group',
    icon: '➕',
    description: 'Add one or more directory objects (users / groups / computers) to a group.',
    columns: ['groupDn', 'memberDn'],
    sample: [
      { groupDn: SAMPLE_GROUP, memberDn: SAMPLE_USER_DN },
      { groupDn: SAMPLE_GROUP, memberDn: 'CN=Anna Smith,OU=Users,DC=corp,DC=example,DC=com' },
    ],
    run: (row) => addAdGroupMembers({ dn: row.groupDn, members: [row.memberDn] }),
    key: (row) => `${row.memberDn || ''} → ${row.groupDn || ''}`,
  },
  {
    id: 'removeFromGroup',
    label: 'Remove users from group',
    icon: '➖',
    description: 'Remove directory objects from a group.',
    columns: ['groupDn', 'memberDn'],
    sample: [{ groupDn: SAMPLE_GROUP, memberDn: SAMPLE_USER_DN }],
    run: (row) => removeAdGroupMembers({ dn: row.groupDn, members: [row.memberDn] }),
    key: (row) => `${row.memberDn || ''} ⨯ ${row.groupDn || ''}`,
  },
  {
    id: 'accountFlags',
    label: 'Set account flags',
    icon: '🔧',
    description:
      'Toggle account state: disabled, unlock, mustChangePassword (pwdLastSet=0), dontExpirePassword. Leave a cell blank to skip that flag.',
    columns: ['dn', 'disabled', 'unlock', 'mustChangePassword', 'dontExpirePassword'],
    sample: [
      { dn: SAMPLE_USER_DN, disabled: 'true', unlock: '', mustChangePassword: '', dontExpirePassword: '' },
      { dn: 'CN=Anna Smith,OU=Users,DC=corp,DC=example,DC=com', disabled: '', unlock: 'true', mustChangePassword: '', dontExpirePassword: '' },
      { dn: 'CN=Service Account,OU=Service Accounts,DC=corp,DC=example,DC=com', disabled: '', unlock: '', mustChangePassword: '', dontExpirePassword: 'true' },
    ],
    run: (row) => {
      const body = { dn: row.dn }
      const disabled = parseBool(row.disabled, null)
      const unlock = parseBool(row.unlock, null)
      const mustChangePassword = parseBool(row.mustChangePassword, null)
      const dontExpirePassword = parseBool(row.dontExpirePassword, null)
      if (disabled !== null) body.disabled = disabled
      if (unlock === true) body.unlock = true
      if (mustChangePassword === true) body.mustChangePassword = true
      if (dontExpirePassword !== null) body.dontExpirePassword = dontExpirePassword
      return setAdUserAccount(body)
    },
    key: (row) => row.dn || `row ${row._row}`,
  },
  {
    id: 'resetPasswords',
    label: 'Reset passwords',
    icon: '🔑',
    description:
      'Set a new password for each user via LDAP unicodePwd. Requires encrypted LDAP (LDAPS / StartTLS) and reset rights.',
    columns: ['dn', 'newPassword', 'mustChangeNextLogon'],
    sample: [
      { dn: SAMPLE_USER_DN, newPassword: 'P@ssw0rd!2026', mustChangeNextLogon: 'true' },
    ],
    run: (row) =>
      resetAdUserPassword({
        dn: row.dn,
        newPassword: row.newPassword,
        mustChangeNextLogon: parseBool(row.mustChangeNextLogon, false),
      }),
    key: (row) => row.dn || `row ${row._row}`,
  },
  {
    id: 'updateAttributes',
    label: 'Update user attributes',
    icon: '✏️',
    description:
      'Patch standard user fields (display name, mail, phones, manager, address, profile). Leave a cell blank to skip an attribute; use NULL to clear it.',
    columns: [
      'dn',
      'displayName',
      'givenName',
      'sn',
      'mail',
      'telephoneNumber',
      'mobile',
      'title',
      'department',
      'company',
      'manager',
      'description',
    ],
    sample: [
      {
        dn: SAMPLE_USER_DN,
        displayName: 'John Doe',
        givenName: 'John',
        sn: 'Doe',
        mail: 'jdoe@corp.example.com',
        telephoneNumber: '',
        mobile: '+1 555 0100',
        title: 'Analyst',
        department: 'Finance',
        company: 'Lenskart',
        manager: 'CN=Manager,OU=Users,DC=corp,DC=example,DC=com',
        description: 'Imported via Netpulse bulk',
      },
    ],
    run: (row) => {
      const patch = {}
      for (const k of [
        'displayName',
        'givenName',
        'sn',
        'mail',
        'telephoneNumber',
        'mobile',
        'title',
        'department',
        'company',
        'manager',
        'description',
      ]) {
        const v = row[k]
        if (v == null) continue
        if (String(v).toUpperCase() === 'NULL') patch[k] = ''
        else if (String(v).trim() === '') continue
        else patch[k] = v
      }
      if (!Object.keys(patch).length) {
        return Promise.reject(
          Object.assign(new Error('No editable cells supplied on this row.'), {
            response: { data: { code: 'AD_PATCH_EMPTY', error: 'Row had no editable cells.' } },
          }),
        )
      }
      return modifyAdUser({ dn: row.dn, patch })
    },
    key: (row) => row.dn || `row ${row._row}`,
  },
  {
    id: 'createGroups',
    label: 'Create groups',
    icon: '🗂️',
    description: 'Add new AD groups. groupCategory = security | distribution. groupScope = global | domainLocal | universal.',
    columns: [
      'parentDn',
      'cn',
      'samAccountName',
      'description',
      'mail',
      'groupCategory',
      'groupScope',
    ],
    sample: [
      {
        parentDn: 'OU=Groups,DC=corp,DC=example,DC=com',
        cn: 'All Staff',
        samAccountName: 'AllStaff',
        description: 'All employees',
        mail: 'all-staff@corp.example.com',
        groupCategory: 'security',
        groupScope: 'global',
      },
    ],
    run: (row) =>
      createAdGroup({
        parentDn: row.parentDn,
        cn: row.cn,
        samAccountName: row.samAccountName || row.cn,
        description: row.description || undefined,
        mail: row.mail || undefined,
        groupCategory: row.groupCategory || 'security',
        groupScope: row.groupScope || 'global',
      }),
    key: (row) => row.cn || `row ${row._row}`,
  },
  {
    id: 'createOus',
    label: 'Create OUs',
    icon: '🌳',
    description: 'Add new organizational units.',
    columns: ['parentDn', 'name', 'description', 'managedBy'],
    sample: [
      {
        parentDn: 'DC=corp,DC=example,DC=com',
        name: 'Finance',
        description: 'Finance department',
        managedBy: '',
      },
      {
        parentDn: 'OU=Finance,DC=corp,DC=example,DC=com',
        name: 'AP',
        description: 'Accounts payable',
        managedBy: '',
      },
    ],
    run: (row) =>
      createAdOu({
        parentDn: row.parentDn,
        name: row.name,
        description: row.description || undefined,
        managedBy: row.managedBy || undefined,
      }),
    key: (row) => row.name || `row ${row._row}`,
  },
]

const CONCURRENCY = 3

// ─── Component ──────────────────────────────────────────────────────────────

export default function AdBulkPanel() {
  const [opId, setOpId] = useState(null)
  const op = useMemo(() => OPERATIONS.find((o) => o.id === opId) || null, [opId])
  const [rows, setRows] = useState([])
  const [missing, setMissing] = useState([])
  const [filename, setFilename] = useState('')
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState([])
  const cancelRef = useRef(false)
  const fileRef = useRef(null)

  useEffect(() => {
    setRows([])
    setResults([])
    setMissing([])
    setFilename('')
  }, [opId])

  const summary = useMemo(() => {
    let ok = 0
    let err = 0
    for (const r of results) {
      if (r.status === 'ok') ok++
      else if (r.status === 'error') err++
    }
    return { ok, err, total: rows.length, processed: results.filter((r) => r.status !== 'pending').length }
  }, [results, rows.length])

  const handleFile = async (file) => {
    if (!file || !op) return
    const text = await file.text()
    const raw = parseCsv(text)
    const { data, missing: miss } = rowsToObjects(raw, op.columns)
    setFilename(file.name)
    setRows(data)
    setMissing(miss)
    setResults([])
  }

  const downloadSample = () => {
    if (!op) return
    download(`bulk-${op.id}.csv`, buildCsv(op.columns, op.sample))
  }

  const start = async () => {
    if (!op || !rows.length || running) return
    cancelRef.current = false
    setRunning(true)
    const init = rows.map(() => ({ status: 'pending', message: '' }))
    setResults(init)
    let idx = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
      while (!cancelRef.current) {
        const myIdx = idx++
        if (myIdx >= rows.length) return
        try {
          await op.run(rows[myIdx], myIdx)
          setResults((prev) => {
            const next = prev.slice()
            next[myIdx] = { status: 'ok', message: 'Success' }
            return next
          })
        } catch (e) {
          const d = e?.response?.data
          const code = d?.code
          const message = `${code ? `[${code}] ` : ''}${d?.error || e?.message || 'Failed'}`
          setResults((prev) => {
            const next = prev.slice()
            next[myIdx] = { status: 'error', message }
            return next
          })
        }
      }
    })
    await Promise.all(workers)
    setRunning(false)
  }

  const stop = () => {
    cancelRef.current = true
  }

  const downloadReport = () => {
    if (!op || !rows.length) return
    const cols = ['_row', ...op.columns, '_status', '_message']
    const data = rows.map((r, i) => ({
      ...r,
      _status: results[i]?.status || 'pending',
      _message: results[i]?.message || '',
    }))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const escape = (v) => {
      const s = v == null ? '' : String(v)
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [cols.map(escape).join(',')]
    for (const r of data) lines.push(cols.map((c) => escape(r[c])).join(','))
    download(`bulk-${op.id}-report-${stamp}.csv`, '\uFEFF' + lines.join('\r\n'))
  }

  if (!op) {
    return (
      <div className="space-y-4">
        <div className={`rounded-xl border p-5 ${idcsCx.border} ${idcsCx.bg2}`}>
          <h3 className={`text-sm font-semibold ${idcsCx.text}`}>Pick a bulk operation</h3>
          <p className={`text-sm mt-1 ${idcsCx.text2}`}>
            Each task uses its own CSV format. Download the sample, fill it in, then upload to run row-by-row with live
            progress. All writes respect the same LDAP permissions as single-user edits.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {OPERATIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setOpId(o.id)}
              className={`text-left rounded-xl border p-4 transition-opacity hover:opacity-95 cursor-pointer ${idcsCx.border} ${idcsCx.bg3}`}
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl select-none">{o.icon}</span>
                <div className="min-w-0">
                  <div className={`font-semibold ${idcsCx.text}`}>{o.label}</div>
                  <p className={`text-xs mt-1 ${idcsCx.text2}`}>{o.description}</p>
                  <p className={`text-[11px] font-mono mt-2 truncate ${idcsCx.text3}`}>
                    {o.columns.join(', ')}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className={`rounded-xl border p-4 ${idcsCx.border} ${idcsCx.bg2}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-2xl">{op.icon}</span>
              <h3 className={`text-base font-semibold ${idcsCx.text}`}>{op.label}</h3>
            </div>
            <p className={`text-sm mt-1 ${idcsCx.text2}`}>{op.description}</p>
            <p className={`text-[11px] font-mono mt-2 ${idcsCx.text3}`}>
              Columns: {op.columns.join(', ')}
            </p>
          </div>
          <button type="button" className={`text-sm ${idcsBtnGhost()}`} onClick={() => setOpId(null)}>
            ← Back to operations
          </button>
        </div>
      </div>

      <div className={`rounded-xl border p-4 ${idcsCx.border} ${idcsCx.bg3} flex flex-wrap items-center gap-3`}>
        <button type="button" className={`text-sm ${idcsBtnGhost()}`} onClick={downloadSample}>
          Download sample CSV
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          className={`text-sm ${idcsBtnPrimary()}`}
          onClick={() => fileRef.current?.click()}
          disabled={running}
        >
          Choose CSV
        </button>
        {filename && (
          <span className={`text-xs font-mono truncate ${idcsCx.text3}`} title={filename}>
            {filename}
          </span>
        )}
        {rows.length > 0 && (
          <span className={`text-xs ${idcsCx.text2}`}>
            {rows.length} row{rows.length !== 1 ? 's' : ''} ready
          </span>
        )}
      </div>

      {missing.length > 0 && (
        <div
          className={`text-sm rounded-lg px-4 py-3 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          Missing required columns: <strong>{missing.join(', ')}</strong>. Re-export from the sample template.
        </div>
      )}

      {rows.length > 0 && (
        <div className={`rounded-xl border ${idcsCx.border} ${idcsCx.bg3} overflow-hidden`}>
          <div className={`flex flex-wrap items-center gap-3 px-3 py-2 border-b ${idcsCx.border}`}>
            <button
              type="button"
              className={`text-sm ${idcsBtnPrimary()}`}
              disabled={running || !rows.length || missing.length > 0}
              onClick={start}
            >
              {running ? `Processing… ${summary.processed}/${summary.total}` : `Run ${rows.length} row${rows.length !== 1 ? 's' : ''}`}
            </button>
            {running && (
              <button type="button" className={`text-sm ${idcsBtnGhost()}`} onClick={stop}>
                Stop
              </button>
            )}
            {results.length > 0 && (
              <button type="button" className={`text-sm ${idcsBtnGhost()}`} onClick={downloadReport}>
                Download report CSV
              </button>
            )}
            {results.length > 0 && (
              <span className={`text-xs ml-auto ${idcsCx.text2}`}>
                <span style={{ color: 'var(--green)' }}>{summary.ok} ok</span> ·{' '}
                <span style={{ color: 'var(--red)' }}>{summary.err} failed</span> ·{' '}
                {summary.total - summary.processed} remaining
              </span>
            )}
          </div>
          <div className="max-h-[60vh] overflow-auto">
            <table className="min-w-full text-xs">
              <thead className={`${idcsCx.bg3} text-[11px] uppercase tracking-wide ${idcsCx.text3}`}>
                <tr>
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">Key</th>
                  {op.columns.slice(0, 3).map((c) => (
                    <th key={c} className="px-2 py-2 text-left">
                      {c}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-left">Status</th>
                  <th className="px-2 py-2 text-left">Message</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${idcsCx.divide}`}>
                {rows.map((r, i) => {
                  const st = results[i]
                  const color =
                    st?.status === 'ok'
                      ? 'var(--green)'
                      : st?.status === 'error'
                        ? 'var(--red)'
                        : st?.status === 'pending'
                          ? 'var(--text3)'
                          : 'var(--text3)'
                  return (
                    <tr key={r._row} className="align-top">
                      <td className={`px-2 py-1.5 ${idcsCx.text3}`}>{r._row}</td>
                      <td className={`px-2 py-1.5 font-mono break-all max-w-[16rem] ${idcsCx.text}`}>
                        {op.key(r)}
                      </td>
                      {op.columns.slice(0, 3).map((c) => (
                        <td key={c} className={`px-2 py-1.5 font-mono break-all max-w-[12rem] ${idcsCx.text2}`}>
                          {r[c]}
                        </td>
                      ))}
                      <td className="px-2 py-1.5" style={{ color }}>
                        {st?.status === 'ok'
                          ? '✓ ok'
                          : st?.status === 'error'
                            ? '✗ error'
                            : st?.status === 'pending'
                              ? '…'
                              : '—'}
                      </td>
                      <td className={`px-2 py-1.5 max-w-[24rem] break-words ${idcsCx.text2}`}>
                        {st?.message || ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
