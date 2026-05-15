/**
 * IdcsManagement.jsx
 * Oracle IDCS User Management — with Stats Dashboard
 */

import { useState, useEffect, useCallback } from 'react';
import UserTable from '../components/idcs/UserTable';
import BulkUpload from '../components/idcs/BulkUpload';
import ExportPanel from '../components/idcs/ExportPanel';
import GroupManager from '../components/idcs/GroupManager';
import { createUser, getAuditLogs, listUsers, listGroups } from '../api/idcs';
import { idcsCx, idcsInputClass, idcsBtnPrimary } from '../components/idcs/idcsTheme';

const TABS = [
  { id: 'users',  label: 'Users',          icon: '👥' },
  { id: 'create', label: 'Create User',     icon: '➕' },
  { id: 'bulk',   label: 'Bulk Operations', icon: '📦' },
  { id: 'groups', label: 'Groups',          icon: '🗂️'  },
  { id: 'export', label: 'Export',          icon: '⬇'  },
  { id: 'audit',  label: 'Audit Log',       icon: '📋'  },
];

// ─── Stat card ───────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, color = 'blue', onClick }) {
  const colorMap = {
    blue:   { mix: 'var(--accent)',  icon: 'var(--accent)' },
    green:  { mix: 'var(--green)',   icon: 'var(--green)' },
    red:    { mix: 'var(--red)',     icon: 'var(--red)' },
    purple: { mix: 'var(--accent2)', icon: 'var(--accent2)' },
    orange: { mix: 'var(--amber)',   icon: 'var(--amber)' },
  };
  const c = colorMap[color] || colorMap.blue;

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      onClick={onClick}
      style={{
        background: `color-mix(in srgb, ${c.mix} 16%, var(--bg3))`,
        borderColor: 'var(--border)',
      }}
      className={`border rounded-xl p-4 flex items-center gap-4 ${onClick ? 'cursor-pointer hover:opacity-95 transition-opacity' : ''}`}
    >
      <div className="text-3xl select-none" style={{ color: c.icon }}>{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-2xl font-bold leading-none" style={{ color: c.mix }}>
          {value === null ? <span className={`text-lg animate-pulse ${idcsCx.text3}`}>—</span> : value}
        </div>
        <div className={`text-xs mt-0.5 font-medium uppercase tracking-wide ${idcsCx.text2}`}>{label}</div>
        {sub && <div className={`text-xs mt-0.5 ${idcsCx.text3}`}>{sub}</div>}
      </div>
    </div>
  );
}

