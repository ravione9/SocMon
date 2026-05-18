/**
 * UserTable.jsx
 * Paginated IDCS user list with:
 *  - Search / status filter
 *  - Set Password modal (admin sets password + optional "must change on next login")
 *  - Delete confirmation
 *  - Add to Group shortcut
 */

import { useState, useEffect, useCallback } from 'react';
import { listUsers, deleteUser, setPassword, suspendUser, activateUser, bulkSetActive } from '../../api/idcs';
import { idcsCx, idcsInputClass, idcsBtnPrimary, idcsBtnGhost } from './idcsTheme';
import UserDetailModal from './UserDetailModal';
import { formatUserGroups } from './formatUserGroups';
import { computePasswordStrength, generateRandomPassword } from '../../utils/idcsStylePassword.js';
import { useResizableColumns, ResizableColGroup, ResizableTh } from '../ui/ResizableTable.jsx';

const USER_COLS = [44, 220, 240, 130, 200, 96, 260];
const USER_TH_STYLE = {
  textAlign: 'left',
  padding: '12px 16px',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--text3)',
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg3)',
  whiteSpace: 'nowrap',
};

function StatusBadge({ active }) {
  const mix = active ? 'var(--green)' : 'var(--amber)';
  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium border border-[var(--border)]"
      style={{
        background: `color-mix(in srgb, ${mix} 22%, var(--bg3))`,
        color: mix,
      }}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

// ─── After password is set: show value + copy (one-time) ─────────────────────
function PasswordSavedPanel({ password, mustChange, user, email, groupStr, onDone }) {
  const [visible, setVisible] = useState(true);
  const [copied, setCopied]     = useState(false);

  const copyPw = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt('Copy this password (Ctrl+C):', password);
    }
  };

  return (
    <>
      <div
        className="px-6 py-4 flex items-center justify-between"
        style={{ background: 'linear-gradient(135deg, var(--green), color-mix(in srgb, var(--green) 70%, var(--accent)))' }}
      >
        <div className="min-w-0 pr-2">
          <h2 className="font-semibold text-base text-[var(--on-accent)]">Password set</h2>
          <p className="text-xs mt-0.5 opacity-90 text-[var(--on-accent)] break-words">
            {user.displayName || user.userName} · {email}
          </p>
          {groupStr ? (
            <p className="text-[11px] mt-1 opacity-85 text-[var(--on-accent)] leading-snug">
              Groups: <span className="font-normal">{groupStr}</span>
            </p>
          ) : null}
        </div>
        <button type="button" onClick={onDone} className="text-[var(--on-accent)] opacity-80 hover:opacity-100 text-xl leading-none">✕</button>
      </div>
      <div className="p-6 space-y-5">
        <p className={`text-sm ${idcsCx.text2}`}>
          Copy the password below and share it securely. This dialog does not store it — close when done.
        </p>
        {mustChange && (
          <div
            className={`text-sm rounded-lg px-3 py-2 border ${idcsCx.border}`}
            style={{ background: 'color-mix(in srgb, var(--amber) 14%, var(--bg3))', color: 'var(--amber)' }}
          >
            User must change password on next login.
          </div>
        )}
        <div>
          <label className={`block text-sm font-medium mb-2 ${idcsCx.text}`}>New password</label>
          <div className="flex flex-wrap gap-2 items-stretch">
            <div className="flex-1 min-w-0">
              <input
                readOnly
                type={visible ? 'text' : 'password'}
                value={password}
                className={`${idcsInputClass('font-mono')} w-full`}
                onFocus={(e) => e.target.select()}
              />
            </div>
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              className={`shrink-0 px-3 rounded-lg border self-stretch ${idcsCx.border} ${idcsCx.bg3}`}
              style={{ color: 'var(--text2)' }}
              title={visible ? 'Hide' : 'Show'}
            >
              {visible ? '🙈' : '👁'}
            </button>
            <button
              type="button"
              onClick={copyPw}
              className={`shrink-0 px-4 rounded-lg text-sm font-semibold self-stretch ${idcsBtnPrimary()}`}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <button type="button" onClick={onDone} className={`w-full text-sm ${idcsBtnPrimary()}`}>
          Done
        </button>
      </div>
    </>
  );
}

