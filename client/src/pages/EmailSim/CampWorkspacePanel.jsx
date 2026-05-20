/**
 * Campaign workspace — tabbed recipient import, compact audience pickers, sticky actions.
 */

import { useEffect, useState } from 'react'
import { ES_ACCENT, ES_RADIUS, ES_RADIUS_SM } from './emailSimTheme.js'

const gpTextArea = {
  marginTop: 6,
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 11px',
  fontSize: 12,
  fontFamily: 'var(--mono)',
  lineHeight: 1.45,
  borderRadius: ES_RADIUS_SM,
  border: '1px solid var(--border)',
  background: 'var(--bg3)',
  color: 'var(--text)',
  resize: 'vertical',
}

const gpSelect = {
  marginTop: 0,
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 11px',
  fontSize: 13,
  borderRadius: ES_RADIUS_SM,
  border: '1px solid var(--border)',
  background: 'var(--bg3)',
  color: 'var(--text)',
}

function BtnPrimary({ children, style, ...props }) {
  return (
    <button type={props.type || 'button'} {...props} className="es-btn-primary" style={style}>
      {children}
    </button>
  )
}

function BtnSecondary({ children, style, ...props }) {
  return (
    <button {...props} className="es-btn-secondary" style={style}>
      {children}
    </button>
  )
}

function StatusBadge({ status }) {
  const s = String(status || 'draft').toLowerCase()
  const cls =
    s === 'completed'
      ? 'es-badge-completed'
      : s === 'launched'
        ? 'es-badge-launched'
        : s === 'scheduled'
          ? 'es-badge-scheduled'
          : 'es-badge-draft'
  return <span className={`es-badge ${cls}`}>{s}</span>
}

function WorkspaceTabs({ value, onChange, tabs }) {
  return (
    <div role="tablist" className="es-ws-tabs">
      {tabs.map((t) => {
        const active = value === t.id
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            className={`es-ws-tab${active ? ' es-ws-tab-active' : ''}`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function SubCard({ title, action, children }) {
  return (
    <div className="es-subcard">
      {(title || action) && (
        <div className="es-subcard-head">
          {title ? <span className="es-subcard-title">{title}</span> : <span />}
          {action}
        </div>
      )}
      <div className="es-subcard-body">{children}</div>
    </div>
  )
}

function CompactPicker({
  title,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  disabled,
  loading,
  emptyMessage,
  items,
  renderRow,
  page,
  pageSize,
  total,
  onPrev,
  onNext,
  toolbar,
}) {
  return (
    <SubCard title={title} action={toolbar}>
      <input
        type="search"
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={searchPlaceholder}
        disabled={disabled}
        autoComplete="off"
        style={{ ...gpSelect, marginBottom: 10 }}
      />
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: ES_RADIUS_SM,
          background: 'var(--bg2)',
          maxHeight: 280,
          overflow: 'auto',
        }}
      >
        {loading ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--text3)' }}>Loading…</div>
        ) : !items.length ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--text3)' }}>{emptyMessage}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>{items.map(renderRow)}</div>
        )}
      </div>
      <PickerPagination page={page} pageSize={pageSize} total={total} disabled={disabled || loading} onPrev={onPrev} onNext={onNext} />
    </SubCard>
  )
}

function PickerPagination({ page, pageSize, total, disabled, onPrev, onNext }) {
  const n = typeof total === 'number' ? total : 0
  const totalPages = Math.max(1, Math.ceil(n / pageSize) || 1)
  const from = n === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(n, page * pageSize)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 10,
        gap: 8,
        fontSize: 12,
        color: 'var(--text3)',
      }}
    >
      <span>
        {n === 0 ? '0 items' : `${from}–${to} of ${n}`}
      </span>
      <span style={{ display: 'flex', gap: 6 }}>
        <BtnSecondary type="button" disabled={disabled || page <= 1} onClick={onPrev}>
          Prev
        </BtnSecondary>
        <BtnSecondary type="button" disabled={disabled || page >= totalPages} onClick={onNext}>
          Next
        </BtnSecondary>
      </span>
    </div>
  )
}

