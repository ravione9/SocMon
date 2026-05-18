/**
 * BulkUpload.jsx
 * CSV / JSON bulk user create or delete.
 * - Drag-and-drop or click to upload a CSV/JSON file
 * - Shows a preview table before submitting
 * - Reports per-user success/failure after submit
 */

import { useState, useRef } from 'react';
import { bulkCreateUsers, bulkDeleteUsers, bulkSetActive, bulkResetPassword } from '../../api/idcs';
import { idcsCx, idcsBtnPrimary, idcsBtnDanger } from './idcsTheme';

const REQUIRED_FIELDS = ['firstName', 'lastName', 'email'];
// `recoveryEmail` is optional; if present in the CSV/JSON it's forwarded to IDCS
// and stored as a SCIM emails[type=recovery] entry on the user.
const CREATE_CSV_TEMPLATE = `firstName,lastName,email,recoveryEmail,mobileNumber,password
John,Doe,john.doe@example.com,john.personal@gmail.com,+911234567890,
Jane,Smith,jane.smith@example.com,,,`;
// Suspend / Activate / Delete — only IDCS user IDs are needed.
const IDCS_ID_CSV_TEMPLATE = `idcsId
ffffab6d220d414cad673a2d9fb995ab
abcd1234ef567890abcd1234ef567890`;

const MODES = [
  { id: 'create',        label: 'Bulk Create',         needsIdcsId: false, danger: false },
  { id: 'reset-password',label: 'Bulk Reset Password', needsIdcsId: true,  danger: false },
  { id: 'suspend',       label: 'Bulk Suspend',        needsIdcsId: true,  danger: false },
  { id: 'activate',      label: 'Bulk Activate',       needsIdcsId: true,  danger: false },
  { id: 'delete',        label: 'Bulk Delete',         needsIdcsId: true,  danger: true  },
];

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const obj = {};
    headers.forEach((h, i) => { if (values[i]) obj[h] = values[i]; });
    return obj;
  });
}

function parseJSON(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('JSON must be an array of user objects');
  return data;
}

