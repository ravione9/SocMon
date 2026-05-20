import { useEffect, useMemo, useRef, useState } from 'react'
import { assignUsersRolesBulk, getAssignableRoles, getUserRoles, lookupEmployee } from '../../api/nexs'
import { nexsBtnGhost, nexsBtnPrimary, nexsCx, nexsInputClass } from './nexsTheme'

function roleLabel(r) {
  if (typeof r === 'string') return r
  return r?.name || r?.roleGroupName || r?.id || String(r)
}

function roleValue(r) {
  if (typeof r === 'string') return r
  return r?.name || r?.roleGroupName || String(r?.id ?? '')
}

function normalizeRolesFromPayload(data) {
  const candidates = [
    data?.data,
    data?.content,
    data?.roleGroups,
    data?.roles,
    data?.activeRoleGroups,
    data?.data?.roleGroups,
    data?.data?.roles,
    data?.content?.roleGroups,
    data?.content?.roles,
    data?.payload?.roleGroups,
    data?.payload?.roles,
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (Array.isArray(candidate)) {
      return candidate.map(roleValue).filter(Boolean)
    }
  }
  return []
}

function uniqueRoleEntries(...sources) {
  const byValue = new Map()
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const role of source) {
      const value = roleValue(role)
      if (!value || byValue.has(value)) continue
      byValue.set(value, typeof role === 'string' ? { name: role } : role)
    }
  }
  return [...byValue.values()]
}

function normalizeFacilitiesFromPayload(data) {
  const candidates = [
    data?.facilities,
    data?.facility,
    data?.data?.facilities,
    data?.data?.facility,
    data?.content?.facilities,
    data?.content?.facility,
    data?.payload?.facilities,
    data?.payload?.facility,
  ]

  const names = []
  const add = (value) => {
    if (value == null) return
    if (typeof value === 'string') {
      const v = value.trim()
      if (v) names.push(v)
      return
    }
    if (typeof value === 'object') {
      const v = String(value.name || value.facility || value.facilityName || value.code || value.id || '').trim()
      if (v) names.push(v)
    }
  }

  for (const candidate of candidates) {
    if (!candidate) continue
    if (Array.isArray(candidate)) {
      for (const item of candidate) add(item)
    } else {
      add(candidate)
    }
  }
  return [...new Set(names)]
}

