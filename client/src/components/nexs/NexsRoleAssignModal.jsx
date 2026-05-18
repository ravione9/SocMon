import { useEffect, useState } from 'react'
import { assignUserRoles, getUserRoles } from '../../api/nexs'
import { nexsBtnGhost, nexsBtnPrimary, nexsCx, nexsInputClass } from './nexsTheme'

function roleLabel(r) {
  if (typeof r === 'string') return r
  return r?.name || r?.roleGroupName || r?.id || String(r)
}

function roleValue(r) {
  if (typeof r === 'string') return r
  return r?.name || r?.roleGroupName || String(r?.id ?? '')
}

export default function NexsRoleAssignModal({ empCode, userLabel, allRoles, onClose, onSaved }) {
  const [selected, setSelected] = useState([])
  const [customRole, setCustomRole] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getUserRoles(empCode)
      .then((data) => {
        if (cancelled) return
        const list = data?.data || data?.roleGroups || data?.roles || []
        const names = (Array.isArray(list) ? list : []).map(roleValue).filter(Boolean)
        setSelected(names)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [empCode])

  const toggle = (val) => {
    setSelected((prev) => (prev.includes(val) ? prev.filter((x) => x !== val) : [...prev, val]))
  }

  const addCustom = () => {
    const v = customRole.trim()
    if (!v || selected.includes(v)) return
    setSelected((p) => [...p, v])
    setCustomRole('')
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      await assignUserRoles(empCode, { roleGroups: selected })
      onSaved?.()
      onClose()
    } catch (e) {
      setError(e.response?.data?.error || e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }}>
      <div className={`w-full max-w-md rounded-xl border p-5 shadow-xl ${nexsCx.border} ${nexsCx.bg2}`}>
        <h3 className={`text-lg font-semibold mb-1 ${nexsCx.text}`}>Assign roles</h3>
        <p className={`text-sm mb-4 ${nexsCx.text3}`}>
          {userLabel || empCode} · <span className="font-mono">{empCode}</span>
        </p>

        {loading ? (
          <p className={`text-sm mb-4 ${nexsCx.text3}`}>Loading current roles…</p>
        ) : (
          <div className="max-h-56 overflow-y-auto space-y-2 mb-4">
            {(allRoles || []).length === 0 ? (
              <p className={`text-sm ${nexsCx.text3}`}>No roles returned from auth service.</p>
            ) : (
              allRoles.map((r) => {
                const val = roleValue(r)
                const label = roleLabel(r)
                return (
                  <label
                    key={val}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer border ${nexsCx.border} ${nexsCx.bg3}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(val)}
                      onChange={() => toggle(val)}
                      className="rounded"
                    />
                    <span className={`text-sm ${nexsCx.text}`}>{label}</span>
                  </label>
                )
              })
            )}
          </div>
        )}

        <div className="mb-3">
          <label className={`block text-xs font-medium mb-1 ${nexsCx.text2}`}>Add custom role group</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={customRole}
              onChange={(e) => setCustomRole(e.target.value)}
              placeholder="Role group name"
              className={nexsInputClass('flex-1')}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom() } }}
            />
            <button type="button" onClick={addCustom} className={nexsBtnGhost()}>Add</button>
          </div>
        </div>

        {error && (
          <div className="text-sm mb-3 p-2 rounded-lg" style={{ color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))' }}>
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={nexsBtnGhost()} disabled={saving}>Cancel</button>
          <button type="button" onClick={handleSave} className={nexsBtnPrimary()} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save roles'}
          </button>
        </div>
      </div>
    </div>
  )
}
