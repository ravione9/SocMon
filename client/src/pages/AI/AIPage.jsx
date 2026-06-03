import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { aiAPI } from '../../api/ai.js'
import { useUrlTab } from '../../hooks/useUrlTab.js'
import { useAuthStore } from '../../store/authStore.js'
import {
  createChatSession,
  defaultWelcomeMessages,
  deleteChatSession,
  deriveSessionTitle,
  formatSessionWhen,
  hasUserMessages,
  loadChatSessions,
  persistSessionInList,
  saveChatSessions,
  adjustSessionPending,
  getSessionPendingCount,
  addInflightRequest,
  removeInflightRequest,
  loadInflightRequests,
  sessionHasAssistantForReq,
} from '../../utils/aiChatHistory.js'
import { shouldStartNewThreadForQuestion } from '../../utils/aiChatSubject.js'
import AiMessageContent from '../../components/ai/AiMessageContent.jsx'
import './AIPage.css'

function insertAfterUserReq(messages, reqId, msg) {
  const idx = (messages || []).findIndex(m => m.reqId === reqId && m.role === 'user')
  if (idx === -1) return [...(messages || []), msg]
  const out = [...messages]
  out.splice(idx + 1, 0, msg)
  return out
}

const TABS = [
  { id: 'chat', label: 'Chat' },
  { id: 'search', label: 'Log search' },
  { id: 'anomalies', label: 'Anomalies' },
  { id: 'triage', label: 'Alert triage' },
]

const C = {
  text: 'var(--text)',
  text2: 'var(--text2)',
  text3: 'var(--text3)',
  bg2: 'var(--bg2)',
  bg3: 'var(--bg3)',
  border: 'var(--border)',
  accent: 'var(--accent)',
  green: 'var(--green)',
  amber: 'var(--amber)',
  red: 'var(--red)',
}

const PAGE_ROOT = {
  width: '100%',
  boxSizing: 'border-box',
  flex: 1,
  minHeight: 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const STARTER_PROMPTS = {
  monitor: [
    'Give me a store monitor summary — online, offline, and stores with issues.',
    'How many firewall denies in the last hour?',
    'Sentinel xdr failed login on server machines last 1 hour',
    'Sentinel xdr connections to china last 12 hours',
    'Disk usage report for lenskart-database group',
  ],
  details: [
    'Give me complete details of RP4531-E521BCXS last 6 hours',
    'Full hostname report for RP4430 with Sentinel, SOC, and NOC data',
    'Show metrics chart for RP4139-E528B7N1 last 24 hours',
  ],
  rca: [
    'Why is RP4531-E521BCXS offline? Root cause last 6 hours',
    'Investigate connectivity issues on RP4430 — correlate all signals',
    'What caused USB disconnections on RP4139? RCA last 1 hour',
  ],
  agent: [
    'Disk usage report for lenskart-database group — which servers need attention first?',
    'How many stores are offline and list their hostnames',
    'Switch status and ping summary — highlight any unreachable devices',
    'Sentinel xdr suspicious powershell process creation last 6 hours',
    'Connections from India in last 24 hours — summarize by FortiGate device',
    'Complete environment report for RP4531-E521BCXS with recommendations',
  ],
}

const CHAT_MODES = [
  { id: 'monitor', label: 'Monitor', hint: 'Fast live counts, summaries, and alerts' },
  { id: 'agent', label: 'Agent', hint: 'LLM + live tools — natural language with recommendations' },
  { id: 'details', label: 'Details', hint: 'Deep hostname / store reports with all environments' },
  { id: 'rca', label: 'RCA', hint: 'Root cause analysis with correlated timeline' },
]

function formatPortalTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  })
}

function formatMetricNum(v) {
  if (v == null || Number.isNaN(Number(v))) return '—'
  const n = Number(v)
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function Sparkline({ values, color = C.accent }) {
  if (!values?.length) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const w = 280
  const h = 40
  const pad = 3
  const coords = values.map((v, i) => {
    const x = pad + (i / Math.max(values.length - 1, 1)) * (w - pad * 2)
    const y = max === min
      ? h / 2
      : pad + (1 - (v - min) / (max - min)) * (h - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const area = `${pad},${h - pad} ${coords.join(' ')} ${w - pad},${h - pad}`
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ display: 'block', borderRadius: 4 }}
      aria-hidden
    >
      <polygon points={area} fill={`${color}22`} />
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        points={coords.join(' ')}
      />
    </svg>
  )
}

function MetricChartsPanel({ series = [] }) {
  if (!series.length) return null
  const colors = [C.accent, C.green, C.amber, '#a78bfa', '#38bdf8', '#fb7185', '#fbbf24', '#34d399']
  return (
    <div style={{ marginTop: 12, width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {series.map((s, i) => (
        <div
          key={s.id || s.name}
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            background: C.bg2,
            border: `1px solid ${C.border}`,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: C.text2 }}>{s.label || s.name}</span>
            <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: C.text3, whiteSpace: 'nowrap' }}>
              latest {formatMetricNum(s.latest)} · min {formatMetricNum(s.min)} · max {formatMetricNum(s.max)}
            </span>
          </div>
          <Sparkline values={s.values} color={colors[i % colors.length]} />
          <div style={{ marginTop: 4, fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
            {s.samples ?? s.values?.length ?? 0} samples
          </div>
        </div>
      ))}
    </div>
  )
}

function FreshnessBadge({ freshness }) {
  const live = freshness === 'live'
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 6,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: 'var(--mono)',
        background: live ? 'rgba(34,211,160,.15)' : 'rgba(245,166,35,.15)',
        color: live ? C.green : C.amber,
        border: `1px solid ${live ? 'rgba(34,211,160,.35)' : 'rgba(245,166,35,.35)'}`,
      }}
    >
      {live ? 'LIVE' : 'PERIODIC'}
    </span>
  )
}