// ─── Set Password Modal ───────────────────────────────────────────────────────
function SetPasswordModal({ user, onClose, onSuccess }) {
  const [newPassword, setNewPassword]           = useState('');
  const [confirmPassword, setConfirmPassword]   = useState('');
  const [mustChange, setMustChange]             = useState(false);
  const [showPwd, setShowPwd]                   = useState(true);
  const [loading, setLoading]                   = useState(false);
  const [error, setError]                       = useState('');
  const [savedPassword, setSavedPassword]       = useState(null);

  const applyEasyPassword = useCallback(() => {
    const pw = generateRandomPassword();
    setNewPassword(pw);
    setConfirmPassword(pw);
    setError('');
    setShowPwd(true);
  }, []);

  useEffect(() => {
    applyEasyPassword();
  }, [user.id, applyEasyPassword]);

  const validate = () => {
    if (!newPassword)                      return 'Password is required';
    if (newPassword.length < 8)            return 'Password must be at least 8 characters';
    if (newPassword !== confirmPassword)   return 'Passwords do not match';
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }
    setLoading(true);
    setError('');
    try {
      await setPassword(user.id, newPassword, mustChange);
      setSavedPassword(newPassword);
    } catch (ex) {
      setError(ex.response?.data?.error || ex.message);
    } finally {
      setLoading(false);
    }
  };

  // Password strength
  const strength = computePasswordStrength(newPassword);

  const email = user.emails?.find((e) => e.primary)?.value || user.emails?.[0]?.value || user.userName;
  const groupStr = formatUserGroups(user);

  const finishFlow = () => {
    onSuccess(mustChange);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className={`rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden border ${idcsCx.border} ${idcsCx.bg2}`}>
        {savedPassword ? (
          <PasswordSavedPanel
            password={savedPassword}
            mustChange={mustChange}
            user={user}
            email={email}
            groupStr={groupStr}
            onDone={finishFlow}
          />
        ) : (
          <>
        {/* Header */}
        <div
          className="px-6 py-4 flex items-center justify-between"
          style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent2))' }}
        >
          <div className="min-w-0 pr-2">
            <h2 className="font-semibold text-base text-[var(--on-accent)]">Set New Password</h2>
            <p className="text-xs mt-0.5 opacity-90 text-[var(--on-accent)] break-words">
              {user.displayName || user.userName} · {email}
            </p>
            {groupStr ? (
              <p className="text-[11px] mt-1 opacity-85 text-[var(--on-accent)] leading-snug">
                Groups: <span className="font-normal">{groupStr}</span>
              </p>
            ) : (
              <p className="text-[11px] mt-1 opacity-75 text-[var(--on-accent)] italic">
                Groups: —
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-[var(--on-accent)] opacity-80 hover:opacity-100 text-xl leading-none">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* New password */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <label className={`block text-sm font-medium ${idcsCx.text}`}>
                New Password <span className="text-[var(--red)]">*</span>
              </label>
              <button
                type="button"
                onClick={applyEasyPassword}
                className={`text-xs font-semibold shrink-0 px-2 py-1 rounded-md border ${idcsCx.border} ${idcsCx.bg3} hover:opacity-90`}
                style={{ color: 'var(--accent)' }}
              >
                Generate Password
              </button>
            </div>
            <div className="relative">
              <input
                type={showPwd ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
                placeholder="Enter new password"
                className={idcsInputClass('pr-10')}
              />
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                className={`absolute right-3 top-1/2 -translate-y-1/2 text-sm hover:opacity-90 ${idcsCx.text3}`}
                tabIndex={-1}
              >
                {showPwd ? '🙈' : '👁'}
              </button>
            </div>
            {/* Strength bar */}
            {strength && (
              <div className="mt-1.5">
                <div className={`h-1.5 rounded-full overflow-hidden ${idcsCx.bg3}`}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ background: strength.bar, width: strength.pct }}
                  />
                </div>
                <p
                  className="text-xs mt-0.5 font-medium"
                  style={{
                    color:
                      strength.label === 'Weak' ? 'var(--red)' :
                      strength.label === 'Fair' ? 'var(--amber)' :
                      strength.label === 'Good' ? 'var(--accent)' : 'var(--green)',
                  }}
                >
                  {strength.label}
                </p>
              </div>
            )}
          </div>

          {/* Confirm password */}
          <div>
            <label className={`block text-sm font-medium mb-1 ${idcsCx.text}`}>Confirm Password <span className="text-[var(--red)]">*</span></label>
            <input
              type={showPwd ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
              placeholder="Re-enter new password"
              className={idcsInputClass()}
              style={
                confirmPassword && confirmPassword !== newPassword
                  ? { borderColor: 'var(--red)', background: 'color-mix(in srgb, var(--red) 10%, var(--bg3))' }
                  : undefined
              }
            />
            {confirmPassword && confirmPassword !== newPassword && (
              <p className="text-xs mt-1 text-[var(--red)]">Passwords do not match</p>
            )}
          </div>

          {/* Must change on next login */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <div className="relative mt-0.5">
              <input
                type="checkbox"
                checked={mustChange}
                onChange={(e) => setMustChange(e.target.checked)}
                className="sr-only"
              />
              <div
                className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors border-[var(--border)] ${idcsCx.bg3} group-hover:border-[var(--accent)]`}
                style={mustChange ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : undefined}
              >
                {mustChange && <span className="text-[var(--on-accent)] text-xs font-bold">✓</span>}
              </div>
            </div>
            <div>
              <p className={`text-sm font-medium ${idcsCx.text}`}>Require password change on next login</p>
            </div>
          </label>

          {/* Error */}
          {error && (
            <div
              className={`text-sm rounded-lg px-3 py-2 border ${idcsCx.border}`}
              style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
            >
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={loading}
              className={`flex-1 text-sm ${idcsBtnPrimary()}`}
            >
              {loading ? 'Updating...' : 'Set Password'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className={`flex-1 text-sm ${idcsBtnGhost()}`}
            >
              Cancel
            </button>
          </div>
        </form>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Success toast ────────────────────────────────────────────────────────────
function Toast({ message, type = 'success', onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl text-sm font-medium animate-bounce-once border border-[var(--border)]"
      style={{
        background: type === 'success' ? 'var(--green)' : 'var(--red)',
        color: '#fff',
      }}
    >
      <span>{type === 'success' ? '✓' : '✕'}</span>
      {message}
      <button type="button" onClick={onClose} className="ml-2 opacity-70 hover:opacity-100">✕</button>
    </div>
  );
}

// ─── Main table ───────────────────────────────────────────────────────────────
export default function UserTable({ onAddToGroup, refreshTrigger }) {
  const [users, setUsers]           = useState([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [search, setSearch]         = useState('');
  const [status, setStatus]         = useState('');
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [selected, setSelected]     = useState(new Set());
  const [actionLoading, setActionLoading] = useState({});

  // Modal state
  const [pwdModal, setPwdModal]     = useState(null); // user object or null
  const [toast, setToast]           = useState(null); // { message, type }
  const [detailOpen, setDetailOpen] = useState(null); // { id, preview } | null

  const LIMIT = 25;

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listUsers({ page, limit: LIMIT, search, status });
      setUsers(data.users);
      setTotal(data.total);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [page, search, status, refreshTrigger]); // eslint-disable-line

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  // Debounce search
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(selected.size === users.length ? new Set() : new Set(users.map((u) => u.id)));
  };

  const handleDelete = async (id, userName) => {
    if (!window.confirm(`Delete user ${userName}? This cannot be undone.`)) return;
    setActionLoading((p) => ({ ...p, [id]: 'deleting' }));
    try {
      await deleteUser(id);
      fetchUsers();
      setToast({ message: `User ${userName} deleted`, type: 'success' });
    } catch (e) {
      setToast({ message: `Delete failed: ${e.response?.data?.error || e.message}`, type: 'error' });
    } finally {
      setActionLoading((p) => ({ ...p, [id]: null }));
    }
  };

  const handleToggleActive = async (user) => {
    const targetActive = !user.active;
    const verb = targetActive ? 'Activate' : 'Suspend';
    if (!window.confirm(`${verb} user ${user.userName || user.displayName}?`)) return;
    setActionLoading((p) => ({ ...p, [user.id]: targetActive ? 'activating' : 'suspending' }));
    try {
      if (targetActive) await activateUser(user.id);
      else await suspendUser(user.id);
      fetchUsers();
      setToast({
        message: `${user.userName || 'User'} ${targetActive ? 'activated' : 'suspended'}`,
        type: 'success',
      });
    } catch (e) {
      setToast({
        message: `${verb} failed: ${e.response?.data?.error || e.message}`,
        type: 'error',
      });
    } finally {
      setActionLoading((p) => ({ ...p, [user.id]: null }));
    }
  };

  const handleBulkSetActive = async (active) => {
    const ids = [...selected];
    if (!ids.length) return;
    const verb = active ? 'Activate' : 'Suspend';
    if (!window.confirm(`${verb} ${ids.length} selected user${ids.length === 1 ? '' : 's'}?`)) return;
    try {
      const res = await bulkSetActive(ids, active);
      const okN = res?.succeeded?.length ?? 0;
      const failN = res?.failed?.length ?? 0;
      setToast({
        message: `${verb}d ${okN} user${okN === 1 ? '' : 's'}${failN ? ` — ${failN} failed` : ''}`,
        type: failN ? 'error' : 'success',
      });
      setSelected(new Set());
      fetchUsers();
    } catch (e) {
      setToast({
        message: `Bulk ${verb.toLowerCase()} failed: ${e.response?.data?.error || e.message}`,
        type: 'error',
      });
    }
  };

  const handlePasswordSuccess = (mustChange) => {
    setPwdModal(null);
    setToast({
      message: mustChange
        ? 'Password updated — user must change it on next login'
        : 'Password updated successfully',
      type: 'success',
    });
  };

  const totalPages = Math.ceil(total / LIMIT);

  const userResize = useResizableColumns('idcs-users', USER_COLS);

  return (
    <div className="space-y-4">
      {/* Modals & toasts */}
      {pwdModal && (
        <SetPasswordModal
          user={pwdModal}
          onClose={() => setPwdModal(null)}
          onSuccess={handlePasswordSuccess}
        />
      )}
      {toast && (
        <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
      {detailOpen && (
        <UserDetailModal
          userId={detailOpen.id}
          previewUser={detailOpen.preview}
          onClose={() => setDetailOpen(null)}
          onAddToGroup={onAddToGroup}
          onSetPassword={(u) => setPwdModal(u)}
          onUserChanged={fetchUsers}
        />
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className={idcsInputClass('w-64')}
        />
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className={idcsInputClass('w-auto')}
        >
          <option value="">All Users</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <span className={`text-sm ml-auto ${idcsCx.text2}`}>
          {total} user{total !== 1 ? 's' : ''} found
        </span>
        {selected.size > 0 && (
          <div className="flex flex-wrap gap-2 items-center">
            {onAddToGroup && (
              <button
                type="button"
                onClick={() => onAddToGroup([...selected])}
                className={`text-sm ${idcsBtnPrimary()}`}
              >
                Add {selected.size} to Group
              </button>
            )}
            <button
              type="button"
              onClick={() => handleBulkSetActive(false)}
              className={`text-sm px-4 py-2.5 rounded-lg font-medium border ${idcsCx.border} ${idcsCx.bg3} hover:opacity-90`}
              style={{ color: 'var(--amber)' }}
              title="Set active=false for the selected users"
            >
              Suspend {selected.size}
            </button>
            <button
              type="button"
              onClick={() => handleBulkSetActive(true)}
              className={`text-sm px-4 py-2.5 rounded-lg font-medium border ${idcsCx.border} ${idcsCx.bg3} hover:opacity-90`}
              style={{ color: 'var(--green)' }}
              title="Set active=true for the selected users"
            >
              Activate {selected.size}
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div
          className={`rounded-lg p-3 text-sm border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {error}
        </div>
      )}

      {/* Table */}
      <div className={`overflow-x-auto rounded-xl border ${idcsCx.border}`}>
        <table
          className="text-sm"
          style={{
            width: '100%',
            tableLayout: 'fixed',
            minWidth: userResize.sumWidth,
            borderCollapse: 'collapse',
          }}
        >
          <ResizableColGroup widths={userResize.widths} />
          <thead>
            <tr>
              <ResizableTh
                columnIndex={0}
                columnCount={USER_COLS.length}
                startResize={userResize.startResize}
                style={USER_TH_STYLE}
              >
                <input
                  type="checkbox"
                  checked={selected.size === users.length && users.length > 0}
                  onChange={toggleAll}
                  className="rounded"
                />
              </ResizableTh>
              {['User', 'Email', 'Mobile', 'Groups', 'Status', 'Actions'].map((label, i) => (
                <ResizableTh
                  key={label}
                  columnIndex={i + 1}
                  columnCount={USER_COLS.length}
                  startResize={userResize.startResize}
                  style={USER_TH_STYLE}
                >
                  {label}
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody className={`divide-y ${idcsCx.divide}`}>
            {loading ? (
              <tr>
                <td colSpan={7} className={`text-center py-10 ${idcsCx.text3}`}>Loading users...</td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={7} className={`text-center py-10 ${idcsCx.text3}`}>No users found</td>
              </tr>
            ) : (
              users.map((u) => {
                const email      = u.emails?.find((e) => e.primary)?.value || u.emails?.[0]?.value || '—';
                const mobile     = u.phoneNumbers?.find((p) => p.type === 'mobile')?.value || '—';
                const groups = formatUserGroups(u) || '—';
                const busy       = actionLoading[u.id];

                return (
                  <tr
                    key={u.id}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setDetailOpen({ id: u.id, preview: u });
                      }
                    }}
                    onClick={() => setDetailOpen({ id: u.id, preview: u })}
                    className={`cursor-pointer hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg2))] ${
                      selected.has(u.id) ? 'bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg3))]' : ''
                    }`}
                  >
                    <td className="px-4 py-3 overflow-hidden" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(u.id)}
                        onChange={() => toggleSelect(u.id)}
                        className="rounded"
                      />
                    </td>
                    <td className="px-4 py-3 overflow-hidden">
                      <div className={`font-medium truncate ${idcsCx.text}`} title={u.displayName || u.userName}>{u.displayName || u.userName}</div>
                      <div className={`text-xs truncate ${idcsCx.text3}`} title={u.userName}>{u.userName}</div>
                    </td>
                    <td className={`px-4 py-3 overflow-hidden truncate ${idcsCx.text2}`} title={email}>{email}</td>
                    <td className={`px-4 py-3 overflow-hidden truncate ${idcsCx.text2}`} title={mobile}>{mobile}</td>
                    <td className={`px-4 py-3 overflow-hidden truncate ${idcsCx.text2}`} title={groups}>{groups}</td>
                    <td className="px-4 py-3 overflow-hidden">
                      <StatusBadge active={u.active} />
                    </td>
                    <td className="px-4 py-3 overflow-hidden" onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-3 items-center">
                        <button
                          type="button"
                          onClick={() => setPwdModal(u)}
                          disabled={!!busy}
                          className={`text-xs disabled:opacity-40 font-medium hover:opacity-90`}
                          style={{ color: 'var(--accent)' }}
                          title="Set password for this user"
                        >
                          🔑 Set Pwd
                        </button>
                        {onAddToGroup && (
                          <button
                            type="button"
                            onClick={() => onAddToGroup([u.id])}
                            className="text-xs font-medium hover:opacity-90"
                            style={{ color: 'var(--accent2)' }}
                            title="Manage group membership"
                          >
                            Group
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleToggleActive(u)}
                          disabled={!!busy}
                          className="text-xs font-medium hover:opacity-90 disabled:opacity-40"
                          style={{ color: u.active ? 'var(--amber)' : 'var(--green)' }}
                          title={u.active ? 'Suspend (set active=false)' : 'Activate (set active=true)'}
                        >
                          {busy === 'suspending' || busy === 'activating'
                            ? '...'
                            : u.active ? 'Suspend' : 'Activate'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(u.id, u.userName)}
                          disabled={!!busy}
                          className="text-xs text-[var(--red)] hover:opacity-90 disabled:opacity-40 font-medium"
                          title="Delete user"
                        >
                          {busy === 'deleting' ? '...' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className={`flex items-center justify-between text-sm ${idcsCx.text2}`}>
          <span>Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, total)} of {total}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className={`px-3 py-1 rounded disabled:opacity-40 border ${idcsCx.border} ${idcsCx.bg3}`}
            >Prev</button>
            <span className="px-3 py-1">{page} / {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className={`px-3 py-1 rounded disabled:opacity-40 border ${idcsCx.border} ${idcsCx.bg3}`}
            >Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
