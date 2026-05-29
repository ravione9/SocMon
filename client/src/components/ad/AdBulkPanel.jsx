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

function colName(col) {
  return typeof col === 'string' ? col : col.name
}

function colRequired(col) {
  return typeof col === 'string' ? false : col.required === true
}

function colNames(cols) {
  return cols.map(colName)
}

function rowsToObjects(rows, expectedCols) {
  if (!rows.length) return { headers: [], data: [], missing: [] }
  const headerRow = rows[0].map((h) => String(h ?? '').trim())
  const lower = headerRow.map((h) => h.toLowerCase())
  const headerMap = new Map()
  for (const col of expectedCols) {
    const name = colName(col)
    const idx = lower.indexOf(name.toLowerCase())
    if (idx >= 0) headerMap.set(name, idx)
  }
  const missing = expectedCols.filter((c) => colRequired(c) && !headerMap.has(colName(c))).map(colName)
  const data = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.every((c) => String(c).trim() === '')) continue
    const obj = { _row: r + 1 }
    for (const col of expectedCols) {
      const name = colName(col)
      const idx = headerMap.get(name)
      obj[name] = idx == null ? '' : String(row[idx] ?? '').trim()
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
  const names = colNames(columns)
  const escape = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [names.map(escape).join(',')]
  for (const row of sample) {
    lines.push(names.map((c) => escape(row[c] ?? '')).join(','))
  }
  return '\uFEFF' + lines.join('\r\n')
}

function deriveUpn(sam, domainFqdn) {
  const s = String(sam || '').trim()
  const d = String(domainFqdn || '').trim().replace(/^@/, '')
  if (!s || !d) return ''
  return `${s}@${d}`
}

function fqdnToSampleBase(domainFqdn) {
  const d = String(domainFqdn || '').trim().replace(/^@/, '')
  if (!d) return 'DC=corp,DC=example,DC=com'
  return d.split('.').map((p) => `DC=${p}`).join(',')
}