export default function BulkUpload({ onComplete }) {
  const [mode, setMode] = useState('create'); // 'create' | 'suspend' | 'activate' | 'delete'
  const [rows, setRows] = useState([]);
  const [parseError, setParseError] = useState('');
  const [fileName, setFileName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  const handleFile = (file) => {
    if (!file) return;
    setFileName(file.name);
    setParseError('');
    setRows([]);
    setResult(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const parsed = file.name.endsWith('.json') ? parseJSON(text) : parseCSV(text);

        if (mode === 'create') {
          // Validate required fields
          const missing = parsed.filter((r) =>
            REQUIRED_FIELDS.some((f) => !r[f])
          );
          if (missing.length > 0) {
            setParseError(`${missing.length} row(s) are missing required fields (firstName, lastName, email)`);
          }
        } else {
          // suspend/activate/delete: need idcsId for each row
          const hasIdcsId = parsed.every((r) => r.idcsId);
          if (!hasIdcsId) {
            setParseError(`Each row must include an "idcsId" column for ${mode}. (Tip: download the template.)`);
          }
        }

        setRows(parsed);
      } catch (err) {
        setParseError(err.message);
      }
    };
    reader.readAsText(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleSubmit = async () => {
    if (rows.length === 0) return;
    setSubmitting(true);
    setResult(null);

    try {
      let res;
      if (mode === 'create') {
        res = await bulkCreateUsers(rows);
      } else {
        const userIds = rows.map((r) => r.idcsId).filter(Boolean);
        if (userIds.length === 0) {
          setResult({ error: 'No idcsId column found. Please include the IDCS ID for each user.' });
          setSubmitting(false);
          return;
        }
        if (mode === 'delete') {
          res = await bulkDeleteUsers(userIds);
        } else if (mode === 'suspend' || mode === 'activate') {
          res = await bulkSetActive(userIds, mode === 'activate');
        } else if (mode === 'reset-password') {
          res = await bulkResetPassword(userIds);
        }
      }
      setResult(res);
      if (onComplete) onComplete();
    } catch (e) {
      setResult({ error: e.response?.data?.error || e.message });
    } finally {
      setSubmitting(false);
    }
  };

  const downloadTemplate = () => {
    const isCreate = mode === 'create';
    const blob = new Blob([isCreate ? CREATE_CSV_TEMPLATE : IDCS_ID_CSV_TEMPLATE], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `idcs_bulk_${mode}_template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentMode = MODES.find((m) => m.id === mode) || MODES[0];

  return (
    <div className="space-y-5">
      {/* Mode toggle */}
      <div className="flex gap-2 flex-wrap items-center">
        {MODES.map((m) => (
          <button
            type="button"
            key={m.id}
            onClick={() => { setMode(m.id); setRows([]); setResult(null); setParseError(''); setFileName(''); }}
            className={
              mode === m.id
                ? `rounded-lg text-sm font-medium ${m.danger ? idcsBtnDanger() : idcsBtnPrimary()}`
                : `rounded-lg text-sm font-medium px-4 py-2 border ${idcsCx.border} ${idcsCx.bg3} ${idcsCx.text2} hover:opacity-90`
            }
          >
            {m.label}
          </button>
        ))}
        <button
          type="button"
          onClick={downloadTemplate}
          className="ml-auto text-sm hover:opacity-90 hover:underline"
          style={{ color: 'var(--accent)' }}
        >
          Download CSV template
        </button>
      </div>

      {/* Mode helper */}
      <div className={`text-xs ${idcsCx.text3}`}>
        {mode === 'create' && 'Upload users to create. Required: firstName, lastName, email. Optional: recoveryEmail, mobileNumber, password.'}
        {mode === 'delete' && 'Upload an idcsId column. Each user will be permanently deleted from Oracle IDCS.'}
        {mode === 'suspend' && 'Upload an idcsId column. Each user will be suspended (active=false).'}
        {mode === 'activate' && 'Upload an idcsId column. Each user will be activated (active=true).'}
        {mode === 'reset-password' && 'Upload an idcsId column. Oracle IDCS will email a password-reset link to each user.'}
      </div>

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${idcsCx.border} hover:border-[var(--accent)]`}
        style={{ background: 'color-mix(in srgb, var(--accent) 6%, var(--bg2))' }}
      >
        <div className="text-3xl mb-2">📂</div>
        <p className={`text-sm ${idcsCx.text2}`}>
          {fileName ? (
            <span className="font-medium" style={{ color: 'var(--accent)' }}>{fileName}</span>
          ) : (
            <>Drag & drop a <strong>.csv</strong> or <strong>.json</strong> file here, or click to browse</>
          )}
        </p>
        {rows.length > 0 && (
          <p className={`text-xs mt-1 ${idcsCx.text3}`}>{rows.length} row{rows.length !== 1 ? 's' : ''} loaded</p>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.json"
          className="hidden"
          onChange={(e) => handleFile(e.target.files[0])}
        />
      </div>

      {/* Parse error */}
      {parseError && (
        <div
          className={`text-sm rounded-lg p-3 border ${idcsCx.border}`}
          style={{ background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', color: 'var(--red)' }}
        >
          {parseError}
        </div>
      )}

      {/* Preview table */}
      {rows.length > 0 && !result && (
        <div>
          <h4 className={`text-sm font-semibold mb-2 ${idcsCx.text}`}>
            Preview — first {Math.min(rows.length, 5)} of {rows.length} rows
          </h4>
          <div className={`overflow-x-auto rounded-lg border ${idcsCx.border}`}>
            <table className="min-w-full text-xs">
              <thead className={idcsCx.bg3}>
                <tr>
                  {Object.keys(rows[0]).map((k) => (
                    <th key={k} className={`px-3 py-2 text-left uppercase ${idcsCx.text3}`}>{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody className={`divide-y ${idcsCx.divide}`}>
                {rows.slice(0, 5).map((row, i) => (
                  <tr key={i}>
                    {Object.values(row).map((v, j) => (
                      <td key={j} className={`px-3 py-2 ${idcsCx.text}`}>{v || '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !!parseError}
            className={`mt-4 rounded-lg text-sm font-medium disabled:opacity-50 ${
              currentMode.danger ? idcsBtnDanger() : idcsBtnPrimary()
            }`}
          >
            {submitting
              ? `Processing ${rows.length} users...`
              : `${currentMode.label.replace('Bulk ', '')} ${rows.length} User${rows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}

      {/* Result */}
      {result && (
        <div
          className={`rounded-xl p-4 text-sm border ${idcsCx.border}`}
          style={{
            background: result.error
              ? 'color-mix(in srgb, var(--red) 12%, var(--bg3))'
              : 'color-mix(in srgb, var(--green) 12%, var(--bg3))',
          }}
        >
          {result.error ? (
            <p style={{ color: 'var(--red)' }}>{result.error}</p>
          ) : (
            <div className="space-y-2">
              <p className="font-semibold" style={{ color: 'var(--green)' }}>
                Completed: {result.succeeded?.length || 0} succeeded,{' '}
                {result.failed?.length || 0} failed
              </p>
              {result.failed?.length > 0 && (
                <div className="mt-2">
                  <p className="font-medium" style={{ color: 'var(--red)' }}>Failed:</p>
                  <ul className="list-disc list-inside space-y-0.5" style={{ color: 'var(--red)' }}>
                    {result.failed.map((f, i) => (
                      <li key={i}>{f.email || f.id}: {f.error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