function ConfigTable({ title, rows, columns = ['label', 'value'] }) {
  if (!rows?.length) return null
  const colA = columns[0] === 'what' ? 'what' : 'label'
  const colB = columns[1] === 'detail' ? 'detail' : 'value'
  return (
    <div style={{ marginTop: title ? 10 : 0 }}>
      {title && (
        <div style={{ fontSize: 10, fontWeight: 700, color: C.text2, marginBottom: 6, fontFamily: 'var(--mono)' }}>
          {title}
        </div>
      )}
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 11,
          fontFamily: 'var(--mono)',
          lineHeight: 1.45,
        }}
      >
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.key || row.what || i} style={{ borderTop: i ? `1px solid ${C.border}` : undefined }}>
              <td
                style={{
                  padding: '8px 10px 8px 0',
                  color: C.text3,
                  verticalAlign: 'top',
                  width: '38%',
                  fontWeight: 600,
                }}
              >
                {row[colA]}
              </td>
              <td
                style={{
                  padding: '8px 0',
                  color: row.ok === false ? C.red : row.ok === true ? C.green : C.text2,
                  verticalAlign: 'top',
                  wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {row[colB]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AiErrorPanel({ detail }) {
  if (!detail?.errorTable?.length) return null
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        background: 'rgba(248,113,113,.08)',
        border: `1px solid ${C.red}`,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: C.red, marginBottom: 10 }}>{detail.error}</div>
      <ConfigTable rows={detail.errorTable} columns={['what', 'detail']} />
      {detail.providerStatus?.rows?.length > 0 && (
        <ConfigTable title="Server configuration" rows={detail.providerStatus.rows} />
      )}
    </div>
  )
}

function ProviderStatusBanner({ status, onSwitchOllama, switching }) {
  if (!status) return null
  const ollamaRow = status.rows?.find((r) => r.key === 'ollama')
  const claudeRow = status.rows?.find((r) => r.key === 'claude')
  const geminiRow = status.rows?.find((r) => r.key === 'gemini')
  const openaiRow = status.rows?.find((r) => r.key === 'openai')
  const activeRow = status.rows?.find((r) => r.key === 'active')
  const cloudKeyMissing =
    (status.active === 'claude' && !claudeRow?.ok) ||
    (status.active === 'openai' && !openaiRow?.ok) ||
    (status.active === 'gemini' && !geminiRow?.ok)
  const needsAttention =
    !!status.hint ||
    !activeRow?.ok ||
    cloudKeyMissing ||
    (status.active === 'ollama' && !ollamaRow?.ok) ||
    (status.active !== 'ollama' && ollamaRow?.ok && cloudKeyMissing)
  if (!needsAttention) return null

  return (
    <div
      style={{
        flexShrink: 0,
        padding: '12px 14px',
        borderRadius: 10,
        border: `1px solid ${C.amber}`,
        background: 'rgba(245,166,35,.08)',
        marginBottom: 10,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: C.amber, marginBottom: 8 }}>LLM provider setup</div>
      {status.hint && (
        <p style={{ margin: '0 0 10px', fontSize: 11, color: C.text2, lineHeight: 1.5 }}>{status.hint}</p>
      )}
      <ConfigTable rows={status.rows} />
      {ollamaRow?.ok && status.active !== 'ollama' && onSwitchOllama && (
        <button
          type="button"
          disabled={switching}
          onClick={onSwitchOllama}
          style={{
            marginTop: 10,
            padding: '8px 14px',
            borderRadius: 8,
            border: 'none',
            background: C.accent,
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            fontFamily: 'var(--mono)',
            cursor: switching ? 'wait' : 'pointer',
          }}
        >
          {switching ? 'Switching…' : 'Use Ollama now'}
        </button>
      )}
    </div>
  )
}

