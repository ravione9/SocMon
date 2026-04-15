import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import api from '../../api/client'
import { ResizableColsTable } from '../../components/ui/ResizableTable.jsx'

const EVENT_TYPE_GROUPS = [
  {
    label: 'FortiGate (fgt.type / subtype / action)',
    options: [
      { value: 'all', label: 'All types' },
      { value: 'traffic', label: 'Traffic' },
      { value: 'utm', label: 'UTM' },
      { value: 'ips', label: 'IPS (subtype)' },
      { value: 'vpn', label: 'VPN / SSL-VPN' },
      { value: 'event', label: 'Event (other)' },
      { value: 'allow', label: 'Allow' },
      { value: 'deny', label: 'Deny' },
    ],
  },
  {
    label: 'Cisco / NOC (mnemonic)',
    options: [
      { value: 'updown', label: 'UPDOWN' },
      { value: 'config', label: 'CONFIG_I' },
      { value: 'macflap', label: 'MACFLAP_NOTIF' },
      { value: 'vlanmismatch', label: 'NATIVE_VLAN_MISMATCH' },
      { value: 'auth', label: 'Auth (login / SSH sample)' },
    ],
  },
]

function eventTypeLabel(value) {
  if (!value) return null
  for (const g of EVENT_TYPE_GROUPS) {
    const o = g.options.find(x => x.value === value)
    if (o) return o.label
  }
  return value
}

const C = {
  accent: 'var(--accent)',
  text: 'var(--text)',
  text2: 'var(--text2)',
  text3: 'var(--text3)',
  bg2: 'var(--bg2)',
  bg3: 'var(--bg3)',
  border: 'var(--border)',
  green: 'var(--green)',
  red: 'var(--red)',
  amber: 'var(--amber)',
}

