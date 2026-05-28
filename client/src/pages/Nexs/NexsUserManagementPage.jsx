/**
 * NexsUserManagementPage — Lenskart Auth Service user & role management
 */

import { useCallback, useEffect, useState } from 'react'
import { useUrlTab } from '../../hooks/useUrlTab.js'
import toast from 'react-hot-toast'
import NexsUserTable from '../../components/nexs/NexsUserTable'
import NexsRoleAssignModal from '../../components/nexs/NexsRoleAssignModal'
import NexsBulkUpload from '../../components/nexs/NexsBulkUpload'
import NexsLoginPanel from '../../components/nexs/NexsLoginPanel'
import {
  createUser,
  getAssignableRoles,
  getNexsMe,
  getNexsMeta,
  getNexsSession,
  getUserRoles,
  listFacilities,
  listRoles,
  listUsers,
  lookupEmployee,
  signOutNexs,
  updateNexsSession,
} from '../../api/nexs'
import NexsPortalButton from '../../components/nexs/NexsPortalButton'
import { nexsBtnGhost, nexsBtnPrimary, nexsCx, nexsInputClass } from '../../components/nexs/nexsTheme'

const TABS = [
  { id: 'users', label: 'Users', icon: '👥' },
  { id: 'create', label: 'Add user', icon: '➕' },
  { id: 'bulk', label: 'Bulk CSV', icon: '📦' },
]

function pickUserText(row, keys) {
  for (const key of keys) {
    const value = row?.[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim()
  }
  return ''
}

function pickEmpCode(row) {
  return pickUserText(row, ['employeeCode', 'empCode', 'employee_code'])
}

function roleName(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.trim()
  return String(value?.name || value?.roleGroupName || value?.roleName || value?.id || '').trim()
}

function parseRoleGroups(data) {
  const candidates = [
    data?.roleGroups,
    data?.roles,
    data?.roleNames,
    data?.roleGroup,
    data?.activeRoleGroups,
    data?.data,
    data?.content,
    data?.data?.roleGroups,
    data?.data?.roles,
    data?.content?.roleGroups,
    data?.content?.roles,
    data?.payload?.roleGroups,
    data?.payload?.roles,
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (Array.isArray(candidate)) {
      return candidate.map(roleName).filter(Boolean)
    }
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    }
  }

  return []
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className={`block text-sm font-medium mb-1 ${nexsCx.text}`}>
        {label} {required && <span style={{ color: 'var(--red)' }}>*</span>}
      </label>
      {children}
    </div>
  )
}

