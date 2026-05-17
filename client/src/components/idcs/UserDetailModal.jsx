/**
 * Read-only user summary + Edit + Set password + Add to group + Delete.
 */

import { useState, useEffect, useMemo } from 'react';
import { getUser, deleteUser, updateUser } from '../../api/idcs';
import { idcsCx, idcsBtnPrimary, idcsBtnGhost, idcsInputClass } from './idcsTheme';
import { formatUserGroups } from './formatUserGroups';

function findEmail(user, predicate) {
  return (user?.emails || []).find(predicate)?.value || '';
}

function readableUser(user) {
  if (!user) return null;
  const primary = findEmail(user, (e) => e.primary === true) || findEmail(user, () => true);
  const recovery = findEmail(user, (e) => String(e.type || '').toLowerCase() === 'recovery');
  const work = findEmail(user, (e) => String(e.type || '').toLowerCase() === 'work');
  const home = findEmail(user, (e) => String(e.type || '').toLowerCase() === 'home');
  const mobile =
    (user.phoneNumbers || []).find((p) => String(p.type || '').toLowerCase() === 'mobile')?.value || '';
  const workPhone =
    (user.phoneNumbers || []).find((p) => String(p.type || '').toLowerCase() === 'work')?.value || '';
  const fullName = [user.name?.givenName, user.name?.familyName].filter(Boolean).join(' ');

  return {
    primary,
    recovery,
    work,
    home,
    mobile,
    workPhone,
    fullName,
  };
}

