import { useState } from 'react'
import { bulkUploadCsv } from '../../api/nexs'
import { nexsBtnPrimary, nexsCx } from './nexsTheme'

const KINDS = [
  { id: 'create', label: 'Bulk create users', hint: 'POST /v1/bulk/createUser (CSV)' },
  { id: 'management', label: 'Bulk create/edit (user management)', hint: 'POST /v1/userManagement/bulk/createEdit/user' },
  { id: 'roles', label: 'Bulk update user roles', hint: 'POST /v1/bulk/update/user-roles' },
]

export default function NexsBulkUpload({ onDone }) {
  const [kind, setKind] = useState('create')
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!file) {
      setError('Select a CSV file')
      return
    }
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const res = await bulkUploadCsv({ file, kind })
      setResult(res)
      onDone?.()
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-4">
      <p className={`text-sm ${nexsCx.text2}`}>
        Upload a CSV file to the Lenskart Auth Service. Use the format expected by your application team for the selected operation.
      </p>

      <div>
        <label className={`block text-sm font-medium mb-2 ${nexsCx.text}`}>Operation</label>
        <div className="space-y-2">
          {KINDS.map((k) => (
            <label key={k.id} className={`flex items-start gap-2 rounded-lg px-3 py-2 border cursor-pointer ${nexsCx.border} ${kind === k.id ? 'ring-1 ring-[var(--accent)]' : ''}`}>
              <input type="radio" name="kind" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} className="mt-1" />
              <span>
                <span className={`text-sm font-medium ${nexsCx.text}`}>{k.label}</span>
                <span className={`block text-xs ${nexsCx.text3}`}>{k.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className={`block text-sm font-medium mb-1 ${nexsCx.text}`}>CSV file</label>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className={`text-sm ${nexsCx.text2}`}
        />
      </div>

      {error && (
        <div className="text-sm p-3 rounded-lg" style={{ color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))' }}>
          {error}
        </div>
      )}

      {result && (
        <div className="text-sm p-3 rounded-lg" style={{ color: 'var(--green)', background: 'color-mix(in srgb, var(--green) 12%, var(--bg3))' }}>
          {result.message || (result.success === false ? 'Request completed with errors' : 'Upload submitted successfully')}
          {result.success !== undefined && (
            <span className={`block mt-1 text-xs ${nexsCx.text3}`}>success: {String(result.success)}</span>
          )}
        </div>
      )}

      <button type="submit" disabled={loading || !file} className={nexsBtnPrimary()}>
        {loading ? 'Uploading…' : 'Upload CSV'}
      </button>
    </form>
  )
}
