/**
 * NexsUserManagementPage — Lenskart Auth Service user & role management
 */

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import NexsUserTable from '../../components/nexs/NexsUserTable'
import NexsRoleAssignModal from '../../components/nexs/NexsRoleAssignModal'
import NexsBulkUpload from '../../components/nexs/NexsBulkUpload'
import NexsLoginPanel from '../../components/nexs/NexsLoginPanel'
import {
  createUser,
  getNexsMeta,
  getNexsSession,
  getUserRoles,
  listRoles,
  listUsers,
  signOutNexs,
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
  const [tab, setTab] = useState('users')
  const [meta, setMeta] = useState(null)
  const [session, setSession] = useState(() => getNexsSession())
  const [users, setUsers] = useState([])
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [roleModal, setRoleModal] = useState(null)

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

  const loadUsers = useCallback(async (q = '') => {
    setLoading(true)
    try {
      const params = q.trim() ? { search: q, mode: 'search' } : {}
      const d = await listUsers(params)
      let nextUsers = Array.isArray(d.users) ? d.users : []

      const query = String(q || '').trim()
      if (query) {
        const empCodes = [...new Set(nextUsers.map((u) => pickEmpCode(u)).filter(Boolean))].slice(0, 10)
        if (empCodes.length) {
          const lookups = await Promise.allSettled(
            empCodes.map(async (empCode) => {
              const data = await getUserRoles(empCode)
              return { empCode, roles: parseRoleGroups(data) }
            }),
          )

          const rolesByEmp = new Map()
          for (const result of lookups) {
            if (result.status !== 'fulfilled') continue
            const { empCode, roles: assignedRoles } = result.value
            if (empCode && Array.isArray(assignedRoles) && assignedRoles.length) {
              rolesByEmp.set(empCode, assignedRoles)
            }
          }

          if (rolesByEmp.size) {
            nextUsers = nextUsers.map((user) => {
              const empCode = pickEmpCode(user)
              const assignedRoles = rolesByEmp.get(empCode)
              if (!assignedRoles?.length) return user

              const existing = []
              if (Array.isArray(user?.roleGroups)) existing.push(...user.roleGroups.map(roleName).filter(Boolean))
              if (Array.isArray(user?.roles)) existing.push(...user.roles.map(roleName).filter(Boolean))
              const merged = [...new Set([...existing, ...assignedRoles])]
              return { ...user, roleGroups: merged }
            })
          }
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
  }, [])

  const refreshData = useCallback(() => {
    loadRoles(meta?.rolesAppName)
    loadUsers(search)
  }, [loadRoles, loadUsers, search, meta?.rolesAppName])

  useEffect(() => {
    loadMeta()
  }, [loadMeta])

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
            {session.appId ? (
              <>
                {' · '}
                App {session.appId}
              </>
            ) : null}
            {' · '}
            <span className="font-mono text-xs">JWT active (this tab)</span>
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
          <form onSubmit={handleSearch} className="flex gap-2 max-w-md">
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
          <NexsUserTable
            users={users}
            loading={loading}
            onAssignRoles={(raw, empCode) => setRoleModal({
              empCode,
              label: raw?.name || raw?.email || empCode,
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
          onClose={() => setRoleModal(null)}
          onSaved={() => { toast.success('Roles updated'); loadUsers(search) }}
        />
      )}
    </div>
  )
}