function validateRow(op, row, ctx) {
  switch (op.id) {
    case 'createUsers': {
      const parentDn = row.parentDn || ctx.defaultParentDn
      if (!parentDn) return 'parentDn is required (set per row or pick a default OU below).'
      if (!row.samAccountName) return 'samAccountName is required.'
      const enabled = parseBool(row.enabled, true)
      if (enabled && !row.password) return 'password is required when enabled=true.'
      return ''
    }
    case 'moveUsers':
      if (!row.dn) return 'dn is required.'
      if (!row.newParentDn) return 'newParentDn is required.'
      return ''
    case 'addToGroup':
    case 'removeFromGroup':
      if (!row.groupDn) return 'groupDn is required.'
      if (!row.memberDn) return 'memberDn is required.'
      return ''
    case 'accountFlags': {
      if (!row.dn) return 'dn is required.'
      const hasFlag =
        parseBool(row.disabled, null) !== null ||
        parseBool(row.unlock, null) === true ||
        parseBool(row.mustChangePassword, null) === true ||
        parseBool(row.dontExpirePassword, null) !== null
      if (!hasFlag) return 'Set at least one flag column (disabled, unlock, mustChangePassword, dontExpirePassword).'
      return ''
    }
    case 'resetPasswords':
      if (!row.dn) return 'dn is required.'
      if (!row.newPassword) return 'newPassword is required.'
      return ''
    case 'updateAttributes':
      if (!row.dn) return 'dn is required.'
      return ''
    case 'createGroups':
      if (!row.parentDn) return 'parentDn is required.'
      if (!row.cn) return 'cn is required.'
      return ''
    case 'createOus':
      if (!row.parentDn) return 'parentDn is required.'
      if (!row.name) return 'name is required.'
      return ''
    default:
      return ''
  }
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

function buildOperations(domainFqdn) {
  const baseDn = fqdnToSampleBase(domainFqdn)
  const sampleParent = `OU=Users,${baseDn}`
  const sampleGroup = `CN=All Staff,OU=Groups,${baseDn}`
  const sampleTargetOu = `OU=Finance,${baseDn}`
  const sampleUserDn = `CN=John Doe,${sampleParent}`
  const sampleUpn = deriveUpn('jdoe', domainFqdn) || 'jdoe@corp.example.com'
  const sampleMail = sampleUpn

  return [
    {
      id: 'createUsers',
      label: 'Create users',
      icon: '👤',
      description: 'Add new AD user accounts. Password is required to start the account enabled.',
      columns: [
        { name: 'samAccountName', required: true },
        { name: 'givenName' },
        { name: 'sn' },
        { name: 'displayName' },
        { name: 'userPrincipalName' },
        { name: 'mail' },
        { name: 'description' },
        { name: 'password' },
        { name: 'parentDn' },
        { name: 'enabled' },
        { name: 'dontExpirePassword' },
        { name: 'mustChangeNextLogon' },
      ],
      sample: [
        {
          samAccountName: 'jdoe',
          givenName: 'John',
          sn: 'Doe',
          displayName: 'John Doe',
          userPrincipalName: sampleUpn,
          mail: sampleMail,
          description: 'Joiner — Finance',
          password: 'P@ssw0rd!2026',
          parentDn: sampleParent,
          enabled: 'true',
          dontExpirePassword: 'false',
          mustChangeNextLogon: 'true',
        },
        {
          samAccountName: 'asmith',
          givenName: 'Anna',
          sn: 'Smith',
          displayName: 'Anna Smith',
          userPrincipalName: deriveUpn('asmith', domainFqdn) || 'asmith@corp.example.com',
          mail: deriveUpn('asmith', domainFqdn) || 'asmith@corp.example.com',
          description: '',
          password: 'P@ssw0rd!2026',
          parentDn: sampleParent,
          enabled: 'true',
          dontExpirePassword: 'true',
          mustChangeNextLogon: 'false',
        },
      ],
      run: (row, _idx, ctx) => {
        const parentDn = row.parentDn || ctx.defaultParentDn
        const userPrincipalName =
          row.userPrincipalName || deriveUpn(row.samAccountName, ctx.domainFqdn) || undefined
        return createAdUser({
          parentDn,
          samAccountName: row.samAccountName,
          userPrincipalName,
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
        })
      },
      key: (row) => row.samAccountName || row.userPrincipalName || `row ${row._row}`,
    },
    {
      id: 'moveUsers',
      label: 'Move users to OU',
      icon: '➡️',
      description: 'Move (or any object) to a new OU/container using modifyDN.',
      columns: [{ name: 'dn', required: true }, { name: 'newParentDn', required: true }],
      sample: [
        { dn: sampleUserDn, newParentDn: sampleTargetOu },
        { dn: `CN=Anna Smith,${sampleParent}`, newParentDn: sampleTargetOu },
      ],
      run: (row) => moveAdUser({ dn: row.dn, newParentDn: row.newParentDn }),
      key: (row) => row.dn || `row ${row._row}`,
    },
    {
      id: 'addToGroup',
      label: 'Add users to group',
      icon: '➕',
      description: 'Add one or more directory objects (users / groups / computers) to a group.',
      columns: [{ name: 'groupDn', required: true }, { name: 'memberDn', required: true }],
      sample: [
        { groupDn: sampleGroup, memberDn: sampleUserDn },
        { groupDn: sampleGroup, memberDn: `CN=Anna Smith,${sampleParent}` },
      ],
      run: (row) => addAdGroupMembers({ dn: row.groupDn, members: [row.memberDn] }),
      key: (row) => `${row.memberDn || ''} → ${row.groupDn || ''}`,
    },
    {
      id: 'removeFromGroup',
      label: 'Remove users from group',
      icon: '➖',
      description: 'Remove directory objects from a group.',
      columns: [{ name: 'groupDn', required: true }, { name: 'memberDn', required: true }],
      sample: [{ groupDn: sampleGroup, memberDn: sampleUserDn }],
      run: (row) => removeAdGroupMembers({ dn: row.groupDn, members: [row.memberDn] }),
      key: (row) => `${row.memberDn || ''} ⨯ ${row.groupDn || ''}`,
    },
    {
      id: 'accountFlags',
      label: 'Set account flags',
      icon: '🔧',
      description:
        'Toggle account state: disabled, unlock, mustChangePassword (pwdLastSet=0), dontExpirePassword. Leave a cell blank to skip that flag.',
      columns: [
        { name: 'dn', required: true },
        { name: 'disabled' },
        { name: 'unlock' },
        { name: 'mustChangePassword' },
        { name: 'dontExpirePassword' },
      ],
      sample: [
        { dn: sampleUserDn, disabled: 'true', unlock: '', mustChangePassword: '', dontExpirePassword: '' },
        {
          dn: `CN=Anna Smith,${sampleParent}`,
          disabled: '',
          unlock: 'true',
          mustChangePassword: '',
          dontExpirePassword: '',
        },
        {
          dn: `CN=Service Account,OU=Service Accounts,${baseDn}`,
          disabled: '',
          unlock: '',
          mustChangePassword: '',
          dontExpirePassword: 'true',
        },
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
      columns: [
        { name: 'dn', required: true },
        { name: 'newPassword', required: true },
        { name: 'mustChangeNextLogon' },
      ],
      sample: [{ dn: sampleUserDn, newPassword: 'P@ssw0rd!2026', mustChangeNextLogon: 'true' }],
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
        { name: 'dn', required: true },
        { name: 'displayName' },
        { name: 'givenName' },
        { name: 'sn' },
        { name: 'mail' },
        { name: 'telephoneNumber' },
        { name: 'mobile' },
        { name: 'title' },
        { name: 'department' },
        { name: 'company' },
        { name: 'manager' },
        { name: 'description' },
      ],
      sample: [
        {
          dn: sampleUserDn,
          displayName: 'John Doe',
          givenName: 'John',
          sn: 'Doe',
          mail: sampleMail,
          telephoneNumber: '',
          mobile: '+1 555 0100',
          title: 'Analyst',
          department: 'Finance',
          company: 'Lenskart',
          manager: `CN=Manager,${sampleParent}`,
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
        { name: 'parentDn', required: true },
        { name: 'cn', required: true },
        { name: 'samAccountName' },
        { name: 'description' },
        { name: 'mail' },
        { name: 'groupCategory' },
        { name: 'groupScope' },
      ],
      sample: [
        {
          parentDn: `OU=Groups,${baseDn}`,
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
      columns: [
        { name: 'parentDn', required: true },
        { name: 'name', required: true },
        { name: 'description' },
        { name: 'managedBy' },
      ],
      sample: [
        {
          parentDn: baseDn,
          name: 'Finance',
          description: 'Finance department',
          managedBy: '',
        },
        {
          parentDn: `OU=Finance,${baseDn}`,
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
}

const CONCURRENCY = 3

// ─── Component ──────────────────────────────────────────────────────────────

export default function AdBulkPanel({ domainFqdn = '' }) {
  const operations = useMemo(() => buildOperations(domainFqdn), [domainFqdn])
  const [opId, setOpId] = useState(null)
  const op = useMemo(() => operations.find((o) => o.id === opId) || null, [operations, opId])
  const [rows, setRows] = useState([])
  const [missing, setMissing] = useState([])
  const [parseError, setParseError] = useState('')
  const [filename, setFilename] = useState('')
  const [defaultParentDn, setDefaultParentDn] = useState('')
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState([])
  const cancelRef = useRef(false)
  const fileRef = useRef(null)
  const runCtx = useMemo(
    () => ({ domainFqdn, defaultParentDn: defaultParentDn.trim() }),
    [domainFqdn, defaultParentDn],
  )

  useEffect(() => {
    setRows([])
    setResults([])
    setMissing([])
    setParseError('')
    setFilename('')
  }, [opId])

  const rowIssues = useMemo(() => {
    if (!op || !rows.length) return []
    return rows.map((row) => validateRow(op, row, runCtx))
  }, [op, rows, runCtx])

  const invalidRowCount = useMemo(() => rowIssues.filter(Boolean).length, [rowIssues])

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
    setParseError('')
    try {
      const text = await file.text()
      const raw = parseCsv(text)
      if (raw.length < 1) {
        setParseError('CSV file is empty.')
        setRows([])
        setMissing([])
        setFilename(file.name)
        return
      }
      if (raw.length < 2) {
        setParseError('CSV must have a header row and at least one data row.')
        setRows([])
        setMissing([])
        setFilename(file.name)
        return
      }
      const { data, missing: miss } = rowsToObjects(raw, op.columns)
      if (!data.length) {
        setParseError('No data rows found after the header. Add at least one row of values.')
        setRows([])
        setMissing(miss)
        setFilename(file.name)
        return
      }
      setFilename(file.name)
      setRows(data)
      setMissing(miss)
      setResults([])
    } catch (e) {
      setParseError(e?.message || 'Failed to read CSV file.')
      setRows([])
      setMissing([])
      setFilename(file?.name || '')
    }
  }

  const downloadSample = () => {
    if (!op) return
    download(`bulk-${op.id}.csv`, buildCsv(op.columns, op.sample))
  }

  const start = async () => {
    if (!op || !rows.length || running || missing.length > 0 || invalidRowCount > 0) return
    cancelRef.current = false
    setRunning(true)
    const init = rows.map(() => ({ status: 'pending', message: '' }))
    setResults(init)
    let idx = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
      while (!cancelRef.current) {
        const myIdx = idx++
        if (myIdx >= rows.length) return
        const rowErr = validateRow(op, rows[myIdx], runCtx)
        if (rowErr) {
          setResults((prev) => {
            const next = prev.slice()
            next[myIdx] = { status: 'error', message: rowErr }
            return next
          })
          continue
        }
        try {
          await op.run(rows[myIdx], myIdx, runCtx)
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
    const names = colNames(op.columns)
    const cols = ['_row', ...names, '_status', '_message']
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

  const opColumnLabel = (opDef) => {
    const required = opDef.columns.filter(colRequired).map(colName)
    const optional = opDef.columns.filter((c) => !colRequired(c)).map(colName)
    if (!optional.length) return required.join(', ')
    return `${required.join(', ')} (optional: ${optional.join(', ')})`
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
          {operations.map((o) => (
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
                  <p className={`text-[11px] font-mono mt-2 line-clamp-2 ${idcsCx.text3}`} title={opColumnLabel(o)}>
                    {opColumnLabel(o)}
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
              Required: {op.columns.filter(colRequired).map(colName).join(', ')}
              {op.columns.some((c) => !colRequired(c)) && (
                <>
                  {' · '}
                  Optional: {op.columns.filter((c) => !colRequired(c)).map(colName).join(', ')}
                </>
              )}
            </p>
          </div>
          <button type="button" className={`text-sm ${idcsBtnGhost()}`} onClick={() => setOpId(null)}>
            ← Back to operations
          </button>
        </div>
      </div>

      {op.id === 'createUsers' && (
        <div className={`rounded-xl border p-4 ${idcsCx.border} ${idcsCx.bg2}`}>
          <label className={`block text-xs font-semibold mb-1 ${idcsCx.text2}`}>
            Default parent OU (optional)
          </label>
          <input
            type="text"
            value={defaultParentDn}
            onChange={(e) => setDefaultParentDn(e.target.value)}
            placeholder={`OU=Users,${fqdnToSampleBase(domainFqdn)}`}
            className={`w-full text-sm font-mono rounded-lg px-3 py-2 border ${idcsCx.border} bg-[var(--bg1)] ${idcsCx.text}`}
          />
          <p className={`text-xs mt-1.5 ${idcsCx.text3}`}>
            Used when a CSV row leaves <span className="font-mono">parentDn</span> blank. UPN is auto-filled from{' '}
            <span className="font-mono">samAccountName@{domainFqdn || 'domain'}</span> when omitted.
          </p>
        </div>
      )}

      <div
        className={`rounded-xl border p-4 ${idcsCx.border} ${idcsCx.bg3} flex flex-wrap items-center gap-3`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const f = e.dataTransfer.files?.[0]
          if (f) handleFile(f)
        }}
      >
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

      {parseError && (
        <div
          className={`text-sm rounded-lg px-4 py-3 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {parseError}
        </div>
      )}

      {missing.length > 0 && (
        <div
          className={`text-sm rounded-lg px-4 py-3 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          Missing required columns: <strong>{missing.join(', ')}</strong>. Download the sample or add these headers.
        </div>
      )}

      {rows.length > 0 && invalidRowCount > 0 && !running && (
        <div
          className={`text-sm rounded-lg px-4 py-3 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--amber) 12%, var(--bg3))', color: 'var(--amber)' }}
        >
          {invalidRowCount} row{invalidRowCount !== 1 ? 's have' : ' has'} validation issues. Fix them before running
          (see Message column below).
        </div>
      )}

      {rows.length > 0 && (
        <div className={`rounded-xl border ${idcsCx.border} ${idcsCx.bg3} overflow-hidden`}>
          <div className={`flex flex-wrap items-center gap-3 px-3 py-2 border-b ${idcsCx.border}`}>
            <button
              type="button"
              className={`text-sm ${idcsBtnPrimary()}`}
              disabled={running || !rows.length || missing.length > 0 || invalidRowCount > 0}
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
                  {colNames(op.columns).slice(0, 3).map((c) => (
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
                  const rowIssue = rowIssues[i]
                  const color =
                    st?.status === 'ok'
                      ? 'var(--green)'
                      : st?.status === 'error' || rowIssue
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
                      {colNames(op.columns).slice(0, 3).map((c) => (
                        <td key={c} className={`px-2 py-1.5 font-mono break-all max-w-[12rem] ${idcsCx.text2}`}>
                          {r[c]}
                        </td>
                      ))}
                      <td className="px-2 py-1.5" style={{ color }}>
                        {st?.status === 'ok'
                          ? '✓ ok'
                          : st?.status === 'error'
                            ? '✗ error'
                            : rowIssue
                              ? '⚠ invalid'
                              : st?.status === 'pending'
                                ? '…'
                                : '—'}
                      </td>
                      <td className={`px-2 py-1.5 max-w-[24rem] break-words ${idcsCx.text2}`}>
                        {st?.message || rowIssue || ''}
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