function toLocalDT(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function fmtIso(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function Td({ children, mono, right }) {
  return (
    <td
      style={{
        padding: '8px 10px',
        fontSize: 12,
        color: C.text2,
        borderBottom: '1px solid var(--border)',
        fontFamily: mono ? 'var(--mono)' : 'inherit',
        textAlign: right ? 'right' : 'left',
      }}
    >
      {children}
    </td>
  )
}

function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          color: 'var(--accent)',
          margin: '0 0 12px',
          fontFamily: 'var(--mono)',
          borderBottom: `1px solid ${C.border}`,
          paddingBottom: 6,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

const REPORT_TABS = [
  { id: 'overall', label: 'Overall' },
  { id: 'soc', label: 'SOC' },
  { id: 'noc', label: 'NOC' },
  { id: 'xdr', label: 'XDR' },
]

function buildNocHighlights(noc, tickets) {
  const lines = []
  if (!noc) return lines
  lines.push(`Cisco / syslog index recorded ${noc.total.toLocaleString()} events in the selected period.`)
  if (noc.updown > 0) lines.push(`${noc.updown.toLocaleString()} interface up/down (UPDOWN) messages.`)
  if (noc.macflap > 0) lines.push(`${noc.macflap.toLocaleString()} MAC flap notifications.`)
  if (noc.vlanmismatch > 0) lines.push(`${noc.vlanmismatch.toLocaleString()} native VLAN mismatch events.`)
  if (noc.configChanges > 0) lines.push(`${noc.configChanges.toLocaleString()} configuration change messages (CONFIG_I).`)
  if (tickets && (tickets.createdInPeriod > 0 || tickets.closedInPeriod > 0)) {
    lines.push(
      `Tickets: ${tickets.createdInPeriod} opened and ${tickets.closedInPeriod} closed during the period (${tickets.openNow} currently open).`,
    )
  }
  return lines
}

export default function ReportsPage() {
  const [mode, setMode] = useState('daily')
  const [fromVal, setFromVal] = useState(() => toLocalDT(new Date(Date.now() - 7 * 86400000)))
  const [toVal, setToVal] = useState(() => toLocalDT(new Date()))
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [deviceFilter, setDeviceFilter] = useState('')
  const [eventTypeFilter, setEventTypeFilter] = useState('all')
  const [reportTab, setReportTab] = useState('overall')
  const [xdrStats, setXdrStats] = useState(null)
  const [xdrLoading, setXdrLoading] = useState(false)
  const [xdrError, setXdrError] = useState(null)

  const fromRef = useRef(fromVal)
  const toRef = useRef(toVal)
  fromRef.current = fromVal
  toRef.current = toVal

  const deviceOptions = useMemo(() => {
    const names = new Set()
    if (deviceFilter.trim()) names.add(deviceFilter.trim())
    const b = data?.breakdown
    if (b) {
      for (const r of b.firewallByDevice || []) {
        if (r.device && r.device !== 'Unknown') names.add(r.device)
      }
      for (const r of b.ciscoByDevice || []) {
        if (r.device && r.device !== 'Unknown') names.add(r.device)
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [data, deviceFilter])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params =
        mode === 'custom'
          ? {
              from: new Date(fromRef.current).toISOString(),
              to: new Date(toRef.current).toISOString(),
            }
          : { preset: mode }
      const dDev = deviceFilter.trim()
      if (dDev) params.device = dDev
      if (eventTypeFilter !== 'all') params.eventType = eventTypeFilter
      const { data: d } = await api.get('/api/stats/report', {
        params,
        timeout: 180000,
      })
      setData(d)
    } catch (e) {
      setData(null)
      setError(e.response?.data?.error || e.message || 'Failed to load report')
    } finally {
      setLoading(false)
    }
  }, [mode, deviceFilter, eventTypeFilter])

  useEffect(() => {
    load()
  }, [load])

  const meta = data?.meta
  const soc = data?.soc
  const noc = data?.noc
  const denied = data?.denied
  const threats = data?.threats
  const tickets = data?.tickets
  const breakdown = data?.breakdown

  const nocHighlights = useMemo(() => {
    if (!data?.noc) return []
    return buildNocHighlights(data.noc, data.tickets)
  }, [data])

  const hasFwBreakdown =
    breakdown &&
    (breakdown.firewallByDevice?.length > 0 || breakdown.firewallByType?.length > 0)
  const hasCiscoBreakdown =
    breakdown &&
    (breakdown.ciscoByDevice?.length > 0 || breakdown.ciscoByMnemonic?.length > 0)
  const showFwTables = reportTab === 'overall' || reportTab === 'soc'
  const showCiscoTables = reportTab === 'overall' || reportTab === 'noc'
  const showVolumeBreakdown =
    reportTab !== 'xdr' && ((showFwTables && hasFwBreakdown) || (showCiscoTables && hasCiscoBreakdown))
  const showSocSections = reportTab === 'overall' || reportTab === 'soc'
  const showNocSections = reportTab === 'overall' || reportTab === 'noc'

  const xdrSummaryLines = useMemo(() => {
    if (!xdrStats) return []
    const lines = []
    const ix = xdrStats.index || 'sentinel-*'
    const tot = xdrStats.total
    lines.push(
      `Sentinel index ${ix} recorded ${typeof tot === 'number' ? tot.toLocaleString() : tot} events in this period.`,
    )
    lines.push(
      `Active threats: ${(xdrStats.activeThreats ?? 0).toLocaleString()}; resolved: ${(xdrStats.resolvedThreats ?? 0).toLocaleString()}.`,
    )
    lines.push(
      `Agent events — disconnected: ${(xdrStats.agentDisconnectedEvents ?? 0).toLocaleString()}, connected: ${(xdrStats.agentConnectedEvents ?? 0).toLocaleString()}.`,
    )
    return lines
  }, [xdrStats])

  useEffect(() => {
    if (reportTab !== 'xdr' || !data?.meta?.from || !data?.meta?.to) return
    let cancelled = false
    ;(async () => {
      setXdrLoading(true)
      setXdrError(null)
      try {
        const { data: s } = await api.get('/api/sentinel/stats', {
          params: { from: data.meta.from, to: data.meta.to },
          timeout: 120000,
        })
        if (!cancelled) setXdrStats(s)
      } catch (e) {
        if (!cancelled) {
          setXdrStats(null)
          setXdrError(e.response?.data?.error || e.message || 'Failed to load XDR stats')
        }
      } finally {
        if (!cancelled) setXdrLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reportTab, data?.meta?.from, data?.meta?.to])

  return (
    <>
      <style>{`
        @media print {
          aside, header, .report-no-print { display: none !important; }
          main { padding: 12mm !important; overflow: visible !important; height: auto !important; }
          body, html { background: #fff !important; }
          #report-print-root {
            background: #fff !important;
            color: #111 !important;
            box-shadow: none !important;
            border: none !important;
          }
          #report-print-root h1, #report-print-root h2, #report-print-root .report-muted { color: #333 !important; }
          #report-print-root table { break-inside: avoid; }
        }
      `}</style>

      <div className="report-no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: C.text3, fontFamily: 'var(--mono)', marginRight: 8 }}>Report type</span>
        {[
          { id: 'daily', label: 'Daily' },
          { id: 'weekly', label: 'Weekly' },
          { id: 'custom', label: 'Custom' },
        ].map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: mode === id ? '1px solid var(--accent)' : `1px solid ${C.border}`,
              background: mode === id ? 'var(--bg4)' : C.bg3,
              color: mode === id ? C.text : C.text2,
              fontSize: 11,
              fontFamily: 'var(--mono)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}

        {mode === 'custom' && (
          <>
            <label style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
              From
              <input
                type="datetime-local"
                value={fromVal}
                onChange={e => setFromVal(e.target.value)}
                style={{
                  marginLeft: 6,
                  padding: '5px 8px',
                  borderRadius: 6,
                  border: `1px solid ${C.border}`,
                  background: C.bg2,
                  color: C.text,
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                }}
              />
            </label>
            <label style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
              To
              <input
                type="datetime-local"
                value={toVal}
                onChange={e => setToVal(e.target.value)}
                style={{
                  marginLeft: 6,
                  padding: '5px 8px',
                  borderRadius: 6,
                  border: `1px solid ${C.border}`,
                  background: C.bg2,
                  color: C.text,
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                }}
              />
            </label>
          </>
        )}

        <button
          type="button"
          onClick={() => load()}
          disabled={loading}
          style={{
            padding: '6px 14px',
            borderRadius: 8,
            border: 'none',
            background: C.accent,
            color: 'var(--on-accent)',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            fontWeight: 600,
            cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          style={{
            padding: '6px 14px',
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            background: C.bg3,
            color: C.text2,
            fontSize: 11,
            fontFamily: 'var(--mono)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Print / Save PDF
        </button>
      </div>

      <div className="report-no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: C.text3, fontFamily: 'var(--mono)', marginRight: 8 }}>Report scope</span>
        {REPORT_TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setReportTab(id)}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: reportTab === id ? '1px solid var(--accent)' : `1px solid ${C.border}`,
              background: reportTab === id ? 'var(--bg4)' : C.bg3,
              color: reportTab === id ? C.text : C.text2,
              fontSize: 11,
              fontFamily: 'var(--mono)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        className="report-no-print"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'flex-end',
          marginBottom: 16,
          padding: '12px 14px',
          background: C.bg3,
          borderRadius: 10,
          border: `1px solid ${C.border}`,
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Device (exact match, optional)
          </span>
          <input
            type="text"
            list="report-device-suggestions"
            value={deviceFilter}
            onChange={e => setDeviceFilter(e.target.value)}
            placeholder="Leave empty for all — pick from suggestions after load"
            style={{
              width: 280,
              padding: '6px 10px',
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.bg2,
              color: C.text,
              fontFamily: 'var(--mono)',
              fontSize: 11,
            }}
          />
          <datalist id="report-device-suggestions">
            {deviceOptions.map(name => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Event type
          </span>
          <select
            value={eventTypeFilter}
            onChange={e => setEventTypeFilter(e.target.value)}
            style={{
              minWidth: 240,
              padding: '6px 10px',
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.bg2,
              color: C.text,
              fontFamily: 'var(--mono)',
              fontSize: 11,
            }}
          >
            {EVENT_TYPE_GROUPS.map(g => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map(o => (
                  <option key={g.label + o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <span style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', maxWidth: 320, lineHeight: 1.4 }}>
          Forti filters apply to firewall-*; Cisco filters apply to cisco-*. Other index stays unfiltered for cross-context metrics.
        </span>
      </div>

      {error && (
        <div
          className="report-no-print"
          style={{
            padding: 12,
            borderRadius: 8,
            background: 'color-mix(in srgb, var(--red) 14%, transparent)',
            border: '1px solid color-mix(in srgb, var(--red) 40%, transparent)',
            color: 'var(--red)',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <div
        id="report-print-root"
        style={{
          maxWidth: 900,
          margin: '0 auto',
          background: C.bg2,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: '28px 32px 36px',
          fontFamily: 'var(--sans), system-ui, sans-serif',
          color: C.text,
        }}
      >
        {!data && loading ? (
          <div style={{ textAlign: 'center', color: C.text3, fontFamily: 'var(--mono)', padding: 48 }}>Generating report…</div>
        ) : data ? (
          <>
            <header style={{ borderBottom: '2px solid var(--accent)', paddingBottom: 16, marginBottom: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, color: 'var(--accent)', fontFamily: 'var(--mono)', marginBottom: 6 }}>
                LENSKART
              </div>
              <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px', letterSpacing: -0.3 }}>{meta.title}</h1>
              {reportTab !== 'overall' && (
                <div style={{ fontSize: 12, color: 'var(--accent)', fontFamily: 'var(--mono)', marginBottom: 8 }}>
                  {reportTab === 'soc' && 'Scope: SOC — firewall & security'}
                  {reportTab === 'noc' && 'Scope: NOC — Cisco & network'}
                  {reportTab === 'xdr' && 'Scope: XDR — Sentinel / endpoint'}
                </div>
              )}
              <div className="report-muted" style={{ fontSize: 13, color: C.text2, marginBottom: 4 }}>
                <strong>Period:</strong> {meta.periodLabel}
              </div>
              <div className="report-muted" style={{ fontSize: 12, color: C.text3, fontFamily: 'var(--mono)' }}>
                Range (ISO): {meta.from} → {meta.to}
              </div>
              <div className="report-muted" style={{ fontSize: 12, color: C.text3, fontFamily: 'var(--mono)', marginTop: 6 }}>
                Generated: {fmtIso(meta.generatedAt)}
              </div>
              <p className="report-muted" style={{ fontSize: 11, color: C.text3, margin: '12px 0 0', fontStyle: 'italic' }}>
                {meta.timezoneNote}
              </p>
              {(meta.filters?.device || meta.filters?.eventType) && (
                <div
                  className="report-muted"
                  style={{
                    marginTop: 14,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: C.bg3,
                    border: `1px solid ${C.border}`,
                    fontSize: 12,
                    color: C.text2,
                    fontFamily: 'var(--mono)',
                    lineHeight: 1.5,
                  }}
                >
                  <strong style={{ color: C.text }}>Active filters</strong>
                  {meta.filters.device ? (
                    <div>
                      Device: <span style={{ color: 'var(--accent)' }}>{meta.filters.device}</span> (firewall-* and cisco-* where applicable)
                    </div>
                  ) : null}
                  {meta.filters.eventType ? (
                    <div>
                      Event type: <span style={{ color: 'var(--accent)' }}>{eventTypeLabel(meta.filters.eventType) || meta.filters.eventType}</span>
                    </div>
                  ) : null}
                </div>
              )}
            </header>

            {reportTab === 'xdr' ? (
              <>
                <Section title="Executive summary">
                  {xdrLoading ? (
                    <p className="report-muted" style={{ color: C.text3, fontSize: 13 }}>
                      Loading XDR summary…
                    </p>
                  ) : xdrError ? (
                    <p style={{ color: 'var(--red)', fontSize: 13, fontFamily: 'var(--mono)' }}>{xdrError}</p>
                  ) : xdrSummaryLines.length ? (
                    <ul style={{ margin: 0, paddingLeft: 20, color: C.text2, fontSize: 13, lineHeight: 1.65 }}>
                      {xdrSummaryLines.map((line, i) => (
                        <li key={i} style={{ marginBottom: 6 }}>
                          {line}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="report-muted" style={{ color: C.text3, fontSize: 13 }}>
                      No XDR data for this period.
                    </p>
                  )}
                </Section>

                <Section title="XDR telemetry (Sentinel)">
                  <p className="report-muted" style={{ fontSize: 12, color: C.text3, margin: '0 0 16px' }}>
                    Same time range as the report header. Device and event-type filters above apply to firewall and Cisco indices only, not Sentinel.
                  </p>
                  {xdrLoading ? (
                    <p className="report-muted" style={{ color: C.text3, fontSize: 13 }}>
                      Loading metrics…
                    </p>
                  ) : xdrError ? null : xdrStats ? (
                    <>
                      <ResizableColsTable
                        tableId="report-xdr-metrics"
                        defaultWidths={[400, 140]}
                        columns={[{ label: 'Metric' }, { label: 'Count', thStyle: { textAlign: 'right' } }]}
                        tableStyle={{ marginBottom: 20 }}
                      >
                        <tbody>
                          {[
                            ['Total events', xdrStats.total],
                            ['Active threats', xdrStats.activeThreats],
                            ['Resolved threats', xdrStats.resolvedThreats],
                            ['Agent disconnected events', xdrStats.agentDisconnectedEvents],
                            ['Agent connected events', xdrStats.agentConnectedEvents],
                          ].map(([label, val]) => (
                            <tr key={label}>
                              <Td>{label}</Td>
                              <Td mono right>
                                {typeof val === 'number' ? val.toLocaleString() : val}
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                      </ResizableColsTable>
                      {xdrStats.severityBreakdown?.length ? (
                        <div>
                          <h3
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: 0.8,
                              color: C.text3,
                              margin: '0 0 8px',
                              fontFamily: 'var(--mono)',
                            }}
                          >
                            Active threats by confidence / severity
                          </h3>
                          <ResizableColsTable
                            tableId="report-xdr-severity"
                            defaultWidths={[320, 120]}
                            columns={[{ label: 'Level' }, { label: 'Count', thStyle: { textAlign: 'right' } }]}
                          >
                            <tbody>
                              {xdrStats.severityBreakdown.map((row, i) => (
                                <tr key={`${row.key}-${i}`}>
                                  <Td mono>{row.key}</Td>
                                  <Td mono right>
                                    {row.count.toLocaleString()}
                                  </Td>
                                </tr>
                              ))}
                            </tbody>
                          </ResizableColsTable>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="report-muted" style={{ color: C.text3, fontSize: 13 }}>
                      No XDR metrics.
                    </p>
                  )}
                </Section>
              </>
            ) : (
              <>
                <Section title="Executive summary">
                  <ul style={{ margin: 0, paddingLeft: 20, color: C.text2, fontSize: 13, lineHeight: 1.65 }}>
                    {(reportTab === 'noc' && nocHighlights.length ? nocHighlights : data.highlights || []).map((line, i) => (
                      <li key={i} style={{ marginBottom: 6 }}>
                        {line}
                      </li>
                    ))}
                  </ul>
                </Section>

                {showVolumeBreakdown ? (
              <Section title="Volume breakdown (same period and filters)">
                <p className="report-muted" style={{ fontSize: 12, color: C.text3, margin: '0 0 16px' }}>
                  Top buckets from Elasticsearch for this report window. Counts respect device and event-type filters on each index.
                </p>
                <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
                  {showFwTables && breakdown.firewallByDevice?.length > 0 ? (
                    <div>
                      <h3
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: 0.8,
                          color: C.text3,
                          margin: '0 0 8px',
                          fontFamily: 'var(--mono)',
                        }}
                      >
                        Firewall by device
                      </h3>
                      <ResizableColsTable
                        tableId="report-fw-by-device"
                        defaultWidths={[320, 120]}
                        columns={[{ label: 'Device' }, { label: 'Events', thStyle: { textAlign: 'right' } }]}
                      >
                        <tbody>
                          {breakdown.firewallByDevice.map((row, i) => (
                            <tr key={`${row.device}-${i}`}>
                              <Td mono>{row.device}</Td>
                              <Td mono right>
                                {row.count.toLocaleString()}
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                      </ResizableColsTable>
                    </div>
                  ) : null}
                  {showFwTables && breakdown.firewallByType?.length > 0 ? (
                    <div>
                      <h3
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: 0.8,
                          color: C.text3,
                          margin: '0 0 8px',
                          fontFamily: 'var(--mono)',
                        }}
                      >
                        Firewall by fgt.type
                      </h3>
                      <ResizableColsTable
                        tableId="report-fw-by-type"
                        defaultWidths={[320, 120]}
                        columns={[{ label: 'Type' }, { label: 'Events', thStyle: { textAlign: 'right' } }]}
                      >
                        <tbody>
                          {breakdown.firewallByType.map((row, i) => (
                            <tr key={`${row.type}-${i}`}>
                              <Td mono>{row.type}</Td>
                              <Td mono right>
                                {row.count.toLocaleString()}
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                      </ResizableColsTable>
                    </div>
                  ) : null}
                  {showCiscoTables && breakdown.ciscoByDevice?.length > 0 ? (
                    <div>
                      <h3
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: 0.8,
                          color: C.text3,
                          margin: '0 0 8px',
                          fontFamily: 'var(--mono)',
                        }}
                      >
                        Cisco by device
                      </h3>
                      <ResizableColsTable
                        tableId="report-cisco-by-device"
                        defaultWidths={[320, 120]}
                        columns={[{ label: 'Device' }, { label: 'Events', thStyle: { textAlign: 'right' } }]}
                      >
                        <tbody>
                          {breakdown.ciscoByDevice.map((row, i) => (
                            <tr key={`${row.device}-${i}`}>
                              <Td mono>{row.device}</Td>
                              <Td mono right>
                                {row.count.toLocaleString()}
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                      </ResizableColsTable>
                    </div>
                  ) : null}
                  {showCiscoTables && breakdown.ciscoByMnemonic?.length > 0 ? (
                    <div>
                      <h3
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: 0.8,
                          color: C.text3,
                          margin: '0 0 8px',
                          fontFamily: 'var(--mono)',
                        }}
                      >
                        Cisco by mnemonic
                      </h3>
                      <ResizableColsTable
                        tableId="report-cisco-by-mnemonic"
                        defaultWidths={[320, 120]}
                        columns={[{ label: 'Mnemonic' }, { label: 'Events', thStyle: { textAlign: 'right' } }]}
                      >
                        <tbody>
                          {breakdown.ciscoByMnemonic.map((row, i) => (
                            <tr key={`${row.mnemonic}-${i}`}>
                              <Td mono>{row.mnemonic}</Td>
                              <Td mono right>
                                {row.count.toLocaleString()}
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                      </ResizableColsTable>
                    </div>
                  ) : null}
                </div>
              </Section>
            ) : null}

                {showSocSections ? (
                  <Section title="Security operations (firewall)">
                    <ResizableColsTable
                      tableId="report-soc-metrics"
                      defaultWidths={[400, 120]}
                      columns={[{ label: 'Metric' }, { label: 'Count', thStyle: { textAlign: 'right' } }]}
                    >
                      <tbody>
                        {[
                          ['Total firewall events', soc.total],
                          ['Policy deny', soc.denied],
                          ['Allow / other (estimate)', soc.allowedEstimate],
                          ['IPS events', soc.ips],
                          ['UTM events', soc.utm],
                          ['VPN-related events', soc.vpn],
                        ].map(([label, val]) => (
                          <tr key={label}>
                            <Td>{label}</Td>
                            <Td mono right>
                              {typeof val === 'number' ? val.toLocaleString() : val}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </ResizableColsTable>
                  </Section>
                ) : null}

                {showNocSections ? (
                  <Section title="Network operations (Cisco index)">
                    <ResizableColsTable
                      tableId="report-noc-metrics"
                      defaultWidths={[400, 120]}
                      columns={[{ label: 'Metric' }, { label: 'Count', thStyle: { textAlign: 'right' } }]}
                    >
                      <tbody>
                        {[
                          ['Total Cisco / syslog events', noc.total],
                          ['Interface up/down (UPDOWN)', noc.updown],
                          ['MAC flap notifications', noc.macflap],
                          ['Native VLAN mismatch', noc.vlanmismatch],
                          ['Configuration changes (CONFIG_I)', noc.configChanges],
                          ['Switch auth-related (sample mnemonics)', soc.switchAuthEvents],
                        ].map(([label, val]) => (
                          <tr key={label}>
                            <Td>{label}</Td>
                            <Td mono right>
                              {typeof val === 'number' ? val.toLocaleString() : val}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </ResizableColsTable>
                  </Section>
                ) : null}

                {showSocSections ? (
                  <>
                    <Section title="Top denied source IPs">
                      {denied.by_src?.length ? (
                        <ResizableColsTable
                          tableId="report-denied-src"
                          defaultWidths={[52, 180, 120]}
                          columns={[
                            { label: '#' },
                            { label: 'Source IP' },
                            { label: 'Deny events', thStyle: { textAlign: 'right' } },
                          ]}
                        >
                          <tbody>
                            {denied.by_src.map((row, i) => (
                              <tr key={row.ip || i}>
                                <Td mono>{i + 1}</Td>
                                <Td mono>{row.ip}</Td>
                                <Td mono right>
                                  {row.count.toLocaleString()}
                                </Td>
                              </tr>
                            ))}
                          </tbody>
                        </ResizableColsTable>
                      ) : (
                        <p className="report-muted" style={{ color: C.text3, fontSize: 13 }}>
                          No deny traffic in this period.
                        </p>
                      )}
                    </Section>

                    <Section title="Top source countries (deny)">
                      {denied.by_country?.length ? (
                        <ResizableColsTable
                          tableId="report-denied-country"
                          defaultWidths={[52, 240, 120]}
                          columns={[
                            { label: '#' },
                            { label: 'Country / region' },
                            { label: 'Deny events', thStyle: { textAlign: 'right' } },
                          ]}
                        >
                          <tbody>
                            {denied.by_country.map((row, i) => (
                              <tr key={`${row.country}-${i}`}>
                                <Td mono>{i + 1}</Td>
                                <Td>{row.country}</Td>
                                <Td mono right>
                                  {row.count.toLocaleString()}
                                </Td>
                              </tr>
                            ))}
                          </tbody>
                        </ResizableColsTable>
                      ) : (
                        <p className="report-muted" style={{ color: C.text3, fontSize: 13 }}>
                          No country aggregation for denies in this period.
                        </p>
                      )}
                    </Section>

                    <Section title="Top IPS signatures">
                      {threats?.length ? (
                        <ResizableColsTable
                          tableId="report-ips-signatures"
                          defaultWidths={[52, 320, 100]}
                          columns={[
                            { label: '#' },
                            { label: 'Signature' },
                            { label: 'Hits', thStyle: { textAlign: 'right' } },
                          ]}
                        >
                          <tbody>
                            {threats.map((row, i) => (
                              <tr key={`${row.name}-${i}`}>
                                <Td mono>{i + 1}</Td>
                                <Td>{row.name || '—'}</Td>
                                <Td mono right>
                                  {row.count.toLocaleString()}
                                </Td>
                              </tr>
                            ))}
                          </tbody>
                        </ResizableColsTable>
                      ) : (
                        <p className="report-muted" style={{ color: C.text3, fontSize: 13 }}>
                          No IPS hits in this period.
                        </p>
                      )}
                    </Section>
                  </>
                ) : null}

              </>
            )}

            <Section title="Tickets">
              <ResizableColsTable
                tableId="report-tickets"
                defaultWidths={[400, 120]}
                columns={[{ label: 'Metric' }, { label: 'Count', thStyle: { textAlign: 'right' } }]}
              >
                <tbody>
                  <tr>
                    <Td>Opened during period</Td>
                    <Td mono right>
                      {(tickets?.createdInPeriod ?? 0).toLocaleString()}
                    </Td>
                  </tr>
                  <tr>
                    <Td>Closed during period</Td>
                    <Td mono right>
                      {(tickets?.closedInPeriod ?? 0).toLocaleString()}
                    </Td>
                  </tr>
                  <tr>
                    <Td>Open or in-progress (current)</Td>
                    <Td mono right>
                      {(tickets?.openNow ?? 0).toLocaleString()}
                    </Td>
                  </tr>
                </tbody>
              </ResizableColsTable>
            </Section>

            <footer
              className="report-muted"
              style={{
                marginTop: 32,
                paddingTop: 16,
                borderTop: `1px solid ${C.border}`,
                fontSize: 10,
                color: C.text3,
                fontFamily: 'var(--mono)',
                textAlign: 'center',
              }}
            >
              Lenskart — standard report format · Confidential
            </footer>
          </>
        ) : null}
      </div>
    </>
  )
}
