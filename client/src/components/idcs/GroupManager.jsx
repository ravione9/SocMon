/**
 * GroupManager.jsx
 * Search groups (paginated list API), paginated searchable members,
 * add/remove users — avoids loading huge member arrays from IDCS.
 */

import { useState, useEffect, useCallback } from 'react';
import { listGroups, getGroupMembers, addUsersToGroup, removeUsersFromGroup } from '../../api/idcs';
import { idcsCx, idcsInputClass, idcsBtnPrimary } from './idcsTheme';

const MEMBER_PAGE = 50;

export default function GroupManager({ preSelectedUserIds = [], onDone }) {
  const [groupQuery, setGroupQuery] = useState('');
  const [debouncedGroupQ, setDebouncedGroupQ] = useState('');
  const [groupList, setGroupList] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupListTotal, setGroupListTotal] = useState(0);

  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedGroupName, setSelectedGroupName] = useState('');

  const [members, setMembers] = useState([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [memberPage, setMemberPage] = useState(1);
  const [memberSearchInput, setMemberSearchInput] = useState('');
  const [debouncedMemberQ, setDebouncedMemberQ] = useState('');

  const [loadingMembers, setLoadingMembers] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [userIdsInput, setUserIdsInput] = useState(preSelectedUserIds.join('\n'));

  useEffect(() => {
    const t = setTimeout(() => setDebouncedGroupQ(groupQuery), 350);
    return () => clearTimeout(t);
  }, [groupQuery]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedMemberQ(memberSearchInput), 350);
    return () => clearTimeout(t);
  }, [memberSearchInput]);

  useEffect(() => {
    let cancelled = false;
    setGroupsLoading(true);
    listGroups({ search: debouncedGroupQ, page: 1, limit: 80 })
      .then((d) => {
        if (!cancelled) {
          setGroupList(d.groups || []);
          setGroupListTotal(d.total ?? 0);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.response?.data?.error || e.message);
      })
      .finally(() => {
        if (!cancelled) setGroupsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedGroupQ]);

  useEffect(() => {
    setMemberPage(1);
  }, [debouncedMemberQ]);

  const loadMembers = useCallback(async () => {
    if (!selectedGroupId) return;
    setLoadingMembers(true);
    setError('');
    try {
      const data = await getGroupMembers(selectedGroupId, {
        page: memberPage,
        limit: MEMBER_PAGE,
        search: debouncedMemberQ,
      });
      setMembers(data.members || []);
      setMemberTotal(typeof data.total === 'number' ? data.total : (data.members || []).length);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setMembers([]);
      setMemberTotal(0);
    } finally {
      setLoadingMembers(false);
    }
  }, [selectedGroupId, memberPage, debouncedMemberQ]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    if (preSelectedUserIds.length > 0) {
      setUserIdsInput(preSelectedUserIds.join('\n'));
    }
  }, [preSelectedUserIds]);

  const selectGroup = (g) => {
    setMemberPage(1);
    setMemberSearchInput('');
    setDebouncedMemberQ('');
    setSelectedGroupId(g.id);
    setSelectedGroupName(g.displayName || g.id);
    setSuccess('');
    setError('');
  };

  const clearGroup = () => {
    setSelectedGroupId('');
    setSelectedGroupName('');
    setMembers([]);
    setMemberTotal(0);
    setMemberPage(1);
    setMemberSearchInput('');
    setDebouncedMemberQ('');
    setSuccess('');
  };

  const getUserIds = () =>
    userIdsInput
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const handleAdd = async () => {
    const ids = getUserIds();
    if (!selectedGroupId || ids.length === 0) {
      setError('Select a group and enter at least one User ID');
      return;
    }
    setActionLoading(true);
    setError('');
    setSuccess('');
    try {
      await addUsersToGroup(selectedGroupId, ids);
      setSuccess(`${ids.length} user(s) added to group`);
      loadMembers();
      if (onDone) onDone();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemove = async (userId, displayName) => {
    if (!window.confirm(`Remove ${displayName} from this group?`)) return;
    setActionLoading(true);
    setError('');
    try {
      await removeUsersFromGroup(selectedGroupId, [userId]);
      setMembers((prev) => prev.filter((m) => m.value !== userId));
      setMemberTotal((t) => Math.max(0, t - 1));
      setSuccess(`${displayName} removed from group`);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setActionLoading(false);
    }
  };

  const memberPages = Math.max(1, Math.ceil(memberTotal / MEMBER_PAGE));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-4">
        <div>
          <label className={`block text-sm font-medium mb-1 ${idcsCx.text}`}>Find group</label>
          <input
            type="search"
            value={groupQuery}
            onChange={(e) => setGroupQuery(e.target.value)}
            placeholder="Type group name (e.g. Zoho)…"
            className={idcsInputClass()}
          />
          <p className={`text-xs mt-1 ${idcsCx.text3}`}>
            {groupsLoading ? 'Searching…' : `Showing ${groupList.length} of ${groupListTotal} matching groups (max 80 per search).`}
          </p>
          {!selectedGroupId ? (
            <div
              className={`mt-2 max-h-52 overflow-y-auto rounded-lg border ${idcsCx.border} divide-y ${idcsCx.divide}`}
            >
              {groupList.length === 0 && !groupsLoading ? (
                <div className={`p-3 text-sm ${idcsCx.text3}`}>No groups match. Try another search.</div>
              ) : (
                groupList.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => selectGroup(g)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg2))] ${idcsCx.text}`}
                  >
                    {g.displayName || g.id}
                  </button>
                ))
              )}
            </div>
          ) : (
            <div
              className={`mt-2 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${idcsCx.border} ${idcsCx.bg3}`}
            >
              <span className={`text-sm font-medium truncate ${idcsCx.text}`}>{selectedGroupName}</span>
              <button
                type="button"
                onClick={clearGroup}
                className={`text-xs shrink-0 hover:opacity-90`}
                style={{ color: 'var(--accent)' }}
              >
                Change group
              </button>
            </div>
          )}
        </div>

        <div>
          <label className={`block text-sm font-medium mb-1 ${idcsCx.text}`}>
            IDCS User IDs to Add
            {preSelectedUserIds.length > 0 && (
              <span className="ml-2 text-xs" style={{ color: 'var(--accent)' }}>
                ({preSelectedUserIds.length} pre-filled from selection)
              </span>
            )}
          </label>
          <textarea
            value={userIdsInput}
            onChange={(e) => setUserIdsInput(e.target.value)}
            rows={5}
            placeholder="Paste IDCS User IDs, one per line or comma-separated"
            className={`${idcsInputClass()} font-mono`}
          />
          <p className={`text-xs mt-1 ${idcsCx.text3}`}>
            {getUserIds().length} user ID{getUserIds().length !== 1 ? 's' : ''} entered
          </p>
        </div>

        <button
          type="button"
          onClick={handleAdd}
          disabled={actionLoading || !selectedGroupId || getUserIds().length === 0}
          className={`text-sm ${idcsBtnPrimary()}`}
        >
          {actionLoading ? 'Processing…' : `Add ${getUserIds().length || ''} Users to Group`}
        </button>

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
      </div>

      <div>
        <h4 className={`text-sm font-semibold mb-2 ${idcsCx.text}`}>Members in this group</h4>

        {!selectedGroupId ? (
          <div className={`rounded-xl border border-dashed p-8 text-center text-sm ${idcsCx.border} ${idcsCx.text3}`}>
            Choose a group on the left to load members (paginated — safe for large groups).
          </div>
        ) : (
          <>
            <input
              type="search"
              value={memberSearchInput}
              onChange={(e) => setMemberSearchInput(e.target.value)}
              placeholder="Search members by name, username, or email…"
              className={`${idcsInputClass()} mb-2`}
            />
            <p className={`text-xs mb-2 ${idcsCx.text3}`}>
              Page {memberPage} of {memberPages} · {memberTotal} member{memberTotal !== 1 ? 's' : ''} total
              {debouncedMemberQ ? ` matching “${debouncedMemberQ}”` : ''}
            </p>

            {loadingMembers ? (
              <div className={`text-sm p-4 ${idcsCx.text3}`}>Loading members…</div>
            ) : members.length === 0 ? (
              <div className={`rounded-xl border border-dashed p-8 text-center text-sm ${idcsCx.border} ${idcsCx.text3}`}>
                No members on this page{debouncedMemberQ ? ' for this search' : ''}.
              </div>
            ) : (
              <div className={`border rounded-xl overflow-hidden max-h-96 overflow-y-auto ${idcsCx.border}`}>
                <table className="min-w-full text-sm">
                  <thead className={`${idcsCx.bg3} text-xs uppercase sticky top-0 ${idcsCx.text3}`}>
                    <tr>
                      <th className="px-4 py-2 text-left">Member</th>
                      <th className="px-4 py-2 text-left">ID</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${idcsCx.divide}`}>
                    {members.map((m) => (
                      <tr key={m.value} className="hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg2))]">
                        <td className={`px-4 py-2 font-medium ${idcsCx.text}`}>{m.display || m.value}</td>
                        <td className={`px-4 py-2 text-xs font-mono truncate max-w-[120px] ${idcsCx.text3}`}>
                          {m.value}
                        </td>
                        <td className="px-4 py-2">
                          <button
                            type="button"
                            onClick={() => handleRemove(m.value, m.display || m.value)}
                            disabled={actionLoading}
                            className="text-xs text-[var(--red)] hover:opacity-90 disabled:opacity-40"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {memberPages > 1 && (
              <div className={`flex justify-between items-center mt-3 text-sm ${idcsCx.text2}`}>
                <button
                  type="button"
                  disabled={memberPage <= 1 || loadingMembers}
                  onClick={() => setMemberPage((p) => Math.max(1, p - 1))}
                  className={`px-3 py-1 rounded border ${idcsCx.border} ${idcsCx.bg3} disabled:opacity-40`}
                >
                  Prev
                </button>
                <span>
                  {memberPage} / {memberPages}
                </span>
                <button
                  type="button"
                  disabled={memberPage >= memberPages || loadingMembers}
                  onClick={() => setMemberPage((p) => p + 1)}
                  className={`px-3 py-1 rounded border ${idcsCx.border} ${idcsCx.bg3} disabled:opacity-40`}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