export default function NexsRoleAssignModal({
  empCode,
  userLabel,
  allRoles,
  grantableRoles = [],
  parentEmpCode,
  parentLabel,
  allFacilities = [],
  initialRoles = [],
  onClose,
  onSaved,
}) {
  const [selected, setSelected] = useState([])
  const [customRoles, setCustomRoles] = useState([])
  const [customRole, setCustomRole] = useState('')
  const [employeeCodesInput, setEmployeeCodesInput] = useState(empCode || '')
  const [facilities, setFacilities] = useState([])
  const [facilityInput, setFacilityInput] = useState('')
  const [parentGrantable, setParentGrantable] = useState([])
  const [targetCurrent, setTargetCurrent] = useState([])
  const [sources, setSources] = useState([])
  const [employeeRecords, setEmployeeRecords] = useState({}) // { empCode: { status, employee, error } }
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const lookupSeqRef = useRef(0)

  // The pool of roles the signed-in (parent) user can grant.
  // 1) Prefer their specific child-role pool (getAllChildRoles / approverRoleGroups).
  // 2) If that's empty (admin-style accounts have no explicit pool), fall back to the
  //    global role list — the auth service validates at write-time, mirroring portal behaviour.
  const childPool = useMemo(
    () => uniqueRoleEntries(grantableRoles, parentGrantable),
    [grantableRoles, parentGrantable],
  )
  const grantablePool = useMemo(
    () => (childPool.length > 0 ? childPool : uniqueRoleEntries(allRoles || [])),
    [childPool, allRoles],
  )
  const grantPoolMode = childPool.length > 0 ? 'specific' : 'global-fallback'
  const grantableValues = useMemo(() => new Set(grantablePool.map(roleValue).filter(Boolean)), [grantablePool])

  // Roles the target already has but the parent CANNOT grant — display as read-only,
  // so the parent doesn't accidentally remove them via an empty submit.
  const lockedTargetRoles = useMemo(() => {
    const locked = new Map()
    for (const r of targetCurrent) {
      const value = roleValue(r)
      if (!value || grantableValues.has(value) || locked.has(value)) continue
      locked.set(value, typeof r === 'string' ? { name: r } : r)
    }
    return [...locked.values()]
  }, [targetCurrent, grantableValues])
  const lockedValues = useMemo(() => new Set(lockedTargetRoles.map(roleValue).filter(Boolean)), [lockedTargetRoles])

  // Final list shown as toggleable checkboxes: grantable pool only, plus any custom roles
  // the parent explicitly typed (NOT the target's existing roles — those go in `lockedTargetRoles`).
  const visibleRoles = useMemo(() => {
    const customs = customRoles
      .filter((v) => !grantableValues.has(v) && !lockedValues.has(v))
      .map((v) => ({ name: v, _custom: true }))
    return uniqueRoleEntries(grantablePool, customs)
  }, [grantablePool, customRoles, grantableValues, lockedValues])

  const employeeCodes = useMemo(
    () => [...new Set(String(employeeCodesInput || '').split(/[\s,\n]+/g).map((v) => v.trim()).filter(Boolean))],
    [employeeCodesInput],
  )

  // Auto-lookup each employee code (debounced) so the parent can see who they're assigning roles to,
  // including brand-new employees that aren't Nexs users yet.
  useEffect(() => {
    if (!employeeCodes.length) return undefined
    const handle = setTimeout(() => {
      lookupSeqRef.current += 1
      const seq = lookupSeqRef.current
      const pending = employeeCodes.filter((code) => {
        const entry = employeeRecords[code]
        return !entry || entry.status === 'idle'
      })
      if (!pending.length) return

      setEmployeeRecords((prev) => {
        const next = { ...prev }
        for (const code of pending) next[code] = { status: 'loading', employee: null, error: null }
        return next
      })

      Promise.all(
        pending.map(async (code) => {
          try {
            const data = await lookupEmployee(code)
            return { code, employee: data?.employee || null, warning: data?.warning || null }
          } catch (err) {
            return { code, employee: null, error: err?.response?.data?.error || err.message || 'Lookup failed' }
          }
        }),
      ).then((results) => {
        if (seq !== lookupSeqRef.current) return
        setEmployeeRecords((prev) => {
          const next = { ...prev }
          for (const r of results) {
            next[r.code] = {
              status: 'done',
              employee: r.employee,
              warning: r.warning || null,
              error: r.error || null,
            }
          }
          return next
        })
      })
    }, 300)

    return () => clearTimeout(handle)
  }, [employeeCodes, employeeRecords])

  const availableFacilities = useMemo(
    () => [...new Set([...(allFacilities || []), ...facilities].map((v) => String(v || '').trim()).filter(Boolean))],
    [allFacilities, facilities],
  )

  useEffect(() => {
    let cancelled = false
    const initialList = Array.isArray(initialRoles) ? initialRoles : []
    const initialValues = initialList.map(roleValue).filter(Boolean)
    setSelected(initialValues)
    setTargetCurrent(initialList)
    setCustomRoles([])
    setEmployeeCodesInput(empCode || '')
    setFacilities([])
    setFacilityInput('')
    setParentGrantable([])
    setSources([])
    setEmployeeRecords({})
    setLoading(true)

    // Pull the target user's current roles in parallel with the parent's child-roles pool.
    // Always (re-)fetch the parent's pool when we have an empCode — even if the page
    // already supplied a list — so the modal always reflects fresh sources/diagnostics.
    const parentRolesPromise = parentEmpCode
      ? getAssignableRoles(parentEmpCode).then(
          (v) => ({ status: 'fulfilled', value: v }),
          (e) => ({ status: 'rejected', reason: e }),
        )
      : Promise.resolve({ status: 'skipped' })

    Promise.allSettled([getUserRoles(empCode), parentRolesPromise])
      .then(([userRolesResult, parentResult]) => {
        if (cancelled) return

        if (userRolesResult.status === 'fulfilled') {
          const data = userRolesResult.value
          const names = normalizeRolesFromPayload(data)
          if (names.length) {
            setSelected(names)
            setTargetCurrent(names.map((n) => ({ name: n })))
          }
          const fetchedFacilities = normalizeFacilitiesFromPayload(data)
          if (fetchedFacilities.length) setFacilities((prev) => [...new Set([...prev, ...fetchedFacilities])])
        }

        if (parentResult.status === 'fulfilled' && parentResult.value?.status === 'fulfilled') {
          const payload = parentResult.value.value || {}
          const list = payload?.roles || []
          if (Array.isArray(list) && list.length) setParentGrantable(list)
          if (Array.isArray(payload?.sources)) setSources(payload.sources)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [empCode, initialRoles, parentEmpCode, grantableRoles])

  const toggle = (val) => {
    setSelected((prev) => (prev.includes(val) ? prev.filter((x) => x !== val) : [...prev, val]))
  }

  const addCustom = () => {
    const v = customRole.trim()
    if (!v) return
    setCustomRoles((prev) => (prev.includes(v) ? prev : [...prev, v]))
    setSelected((prev) => (prev.includes(v) ? prev : [...prev, v]))
    setCustomRole('')
  }

  const addFacility = () => {
    const v = facilityInput.trim()
    if (!v || facilities.includes(v)) return
    setFacilities((prev) => [...prev, v])
    setFacilityInput('')
  }

  const toggleFacility = (name) => {
    setFacilities((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]))
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      if (!employeeCodes.length) {
        setError('Add at least one employee code')
        return
      }
      if (!selected.length && !facilities.length) {
        setError('Select at least one role or facility')
        return
      }
      // Single-target case: preserve locked roles the parent can't grant so we don't accidentally
      // strip them on a replace-style upstream save. For multi-target, locked roles only apply
      // to the original user, so we skip the merge to avoid leaking them to other targets.
      const isSingleTarget = employeeCodes.length === 1 && employeeCodes[0] === String(empCode || '').trim()
      const lockedValues = isSingleTarget ? lockedTargetRoles.map(roleValue).filter(Boolean) : []
      const payloadRoles = [...new Set([...selected, ...lockedValues])]
      await assignUsersRolesBulk({ employeeCodes, roleGroups: payloadRoles, facilities })
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
        <p className={`text-sm ${nexsCx.text3}`}>
          Target: <strong className={nexsCx.text2}>{userLabel || empCode}</strong>
          {' · '}
          <span className="font-mono">{empCode}</span>
        </p>
        <p className={`text-xs mb-4 ${nexsCx.text3}`}>
          {parentLabel ? <>Granting as <strong className={nexsCx.text2}>{parentLabel}</strong>{parentEmpCode ? <> · <span className="font-mono">{parentEmpCode}</span></> : null}</> : 'Granting roles from your child-role pool'}
        </p>

        <label className={`block text-xs font-medium mb-1 ${nexsCx.text2}`}>
          {grantPoolMode === 'specific' ? 'Roles you can grant' : 'All role groups (admin scope)'}
          {grantablePool.length > 0 && <span className={nexsCx.text3}> ({grantablePool.length})</span>}
        </label>
        {grantPoolMode === 'global-fallback' && grantablePool.length > 0 && (
          <p className={`text-[11px] mb-2 ${nexsCx.text3}`}>
            Your account has no specific child-role pool, so the global list is shown. The auth service validates each assignment on save.
          </p>
        )}
        {loading ? (
          <p className={`text-sm mb-4 ${nexsCx.text3}`}>Loading current roles…</p>
        ) : (
          <div className="max-h-56 overflow-y-auto space-y-2 mb-2">
            {visibleRoles.length === 0 ? (
              <div className={`text-sm space-y-1 ${nexsCx.text3}`}>
                <p>
                  {parentEmpCode
                    ? 'No roles available — neither your child-role pool nor the global role list is populated.'
                    : 'Sign-in details missing employee code.'}
                </p>
                <p className="text-xs">
                  Type a role name in the “Add custom role group” field below to assign it directly; the auth service will validate it on save.
                </p>
                {sources?.length > 0 && (
                  <p className="text-[11px] font-mono">
                    {sources.map((s) => `${s.source}=${s.error ? `err(${s.status || '?'})` : s.count}`).join(' · ')}
                  </p>
                )}
              </div>
            ) : (
              visibleRoles.map((r) => {
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
                    {r?._custom && <span className={`text-[10px] ${nexsCx.text3}`}>(custom)</span>}
                  </label>
                )
              })
            )}
          </div>
        )}

        {lockedTargetRoles.length > 0 && (
          <div className="mb-4">
            <p className={`text-xs mb-1 ${nexsCx.text3}`}>
              Already assigned, outside your grant scope (kept on save):
            </p>
            <div className="flex flex-wrap gap-1.5">
              {lockedTargetRoles.map((r) => (
                <span
                  key={roleValue(r)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${nexsCx.border} ${nexsCx.bg3} ${nexsCx.text3}`}
                  title="You can't grant this role, but it will not be removed."
                >
                  {roleLabel(r)}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mb-3">
          <label className={`block text-xs font-medium mb-1 ${nexsCx.text2}`}>Employee codes (multiple)</label>
          <textarea
            rows={2}
            value={employeeCodesInput}
            onChange={(e) => setEmployeeCodesInput(e.target.value)}
            placeholder="116970, THRS208102TFR"
            className={nexsInputClass('w-full resize-y')}
          />
          <p className={`text-xs mt-1 ${nexsCx.text3}`}>
            Use comma, space, or new line. Existing or new employees both work — names are auto-resolved from HR data; new users are created on save.
          </p>
          {employeeCodes.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {employeeCodes.map((code) => {
                const entry = employeeRecords[code]
                const emp = entry?.employee
                const isLoading = !entry || entry.status === 'loading'
                const failed = entry?.status === 'done' && !emp
                return (
                  <div
                    key={code}
                    className={`flex items-start justify-between gap-2 rounded-lg px-2.5 py-1.5 border ${nexsCx.border} ${nexsCx.bg3}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm flex items-baseline gap-1.5 ${nexsCx.text}`}>
                        <span className="font-mono">{code}</span>
                        {isLoading && <span className={`text-[10px] ${nexsCx.text3}`}>resolving…</span>}
                        {emp?.name && <span className={`text-xs ${nexsCx.text2}`}>· {emp.name}</span>}
                        {emp?.status && emp.status !== 'ACTIVE' && (
                          <span className="text-[10px] px-1 rounded" style={{ color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))' }}>{emp.status}</span>
                        )}
                        {failed && (
                          <span className="text-[10px]" style={{ color: 'var(--orange, #f59e0b)' }}>· will be created on save</span>
                        )}
                      </div>
                      {emp && (
                        <div className={`text-[11px] mt-0.5 ${nexsCx.text3}`}>
                          {[emp.designation, emp.department, emp.location].filter(Boolean).join(' · ')}
                          {emp.managerEmpCode && (
                            <> · mgr <span className="font-mono">{emp.managerEmpCode}</span></>
                          )}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className={`text-xs ${nexsCx.text3} hover:opacity-100 opacity-60`}
                      title="Remove"
                      onClick={() => {
                        const next = employeeCodes.filter((c) => c !== code).join(', ')
                        setEmployeeCodesInput(next)
                      }}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="mb-3">
          <label className={`block text-xs font-medium mb-1 ${nexsCx.text2}`}>Facilities (optional, multiple)</label>
          {availableFacilities.length > 0 ? (
            <div className="max-h-32 overflow-y-auto space-y-2 mb-2">
              {availableFacilities.map((name) => (
                <label
                  key={name}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer border ${nexsCx.border} ${nexsCx.bg3}`}
                >
                  <input
                    type="checkbox"
                    checked={facilities.includes(name)}
                    onChange={() => toggleFacility(name)}
                    className="rounded"
                  />
                  <span className={`text-sm ${nexsCx.text}`}>{name}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className={`text-xs mb-2 ${nexsCx.text3}`}>No facilities returned from auth service yet.</p>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={facilityInput}
              onChange={(e) => setFacilityInput(e.target.value)}
              placeholder="Facility name"
              className={nexsInputClass('flex-1')}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFacility() } }}
            />
            <button type="button" onClick={addFacility} className={nexsBtnGhost()}>Add</button>
          </div>
          {facilities.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {facilities.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`text-xs px-2 py-1 rounded-full border ${nexsCx.border}`}
                  onClick={() => setFacilities((prev) => prev.filter((x) => x !== f))}
                >
                  {f} ×
                </button>
              ))}
            </div>
          )}
        </div>

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
          <button type="button" onClick={handleSave} className={nexsBtnPrimary()} disabled={saving || loading || !employeeCodes.length}>
            {saving ? 'Saving…' : 'Save roles'}
          </button>
        </div>
      </div>
    </div>
  )
}
