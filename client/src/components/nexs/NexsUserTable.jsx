import { useMemo } from 'react'
import { nexsCx } from './nexsTheme'

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row?.[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

export default function NexsUserTable({ users, loading, onAssignRoles }) {
  const rows = useMemo(() => {
    return (users || [])
      .map((u, i) => ({
        key: pick(u, 'employeeCode', 'empCode', 'userId', 'email', 'id') || i,
        name: pick(u, 'name', 'displayName', 'fullName'),
        email: pick(u, 'email', 'emailId', 'mail'),
        empCode: pick(u, 'employeeCode', 'empCode', 'employee_code'),
        phone: pick(u, 'phoneNumber', 'mobile', 'phone'),
        department: pick(u, 'department', 'dept'),
        roles: Array.isArray(u.roleGroups)
          ? u.roleGroups.join(', ')
          : Array.isArray(u.roles)
            ? u.roles.map((r) => (typeof r === 'string' ? r : r?.name)).filter(Boolean).join(', ')
            : pick(u, 'roleNames', 'roleGroup'),
        raw: u,
      }))
      .filter((r) => Boolean(r.name || r.email || r.phone || r.department || r.roles))
  }, [users])

  if (loading) {
    return (
      <div className={`rounded-xl border p-8 text-center text-sm animate-pulse ${nexsCx.border} ${nexsCx.text3}`}>
        Loading users…
      </div>
    )
  }

  if (!rows.length) {
    return (
      <div className={`rounded-xl border p-8 text-center text-sm ${nexsCx.border} ${nexsCx.text3}`}>
        No users found. Try refresh or search by email / employee code.
      </div>
    )
  }

  return (
    <div className={`overflow-x-auto rounded-xl border ${nexsCx.border}`}>
      <table className="w-full text-sm">
        <thead className={nexsCx.bg2}>
          <tr className={`text-left text-xs uppercase tracking-wide ${nexsCx.text2}`}>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Email</th>
            <th className="px-4 py-3">Emp code</th>
            <th className="px-4 py-3">Phone</th>
            <th className="px-4 py-3">Department</th>
            <th className="px-4 py-3">Roles</th>
            <th className="px-4 py-3 w-28">Actions</th>
          </tr>
        </thead>
        <tbody className={`divide-y ${nexsCx.border}`}>
          {rows.map((r) => (
            <tr key={r.key} className="hover:bg-[var(--bg3)]">
              <td className={`px-4 py-2.5 ${nexsCx.text}`}>{r.name || '—'}</td>
              <td className={`px-4 py-2.5 font-mono text-xs ${nexsCx.text2}`}>{r.email || '—'}</td>
              <td className={`px-4 py-2.5 font-mono text-xs ${nexsCx.text2}`}>{r.empCode || '—'}</td>
              <td className={`px-4 py-2.5 ${nexsCx.text2}`}>{r.phone || '—'}</td>
              <td className={`px-4 py-2.5 ${nexsCx.text2}`}>{r.department || '—'}</td>
              <td className={`px-4 py-2.5 text-xs ${nexsCx.text3}`}>{r.roles || '—'}</td>
              <td className="px-4 py-2.5">
                {r.empCode && onAssignRoles ? (
                  <button
                    type="button"
                    onClick={() => onAssignRoles(r.raw, r.empCode)}
                    className="text-xs font-medium hover:opacity-90"
                    style={{ color: 'var(--accent)' }}
                  >
                    Roles
                  </button>
                ) : (
                  <span className={`text-xs ${nexsCx.text3}`}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
