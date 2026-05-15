/**
 * ExportPanel.jsx
 * Download IDCS users as CSV, XLSX, or JSON.
 * Options: Active / Inactive / All users / Group-wise (searchable groups — no giant dropdown).
 */

import { useState, useEffect } from 'react';
import { exportUsers, listGroups } from '../../api/idcs';
import { idcsCx, idcsInputClass, idcsBtnPrimary } from './idcsTheme';

const FORMAT_OPTIONS = [
  { value: 'csv',  label: 'CSV',   icon: '📄' },
  { value: 'xlsx', label: 'Excel', icon: '📊' },
  { value: 'json', label: 'JSON',  icon: '📋' },
];

/** exportMode: all | active | inactive | group */
const SCOPE_OPTIONS = [
  { mode: 'all',      label: 'All Users' },
  { mode: 'active',   label: 'Active Users' },
  { mode: 'inactive', label: 'Inactive Users' },
];

export default function ExportPanel() {
  const [format, setFormat] = useState('xlsx');
  const [exportMode, setExportMode] = useState('all');
  const [groupId, setGroupId] = useState('');
  const [groupLabel, setGroupLabel] = useState('');
  const [groupQuery, setGroupQuery] = useState('');
  const [debouncedGQ, setDebouncedGQ] = useState('');
  const [groupHits, setGroupHits] = useState([]);
  const [groupTotal, setGroupTotal] = useState(0);
  const [groupsLoading, setGroupsLoading] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedGQ(groupQuery), 350);
    return () => clearTimeout(t);
  }, [groupQuery]);

  useEffect(() => {
    if (exportMode !== 'group') return;
    let cancelled = false;
    setGroupsLoading(true);
    listGroups({ search: debouncedGQ, page: 1, limit: 80 })
      .then((d) => {
        if (!cancelled) {
          setGroupHits(d.groups || []);
          setGroupTotal(d.total ?? 0);
        }
      })
      .catch((e) => {
        if (!cancelled) setError('Failed to load groups: ' + (e.response?.data?.error || e.message));
      })
      .finally(() => {
        if (!cancelled) setGroupsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [exportMode, debouncedGQ]);

  const pickGroup = (g) => {
    setGroupId(g.id);
    setGroupLabel(g.displayName || g.id);
  };

  const handleExport = async () => {
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const isGroup = exportMode === 'group';
      const status = isGroup ? '' : exportMode === 'all' ? '' : exportMode;
      await exportUsers({ format, status, groupId: isGroup ? groupId : '' });
      const label = isGroup
        ? `Group export (${groupLabel || 'group'})`
        : exportMode === 'all'
          ? 'All users'
          : `${exportMode.charAt(0).toUpperCase() + exportMode.slice(1)} users`;
      setSuccess(`${label} downloaded as .${format}`);
    } catch (e) {
      setError('Export failed: ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className={`text-base font-semibold mb-1 ${idcsCx.text}`}>Export Users</h3>
        <p className={`text-sm ${idcsCx.text2}`}>Download user data from Oracle IDCS as a file.</p>
      </div>

      <div>
        <label className={`block text-sm font-medium mb-2 ${idcsCx.text}`}>File Format</label>
        <div className="flex gap-3 flex-wrap">
          {FORMAT_OPTIONS.map((f) => (
            <button
              type="button"
              key={f.value}
              onClick={() => setFormat(f.value)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                format === f.value
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : `${idcsCx.border} ${idcsCx.text2} hover:opacity-90`
              }`}
              style={
                format === f.value
                  ? { background: 'color-mix(in srgb, var(--accent) 14%, var(--bg3))' }
                  : { background: 'var(--bg3)' }
              }
            >
              <span>{f.icon}</span> {f.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className={`block text-sm font-medium mb-2 ${idcsCx.text}`}>Export Scope</label>
        <div className="space-y-2">
          {SCOPE_OPTIONS.map((s) => (
            <label key={s.mode} className={`flex items-center gap-2 cursor-pointer ${idcsCx.text}`}>
              <input
                type="radio"
                name="export-scope"
                checked={exportMode === s.mode}
                onChange={() => {
                  setExportMode(s.mode);
                  setGroupId('');
                  setGroupLabel('');
                }}
                style={{ accentColor: 'var(--accent)' }}
              />
              <span className="text-sm">{s.label}</span>
            </label>
          ))}

          <label className={`flex items-center gap-2 cursor-pointer ${idcsCx.text}`}>
            <input
              type="radio"
              name="export-scope"
              checked={exportMode === 'group'}
              onChange={() => {
                setExportMode('group');
                setGroupId('');
                setGroupLabel('');
                setGroupQuery('');
                setDebouncedGQ('');
              }}
              style={{ accentColor: 'var(--accent)' }}
            />
            <span className="text-sm">By Group</span>
          </label>

          {exportMode === 'group' && (
            <div className={`ml-6 space-y-2 ${idcsCx.text}`}>
              <input
                type="search"
                value={groupQuery}
                onChange={(e) => setGroupQuery(e.target.value)}
                placeholder="Search group name…"
                className={idcsInputClass('max-w-md')}
              />
              <p className={`text-xs ${idcsCx.text3}`}>
                {groupsLoading
                  ? 'Searching…'
                  : `Showing ${groupHits.length} of ${groupTotal} matches (max 80). Pick one below.`}
              </p>
              {groupId && (
                <div
                  className={`text-sm rounded-lg px-3 py-2 border ${idcsCx.border}`}
                  style={{ background: 'color-mix(in srgb, var(--accent) 10%, var(--bg3))' }}
                >
                  Selected: <strong>{groupLabel}</strong>
                  <button
                    type="button"
                    className="ml-2 text-xs underline"
                    style={{ color: 'var(--accent)' }}
                    onClick={() => { setGroupId(''); setGroupLabel(''); }}
                  >
                    Clear
                  </button>
                </div>
              )}
              <div className={`max-h-40 overflow-y-auto rounded-lg border ${idcsCx.border}`}>
                {groupHits.length === 0 && !groupsLoading ? (
                  <div className={`p-3 text-sm ${idcsCx.text3}`}>No groups match.</div>
                ) : (
                  groupHits.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => pickGroup(g)}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg2))] ${
                        groupId === g.id ? idcsCx.bg3 : ''
                      }`}
                    >
                      {g.displayName || g.id}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

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
          className={`text-sm rounded-lg p-3 flex items-center gap-2 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--green) 12%, var(--bg3))', color: 'var(--green)' }}
        >
          <span>✓</span> {success}
        </div>
      )}

      <button
        type="button"
        onClick={handleExport}
        disabled={loading || (exportMode === 'group' && !groupId)}
        className={`flex items-center gap-2 text-sm ${idcsBtnPrimary()}`}
      >
        {loading ? (
          <>
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            Fetching from IDCS...
          </>
        ) : (
          <>⬇ Download {format.toUpperCase()}</>
        )}
      </button>

      <p className={`text-xs ${idcsCx.text3}`}>
        Large exports are paginated automatically. The file will download once all records are fetched.
      </p>
    </div>
  );
}