// ─── Stats dashboard ─────────────────────────────────────────────────────────
function StatsDashboard({ onTabSwitch, refreshTrigger }) {
  const [stats, setStats] = useState({
    total: null, active: null, inactive: null,
    groups: null, recentOps: null, lastAction: null,
  });
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const [totalRes, activeRes, inactiveRes, groupsRes, auditRes] = await Promise.allSettled([
        listUsers({ limit: 1 }),
        listUsers({ status: 'active',   limit: 1 }),
        listUsers({ status: 'inactive', limit: 1 }),
        listGroups({ page: 1, limit: 1 }),
        getAuditLogs({ limit: 5 }),
      ]);

      const get = (r) => (r.status === 'fulfilled' ? r.value : null);
      const totalData    = get(totalRes);
      const activeData   = get(activeRes);
      const inactiveData = get(inactiveRes);
      const groupData    = get(groupsRes);
      const auditData    = get(auditRes);

      setStats({
        total:      totalData?.total   ?? null,
        active:     activeData?.total  ?? null,
        inactive:   inactiveData?.total ?? null,
        groups:     groupData?.total   ?? null,
        recentOps:  auditData?.total   ?? null,
        lastAction: auditData?.logs?.[0] ?? null,
      });
      setLastUpdated(new Date());
    } catch (_) {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchStats() }, [fetchStats, refreshTrigger]);

  const activeRate = stats.total && stats.active !== null
    ? Math.round((stats.active / stats.total) * 100)
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className={`text-sm font-semibold uppercase tracking-wide ${idcsCx.text2}`}>Directory Overview</h2>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className={`text-xs ${idcsCx.text3}`}>
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={fetchStats}
            disabled={loading}
            className={`text-xs disabled:opacity-40 flex items-center gap-1 hover:opacity-90`}
            style={{ color: 'var(--accent)' }}
          >
            <span className={loading ? 'animate-spin inline-block' : ''}>↻</span> Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          icon="👤" label="Total Users" value={stats.total}
          color="blue" onClick={() => onTabSwitch('users')}
        />
        <StatCard
          icon="✅" label="Active Users" value={stats.active}
          sub={activeRate !== null ? `${activeRate}% of total` : undefined}
          color="green" onClick={() => onTabSwitch('users')}
        />
        <StatCard
          icon="⛔" label="Inactive Users" value={stats.inactive}
          color="red" onClick={() => onTabSwitch('users')}
        />
        <StatCard
          icon="🗂️" label="Groups" value={stats.groups}
          color="purple" onClick={() => onTabSwitch('groups')}
        />
        <StatCard
          icon="📋" label="Total Operations" value={stats.recentOps}
          sub={stats.lastAction ? `Last: ${stats.lastAction.action?.replace(/_/g,' ')}` : undefined}
          color="orange" onClick={() => onTabSwitch('audit')}
        />
      </div>

      {/* Recent activity strip */}
      {stats.lastAction && (
        <div className={`rounded-xl px-4 py-3 flex items-center gap-3 text-sm border ${idcsCx.border} ${idcsCx.bg2}`}>
          <span className={`${idcsCx.text3} text-xs uppercase font-medium tracking-wide shrink-0`}>Last activity</span>
          <span
            className="px-2 py-0.5 rounded text-xs font-medium shrink-0 border border-[var(--border)]"
            style={{
              background: stats.lastAction.action?.includes('DELETE')
                ? 'color-mix(in srgb, var(--red) 22%, var(--bg3))'
                : stats.lastAction.action?.includes('CREATE')
                  ? 'color-mix(in srgb, var(--green) 22%, var(--bg3))'
                  : stats.lastAction.action?.includes('PASSWORD')
                    ? 'color-mix(in srgb, var(--accent2) 22%, var(--bg3))'
                    : stats.lastAction.action?.includes('GROUP')
                      ? 'color-mix(in srgb, var(--cyan) 22%, var(--bg3))'
                      : 'color-mix(in srgb, var(--text2) 15%, var(--bg3))',
              color: stats.lastAction.action?.includes('DELETE')
                ? 'var(--red)'
                : stats.lastAction.action?.includes('CREATE')
                  ? 'var(--green)'
                  : stats.lastAction.action?.includes('PASSWORD')
                    ? 'var(--accent2)'
                    : stats.lastAction.action?.includes('GROUP')
                      ? 'var(--cyan)'
                      : 'var(--text2)',
            }}
          >
            {stats.lastAction.action?.replace(/_/g, ' ')}
          </span>
          <span className={`${idcsCx.text2} truncate`}>
            by <strong className={idcsCx.text}>{stats.lastAction.performedBy?.email || 'Unknown'}</strong>
            {stats.lastAction.targetUser?.userName && <> on <em>{stats.lastAction.targetUser.userName}</em></>}
          </span>
          <span className={`ml-auto shrink-0 text-xs font-semibold ${
            stats.lastAction.status === 'SUCCESS' ? 'text-[var(--green)]' :
            stats.lastAction.status === 'FAILED'  ? 'text-[var(--red)]' : 'text-[var(--amber)]'
          }`}>
            {stats.lastAction.status}
          </span>
          <span className={`text-xs shrink-0 ${idcsCx.text3}`}>
            {new Date(stats.lastAction.createdAt).toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Create User form ────────────────────────────────────────────────────────
function CreateUserForm({ onCreated }) {
  const EMPTY = { firstName: '', lastName: '', email: '', userName: '', mobileNumber: '', password: '' };
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  const handleSubmit = async (ev) => {
    ev.preventDefault();
    if (!form.email || !form.firstName || !form.lastName) {
      setError('First name, last name, and email are required');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const created = await createUser(form);
      setSuccess(`User ${created.userName} created successfully (ID: ${created.id})`);
      setForm(EMPTY);
      if (onCreated) onCreated();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const Field = ({ label, name, type = 'text', required = false, placeholder = '' }) => (
    <div>
      <label className={`block text-sm font-medium mb-1 ${idcsCx.text}`}>
        {label} {required && <span className="text-[var(--red)]">*</span>}
      </label>
      <input
        type={type}
        value={form[name]}
        onChange={set(name)}
        placeholder={placeholder}
        className={idcsInputClass()}
      />
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="First Name" name="firstName" required placeholder="John" />
        <Field label="Last Name" name="lastName" required placeholder="Doe" />
      </div>
      <Field label="Email" name="email" type="email" required placeholder="john.doe@lenskart.com" />
      <Field label="User Name" name="userName" placeholder="Leave blank to use email" />
      <Field label="Mobile Number" name="mobileNumber" placeholder="+911234567890" />
      <Field label="Initial Password" name="password" type="password" placeholder="Leave blank to trigger reset email" />

      {error && (
        <div
          className={`text-sm rounded-lg p-3 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className={`text-sm rounded-lg p-3 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--green) 12%, var(--bg3))', color: 'var(--green)' }}
        >
          ✓ {success}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className={`text-sm px-6 py-2.5 ${idcsBtnPrimary()}`}
      >
        {loading ? 'Creating...' : 'Create User'}
      </button>
    </form>
  );
}

// ─── Audit Log table ─────────────────────────────────────────────────────────
function AuditLogTable() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState({ action: '', status: '' });
  const LIMIT = 20;

  useEffect(() => {
    setLoading(true);
    getAuditLogs({ page, limit: LIMIT, ...filter })
      .then((d) => { setLogs(d.logs); setTotal(d.total); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page, filter]);

  const ACTION_STYLE = {
    CREATE_USER:       { mix: 'var(--green)', fg: 'var(--green)' },
    DELETE_USER:       { mix: 'var(--red)', fg: 'var(--red)' },
    BULK_CREATE_USERS: { mix: 'var(--accent)', fg: 'var(--accent)' },
    BULK_DELETE_USERS: { mix: 'var(--amber)', fg: 'var(--amber)' },
    PASSWORD_RESET:    { mix: 'var(--accent2)', fg: 'var(--accent2)' },
    ADD_TO_GROUP:      { mix: 'var(--cyan)', fg: 'var(--cyan)' },
    REMOVE_FROM_GROUP: { mix: 'var(--amber)', fg: 'var(--amber)' },
    EXPORT_USERS:      { mix: 'var(--text2)', fg: 'var(--text)' },
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <select
          value={filter.action}
          onChange={(e) => setFilter((p) => ({ ...p, action: e.target.value }))}
          className={idcsInputClass('w-auto')}
        >
          <option value="">All Actions</option>
          {Object.keys(ACTION_STYLE).map((a) => (
            <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select
          value={filter.status}
          onChange={(e) => setFilter((p) => ({ ...p, status: e.target.value }))}
          className={idcsInputClass('w-auto')}
        >
          <option value="">All Statuses</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILED">Failed</option>
          <option value="PARTIAL">Partial</option>
        </select>
        <span className={`ml-auto text-sm self-center ${idcsCx.text3}`}>{total} entries</span>
      </div>

      <div className={`overflow-x-auto rounded-xl border ${idcsCx.border}`}>
        <table className="min-w-full text-sm">
          <thead className={`${idcsCx.bg3} text-xs uppercase ${idcsCx.text3}`}>
            <tr>
              <th className="px-4 py-3 text-left">Time</th>
              <th className="px-4 py-3 text-left">Action</th>
              <th className="px-4 py-3 text-left">Performed By</th>
              <th className="px-4 py-3 text-left">Target User</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Details</th>
            </tr>
          </thead>
          <tbody className={`divide-y ${idcsCx.divide}`}>
            {loading ? (
              <tr><td colSpan={6} className={`text-center py-8 ${idcsCx.text3}`}>Loading...</td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={6} className={`text-center py-8 ${idcsCx.text3}`}>No audit entries found</td></tr>
            ) : logs.map((log) => {
              const ac = ACTION_STYLE[log.action] || ACTION_STYLE.EXPORT_USERS;
              return (
              <tr key={log._id} className="hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg2))]">
                <td className={`px-4 py-2 text-xs whitespace-nowrap ${idcsCx.text3}`}>
                  {new Date(log.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-2">
                  <span
                    className="px-2 py-0.5 rounded text-xs font-medium border border-[var(--border)]"
                    style={{
                      background: `color-mix(in srgb, ${ac.mix} 20%, var(--bg3))`,
                      color: ac.fg,
                    }}
                  >
                    {log.action?.replace(/_/g, ' ')}
                  </span>
                </td>
                <td className={`px-4 py-2 text-xs ${idcsCx.text2}`}>{log.performedBy?.email || '—'}</td>
                <td className={`px-4 py-2 text-xs ${idcsCx.text2}`}>
                  {log.targetUser?.userName || log.targetUser?.email || '—'}
                </td>
                <td className="px-4 py-2">
                  <span className={`text-xs font-medium ${
                    log.status === 'SUCCESS' ? 'text-[var(--green)]' :
                    log.status === 'FAILED'  ? 'text-[var(--red)]' : 'text-[var(--amber)]'
                  }`}>
                    {log.status}
                  </span>
                </td>
                <td className={`px-4 py-2 text-xs max-w-xs truncate ${idcsCx.text3}`}>
                  {log.details ? JSON.stringify(log.details) : '—'}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className={`flex justify-between text-sm ${idcsCx.text2}`}>
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPage((p) => p - 1)} disabled={page === 1}
              className={`px-3 py-1 rounded disabled:opacity-40 border ${idcsCx.border} ${idcsCx.bg3}`}>Prev</button>
            <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page === totalPages}
              className={`px-3 py-1 rounded disabled:opacity-40 border ${idcsCx.border} ${idcsCx.bg3}`}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────
export default function IdcsManagement() {
  const [activeTab, setActiveTab] = useState('users');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [groupUserIds, setGroupUserIds] = useState([]);

  const refresh = () => setRefreshTrigger((n) => n + 1);

  const handleAddToGroup = (userIds) => {
    setGroupUserIds(userIds);
    setActiveTab('groups');
  };

  return (
    <div className="space-y-5 min-h-0">
      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className={`text-xl font-bold ${idcsCx.text}`}>Oracle IDCS — User Management</h1>
          <p className={`text-sm mt-0.5 ${idcsCx.text2}`}>
            Create, delete, reset passwords, and manage group membership
          </p>
        </div>
        <span
          className="text-xs px-2 py-1 rounded-full font-medium border border-[var(--border)]"
          style={{
            background: 'color-mix(in srgb, var(--accent) 14%, var(--bg3))',
            color: 'var(--accent)',
          }}
        >
          🔗 Connected to IDCS
        </span>
      </div>

      {/* Stats dashboard */}
      <StatsDashboard onTabSwitch={setActiveTab} refreshTrigger={refreshTrigger} />

      {/* Tabs */}
      <div className={`flex gap-1 flex-wrap ${idcsCx.borderB}`}>
        {TABS.map((tab) => (
          <button
            type="button"
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : `border-transparent ${idcsCx.text2} hover:text-[var(--text)] hover:border-[var(--border)]`
            }`}
          >
            <span>{tab.icon}</span> {tab.label}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      <div className={`rounded-xl border p-6 ${idcsCx.border} ${idcsCx.bg2}`}>
        {activeTab === 'users' && (
          <UserTable onAddToGroup={handleAddToGroup} refreshTrigger={refreshTrigger} />
        )}
        {activeTab === 'create' && (
          <CreateUserForm onCreated={refresh} />
        )}
        {activeTab === 'bulk' && (
          <BulkUpload onComplete={refresh} />
        )}
        {activeTab === 'groups' && (
          <GroupManager
            preSelectedUserIds={groupUserIds}
            onDone={() => setGroupUserIds([])}
          />
        )}
        {activeTab === 'export' && (
          <ExportPanel />
        )}
        {activeTab === 'audit' && (
          <AuditLogTable />
        )}
      </div>
    </div>
  );
}