function Field({ label, children, mono, breakAll }) {
  return (
    <>
      <dt className={`${idcsCx.text3} self-start pt-0.5`}>{label}</dt>
      <dd className={`${mono ? 'font-mono text-xs' : ''} ${breakAll ? 'break-all' : 'break-words'}`}>
        {children}
      </dd>
    </>
  );
}

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

  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({});

  const fetchUser = (signal) => {
    setLoading(true);
    setError('');
    return getUser(userId)
      .then((data) => {
        if (!signal?.cancelled) setUser(data);
      })
      .catch((e) => {
        if (!signal?.cancelled) setError(e.response?.data?.error || e.message);
      })
      .finally(() => {
        if (!signal?.cancelled) setLoading(false);
      });
  };

  useEffect(() => {
    const signal = { cancelled: false };
    fetchUser(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [userId]);

  const r = useMemo(() => readableUser(user), [user]);

  const startEdit = () => {
    const src = user || previewUser;
    if (!src) return;
    const sr = readableUser(src);
    setForm({
      displayName: src.displayName || '',
      firstName:   src.name?.givenName || '',
      lastName:    src.name?.familyName || '',
      email:       sr?.primary || '',
      recoveryEmail: sr?.recovery || '',
      mobileNumber: sr?.mobile || '',
      active:      src.active !== false,
    });
    setError('');
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setError('');
  };

  const handleSave = async (e) => {
    e?.preventDefault?.();
    const src = user || previewUser;
    if (!src) return;
    const sr = readableUser(src);

    const trimmed = (v) => (typeof v === 'string' ? v.trim() : v);
    const patch = {};
    if (trimmed(form.displayName) !== (src.displayName || '')) patch.displayName = trimmed(form.displayName);
    if (trimmed(form.firstName)   !== (src.name?.givenName || '')) patch.firstName = trimmed(form.firstName);
    if (trimmed(form.lastName)    !== (src.name?.familyName || '')) patch.lastName  = trimmed(form.lastName);
    if (trimmed(form.email)       !== (sr?.primary || ''))         patch.email      = trimmed(form.email);
    if (trimmed(form.recoveryEmail) !== (sr?.recovery || ''))      patch.recoveryEmail = trimmed(form.recoveryEmail);
    if (trimmed(form.mobileNumber) !== (sr?.mobile || ''))         patch.mobileNumber  = trimmed(form.mobileNumber);
    if (!!form.active !== (src.active !== false))                   patch.active = !!form.active;

    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email.trim())) {
      setError('Primary email is not valid');
      return;
    }
    if (form.recoveryEmail && !/^\S+@\S+\.\S+$/.test(form.recoveryEmail.trim())) {
      setError('Recovery email is not valid');
      return;
    }

    if (!Object.keys(patch).length) {
      setEditMode(false);
      return;
    }

    setSaving(true);
    setError('');
    try {
      const updated = await updateUser(userId, patch);
      setUser(updated);
      setEditMode(false);
      onUserChanged?.();
    } catch (ex) {
      setError(ex.response?.data?.error || ex.message);
    } finally {
      setSaving(false);
    }
  };

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

  const displayPeek = user || previewUser || null;
  const headerEmail =
    displayPeek?.emails?.find((e) => e.primary)?.value || displayPeek?.emails?.[0]?.value || '—';
  const headerGroups = formatUserGroups(displayPeek);
  const groupsFormatted = formatUserGroups(user);
  const title = user?.displayName || user?.userName || previewUser?.displayName || 'User';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div
        className={`rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-hidden flex flex-col border ${idcsCx.border} ${idcsCx.bg2}`}
        role="dialog"
        aria-labelledby="user-detail-title"
      >
        <div
          className="px-5 py-4 flex items-start justify-between gap-3 shrink-0"
          style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent2))' }}
        >
          <div className="min-w-0 pr-2 flex-1">
            <h2 id="user-detail-title" className="font-semibold text-lg text-[var(--on-accent)]">
              {editMode ? 'Edit User' : title}
            </h2>
            <p className="text-xs opacity-90 text-[var(--on-accent)] mt-1 break-all">
              {headerEmail}
            </p>
            <p
              className="text-[11px] opacity-85 text-[var(--on-accent)] mt-1 font-mono truncate"
              title={displayPeek?.userName}
            >
              {loading ? previewUser?.userName || userId : user?.userName || userId}
            </p>
            <p
              className={`text-[11px] mt-1 leading-snug text-[var(--on-accent)] ${
                headerGroups ? 'opacity-90' : 'opacity-75 italic'
              }`}
            >
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
          {loading && <p className={`text-sm ${idcsCx.text3}`}>Loading user details…</p>}
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

          {!loading && user && !editMode && (
            <dl className={`grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-sm ${idcsCx.text}`}>
              <Field label="IDCS ID" mono breakAll>{user.id}</Field>
              <Field label="Username" mono breakAll>{user.userName || '—'}</Field>
              <Field label="Display name">{user.displayName || '—'}</Field>
              <Field label="First name">{user.name?.givenName || '—'}</Field>
              <Field label="Last name">{user.name?.familyName || '—'}</Field>
              <Field label="Full name">{r?.fullName || '—'}</Field>
              <Field label="Primary email" breakAll>{r?.primary || '—'}</Field>
              <Field label="Recovery email" breakAll>
                {r?.recovery ? (
                  r.recovery
                ) : (
                  <span className={`${idcsCx.text3} italic`}>not set</span>
                )}
              </Field>
              {r?.work && r.work !== r.primary && (
                <Field label="Work email" breakAll>{r.work}</Field>
              )}
              {r?.home && (
                <Field label="Home email" breakAll>{r.home}</Field>
              )}
              <Field label="Mobile">{r?.mobile || '—'}</Field>
              {r?.workPhone && <Field label="Work phone">{r.workPhone}</Field>}
              {user.nickName && <Field label="Nickname">{user.nickName}</Field>}
              {user.title && <Field label="Title">{user.title}</Field>}
              {user.userType && <Field label="User type">{user.userType}</Field>}
              {user.preferredLanguage && <Field label="Language">{user.preferredLanguage}</Field>}
              {user.locale && <Field label="Locale">{user.locale}</Field>}
              {user.timezone && <Field label="Timezone">{user.timezone}</Field>}
              <Field label="Status">
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-medium border border-[var(--border)]"
                  style={{
                    background: `color-mix(in srgb, ${user.active ? 'var(--green)' : 'var(--amber)'} 22%, var(--bg3))`,
                    color: user.active ? 'var(--green)' : 'var(--amber)',
                  }}
                >
                  {user.active ? 'Active' : 'Inactive'}
                </span>
              </Field>
              <Field label="Groups">{groupsFormatted || '—'}</Field>
              {user.meta?.created && (
                <Field label="Created"><span className={idcsCx.text2}>{String(user.meta.created)}</span></Field>
              )}
              {user.meta?.lastModified && (
                <Field label="Modified"><span className={idcsCx.text2}>{String(user.meta.lastModified)}</span></Field>
              )}
            </dl>
          )}

          {editMode && (user || previewUser) && (
            <form id="idcs-user-edit-form" onSubmit={handleSave} className="space-y-3">
              <div>
                <label className={`block text-xs font-medium mb-1 ${idcsCx.text3}`}>Display name</label>
                <input
                  className={idcsInputClass()}
                  value={form.displayName}
                  onChange={(e) => setForm((p) => ({ ...p, displayName: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={`block text-xs font-medium mb-1 ${idcsCx.text3}`}>First name</label>
                  <input
                    className={idcsInputClass()}
                    value={form.firstName}
                    onChange={(e) => setForm((p) => ({ ...p, firstName: e.target.value }))}
                  />
                </div>
                <div>
                  <label className={`block text-xs font-medium mb-1 ${idcsCx.text3}`}>Last name</label>
                  <input
                    className={idcsInputClass()}
                    value={form.lastName}
                    onChange={(e) => setForm((p) => ({ ...p, lastName: e.target.value }))}
                  />
                </div>
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1 ${idcsCx.text3}`}>Primary email</label>
                <input
                  type="email"
                  className={idcsInputClass()}
                  value={form.email}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1 ${idcsCx.text3}`}>
                  Recovery email{' '}
                  <span className={`font-normal ${idcsCx.text3}`}>
                    (used by Oracle IDCS to send password recovery messages — leave blank to remove)
                  </span>
                </label>
                <input
                  type="email"
                  className={idcsInputClass()}
                  placeholder="e.g. backup@example.com"
                  value={form.recoveryEmail}
                  onChange={(e) => setForm((p) => ({ ...p, recoveryEmail: e.target.value }))}
                />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1 ${idcsCx.text3}`}>Mobile</label>
                <input
                  className={idcsInputClass()}
                  placeholder="+91…"
                  value={form.mobileNumber}
                  onChange={(e) => setForm((p) => ({ ...p, mobileNumber: e.target.value }))}
                />
              </div>
              <label className={`flex items-center gap-2 text-sm cursor-pointer ${idcsCx.text}`}>
                <input
                  type="checkbox"
                  checked={!!form.active}
                  onChange={(e) => setForm((p) => ({ ...p, active: e.target.checked }))}
                  style={{ accentColor: 'var(--accent)' }}
                />
                Active
              </label>
            </form>
          )}
        </div>

        <div
          key={editMode ? 'footer-edit' : 'footer-view'}
          className={`px-5 py-4 flex flex-wrap gap-2 border-t shrink-0 ${idcsCx.border} ${idcsCx.bg3}`}
        >
          {editMode ? (
            <>
              <button
                key="btn-save"
                type="submit"
                form="idcs-user-edit-form"
                disabled={saving}
                className={`text-sm ${idcsBtnPrimary()}`}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <button key="btn-cancel" type="button" onClick={cancelEdit} className={`text-sm ${idcsBtnGhost()}`}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                key="btn-edit"
                type="button"
                onClick={startEdit}
                disabled={!user && !previewUser}
                className={`text-sm ${idcsBtnPrimary()}`}
              >
                Edit
              </button>
              {onAddToGroup && (
                <button
                  type="button"
                  onClick={() => {
                    onAddToGroup([userId]);
                    onClose();
                  }}
                  className={`text-sm ${idcsBtnGhost()}`}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