function ContextMetaPanel({ meta = [], fastPath, preview, metrics, queryContext }) {
  const [open, setOpen] = useState(false)
  if (!meta?.length && !fastPath && !preview && !metrics && !queryContext) return null
  const summaryBits = [
    metrics?.mode && `mode=${metrics.mode}`,
    metrics?.totalMs != null && `${metrics.totalMs}ms`,
    queryContext?.topic && `topic=${queryContext.topic}`,
    meta.length && `${meta.length} source${meta.length === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ')

  return (
    <div
      style={{
        marginTop: 8,
        borderRadius: 8,
        background: 'rgba(79,126,245,.06)',
        border: `1px solid ${C.border}`,
        fontSize: 10,
        color: C.text3,
        fontFamily: 'var(--mono)',
        lineHeight: 1.6,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 10px',
          border: 'none',
          background: 'transparent',
          color: C.text2,
          fontSize: 10,
          fontFamily: 'var(--mono)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontWeight: 700 }}>
          {fastPath ? 'Live data' : 'Sources'}
          {summaryBits ? ` · ${summaryBits}` : ''}
        </span>
        <span style={{ color: C.text3 }}>{open ? '▲ hide' : '▼ details'}</span>
      </button>
      {!open ? null : (
      <div style={{ padding: '0 10px 8px' }}>
      <div style={{ fontWeight: 700, color: C.text2, marginBottom: 4 }}>
        {fastPath
          ? (metrics?.mode === 'direct-rca'
            ? 'Root cause analysis from correlated live data'
            : metrics?.mode === 'direct-crash'
            ? 'Instant crash answer from live Influx data'
            : metrics?.mode === 'direct-hostname'
              ? 'Instant hostname report from live store data'
              : metrics?.mode === 'direct-xdr'
              ? 'Instant XDR answer from live SentinelOne PowerQuery'
              : 'Instant answer from live SocMon data')
          : metrics?.mode === 'agent'
            ? 'Agent — LLM called live portal tools'
            : 'Data sources for this reply'}
      </div>
      {queryContext?.toolsUsed?.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          Tools: {queryContext.toolsUsed.map(t => `${t.name}${t.ok ? '' : ' (failed)'}`).join(' · ')}
        </div>
      )}
      {metrics && (
        <div style={{ marginBottom: 6 }}>
          mode={metrics.mode || 'llm'} · total={metrics.totalMs}ms · context={metrics.contextMs}ms · llm={metrics.llmMs}ms
        </div>
      )}
      {queryContext && (
        <div style={{ marginBottom: 6, color: C.text2 }}>
          topic={queryContext.topic || 'general'}
          {queryContext.hostname ? ` · host=${queryContext.hostname}` : ''}
          {queryContext.appName ? ` · app=${queryContext.appName}` : ''}
          {queryContext.isFollowUp ? ' · follow-up' : ''}
        </div>
      )}
      {meta.map(m => (
        <div key={m.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <FreshnessBadge freshness={m.freshness} />
          <span style={{ color: C.text2 }}>{m.label}</span>
          {m.fetchedAt && <span>· fetched {formatPortalTime(m.fetchedAt)}</span>}
          {m.snapshotIntervalMinutes && <span>· snap every {m.snapshotIntervalMinutes}m</span>}
          {m.error && <span style={{ color: C.red }}>· {m.error}</span>}
        </div>
      ))}
      {preview?.storeMonitor && (
        <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
          <div style={{ color: C.text2, marginBottom: 2 }}>
            Store Monitor: total {preview.storeMonitor.total} · online {preview.storeMonitor.online} · offline {preview.storeMonitor.offline} · issues {preview.storeMonitor.withIssues}
          </div>
          {(preview.storeMonitor.offlineHostnames || []).slice(0, 5).map((h) => (
            <div key={`${h.storeTag}-${h.hostname}`} style={{ marginLeft: 4 }}>
              • {h.hostname || h.storeTag} [{h.storeTag}] · {h.connState}
            </div>
          ))}
        </div>
      )}
      {preview?.crashes && (
        <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
          <div style={{ color: C.text2, marginBottom: 2 }}>
            Crashes ({preview.crashes.range}{preview.crashes.appFilter ? ` · ${preview.crashes.appFilter}` : ''}): {preview.crashes.totalEvents} events
            {preview.crashes.affectedStores != null ? ` · ${preview.crashes.affectedStores} stores` : ''}
            {preview.crashes.eventLog ? ` · event log (${preview.crashes.eventsShown ?? 0} shown)` : ''}
          </div>
          {(preview.crashes.affectedStoreList || []).slice(0, 5).map((s) => (
            <div key={`${s.storeTag}-${s.hostname}`} style={{ marginLeft: 4 }}>
              • {s.hostname || s.storeTag} [{s.storeTag}]: {s.totalCrashes}
            </div>
          ))}
          {(preview.crashes.topApps || []).slice(0, 3).map((a) => (
            <div key={a.appName} style={{ marginLeft: 4 }}>
              • {a.appName}: {a.totalCrashes}
            </div>
          ))}
        </div>
      )}
      {preview?.xdr && (
        <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
          <div style={{ color: C.text2, marginBottom: 2 }}>
            XDR ({preview.xdr.range}): {preview.xdr.totalEvents} events · {preview.xdr.rowCount} rows shown
          </div>
          {(preview.xdr.topEndpoints || []).slice(0, 3).map((e) => (
            <div key={e.key} style={{ marginLeft: 4 }}>
              • {e.key}: {e.count}
            </div>
          ))}
        </div>
      )}
      {preview?.rca && (
        <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
          <div style={{ color: C.text2 }}>
            RCA{preview.rca.window ? ` ${preview.rca.window}` : ''}
            {preview.rca.anchor ? ` · ${preview.rca.anchor}` : ''}
            {preview.rca.timelineEvents != null ? ` · ${preview.rca.timelineEvents} events` : ''}
            {preview.rca.topHypothesis ? ` · ${preview.rca.topHypothesis} (${preview.rca.topConfidence})` : ''}
            {preview.rca.llmSynthesis ? ' · LLM narrative' : ''}
          </div>
        </div>
      )}
      {preview?.noc && (
        <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
          <div style={{ color: C.text2 }}>
            NOC{preview.noc.window ? ` ${preview.noc.window}` : ''}: {preview.noc.total ?? 0} events
            {preview.noc.updown != null ? ` · UPDOWN ${preview.noc.updown}` : ''}
            {preview.noc.usbDisconnect != null ? ` · USB ↓${preview.noc.usbDisconnect}` : ''}
            {preview.noc.rpGroupOnly ? ' · RP Group' : ''}
          </div>
        </div>
      )}
      {preview?.sentinel && (
        <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
          <div style={{ color: C.text2 }}>
            Sentinel: USB ↑{preview.sentinel.usbConnected} ↓{preview.sentinel.usbDisconnected} · threats {preview.sentinel.threats}
          </div>
        </div>
      )}
      {preview?.soc && (
        <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
          <div style={{ color: C.text2 }}>
            SOC{preview.soc.window ? ` ${preview.soc.window}` : ''}: {(preview.soc.total ?? preview.soc.totalEvents ?? 0)} events · denies {preview.soc.denies ?? 0}
            {preview.soc.allows != null ? ` · allows ${preview.soc.allows}` : ''}
          </div>
        </div>
      )}
      </div>
      )}
    </div>
  )
}

function DataSourcesPanel({ modules, enabled, onToggle, autoModules, onAutoToggle, collapsed, onToggleCollapsed }) {
  if (!modules.length) return null

  if (collapsed) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="Show data source toggles"
          style={{
            padding: '5px 10px',
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            background: C.bg3,
            color: C.text2,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Sources {enabled.length}/{modules.length} ▾
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.text3, cursor: 'pointer' }}>
          <input type="checkbox" checked={autoModules} onChange={e => onAutoToggle(e.target.checked)} />
          Auto-detect
        </label>
      </div>
    )
  }

  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        background: C.bg2,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <button
          type="button"
          onClick={onToggleCollapsed}
          style={{
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: C.text,
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Data sources ▴
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.text3, cursor: 'pointer' }}>
          <input type="checkbox" checked={autoModules} onChange={e => onAutoToggle(e.target.checked)} />
          Auto-detect from question
        </label>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {modules.map(m => {
          const on = enabled.includes(m.id)
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onToggle(m.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                borderRadius: 8,
                border: `1px solid ${on ? C.accent : C.border}`,
                background: on ? 'rgba(79,126,245,.12)' : C.bg3,
                color: on ? C.accent : C.text3,
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              <FreshnessBadge freshness={m.freshness} />
              {m.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TabBar({ tab, setTab, compact = false }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: compact ? 0 : 10, flexShrink: 0 }}>
      {TABS.map(t => (
        <button
          key={t.id}
          type="button"
          onClick={() => setTab(t.id)}
          style={{
            padding: compact ? '6px 12px' : '8px 14px',
            borderRadius: 8,
            border: `1px solid ${tab === t.id ? C.accent : C.border}`,
            background: tab === t.id ? 'rgba(79,126,245,.12)' : C.bg3,
            color: tab === t.id ? C.accent : C.text2,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'var(--mono)',
            cursor: 'pointer',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function ChatModeBar({ mode, onModeChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {CHAT_MODES.map(m => (
        <button
          key={m.id}
          type="button"
          title={m.hint}
          onClick={() => onModeChange(m.id)}
          style={{
            padding: '5px 10px',
            borderRadius: 8,
            border: `1px solid ${mode === m.id ? C.accent : C.border}`,
            background: mode === m.id ? 'rgba(79,126,245,.12)' : C.bg3,
            color: mode === m.id ? C.accent : C.text2,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

function ChatHistorySidebar({
  sessions,
  activeId,
  onSelect,
  onNewChat,
  onDelete,
  collapsed,
  onToggleCollapsed,
}) {
  return (
    <div
      style={{
        width: collapsed ? 44 : 248,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRight: `1px solid ${C.border}`,
        background: C.bg3,
        transition: 'width 0.15s ease',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: collapsed ? '10px 6px' : '10px 10px',
          borderBottom: `1px solid ${C.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        {!collapsed && (
          <span style={{ flex: 1, fontSize: 11, fontWeight: 700, color: C.text2, fontFamily: 'var(--mono)' }}>
            Chat history
          </span>
        )}
        <button
          type="button"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapsed}
          style={{
            padding: '4px 8px',
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: C.bg2,
            color: C.text3,
            fontSize: 12,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {!collapsed && (
        <button
          type="button"
          onClick={onNewChat}
          style={{
            margin: '10px 10px 6px',
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px dashed ${C.accent}`,
            background: 'rgba(79,126,245,.08)',
            color: C.accent,
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
            textAlign: 'left',
            flexShrink: 0,
          }}
        >
          + New chat
        </button>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: collapsed ? '6px 4px' : '4px 8px 10px' }}>
        {sessions.map(s => {
          const active = s.id === activeId
          if (collapsed) {
            return (
              <button
                key={s.id}
                type="button"
                title={s.title}
                onClick={() => onSelect(s.id)}
                style={{
                  width: '100%',
                  marginBottom: 4,
                  padding: '6px 0',
                  borderRadius: 6,
                  border: `1px solid ${active ? C.accent : C.border}`,
                  background: active ? 'rgba(79,126,245,.2)' : C.bg2,
                  color: active ? C.accent : C.text3,
                  fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                ●
              </button>
            )
          }
          return (
            <div
              key={s.id}
              style={{
                display: 'flex',
                alignItems: 'stretch',
                gap: 4,
                marginBottom: 4,
              }}
            >
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: `1px solid ${active ? C.accent : C.border}`,
                  background: active ? 'rgba(79,126,245,.12)' : C.bg2,
                  color: C.text,
                  fontSize: 12,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div
                  style={{
                    fontWeight: active ? 700 : 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginBottom: 2,
                  }}
                >
                  {s.title || 'New chat'}
                </div>
                <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
                  {formatSessionWhen(s.updatedAt)}
                  {s.chatMode ? ` · ${s.chatMode}` : ''}
                </div>
              </button>
              <button
                type="button"
                title="Delete chat"
                onClick={e => {
                  e.stopPropagation()
                  onDelete(s.id)
                }}
                style={{
                  padding: '0 8px',
                  borderRadius: 8,
                  border: `1px solid ${C.border}`,
                  background: C.bg2,
                  color: C.text3,
                  fontSize: 14,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          )
        })}
        {!collapsed && sessions.length === 0 && (
          <div style={{ fontSize: 11, color: C.text3, padding: '8px 4px' }}>No saved chats yet.</div>
        )}
      </div>
    </div>
  )
}

function ChatTab({
  provider,
  model,
  providerStatus,
  onSwitchOllama,
  switchingProvider,
  availableModules,
  enabledModules,
  onToggleModule,
  autoModules,
  onAutoToggle,
}) {
  const user = useAuthStore(s => s.user)
  const userKey = user?.email || user?.id || 'anonymous'

  const [chatMode, setChatMode] = useState('monitor')
  const [messages, setMessages] = useState(defaultWelcomeMessages())
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [historyCollapsed, setHistoryCollapsed] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [loadingHint, setLoadingHint] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const bottomRef = useRef(null)
  const abortControllersRef = useRef(new Map())
  const userStopRequestedRef = useRef(false)
  const mountedRef = useRef(true)
  const resumeInflightRanRef = useRef(false)
  const skipPersistRef = useRef(false)
  const hydratedRef = useRef(false)
  const activeSessionIdRef = useRef(null)
  const sessionsRef = useRef([])
  const pendingBySessionRef = useRef(new Map())

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const buildSessionSnapshot = useCallback((id, msgs, mode, createdAt) => ({
    id,
    title: deriveSessionTitle(msgs),
    chatMode: mode,
    messages: msgs,
    updatedAt: new Date().toISOString(),
    createdAt: createdAt || new Date().toISOString(),
  }), [])

  const syncActiveLoading = useCallback(() => {
    const sid = activeSessionIdRef.current
    const n = sid ? getSessionPendingCount(sid) : 0
    setPendingCount(n)
    setLoading(n > 0)
  }, [])

  const trackSessionPending = useCallback((sessionId, delta) => {
    adjustSessionPending(sessionId, delta)
    pendingBySessionRef.current.set(sessionId, getSessionPendingCount(sessionId))
    if (sessionId === activeSessionIdRef.current) syncActiveLoading()
  }, [syncActiveLoading])

  /** Persist messages to session storage; survives navigation away from the AI page. */
  const commitSessionMessages = useCallback((sessionId, updater, modeOverride) => {
    const list = sessionsRef.current?.length
      ? sessionsRef.current
      : loadChatSessions(userKey)
    const existing = list.find(s => s.id === sessionId)
    const base = existing?.messages
      || (activeSessionIdRef.current === sessionId ? messages : null)
      || defaultWelcomeMessages()
    const nextMessages = typeof updater === 'function' ? updater(base) : updater
    const snapshot = buildSessionSnapshot(
      sessionId,
      nextMessages,
      modeOverride ?? existing?.chatMode ?? chatMode,
      existing?.createdAt,
    )
    const next = persistSessionInList(userKey, list, snapshot)
    sessionsRef.current = next
    if (mountedRef.current) {
      setSessions(next)
      if (activeSessionIdRef.current === sessionId) {
        setMessages(nextMessages)
      }
    }
    return nextMessages
  }, [buildSessionSnapshot, userKey, messages, chatMode])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId
    syncActiveLoading()
  }, [activeSessionId, syncActiveLoading])

  useEffect(() => {
    skipPersistRef.current = true
    resumeInflightRanRef.current = false
    setHydrated(false)
    const loaded = loadChatSessions(userKey)
    if (loaded.length) {
      const first = loaded[0]
      setSessions(loaded)
      sessionsRef.current = loaded
      activeSessionIdRef.current = first.id
      setActiveSessionId(first.id)
      setMessages(first.messages || defaultWelcomeMessages())
      setChatMode(first.chatMode || 'monitor')
    } else {
      const fresh = createChatSession({ chatMode: 'monitor' })
      setSessions([fresh])
      sessionsRef.current = [fresh]
      activeSessionIdRef.current = fresh.id
      setActiveSessionId(fresh.id)
      setMessages(fresh.messages)
      setChatMode(fresh.chatMode)
      saveChatSessions(userKey, [fresh])
    }
    hydratedRef.current = true
    setHydrated(true)
  }, [userKey])

  useEffect(() => {
    if (!hydratedRef.current || !activeSessionId || skipPersistRef.current) {
      skipPersistRef.current = false
      return
    }
    setSessions(prev => {
      const existing = prev.find(s => s.id === activeSessionId)
      const snapshot = buildSessionSnapshot(activeSessionId, messages, chatMode, existing?.createdAt)
      return persistSessionInList(userKey, prev, snapshot)
    })
  }, [messages, chatMode, activeSessionId, userKey, buildSessionSnapshot])

  const selectSession = useCallback((sessionId) => {
    if (sessionId === activeSessionId) return
    const target = sessions.find(s => s.id === sessionId)
    if (!target) return
    skipPersistRef.current = true
    activeSessionIdRef.current = sessionId
    setActiveSessionId(sessionId)
    setMessages(target.messages || defaultWelcomeMessages())
    setChatMode(target.chatMode || 'monitor')
    setInput('')
    syncActiveLoading()
  }, [activeSessionId, sessions, syncActiveLoading])

  const startNewChat = useCallback(() => {
    skipPersistRef.current = true
    const fresh = createChatSession({ chatMode })
    setSessions(prev => {
      const next = persistSessionInList(userKey, prev, fresh)
      sessionsRef.current = next
      return next
    })
    activeSessionIdRef.current = fresh.id
    setActiveSessionId(fresh.id)
    setMessages(fresh.messages)
    setInput('')
    syncActiveLoading()
  }, [chatMode, userKey, syncActiveLoading])

  const removeSession = useCallback((sessionId) => {
    const next = deleteChatSession(userKey, sessionId, sessions)
    if (sessionId === activeSessionId) {
      skipPersistRef.current = true
      if (next.length) {
        activeSessionIdRef.current = next[0].id
        setActiveSessionId(next[0].id)
        setMessages(next[0].messages || defaultWelcomeMessages())
        setChatMode(next[0].chatMode || 'monitor')
      } else {
        const fresh = createChatSession({ chatMode: 'monitor' })
        const saved = saveChatSessions(userKey, [fresh])
        sessionsRef.current = saved
        activeSessionIdRef.current = fresh.id
        setSessions(saved)
        setActiveSessionId(fresh.id)
        setMessages(fresh.messages)
        setChatMode(fresh.chatMode)
      }
      syncActiveLoading()
    } else {
      setSessions(next)
    }
  }, [activeSessionId, sessions, userKey, syncActiveLoading])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, pendingCount])

  const stop = useCallback(() => {
    userStopRequestedRef.current = true
    const entries = [...abortControllersRef.current.entries()]
    for (const [, controller] of entries) controller.abort()
    abortControllersRef.current.clear()
    for (const [reqId] of entries) {
      removeInflightRequest(userKey, reqId)
    }
    for (const sid of [...pendingBySessionRef.current.keys()]) {
      const n = getSessionPendingCount(sid)
      if (n > 0) adjustSessionPending(sid, -n)
    }
    pendingBySessionRef.current.clear()
    setPendingCount(0)
    setLoading(false)
    setLoadingHint('')
    window.setTimeout(() => { userStopRequestedRef.current = false }, 200)
  }, [userKey])

  const executeChatRequest = useCallback(async ({
    sessionId,
    reqId,
    history,
    modeAtSend,
    modulesAtSend,
    autoModulesAtSend,
    loadingHintText = '',
  }) => {
    trackSessionPending(sessionId, 1)
    if (loadingHintText) setLoadingHint(loadingHintText)

    addInflightRequest(userKey, {
      reqId,
      sessionId,
      modeAtSend,
      enabledModules: modulesAtSend,
      autoModules: autoModulesAtSend,
    })

    const controller = new AbortController()
    abortControllersRef.current.set(reqId, controller)

    try {
      const { data } = await aiAPI.chat(history, {
        modules: modulesAtSend,
        autoModules: autoModulesAtSend,
        mode: modeAtSend,
        signal: controller.signal,
      })
      removeInflightRequest(userKey, reqId)
      const assistantMsg = {
        role: 'assistant',
        content: data.content,
        contextMeta: data.contextMeta,
        contextPreview: data.contextPreview,
        queryContext: data.queryContext,
        chartSeries: data.chartSeries,
        metrics: data.metrics,
        fastPath: data.fastPath,
        reqId,
      }
      commitSessionMessages(
        sessionId,
        prev => insertAfterUserReq(prev, reqId, assistantMsg),
        modeAtSend,
      )
    } catch (err) {
      const cancelled = err.code === 'ERR_CANCELED' || err.name === 'CanceledError'
      if (cancelled) {
        removeInflightRequest(userKey, reqId)
        if (userStopRequestedRef.current) {
          commitSessionMessages(
            sessionId,
            prev => insertAfterUserReq(prev, reqId, { role: 'assistant', content: 'Stopped — request cancelled.', reqId }),
            modeAtSend,
          )
        }
        return
      }
      removeInflightRequest(userKey, reqId)
      const data = err.response?.data
      const errorDetail = data?.errorTable ? data : null
      const msg = data?.error || err.message || 'Chat failed'
      toast.error(msg)
      commitSessionMessages(
        sessionId,
        prev => insertAfterUserReq(prev, reqId, {
          role: 'assistant',
          content: errorDetail ? '' : `Error: ${msg}`,
          errorDetail,
          reqId,
        }),
        modeAtSend,
      )
    } finally {
      abortControllersRef.current.delete(reqId)
      trackSessionPending(sessionId, -1)
      if (getSessionPendingCount(sessionId) === 0 && activeSessionIdRef.current === sessionId) {
        setLoadingHint('')
      }
    }
  }, [userKey, commitSessionMessages, trackSessionPending])

  const send = useCallback(async (text) => {
    const content = String(text || input).trim()
    if (!content) return

    let sessionId = activeSessionIdRef.current
    if (!sessionId) return

    const existingSession = sessionsRef.current.find(s => s.id === sessionId)
    let baseMessages = (activeSessionIdRef.current === sessionId && messages?.length)
      ? messages
      : (existingSession?.messages || defaultWelcomeMessages())
    let modeAtSend = existingSession?.chatMode || chatMode

    if (shouldStartNewThreadForQuestion(content, baseMessages) && hasUserMessages(baseMessages)) {
      const fresh = createChatSession({ chatMode: modeAtSend })
      setSessions(prev => {
        const next = persistSessionInList(userKey, prev, fresh)
        sessionsRef.current = next
        return next
      })
      skipPersistRef.current = true
      sessionId = fresh.id
      activeSessionIdRef.current = fresh.id
      setActiveSessionId(fresh.id)
      baseMessages = fresh.messages
      modeAtSend = fresh.chatMode
      setMessages(fresh.messages)
      toast('New chat started — different device from the previous question.', { icon: '💬', duration: 3500 })
    }

    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const userMsg = { role: 'user', content, reqId }
    const next = [...baseMessages, userMsg]
    // Show the user's question immediately in the active pane (don't wait on session persist).
    if (activeSessionIdRef.current === sessionId) {
      skipPersistRef.current = true
      setMessages(next)
    }
    commitSessionMessages(sessionId, next, modeAtSend)
    setInput('')

    const qLower = content.toLowerCase()
    let hint = ''
    if (/\b(crash|crashed|crashes)\b/.test(qLower)) {
      hint = 'Fetching crash logs from Store Monitor…'
    } else if (/\b(issue|issues|top\s+\d+|store mon)\b/.test(qLower)) {
      hint = 'Fetching Store Monitor issues (live Influx)…'
    } else if (/\b(wifi|wi-?fi|rop|rp group)\b/.test(qLower)) {
      hint = 'Fetching Store Monitor Wi-Fi connectivity…'
    }

    const history = next.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({
      role: m.role,
      content: m.content,
    }))

    await executeChatRequest({
      sessionId,
      reqId,
      history,
      modeAtSend,
      modulesAtSend: enabledModules,
      autoModulesAtSend: autoModules,
      loadingHintText: hint,
    })
  }, [input, messages, enabledModules, autoModules, chatMode, userKey, commitSessionMessages, executeChatRequest])

  useEffect(() => {
    if (!hydrated || resumeInflightRanRef.current) return
    resumeInflightRanRef.current = true

    const jobs = loadInflightRequests(userKey)
    if (!jobs.length) return

    const sessions = loadChatSessions(userKey)
    let resumed = 0

    for (const job of jobs) {
      const session = sessions.find(s => s.id === job.sessionId)
      if (!session) {
        removeInflightRequest(userKey, job.reqId)
        continue
      }
      if (sessionHasAssistantForReq(session.messages, job.reqId)) {
        removeInflightRequest(userKey, job.reqId)
        continue
      }
      const userMsg = session.messages.find(m => m.role === 'user' && m.reqId === job.reqId)
      if (!userMsg) {
        removeInflightRequest(userKey, job.reqId)
        continue
      }

      const history = session.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }))

      resumed += 1
      void executeChatRequest({
        sessionId: job.sessionId,
        reqId: job.reqId,
        history,
        modeAtSend: job.modeAtSend || session.chatMode || 'monitor',
        modulesAtSend: job.enabledModules || enabledModules,
        autoModulesAtSend: job.autoModules ?? autoModules,
        loadingHintText: 'Resuming pending query after page reload…',
      })
    }

    if (resumed > 0) {
      toast(`Resuming ${resumed} pending ${resumed === 1 ? 'query' : 'queries'}…`, { icon: '⏳', duration: 4000 })
    }
  }, [hydrated, userKey, enabledModules, autoModules, executeChatRequest])

  const loadingLabel = loadingHint
    || (chatMode === 'agent'
      ? 'Agent selecting tools and fetching live data…'
      : chatMode === 'rca'
        ? 'Correlating signals across Store Monitor, Sentinel, SOC, NOC…'
        : chatMode === 'details'
          ? 'Fetching full hostname environment data…'
          : 'Fetching live portal data & thinking…')

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, overflow: 'hidden' }}>
      <ProviderStatusBanner
        status={providerStatus}
        onSwitchOllama={onSwitchOllama}
        switching={switchingProvider}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        <ChatModeBar mode={chatMode} onModeChange={setChatMode} />
        <DataSourcesPanel
          modules={availableModules}
          enabled={enabledModules}
          onToggle={onToggleModule}
          autoModules={autoModules}
          onAutoToggle={onAutoToggle}
          collapsed={!sourcesOpen}
          onToggleCollapsed={() => setSourcesOpen(v => !v)}
        />
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden', borderRadius: 12, border: `1px solid ${C.border}` }}>
        <ChatHistorySidebar
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={selectSession}
          onNewChat={startNewChat}
          onDelete={removeSession}
          collapsed={historyCollapsed}
          onToggleCollapsed={() => setHistoryCollapsed(v => !v)}
        />

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            minWidth: 0,
            background: C.bg2,
            overflow: 'hidden',
          }}
        >
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <div
          key={activeSessionId || 'none'}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {messages.map((m, i) => {
            const isUser = m.role === 'user'
            const isError = Boolean(m.errorDetail)
            const msgKey = m.reqId ? `${m.role}-${m.reqId}` : `${activeSessionId}-m${i}`
            return (
            <div
              key={msgKey}
              className={
                isError ? 'ai-msg-error'
                  : isUser ? 'ai-msg-user'
                    : 'ai-msg-assistant'
              }
              style={{
                alignSelf: isUser ? 'flex-end' : 'stretch',
                width: isUser ? 'auto' : '100%',
                maxWidth: isUser ? 'min(520px, 85%)' : '100%',
                minWidth: isUser ? 48 : undefined,
                padding: isUser ? '10px 14px' : '12px 14px',
                borderRadius: isUser ? 12 : 16,
                background: isUser
                  ? 'linear-gradient(135deg, rgba(79,126,245,.18), rgba(79,126,245,.08))'
                  : 'linear-gradient(180deg, var(--bg3) 0%, rgba(0,0,0,.08) 100%)',
                border: isUser
                  ? '1px solid rgba(79,126,245,.35)'
                  : '1px solid var(--border)',
                boxShadow: !isUser && !isError ? '0 4px 20px rgba(0,0,0,.12)' : 'none',
                fontSize: 13,
                lineHeight: 1.55,
                color: C.text,
                whiteSpace: isUser ? 'pre-wrap' : 'normal',
                wordBreak: 'break-word',
              }}
            >
              {isError ? (
                <AiErrorPanel detail={m.errorDetail} />
              ) : m.role === 'assistant' ? (
                <AiMessageContent content={m.content} contextPreview={m.contextPreview} />
              ) : (
                m.content
              )}
              {m.chartSeries?.length > 0 && <MetricChartsPanel series={m.chartSeries} />}
              {(m.contextMeta?.length > 0 || m.contextPreview || m.metrics || m.fastPath || m.queryContext) && (
                <ContextMetaPanel
                  meta={m.contextMeta || []}
                  fastPath={m.fastPath}
                  preview={m.contextPreview}
                  metrics={m.metrics}
                  queryContext={m.queryContext}
                />
              )}
            </div>
          )})}
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 2px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: C.text3, fontFamily: 'var(--mono)' }}>
                {pendingCount > 1 ? `${pendingCount} requests in flight — ` : ''}{loadingLabel}
              </span>
              <button
                type="button"
                onClick={stop}
                style={{
                  padding: '4px 12px',
                  borderRadius: 8,
                  border: `1px solid ${C.red}`,
                  background: 'rgba(248,113,113,.12)',
                  color: C.red,
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: 'var(--mono)',
                  cursor: 'pointer',
                }}
              >
                Stop
              </button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="ai-chat-input-dock">
          {messages.length <= 1 && !hasUserMessages(messages) && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, overflowX: 'auto', paddingBottom: 2 }}>
              {(STARTER_PROMPTS[chatMode] || STARTER_PROMPTS.monitor).map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => send(p)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: `1px solid ${C.border}`,
                    background: C.bg2,
                    color: C.text2,
                    fontSize: 11,
                    cursor: 'pointer',
                    textAlign: 'left',
                    flex: '0 0 auto',
                    maxWidth: 280,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={loading ? 'Another question can be sent while a request runs — Stop cancels all in flight' : 'Ask SocMon AI… (Enter to send, Shift+Enter for newline)'}
              rows={2}
              style={{
                flex: 1,
                resize: 'none',
                minHeight: 52,
                maxHeight: 120,
                padding: '10px 12px',
                borderRadius: 10,
                border: `1px solid ${C.border}`,
                background: C.bg2,
                color: C.text,
                fontSize: 13,
                fontFamily: 'var(--sans)',
                lineHeight: 1.45,
              }}
            />
            {loading ? (
              <button
                type="button"
                onClick={stop}
                style={{
                  minWidth: 92,
                  padding: '0 20px',
                  borderRadius: 10,
                  border: `1px solid ${C.red}`,
                  background: 'rgba(248,113,113,.15)',
                  color: C.red,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => send()}
                disabled={!input.trim()}
                style={{
                  minWidth: 92,
                  padding: '0 20px',
                  borderRadius: 10,
                  border: 'none',
                  background: C.accent,
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: !input.trim() ? 'not-allowed' : 'pointer',
                  opacity: !input.trim() ? 0.6 : 1,
                }}
              >
                Send
              </button>
            )}
          </div>

          <div style={{ marginTop: 6, fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', textAlign: 'center' }}>
            {provider ? `${provider}${model ? ` · ${model}` : ''}` : ''}
            {activeSessionId && sessions.length > 0 ? ` · ${sessions.length} saved chat${sessions.length !== 1 ? 's' : ''}` : ''}
          </div>
        </div>
      </div>
        </div>
      </div>
    </div>
  )
}

function LogSearchTab() {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)

  const run = async () => {
    const q = question.trim()
    if (!q) return
    setLoading(true)
    setResult(null)
    try {
      const { data } = await aiAPI.search(q)
      setResult(data)
      toast.success(`${data.total ?? 0} hits`)
    } catch (err) {
      toast.error(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 12, color: C.text3, lineHeight: 1.5 }}>
        <FreshnessBadge freshness="live" /> Natural language → Elasticsearch on{' '}
        <code style={{ fontFamily: 'var(--mono)' }}>firewall-*</code> and{' '}
        <code style={{ fontFamily: 'var(--mono)' }}>cisco-*</code> — queried live at search time.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && run()}
          placeholder='e.g. denied traffic from 10.1.2.3 in the last hour'
          style={{
            flex: '1 1 280px',
            padding: '10px 12px',
            borderRadius: 10,
            border: `1px solid ${C.border}`,
            background: C.bg3,
            color: C.text,
            fontSize: 13,
          }}
        />
        <button
          type="button"
          onClick={run}
          disabled={loading || !question.trim()}
          style={{
            padding: '10px 16px',
            borderRadius: 10,
            border: 'none',
            background: C.accent,
            color: '#fff',
            fontWeight: 700,
            fontSize: 12,
            cursor: 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      {result && (
        <>
          <div style={{ fontSize: 11, color: C.text3, fontFamily: 'var(--mono)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <FreshnessBadge freshness="live" />
            Index: {result.query?.index} · Total: {result.total}
            {result.fetchedAt && ` · ${new Date(result.fetchedAt).toLocaleTimeString()}`}
          </div>
          <pre
            style={{
              margin: 0,
              padding: 12,
              borderRadius: 10,
              background: C.bg2,
              border: `1px solid ${C.border}`,
              fontSize: 11,
              overflow: 'auto',
              maxHeight: 160,
              color: C.text2,
            }}
          >
            {JSON.stringify(result.query?.body, null, 2)}
          </pre>
          <div style={{ overflow: 'auto', maxHeight: 360, border: `1px solid ${C.border}`, borderRadius: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: C.bg3 }}>
                  {['Time', 'Device', 'Message'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: C.text3, fontFamily: 'var(--mono)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(result.hits || []).slice(0, 50).map((hit, i) => (
                  <tr key={i}>
                    <td style={{ padding: '8px 10px', borderTop: `1px solid ${C.border}`, color: C.text2, whiteSpace: 'nowrap' }}>
                      {hit['@timestamp'] || hit.timestamp || '—'}
                    </td>
                    <td style={{ padding: '8px 10px', borderTop: `1px solid ${C.border}`, color: C.text2 }}>
                      {hit.device_name || hit.host?.name || '—'}
                    </td>
                    <td style={{ padding: '8px 10px', borderTop: `1px solid ${C.border}`, color: C.text2, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {hit.message || hit.cisco_message || hit.fgt?.msg || JSON.stringify(hit).slice(0, 120)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function AnomaliesTab() {
  const [site, setSite] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)

  const run = async () => {
    setLoading(true)
    try {
      const { data } = await aiAPI.anomalies(site.trim() || undefined)
      setResult(data)
    } catch (err) {
      toast.error(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 12, color: C.text3, lineHeight: 1.5 }}>
        <FreshnessBadge freshness="live" /> Live ES aggregation (last 1 hour) + AI interpretation.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={site}
          onChange={e => setSite(e.target.value)}
          placeholder="Optional site name filter"
          style={{
            flex: '1 1 200px',
            padding: '10px 12px',
            borderRadius: 10,
            border: `1px solid ${C.border}`,
            background: C.bg3,
            color: C.text,
            fontSize: 13,
          }}
        />
        <button
          type="button"
          onClick={run}
          disabled={loading}
          style={{
            padding: '10px 16px',
            borderRadius: 10,
            border: 'none',
            background: C.accent,
            color: '#fff',
            fontWeight: 700,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {loading ? 'Analyzing…' : 'Run analysis'}
        </button>
      </div>
      {result && (
        <div style={{ padding: 16, borderRadius: 12, background: C.bg2, border: `1px solid ${C.border}` }}>
          {result.fetchedAt && (
            <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
              <FreshnessBadge freshness="live" /> fetched {new Date(result.fetchedAt).toLocaleTimeString()} · {result.window}
            </div>
          )}
          <div style={{ fontSize: 13, color: C.text, marginBottom: 12, lineHeight: 1.5 }}>{result.summary}</div>
          {(result.anomalies || []).length === 0 ? (
            <div style={{ fontSize: 12, color: C.text3 }}>No anomalies reported.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {result.anomalies.map((a, i) => (
                <li key={i} style={{ fontSize: 12, color: C.text2 }}>
                  <span style={{ color: severityColor(a.severity), fontWeight: 700, fontFamily: 'var(--mono)', marginRight: 8 }}>
                    {(a.severity || 'info').toUpperCase()}
                  </span>
                  <strong>{a.type}</strong> — {a.description}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function TriageTab() {
  const [form, setForm] = useState({
    srcip: '',
    dstip: '',
    action: '',
    message: '',
    device_name: '',
    site_name: '',
  })
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const run = async () => {
    setLoading(true)
    setResult(null)
    try {
      const { data } = await aiAPI.triage(form)
      setResult(data)
    } catch (err) {
      toast.error(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%' }}>
      <p style={{ margin: 0, fontSize: 12, color: C.text3, lineHeight: 1.5 }}>
        Paste alert fields for AI triage (severity, category, recommendation as JSON).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {[
          ['srcip', 'Source IP'],
          ['dstip', 'Dest IP'],
          ['action', 'Action'],
          ['device_name', 'Device'],
          ['site_name', 'Site'],
        ].map(([key, label]) => (
          <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: C.text3 }}>
            {label}
            <input
              value={form[key]}
              onChange={e => set(key, e.target.value)}
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.bg3,
                color: C.text,
                fontSize: 12,
              }}
            />
          </label>
        ))}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: C.text3 }}>
        Message
        <textarea
          value={form.message}
          onChange={e => set('message', e.target.value)}
          rows={3}
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            background: C.bg3,
            color: C.text,
            fontSize: 12,
            resize: 'vertical',
          }}
        />
      </label>
      <button
        type="button"
        onClick={run}
        disabled={loading}
        style={{
          alignSelf: 'flex-start',
          padding: '10px 16px',
          borderRadius: 10,
          border: 'none',
          background: C.accent,
          color: '#fff',
          fontWeight: 700,
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {loading ? 'Triaging…' : 'Triage alert'}
      </button>
      {result && (
        <pre
          style={{
            margin: 0,
            padding: 14,
            borderRadius: 10,
            background: C.bg2,
            border: `1px solid ${C.border}`,
            fontSize: 12,
            color: C.text2,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  )
}

function severityColor(sev) {
  const s = String(sev || '').toLowerCase()
  if (s.includes('critical') || s.includes('high')) return C.red
  if (s.includes('medium')) return C.amber
  return C.green
}

export default function AIPage() {
  const [tab, setTab] = useUrlTab('chat', TABS)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [providerStatus, setProviderStatus] = useState(null)
  const [switchingProvider, setSwitchingProvider] = useState(false)
  const [availableModules, setAvailableModules] = useState([])
  const [enabledModules, setEnabledModules] = useState([])
  const [autoModules, setAutoModules] = useState(true)

  const loadProvider = useCallback(() => {
    return aiAPI.getProvider()
      .then(({ data }) => {
        setProvider(data.provider)
        setModel(data.model || '')
        setProviderStatus({
          configured: data.configured,
          active: data.active ?? data.provider,
          rows: data.rows,
          hint: data.hint,
          autoFallback: data.autoFallback,
        })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadProvider()
    aiAPI.getModules()
      .then(({ data }) => {
        const mods = data.modules || []
        setAvailableModules(mods)
        setEnabledModules(mods.filter(m => m.id === 'storeMonitor' || m.id === 'storeProblems').map(m => m.id))
      })
      .catch(() => {})
  }, [loadProvider])

  const switchToOllama = useCallback(async () => {
    setSwitchingProvider(true)
    try {
      await aiAPI.setProvider('ollama')
      toast.success('Switched to Ollama')
      await loadProvider()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not switch provider')
    } finally {
      setSwitchingProvider(false)
    }
  }, [loadProvider])

  const toggleModule = (id) => {
    setEnabledModules(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

  return (
    <div className="ai-page-root" style={{ ...PAGE_ROOT, color: C.text, fontFamily: 'var(--sans)' }}>
      <div style={{ flexShrink: 0, marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 15, fontWeight: 700, margin: 0, letterSpacing: '-0.02em' }}>SocMon AI</h1>
        <TabBar tab={tab} setTab={setTab} compact />
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {tab === 'chat' && (
          <ChatTab
            provider={provider}
            model={model}
            providerStatus={providerStatus}
            onSwitchOllama={switchToOllama}
            switchingProvider={switchingProvider}
            availableModules={availableModules}
            enabledModules={enabledModules}
            onToggleModule={toggleModule}
            autoModules={autoModules}
            onAutoToggle={setAutoModules}
          />
        )}
        {tab === 'search' && (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
            <LogSearchTab />
          </div>
        )}
        {tab === 'anomalies' && (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
            <AnomaliesTab />
          </div>
        )}
        {tab === 'triage' && (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
            <TriageTab />
          </div>
        )}
      </div>
    </div>
  )
}