function CreateUserForm({ roles, onCreated }) {
  const EMPTY = {
    name: '',
    email: '',
    employeeCode: '',
    phoneCode: '+91',
    phoneNumber: '',
    department: '',
    userType: '',
    roleGroups: [],
  }
  const [form, setForm] = useState(EMPTY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }))
  const toggleRole = (name) => {
    setForm((p) => ({
      ...p,
      roleGroups: p.roleGroups.includes(name)
        ? p.roleGroups.filter((x) => x !== name)
        : [...p.roleGroups, name],
    }))
  }

  const roleName = (r) => (typeof r === 'string' ? r : r?.name || String(r?.id ?? ''))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.email && !form.employeeCode) {
      setError('Email or employee code is required')
      return
    }
    setLoading(true)
    setError('')
    try {
      await createUser({
        name: form.name || undefined,
        email: form.email || undefined,
        employeeCode: form.employeeCode || undefined,
        phoneCode: form.phoneCode || undefined,
        phoneNumber: form.phoneNumber || undefined,
        department: form.department || undefined,
        userType: form.userType || undefined,
        roleGroups: form.roleGroups,
      })
      toast.success('User created')
      setForm(EMPTY)
      onCreated?.()
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-4">
      <Field label="Full name">
        <input className={nexsInputClass()} value={form.name} onChange={set('name')} placeholder="John Doe" />
      </Field>
      <Field label="Email" required>
        <input type="email" className={nexsInputClass()} value={form.email} onChange={set('email')} placeholder="john.doe@lenskart.com" />
      </Field>
      <Field label="Employee code">
        <input className={nexsInputClass()} value={form.employeeCode} onChange={set('employeeCode')} placeholder="EMP001" />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Phone code">
          <input className={nexsInputClass()} value={form.phoneCode} onChange={set('phoneCode')} />
        </Field>
        <div className="col-span-2">
          <Field label="Phone number">
            <input className={nexsInputClass()} value={form.phoneNumber} onChange={set('phoneNumber')} />
          </Field>
        </div>
      </div>
      <Field label="Department">
        <input className={nexsInputClass()} value={form.department} onChange={set('department')} />
      </Field>
      <Field label="User type">
        <input className={nexsInputClass()} value={form.userType} onChange={set('userType')} placeholder="e.g. internal" />
      </Field>
      {roles.length > 0 && (
        <div>
          <p className={`text-sm font-medium mb-2 ${nexsCx.text}`}>Role groups</p>
          <div className="flex flex-wrap gap-2">
            {roles.map((r) => {
              const n = roleName(r)
              if (!n) return null
              const on = form.roleGroups.includes(n)
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => toggleRole(n)}
                  className={`text-xs px-3 py-1.5 rounded-full border ${on ? 'border-[var(--accent)]' : nexsCx.border}`}
                  style={on ? { background: 'color-mix(in srgb, var(--accent) 18%, var(--bg3))', color: 'var(--accent)' } : {}}
                >
                  {n}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {error && (
        <div className="text-sm p-3 rounded-lg" style={{ color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))' }}>
          {error}
        </div>
      )}
      <button type="submit" disabled={loading} className={nexsBtnPrimary()}>
        {loading ? 'Creating…' : 'Create user'}
      </button>
    </form>
  )
}

export default function NexsUserManagementPage() {
  const [tab, setTab] = useUrlTab('users', TABS)
  const [meta, setMeta] = useState(null)
  const [session, setSession] = useState(() => getNexsSession())
  const [users, setUsers] = useState([])
  const [roles, setRoles] = useState([])
  const [grantableRoles, setGrantableRoles] = useState([])
  const [facilities, setFacilities] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [roleModal, setRoleModal] = useState(null)
  const parentEmpCode = session?.empCode || null

  const loadMeta = useCallback(async () => {
    try {
      const m = await getNexsMeta()
      setMeta(m)
      return m
    } catch {
      setMeta({ configured: false })
      return { configured: false }
    }
  }, [])

  const loadRoles = useCallback(async (rolesApp) => {
    try {
      const d = await listRoles(rolesApp)
      setRoles(d.roles || [])
      if (d.warning) {
        toast.error(d.warning, { id: 'nexs-roles-warning' })
      }
    } catch (e) {
      if (e.response?.status === 401) {
        signOutNexs()
        setSession(null)
        toast.error(e.response?.data?.error || 'Session expired — sign in again')
      }
      setRoles([])
    }
  }, [])

  const loadFacilities = useCallback(async (appName) => {
    // Facilities are an enhancement — failures (including 401) must not sign the user out.
    // Search/roles calls will surface a genuine session expiry.
    try {
      const d = await listFacilities(appName)
      setFacilities(Array.isArray(d.facilities) ? d.facilities : [])
    } catch {
      setFacilities([])
    }
  }, [])

  const loadGrantableRoles = useCallback(async (empCode) => {
    if (!empCode) {
      setGrantableRoles([])
      return
    }
    try {
      const d = await getAssignableRoles(empCode)
      setGrantableRoles(Array.isArray(d?.roles) ? d.roles : [])
    } catch {
      setGrantableRoles([])
    }
  }, [])

  const loadUsers = useCallback(async (q = '') => {
    setLoading(true)
    try {
      const params = q.trim()
        ? { search: q, mode: 'search' }
        : { ...(parentEmpCode ? { parentEmpCode } : {}) }
      const d = await listUsers(params)
      let nextUsers = Array.isArray(d.users) ? d.users : []
      const query = String(q || '').trim()

      // If the query looks like an employee code but Nexs has nothing, surface an HR-only row
      // so the user can still see the person and assign roles (creating the Nexs user on save).
      if (query && nextUsers.length === 0 && /^[A-Za-z0-9_-]{3,}$/.test(query)) {
        try {
          const lookup = await lookupEmployee(query)
          const emp = lookup?.employee
          if (emp?.empCode) {
            nextUsers = [{
              employeeCode: emp.empCode,
              name: emp.name || '',
              email: emp.email || '',
              phoneNumber: emp.mobile || '',
              department: emp.department || '',
              designation: emp.designation || '',
              location: emp.location || '',
              managerEmployeeCode: emp.managerEmpCode || '',
              roleGroups: [],
              _hrOnly: true,
            }]
          }
        } catch {
          // ignore - search just returns empty.
        }
      }

      // Enrich every visible user with HR master data (name, dept, designation, location)
      // in parallel. Capped to keep this responsive on larger result sets.
      const empCodes = [...new Set(nextUsers.map((u) => pickEmpCode(u)).filter(Boolean))].slice(0, 30)
      if (empCodes.length) {
        const lookups = await Promise.allSettled(
          empCodes.map(async (empCode) => {
            const [hr, roles] = await Promise.allSettled([
              lookupEmployee(empCode),
              getUserRoles(empCode),
            ])
            return {
              empCode,
              employee: hr.status === 'fulfilled' ? hr.value?.employee || null : null,
              roles: roles.status === 'fulfilled' ? parseRoleGroups(roles.value) : null,
            }
          }),
        )

        const enrichByEmp = new Map()
        for (const result of lookups) {
          if (result.status !== 'fulfilled') continue
          const { empCode, employee, roles: assignedRoles } = result.value
          enrichByEmp.set(empCode, { employee, roles: assignedRoles })
        }

        if (enrichByEmp.size) {
          nextUsers = nextUsers.map((user) => {
            const empCode = pickEmpCode(user)
            const enrich = enrichByEmp.get(empCode)
            if (!enrich) return user
            const out = { ...user }
            if (enrich.employee) {
              const emp = enrich.employee
              out.name = out.name || emp.name || ''
              out.email = out.email || emp.email || ''
              out.phoneNumber = out.phoneNumber || emp.mobile || ''
              out.department = out.department || emp.department || ''
              out.designation = out.designation || emp.designation || ''
              out.location = out.location || emp.location || ''
              out.managerEmployeeCode = out.managerEmployeeCode || emp.managerEmpCode || ''
            }
            if (Array.isArray(enrich.roles) && enrich.roles.length) {
              const existing = []
              if (Array.isArray(out.roleGroups)) existing.push(...out.roleGroups.map(roleName).filter(Boolean))
              if (Array.isArray(out.roles)) existing.push(...out.roles.map(roleName).filter(Boolean))
              out.roleGroups = [...new Set([...existing, ...enrich.roles])]
            }
            return out
          })
        }
      }

      setUsers(nextUsers)
    } catch (e) {
      if (e.response?.status === 401) {
        signOutNexs()
        setSession(null)
        toast.error('Nexs session expired. Please sign in again.')
      } else {
        toast.error(e.response?.data?.error || e.message || 'Failed to load users')
      }
      setUsers([])
    } finally {
      setLoading(false)
    }
  }, [parentEmpCode])

  const refreshData = useCallback(() => {
    loadRoles(meta?.rolesAppName)
    loadFacilities(meta?.appName)
    loadGrantableRoles(parentEmpCode)
    loadUsers(search)
  }, [loadRoles, loadFacilities, loadGrantableRoles, loadUsers, search, meta?.rolesAppName, meta?.appName, parentEmpCode])

  useEffect(() => {
    loadMeta()
  }, [loadMeta])

  // Backfill empCode for sessions that pre-date the login change.
  // Once we have it, immediately trigger a grantable-role fetch so the page header
  // and the role modal don't show "JWT active" with an empty pool.
  useEffect(() => {
    let cancelled = false
    if (!session?.token || session?.empCode) return undefined
    getNexsMe()
      .then((me) => {
        if (cancelled || !me?.empCode) return
        const next = updateNexsSession({ empCode: me.empCode, email: me.email || session.email })
        if (next) {
          setSession(next)
          loadGrantableRoles(me.empCode)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [session?.token, session?.empCode, session?.email, loadGrantableRoles])

  useEffect(() => {
    if (session?.token && meta?.configured) {
      refreshData()
    }
  }, [session?.token, meta?.configured, refreshData])

  const handleNexsLogin = () => {
    setSession(getNexsSession())
  }

  const handleNexsLogout = () => {
    signOutNexs()
    setSession(null)
    setUsers([])
    setRoles([])
    setGrantableRoles([])
    setFacilities([])
    toast.success('Signed out of Nexs')
  }

  const handleSearch = (e) => {
    e.preventDefault()
    loadUsers(search)
  }

  if (meta && !meta.configured) {
    return (
      <div className={`rounded-xl border p-8 max-w-xl ${nexsCx.border} ${nexsCx.bg2}`}>
        <h1 className={`text-xl font-bold mb-2 ${nexsCx.text}`}>Nexs user management</h1>
        <p className={`text-sm ${nexsCx.text2}`}>
          Set <code className="font-mono text-xs">NEXS_AUTH_BASE_URL</code> on the server, then restart.
        </p>
      </div>
    )
  }

  if (!session?.token) {
    return (
      <div className="space-y-6">
        <h1 className={`text-xl font-bold ${nexsCx.text}`}>Nexs user management</h1>
        <NexsLoginPanel onLoggedIn={handleNexsLogin} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className={`text-xl font-bold ${nexsCx.text}`}>Nexs user management</h1>
          <p className={`text-sm ${nexsCx.text3}`}>
            Signed in as <strong className={nexsCx.text2}>{session.userName}</strong>
            {parentEmpCode ? (
              <>
                {' · '}
                Emp <span className="font-mono">{parentEmpCode}</span>
              </>
            ) : null}
            {session.appId ? (
              <>
                {' · '}
                App {session.appId}
              </>
            ) : null}
            {' · '}
            <span className="font-mono text-xs">
              {grantableRoles.length
                ? `${grantableRoles.length} grantable roles`
                : roles.length
                  ? `admin scope (${roles.length} roles)`
                  : 'JWT active'}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NexsPortalButton meta={meta} />
          <button type="button" onClick={refreshData} className="text-sm" style={{ color: 'var(--accent)' }}>
            ↻ Refresh
          </button>
          <button type="button" onClick={handleNexsLogout} className={nexsBtnGhost()}>
            Sign out
          </button>
        </div>
      </div>

      <div className={`flex gap-1 p-1 rounded-xl border w-fit ${nexsCx.border} ${nexsCx.bg2}`}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`text-sm px-4 py-2 rounded-lg transition-colors ${tab === t.id ? 'bg-[var(--bg4)]' : ''} ${nexsCx.text}`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'users' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <form onSubmit={handleSearch} className="flex gap-2 max-w-md flex-1">
              <input
                className={nexsInputClass('flex-1')}
                placeholder="Search email or employee code"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button type="submit" className={nexsBtnPrimary()}>Search</button>
              <button type="button" className="text-sm px-3" style={{ color: 'var(--text3)' }} onClick={() => { setSearch(''); loadUsers('') }}>
                Clear
              </button>
            </form>
            <button
              type="button"
              className={nexsBtnGhost()}
              onClick={() => setRoleModal({ empCode: '', label: 'New employee', initialRoles: [] })}
              title="Assign roles to one or more employees (existing or new — auto-resolved from HR data)"
            >
              + Add / assign roles
            </button>
          </div>
          <NexsUserTable
            users={users}
            loading={loading}
            onAssignRoles={(raw, empCode) => setRoleModal({
              empCode,
              label: raw?.name || raw?.email || empCode,
              initialRoles: parseRoleGroups(raw),
            })}
          />
        </div>
      )}

      {tab === 'create' && <CreateUserForm roles={roles} onCreated={() => { loadUsers(); setTab('users') }} />}
      {tab === 'bulk' && <NexsBulkUpload onDone={() => loadUsers()} />}

      {roleModal && (
        <NexsRoleAssignModal
          empCode={roleModal.empCode}
          userLabel={roleModal.label}
          allRoles={roles}
          grantableRoles={grantableRoles}
          parentEmpCode={parentEmpCode}
          parentLabel={session?.userName || session?.email}
          allFacilities={facilities}
          initialRoles={roleModal.initialRoles}
          onClose={() => setRoleModal(null)}
          onSaved={() => { toast.success('Roles updated'); loadUsers(search) }}
        />
      )}
    </div>
  )
}