function PickerRow({ checked, disabled, onToggle, primary, secondary }) {
  return (
    <label
      className={`es-picker-row${checked ? ' es-picker-checked' : ''}`}
      style={{
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{primary}</span>
        {secondary != null && secondary !== '' ? (
          <span style={{ display: 'block', fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{secondary}</span>
        ) : null}
      </span>
    </label>
  )
}

export default function CampWorkspacePanel({
  campDetail,
  write,
  draftCampaign,
  audiencePickerDisabled,
  campWorkspaceUrls,
  setCampWorkspaceUrls,
  onSaveCampaignUrls,
  injectMode,
  setInjectMode,
  injectCsv,
  setInjectCsv,
  injectJson,
  setInjectJson,
  onInject,
  CsvFileUpload,
  fromSourcesGroupIds,
  setFromSourcesGroupIds,
  fromSourcesContactIds,
  setFromSourcesContactIds,
  campGroupSearchIn,
  setCampGroupSearchIn,
  campContactSearchIn,
  setCampContactSearchIn,
  campGroupsLib,
  campContactsLib,
  campGroupPage,
  setCampGroupPage,
  campContactPage,
  setCampContactPage,
  campGroupSearchQ,
  campContactSearchQ,
  campGroupPageSize,
  campContactPageSize,
  selectAllCampGroupsPage,
  clearCampGroupsPageSelection,
  selectAllCampContactsPage,
  clearCampContactsPageSelection,
  onAddFromSources,
  recipientBulk,
  setRecipientBulk,
  onAddRecipients,
  onLaunch,
  onDeleteCampaign,
  toggleStringId,
  sid,
}) {
  const [tab, setTab] = useState('library')
  useEffect(() => {
    if (!draftCampaign && tab === 'links') setTab('library')
  }, [draftCampaign, tab])
  const campaign = campDetail?.campaign
  const recipientCount = campDetail?.recipients?.length ?? 0
  const canEdit = write && draftCampaign

  const workspaceTabs = [
    { id: 'library', label: 'Groups & contacts' },
    { id: 'import', label: 'CSV / JSON' },
    { id: 'paste', label: 'Quick paste' },
    ...(draftCampaign ? [{ id: 'links', label: 'Links' }] : []),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 14,
          marginBottom: 20,
          padding: '14px 18px',
          borderRadius: ES_RADIUS,
          border: '1px solid var(--border)',
          background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, var(--bg2)) 0%, var(--bg2) 100%)',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <StatusBadge status={campaign?.status} />
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{campaign?.name}</span>
          <span
            style={{
              fontSize: 12,
              color: 'var(--text3)',
              padding: '4px 10px',
              borderRadius: 999,
              border: '1px solid var(--border)',
              background: 'var(--bg3)',
            }}
          >
            <strong style={{ color: 'var(--text)' }}>{recipientCount}</strong> recipient{recipientCount === 1 ? '' : 's'}
          </span>
          {campaign?.launchedAt && (
            <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
              Launched {new Date(campaign.launchedAt).toLocaleString()}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {canEdit && (
            <BtnPrimary type="button" onClick={onLaunch}>
              Launch campaign
            </BtnPrimary>
          )}
          {write && campaign && (
            <button
              type="button"
              onClick={onDeleteCampaign}
              style={{
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: 600,
                borderRadius: ES_RADIUS_SM,
                border: '1px solid color-mix(in srgb, var(--red) 40%, var(--border))',
                background: 'transparent',
                color: 'var(--red)',
                cursor: 'pointer',
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {!draftCampaign && (
        <div
          style={{
            marginBottom: 16,
            padding: '10px 14px',
            borderRadius: ES_RADIUS_SM,
            border: '1px solid color-mix(in srgb, var(--amber) 40%, var(--border))',
            background: 'color-mix(in srgb, var(--amber) 10%, transparent)',
            fontSize: 13,
            color: 'var(--text2)',
          }}
        >
          <strong style={{ color: 'var(--amber)' }}>Launched.</strong> Recipient list is read-only. Duplicate the campaign as draft to add more targets.
        </div>
      )}

      <WorkspaceTabs value={tab} onChange={setTab} tabs={workspaceTabs} />

      {tab === 'library' && (
        <form onSubmit={onAddFromSources}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 16,
              marginBottom: 16,
            }}
          >
            <CompactPicker
              title="Groups"
              searchValue={campGroupSearchIn}
              onSearchChange={setCampGroupSearchIn}
              searchPlaceholder="Search groups…"
              disabled={audiencePickerDisabled}
              loading={campGroupsLib.loading}
              emptyMessage={campGroupSearchQ ? `No match for “${campGroupSearchQ}”.` : 'No groups yet.'}
              items={campGroupsLib.items}
              page={campGroupPage}
              pageSize={campGroupPageSize}
              total={campGroupsLib.total}
              onPrev={() => setCampGroupPage((p) => Math.max(1, p - 1))}
              onNext={() => setCampGroupPage((p) => p + 1)}
              toolbar={
                <span style={{ display: 'flex', gap: 6 }}>
                  <BtnSecondary type="button" disabled={audiencePickerDisabled || !campGroupsLib.items.length} onClick={selectAllCampGroupsPage}>
                    All
                  </BtnSecondary>
                  <BtnSecondary type="button" disabled={audiencePickerDisabled || !campGroupsLib.items.length} onClick={clearCampGroupsPageSelection}>
                    Clear
                  </BtnSecondary>
                </span>
              }
              renderRow={(g) => (
                <PickerRow
                  key={sid(g._id)}
                  checked={fromSourcesGroupIds.some((x) => sid(x) === sid(g._id))}
                  disabled={audiencePickerDisabled}
                  onToggle={() => setFromSourcesGroupIds((prev) => toggleStringId(prev, g._id))}
                  primary={g.name}
                  secondary={`${g.memberCount ?? 0} members`}
                />
              )}
            />
            <CompactPicker
              title="Saved contacts"
              searchValue={campContactSearchIn}
              onSearchChange={setCampContactSearchIn}
              searchPlaceholder="Search email…"
              disabled={audiencePickerDisabled}
              loading={campContactsLib.loading}
              emptyMessage={campContactSearchQ ? `No match for “${campContactSearchQ}”.` : 'No contacts yet.'}
              items={campContactsLib.items}
              page={campContactPage}
              pageSize={campContactPageSize}
              total={campContactsLib.total}
              onPrev={() => setCampContactPage((p) => Math.max(1, p - 1))}
              onNext={() => setCampContactPage((p) => p + 1)}
              toolbar={
                <span style={{ display: 'flex', gap: 6 }}>
                  <BtnSecondary type="button" disabled={audiencePickerDisabled || !campContactsLib.items.length} onClick={selectAllCampContactsPage}>
                    All
                  </BtnSecondary>
                  <BtnSecondary type="button" disabled={audiencePickerDisabled || !campContactsLib.items.length} onClick={clearCampContactsPageSelection}>
                    Clear
                  </BtnSecondary>
                </span>
              }
              renderRow={(c) => (
                <PickerRow
                  key={sid(c._id)}
                  checked={fromSourcesContactIds.some((x) => sid(x) === sid(c._id))}
                  disabled={audiencePickerDisabled}
                  onToggle={() => setFromSourcesContactIds((prev) => toggleStringId(prev, c._id))}
                  primary={c.email}
                />
              )}
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--text3)' }}>
              Selected: <strong style={{ color: 'var(--text)' }}>{fromSourcesGroupIds.length}</strong> groups ·{' '}
              <strong style={{ color: 'var(--text)' }}>{fromSourcesContactIds.length}</strong> contacts
            </span>
            <BtnPrimary type="submit" disabled={audiencePickerDisabled}>
              Add to campaign
            </BtnPrimary>
          </div>
        </form>
      )}

      {tab === 'import' && (
        <SubCard title="Import from file">
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {['csv', 'json'].map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setInjectMode(mode)}
                disabled={!canEdit}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: 700,
                  borderRadius: 6,
                  border: `1px solid ${injectMode === mode ? ES_ACCENT : 'var(--border)'}`,
                  background: injectMode === mode ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'var(--bg3)',
                  color: 'var(--text)',
                  cursor: canEdit ? 'pointer' : 'not-allowed',
                  textTransform: 'uppercase',
                }}
              >
                {mode}
              </button>
            ))}
          </div>
          <form onSubmit={onInject}>
            {injectMode === 'csv' ? (
              <>
                <div style={{ marginBottom: 10 }}>
                  <CsvFileUpload disabled={!canEdit} onLoad={setInjectCsv} label="Upload CSV" />
                </div>
                <textarea value={injectCsv} disabled={!canEdit} onChange={(e) => setInjectCsv(e.target.value)} rows={7} style={gpTextArea} />
              </>
            ) : (
              <textarea value={injectJson} disabled={!canEdit} onChange={(e) => setInjectJson(e.target.value)} rows={9} style={gpTextArea} />
            )}
            <div style={{ marginTop: 14 }}>
              <BtnPrimary type="submit" disabled={!canEdit}>
                Import targets
              </BtnPrimary>
            </div>
          </form>
        </SubCard>
      )}

      {tab === 'paste' && (
        <SubCard title="Paste email addresses">
          <form onSubmit={onAddRecipients}>
            <textarea
              value={recipientBulk}
              disabled={!canEdit}
              onChange={(e) => setRecipientBulk(e.target.value)}
              rows={6}
              style={gpTextArea}
              placeholder={'user@company.com\nother@company.com'}
            />
            <div style={{ marginTop: 14 }}>
              <BtnPrimary type="submit" disabled={!canEdit}>
                Add emails
              </BtnPrimary>
            </div>
          </form>
        </SubCard>
      )}

      {tab === 'links' && draftCampaign && (
        <SubCard title="Template links">
          <form onSubmit={onSaveCampaignUrls}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', display: 'block' }}>
                Tracking URL
                <input
                  type="url"
                  value={campWorkspaceUrls.trackingUrl}
                  disabled={!write}
                  onChange={(e) => setCampWorkspaceUrls((u) => ({ ...u, trackingUrl: e.target.value }))}
                  placeholder="https://…"
                  style={{ ...gpSelect, display: 'block', marginTop: 6 }}
                />
              </label>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', display: 'block' }}>
                Other URL
                <input
                  type="url"
                  value={campWorkspaceUrls.otherUrl}
                  disabled={!write}
                  onChange={(e) => setCampWorkspaceUrls((u) => ({ ...u, otherUrl: e.target.value }))}
                  placeholder="https://…"
                  style={{ ...gpSelect, display: 'block', marginTop: 6 }}
                />
              </label>
            </div>
            <div style={{ marginTop: 14 }}>
              <BtnSecondary type="submit" disabled={!write}>
                Save links
              </BtnSecondary>
            </div>
          </form>
        </SubCard>
      )}

      {/* Recipients table — always visible */}
      <SubCard
        title="Recipients on this campaign"
        action={
          recipientCount > 0 ? (
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>{recipientCount} total</span>
          ) : null
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'color-mix(in srgb, var(--bg4) 50%, transparent)' }}>
                <th style={{ textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase' }}>
                  Email
                </th>
                <th style={{ textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase' }}>
                  Status
                </th>
                <th style={{ textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase' }}>
                  Events
                </th>
              </tr>
            </thead>
            <tbody>
              {!recipientCount ? (
                <tr>
                  <td colSpan={3} style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                    No recipients yet — use a tab above to add targets.
                  </td>
                </tr>
              ) : (
                campDetail.recipients.map((r) => (
                  <tr key={r._id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: 12 }}>{r.email}</td>
                    <td style={{ padding: '10px 12px', textTransform: 'capitalize', fontSize: 12 }}>{r.status}</td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text3)' }}>
                      {(r.events || []).map((e) => e.type).join(' · ') || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SubCard>
    </div>
  )
}
