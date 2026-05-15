/**
 * Read-only user summary + actions (set password, add to group, delete).
 */

import { useState, useEffect } from 'react';
import { getUser, deleteUser } from '../../api/idcs';
import { idcsCx, idcsBtnPrimary, idcsBtnGhost } from './idcsTheme';
import { formatUserGroups } from './formatUserGroups';

export default function UserDetailModal({
  userId,
  previewUser,
  onClose,
  onAddToGroup,
  onSetPassword,
  onUserChanged,
}) {
  const [user, setUser] = useState(previewUser || null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    getUser(userId)
      .then((data) => {
        if (!cancelled) setUser(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e.response?.data?.error || e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const displayPeek = user || previewUser || null;
  const headerEmail =
    displayPeek?.emails?.find((e) => e.primary)?.value ||
    displayPeek?.emails?.[0]?.value ||
    '—';
  const headerGroups = formatUserGroups(displayPeek);

  const email =
    user?.emails?.find((e) => e.primary)?.value || user?.emails?.[0]?.value || '—';
  const mobile =
    user?.phoneNumbers?.find((p) => p.type === 'mobile')?.value ||
    user?.phoneNumbers?.[0]?.value ||
    '—';
  const groupsFormatted = formatUserGroups(user);
  const title = user?.displayName || user?.userName || previewUser?.displayName || 'User';

  const handleDelete = async () => {
    const un = user?.userName || previewUser?.userName || userId;
    if (!window.confirm(`Delete user ${un}? This cannot be undone.`)) return;
    setDeleting(true);
    setError('');
    try {
      await deleteUser(userId);
      onUserChanged?.();
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div
        className={`rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col border ${idcsCx.border} ${idcsCx.bg2}`}
        role="dialog"
        aria-labelledby="user-detail-title"
      >
        <div
          className="px-5 py-4 flex items-start justify-between gap-3 shrink-0"
          style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent2))' }}
        >
          <div className="min-w-0 pr-2 flex-1">
            <h2 id="user-detail-title" className="font-semibold text-lg text-[var(--on-accent)]">
              {title}
            </h2>
            <p className="text-xs opacity-90 text-[var(--on-accent)] mt-1 break-all">
              {headerEmail}
            </p>
            <p className="text-[11px] opacity-85 text-[var(--on-accent)] mt-1 font-mono truncate" title={displayPeek?.userName}>
              {loading ? previewUser?.userName || userId : user?.userName || userId}
            </p>
            <p className={`text-[11px] mt-1 leading-snug text-[var(--on-accent)] ${headerGroups ? 'opacity-90' : 'opacity-75 italic'}`}>
              Groups: {headerGroups || '—'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--on-accent)] opacity-90 hover:opacity-100 text-xl leading-none shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {loading && (
            <p className={`text-sm ${idcsCx.text3}`}>Loading user details…</p>
          )}
          {error && (
            <div
              className={`text-sm rounded-lg px-3 py-2 border ${idcsCx.border}`}
              style={{
                background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))',
                color: 'var(--red)',
              }}
            >
              {error}
            </div>
          )}

          {!loading && user && (
            <dl className={`grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm ${idcsCx.text}`}>
              <dt className={idcsCx.text3}>IDCS ID</dt>
              <dd className="font-mono text-xs break-all">{user.id}</dd>
              <dt className={idcsCx.text3}>Email</dt>
              <dd className="break-all">{email}</dd>
              <dt className={idcsCx.text3}>Mobile</dt>
              <dd>{mobile}</dd>
              <dt className={idcsCx.text3}>Name</dt>
              <dd>
                {[user.name?.givenName, user.name?.familyName].filter(Boolean).join(' ') || '—'}
              </dd>
              <dt className={idcsCx.text3}>Status</dt>
              <dd>{user.active ? 'Active' : 'Inactive'}</dd>
              <dt className={`${idcsCx.text3} self-start pt-0.5`}>Groups</dt>
              <dd className="break-words">{groupsFormatted || '—'}</dd>
              {user.meta?.created && (
                <>
                  <dt className={idcsCx.text3}>Created</dt>
                  <dd className={idcsCx.text2}>{String(user.meta.created)}</dd>
                </>
              )}
              {user.meta?.lastModified && (
                <>
                  <dt className={idcsCx.text3}>Modified</dt>
                  <dd className={idcsCx.text2}>{String(user.meta.lastModified)}</dd>
                </>
              )}
            </dl>
          )}
        </div>

        <div
          className={`px-5 py-4 flex flex-wrap gap-2 border-t shrink-0 ${idcsCx.border} ${idcsCx.bg3}`}
        >
          {onAddToGroup && (
            <button
              type="button"
              onClick={() => {
                onAddToGroup([userId]);
                onClose();
              }}
              className={`text-sm ${idcsBtnPrimary()}`}
            >
              Add to group…
            </button>
          )}
          {onSetPassword && (
            <button
              type="button"
              disabled={!(user || previewUser)}
              onClick={() => {
                const u = user || previewUser;
                if (u) onSetPassword(u);
                onClose();
              }}
              className={`text-sm ${idcsBtnGhost()}`}
            >
              Set password
            </button>
          )}
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || loading}
            className={`text-sm px-4 py-2.5 rounded-lg font-medium border ${idcsCx.border} text-[var(--red)] hover:opacity-90 disabled:opacity-40 ${idcsCx.bg2}`}
          >
            {deleting ? 'Deleting…' : 'Delete user'}
          </button>
          <button type="button" onClick={onClose} className={`text-sm ml-auto ${idcsBtnGhost()}`}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
