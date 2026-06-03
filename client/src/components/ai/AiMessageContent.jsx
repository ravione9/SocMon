import { useMemo, useState } from 'react'
import './aiMessage.css'

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

const SECTION_THEMES = {
  'Infra Zabbix': { accent: '#4f7ef5', bg: 'rgba(79,126,245,.12)', icon: '📡', emoji: 'Zabbix' },
  'Store Zabbix': { accent: '#a78bfa', bg: 'rgba(167,139,250,.12)', icon: '🏪', emoji: 'Store' },
  'Store Monitor': { accent: '#22d3a0', bg: 'rgba(34,211,160,.12)', icon: '📶', emoji: 'Stores' },
  'FortiGate / SOC': { accent: '#f97316', bg: 'rgba(249,115,22,.12)', icon: '🛡️', emoji: 'Firewall' },
  'SOC / firewall': { accent: '#f97316', bg: 'rgba(249,115,22,.12)', icon: '🛡️', emoji: 'SOC' },
  NOC: { accent: '#38bdf8', bg: 'rgba(56,189,248,.12)', icon: '🌐', emoji: 'NOC' },
  Sentinel: { accent: '#fb7185', bg: 'rgba(251,113,133,.12)', icon: '🔍', emoji: 'Sentinel' },
  XDR: { accent: '#e879f9', bg: 'rgba(232,121,249,.12)', icon: '⚡', emoji: 'XDR' },
}

const ANALYSIS_ICONS = {
  'Executive Summary': '📋',
  'Key Findings': '🔎',
  'Risks / Impact': '⚠️',
  Risks: '⚠️',
  'Recommended Actions': '✅',
}

const TONE_STYLES = {
  good: { color: C.green, bg: 'rgba(34,211,160,.16)', border: 'rgba(34,211,160,.4)' },
  warn: { color: C.amber, bg: 'rgba(245,166,35,.16)', border: 'rgba(245,166,35,.4)' },
  bad: { color: C.red, bg: 'rgba(248,113,113,.16)', border: 'rgba(248,113,113,.4)' },
  info: { color: '#38bdf8', bg: 'rgba(56,189,248,.14)', border: 'rgba(56,189,248,.35)' },
  neutral: { color: C.text2, bg: 'rgba(0,0,0,.12)', border: C.border },
}

function themeForSection(title) {
  if (SECTION_THEMES[title]) return SECTION_THEMES[title]
  const key = Object.keys(SECTION_THEMES).find(k => title.toLowerCase().includes(k.toLowerCase()))
  if (key) return SECTION_THEMES[key]
  return { accent: '#4f7ef5', bg: 'rgba(79,126,245,.1)', icon: '📊', emoji: 'Data' }
}

function severityTone(label) {
  const s = String(label || '').toLowerCase()
  if (/disaster|high|critical|down|unreachable|failed|error|deny|tunnel down|link down/.test(s)) return 'bad'
  if (/average|warning|degraded|stale|unknown/.test(s)) return 'warn'
  if (/info|not classified/.test(s)) return 'info'
  if (/available|ok|reachable|allowed|up|live/.test(s)) return 'good'
  return 'neutral'
}

function parseStructuredMessage(raw) {
  let text = String(raw || '')
  let analysis = null
  let footer = null

  const aiIdx = text.indexOf('\n\n── AI Analysis ──\n')
  if (aiIdx >= 0) {
    analysis = text.slice(aiIdx + '\n\n── AI Analysis ──\n'.length)
    text = text.slice(0, aiIdx)
  }

  if (analysis) {
    const footMatch = analysis.match(/\n\n\(Live data \+ AI analysis\.\)\s*$/)
    if (footMatch) {
      footer = footMatch[0].trim()
      analysis = analysis.slice(0, footMatch.index).trim()
    }
  }

  for (const pat of [
    /\n\n?\(Direct answer[^\n]+\)\s*$/,
    /\n\n?\(Direct chart[^\n]+\)\s*$/,
    /\n\n?\(Live data \+ AI analysis\.\)\s*$/,
    /\n\n?\(RCA from[^\n]+\)\s*$/,
  ]) {
    const m = text.match(pat)
    if (m) {
      footer = footer || m[0].trim()
      text = text.slice(0, m.index).trim()
      break
    }
  }

  const lines = text.split('\n')
  const headerLines = []
  const sections = []
  let currentSection = null

  for (const line of lines) {
    const secMatch = line.match(/^── (.+?) ──$/)
    if (secMatch) {
      if (currentSection) sections.push(currentSection)
      currentSection = { title: secMatch[1], lines: [] }
      continue
    }
    if (!currentSection) headerLines.push(line)
    else currentSection.lines.push(line)
  }
  if (currentSection) sections.push(currentSection)

  return {
    header: headerLines.filter(l => l.trim()).join('\n'),
    sections,
    analysis,
    footer,
    structured: sections.length > 0 || Boolean(analysis),
  }
}

function parseStatParts(rest) {
  return rest.split(/\s·\s/).map(p => {
    const text = p.trim()
    let tone = 'neutral'
    if (/available|online|reachable|ok|up|allowed/i.test(text)) tone = 'good'
    else if (/down|offline|unreachable|deny|critical|disaster|high/i.test(text)) tone = 'bad'
    else if (/unknown|degraded|warning|average|issues|stale|no data/i.test(text)) tone = 'warn'
    const kv = text.match(/^(.+?)\s+([\d.,]+|[\w%]+)$/)
    return kv
      ? { label: kv[1].trim(), value: kv[2], tone }
      : { label: text, value: '', tone }
  })
}

function parseKpiLines(lines) {
  const kpis = []
  const rest = []
  for (const line of lines) {
    const t = line.trim()
    const m = t.match(/^(Version|Total monitored|Active problems|Reachable|Unreachable|Degraded|Latency avg):\s*(.+)$/i)
    if (m) {
      const label = m[1]
      const parts = parseStatParts(m[2])
      if (parts.length >= 2 || label.toLowerCase() === 'active problems') {
        if (parts.length === 1 && /^\d+$/.test(parts[0].label)) {
          kpis.push({ label, value: parts[0].label, tone: Number(parts[0].label) > 0 ? 'warn' : 'good' })
        } else if (parts.length === 1 && !parts[0].value) {
          const num = m[2].match(/(\d+)/)
          kpis.push({ label, value: num ? num[1] : m[2], tone: num && Number(num[1]) > 0 ? 'warn' : 'neutral' })
        } else {
          for (const p of parts) kpis.push(p)
        }
      } else {
        rest.push(line)
      }
    } else {
      rest.push(line)
    }
  }
  return { kpis, rest }
}

function parseMbps(str) {
  const m = String(str || '').match(/([\d.]+)\s*(Mbps|Kbps|bps|Gbps)/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  const mult = unit === 'gbps' ? 1e9 : unit === 'mbps' ? 1e6 : unit === 'kbps' ? 1e3 : 1
  return { display: `${m[1]} ${m[2]}`, bps: n * mult }
}

function parseInlineBold(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    const m = part.match(/^\*\*(.+)\*\*$/)
    if (m) return <strong key={i} style={{ color: C.text, fontWeight: 700 }}>{m[1]}</strong>
    return part
  })
}

function Badge({ children, tone = 'neutral', small = false, pulse = false }) {
  const t = TONE_STYLES[tone] || TONE_STYLES.neutral
  return (
    <span
      className={pulse ? 'ai-live-badge' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: small ? '2px 8px' : '4px 11px',
        borderRadius: 999,
        fontSize: small ? 10 : 11,
        fontWeight: 700,
        fontFamily: 'var(--mono)',
        color: t.color,
        background: t.bg,
        border: `1px solid ${t.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

function KpiGrid({ items }) {
  if (!items?.length) return null
  return (
    <div className="ai-kpi-grid">
      {items.map((item, i) => {
        const t = TONE_STYLES[item.tone] || TONE_STYLES.neutral
        return (
          <div
            key={`${item.label}-${i}`}
            className="ai-kpi-card"
            style={{ borderColor: t.border, background: t.bg }}
          >
            <div className="ai-kpi-value" style={{ color: t.color }}>{item.value || '—'}</div>
            <div className="ai-kpi-label" style={{ color: t.color }}>{item.label}</div>
          </div>
        )
      })}
    </div>
  )
}

function ProblemsBanner({ count }) {
  if (!count || count <= 0) return null
  const tone = count >= 5 ? 'bad' : 'warn'
  const t = TONE_STYLES[tone]
  return (
    <div className="ai-problems-banner" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.color }}>
      <span style={{ fontSize: 18 }}>{tone === 'bad' ? '🚨' : '⚠️'}</span>
      <span>{count} active problem{count !== 1 ? 's' : ''} detected — review below</span>
    </div>
  )
}

function TrafficBar({ label, inVal, outVal, status, maxBps, rank }) {
  const inParsed = parseMbps(inVal)
  const outParsed = parseMbps(outVal)
  const inPct = inParsed && maxBps ? Math.max(2, Math.min(100, (inParsed.bps / maxBps) * 100)) : 0
  const outPct = outParsed && maxBps ? Math.max(2, Math.min(100, (outParsed.bps / maxBps) * 100)) : 0
  const stTone = status === 'up' ? 'good' : status === 'down' ? 'bad' : 'neutral'
  const hasTraffic = (inParsed?.bps || 0) > 0 || (outParsed?.bps || 0) > 0

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 10,
        background: 'rgba(0,0,0,.1)',
        border: `1px solid ${C.border}`,
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {rank != null && (
            <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, fontFamily: 'var(--mono)', opacity: 0.7 }}>
              #{rank}
            </span>
          )}
          <span style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: 'var(--mono)' }}>{label}</span>
        </div>
        {status && <Badge tone={stTone} small>{status}</Badge>}
      </div>
      {hasTraffic ? (
        <div style={{ display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: '6px 10px', alignItems: 'center', fontSize: 11, fontFamily: 'var(--mono)' }}>
          <span style={{ color: '#38bdf8', fontWeight: 800, fontSize: 10 }}>IN</span>
          <div className="ai-traffic-bar-track">
            <div className="ai-traffic-bar-fill-in" style={{ width: `${inPct}%` }} />
          </div>
          <span style={{ color: C.text2, whiteSpace: 'nowrap', fontWeight: 600 }}>{inVal || '—'}</span>
          <span style={{ color: '#a78bfa', fontWeight: 800, fontSize: 10 }}>OUT</span>
          <div className="ai-traffic-bar-track">
            <div className="ai-traffic-bar-fill-out" style={{ width: `${outPct}%` }} />
          </div>
          <span style={{ color: C.text2, whiteSpace: 'nowrap', fontWeight: 600 }}>{outVal || '—'}</span>
        </div>
      ) : (
        <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>No traffic</div>
      )}
    </div>
  )
}

function TrafficList({ lines, maxTrafficBps }) {
  const [expanded, setExpanded] = useState(false)
  const items = useMemo(() => {
    return lines
      .map(line => {
        const m = line.match(/^\s*•\s*(.+?) · in (.+?) · out (.+?)(?: · (\w+))?\s*$/)
        if (!m) return null
        const inP = parseMbps(m[2])
        const outP = parseMbps(m[3])
        const peak = Math.max(inP?.bps || 0, outP?.bps || 0)
        return { label: m[1], inVal: m[2], outVal: m[3], status: m[4], peak }
      })
      .filter(Boolean)
      .sort((a, b) => b.peak - a.peak)
  }, [lines])

  if (!items.length) return null
  const show = expanded ? items : items.slice(0, 10)

  return (
    <div style={{ marginTop: 4 }}>
      {show.map((item, i) => (
        <TrafficBar
          key={item.label}
          rank={i + 1}
          label={item.label}
          inVal={item.inVal}
          outVal={item.outVal}
          status={item.status}
          maxBps={maxTrafficBps}
        />
      ))}
      {items.length > 10 && (
        <button type="button" className="ai-collapse-btn" onClick={() => setExpanded(v => !v)}>
          {expanded ? `▲ Show top 10 only` : `▼ Show all ${items.length} interfaces`}
        </button>
      )}
    </div>
  )
}

function HostCard({ name, status, groups, ips, type }) {
  const tone = severityTone(status)
  const t = TONE_STYLES[tone]
  return (
    <div className="ai-host-card" style={{ borderColor: t.border }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>{type === 'fortigate' ? '🔥' : type === 'cisco' ? '🔌' : '🖥️'}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{name}</div>
            {type && type !== 'other' && (
              <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', marginTop: 2 }}>{type}</div>
            )}
          </div>
        </div>
        <Badge tone={tone}>{status}</Badge>
      </div>
      {groups?.length > 0 && (
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Groups</div>
          <div className="ai-tag-row">
            {groups.map(g => <span key={g} className="ai-tag">{g}</span>)}
          </div>
        </div>
      )}
      {ips?.length > 0 && (
        <div style={{ fontSize: 11, color: C.text3, fontFamily: 'var(--mono)' }}>
          <span style={{ color: C.text2, fontWeight: 600 }}>IPs </span>
          {ips.join(' · ')}
        </div>
      )}
    </div>
  )
}

function ProblemItem({ line }) {
  const m = line.match(/^\s*•\s*\[([^\]]+)\]\s*(.+)$/)
  if (!m) return null
  const tone = severityTone(m[1])
  const rest = m[2]
  const since = rest.match(/ · since (.+)$/)
  const name = since ? rest.slice(0, since.index) : rest
  const t = TONE_STYLES[tone]
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: '10px 12px',
        marginBottom: 8,
        borderRadius: 10,
        background: t.bg,
        border: `1px solid ${t.border}`,
        boxShadow: tone === 'bad' ? '0 2px 12px rgba(248,113,113,.15)' : undefined,
      }}
    >
      <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>
        {tone === 'bad' ? '🔴' : tone === 'warn' ? '🟡' : '🔵'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <Badge tone={tone} small>{m[1]}</Badge>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, lineHeight: 1.4 }}>{name.trim()}</div>
        {since && (
          <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', marginTop: 4 }}>
            ⏱ since {since[1]}
          </div>
        )}
      </div>
    </div>
  )
}

function SubSectionTitle({ title, icon }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 11,
      fontWeight: 700,
      color: C.text2,
      margin: '14px 0 8px',
      fontFamily: 'var(--mono)',
      letterSpacing: '0.03em',
      textTransform: 'uppercase',
    }}
    >
      <span>{icon || '▸'}</span>
      {title}
    </div>
  )
}

function SectionLine({ line, maxTrafficBps, skipTraffic }) {
  const trimmed = line.trimEnd()
  if (!trimmed) return null

  if (skipTraffic && (/Interface traffic/i.test(trimmed) || /^\s*•\s*.+ · in .+ · out .+/i.test(trimmed))) return null

  if (/^Not configured/i.test(trimmed)) {
    return (
      <div style={{ padding: '12px 14px', borderRadius: 10, background: TONE_STYLES.warn.bg, border: `1px solid ${TONE_STYLES.warn.border}`, color: C.amber, fontSize: 12, lineHeight: 1.5 }}>
        ⚠ {trimmed.replace(/^\s+/, '')}
      </div>
    )
  }

  if (/^Unreachable:/i.test(trimmed)) {
    return (
      <div style={{ padding: '12px 14px', borderRadius: 10, background: TONE_STYLES.bad.bg, border: `1px solid ${TONE_STYLES.bad.border}`, color: C.red, fontSize: 12 }}>
        ✕ {trimmed.replace(/^\s+/, '')}
      </div>
    )
  }

  const subHeader = trimmed.match(/^\s{2}([A-Za-z][^:]+):$/)
  if (subHeader) {
    const icons = {
      'Device breakdown': '📊',
      'Sample hosts': '🖥️',
      'Host details': '🏷️',
      'Ping / ICMP sensors': '📡',
      'Ping status by host': '✓',
      'Interface traffic': '📈',
      'Top problems': '⚠️',
      'Active problems (all matched)': '🚨',
      'Active problems': '🚨',
    }
    return <SubSectionTitle title={subHeader[1]} icon={icons[subHeader[1]] || '▸'} />
  }

  const problem = trimmed.match(/^\s*•\s*\[[^\]]+\]/)
  if (problem) return <ProblemItem line={trimmed} />

  const hostBullet = trimmed.match(/^\s*•\s*(.+?)\s*\[(\w+)\]\s*—\s*(available|unavailable|down|unknown|up)$/i)
  if (hostBullet) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, padding: '6px 8px', borderRadius: 8, background: 'rgba(0,0,0,.06)' }}>
        <span style={{ fontSize: 14 }}>🖥️</span>
        <span style={{ fontSize: 12, color: C.text, fontWeight: 600, flex: 1 }}>{hostBullet[1]}</span>
        <Badge tone="neutral" small>{hostBullet[2]}</Badge>
        <Badge tone={severityTone(hostBullet[3])} small>{hostBullet[3]}</Badge>
      </div>
    )
  }

  const hostSimple = trimmed.match(/^\s*•\s*(.+?)(?:\s—\s|\s-\s)(available|unavailable|down|unknown|up)$/i)
  if (hostSimple) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, padding: '6px 8px', borderRadius: 8, background: 'rgba(0,0,0,.06)' }}>
        <span style={{ fontSize: 12, color: C.text, fontWeight: 600, flex: 1 }}>{hostSimple[1]}</span>
        <Badge tone={severityTone(hostSimple[2])} small>{hostSimple[2]}</Badge>
      </div>
    )
  }

  const hostDetail = trimmed.match(/^\s*•\s*(.+?)\s*\[(\w+)\]\s*—\s*(available|unavailable|down)$/i)
  if (hostDetail && !trimmed.includes('Zabbix groups')) {
    return null
  }

  const pingLine = trimmed.match(/^\s*•\s*(.+?) · ping (OK|FAIL|unreachable)/i)
  if (pingLine) {
    const tone = /ok/i.test(pingLine[2]) ? 'good' : 'bad'
    const t = TONE_STYLES[tone]
    return (
      <div style={{ padding: '10px 12px', borderRadius: 10, background: t.bg, border: `1px solid ${t.border}`, fontSize: 12, color: C.text2, fontFamily: 'var(--mono)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{tone === 'good' ? '✅' : '❌'}</span>
        {trimmed.replace(/^\s*•\s*/, '')}
      </div>
    )
  }

  const indent = trimmed.match(/^(\s{4,})(.+)$/)
  if (indent && !indent[2].startsWith('•')) {
    const isGroup = /Zabbix groups:/i.test(indent[2])
    const isIp = /Interface IPs:/i.test(indent[2])
    if (isGroup || isIp) return null
    return (
      <div style={{ marginLeft: 12, fontSize: 11, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 3, lineHeight: 1.45 }}>
        {parseInlineBold(indent[2])}
      </div>
    )
  }

  const bullet = trimmed.match(/^\s*•\s*(.+)$/)
  if (bullet) {
    const isDeviceType = /:\s*\d+/.test(bullet[1]) && /devices|firewalls|servers|switch/i.test(bullet[1])
    if (isDeviceType) {
      return (
        <div style={{ display: 'inline-flex', marginRight: 6, marginBottom: 6 }}>
          <Badge tone="info" small>{bullet[1]}</Badge>
        </div>
      )
    }
    return (
      <div style={{ fontSize: 12, color: C.text2, marginBottom: 5, paddingLeft: 2, lineHeight: 1.45, display: 'flex', gap: 8 }}>
        <span style={{ color: C.accent, fontWeight: 700 }}>•</span>
        <span>{parseInlineBold(bullet[1])}</span>
      </div>
    )
  }

  if (/^Device breakdown:/i.test(trimmed.replace(/^\s+/, ''))) return null

  return (
    <div style={{ fontSize: 12, color: C.text2, lineHeight: 1.5, marginBottom: 3 }}>
      {parseInlineBold(trimmed.replace(/^\s{2}/, ''))}
    </div>
  )
}

function filterHostDetailLines(lines) {
  const out = []
  let inBlock = false
  for (const line of lines) {
    if (/^\s{2}Host details:/i.test(line)) {
      inBlock = true
      continue
    }
    if (inBlock) {
      if (/^\s{2}[A-Za-z][^:]+:$/.test(line) && !/^\s{4,}/.test(line)) {
        inBlock = false
        out.push(line)
      }
      continue
    }
    out.push(line)
  }
  return out
}

function parseHostDetails(lines) {
  const hosts = []
  let current = null
  for (const line of lines) {
    const main = line.match(/^\s*•\s*(.+?)\s*\[(\w+)\]\s*—\s*(\w+)/)
    if (main) {
      if (current) hosts.push(current)
      current = { name: main[1], type: main[2], status: main[3], groups: [], ips: [] }
      continue
    }
    if (current) {
      const g = line.match(/^\s+Zabbix groups:\s*(.+)$/)
      if (g) { current.groups = g[1].split(',').map(s => s.trim()).filter(Boolean); continue }
      const ip = line.match(/^\s+Interface IPs:\s*(.+)$/)
      if (ip) { current.ips = ip[1].split(',').map(s => s.trim()).filter(Boolean); continue }
    }
  }
  if (current) hosts.push(current)
  return hosts
}

function maxTrafficFromLines(lines) {
  let max = 0
  for (const line of lines) {
    for (const re of [/in ([\d.]+\s*(?:Mbps|Kbps|Gbps|bps))/i, /out ([\d.]+\s*(?:Mbps|Kbps|Gbps|bps))/i]) {
      const m = line.match(re)
      if (m) {
        const p = parseMbps(m[1])
        if (p?.bps > max) max = p.bps
      }
    }
  }
  return max || 1e6
}

function SectionBlock({ title, lines }) {
  const theme = themeForSection(title)
  const { kpis, rest } = parseKpiLines(lines)
  const maxTrafficBps = maxTrafficFromLines(lines)
  const isStoreUnconfigured = lines.some(l => /Not configured/i.test(l))
  const problemCount = kpis.find(k => /active problems/i.test(k.label))?.value
  const hosts = parseHostDetails(lines)
  const hasTraffic = rest.some(l => / · in .+ · out .+/i.test(l))
  const inHostDetails = rest.some(l => /Host details:/i.test(l))
  const showHostCards = hosts.length > 0 && inHostDetails
  const bodyLines = showHostCards ? filterHostDetailLines(rest) : rest

  return (
    <div className="ai-section-card" style={{ border: `1px solid ${theme.accent}44`, background: theme.bg, marginBottom: 4 }}>
      <div className="ai-section-head" style={{ background: `linear-gradient(90deg, ${theme.accent}28, transparent)`, borderBottom: `1px solid ${theme.accent}33` }}>
        <div className="ai-section-icon" style={{ background: `${theme.accent}22`, border: `1px solid ${theme.accent}44` }}>
          {theme.icon}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: theme.accent, letterSpacing: '-0.01em' }}>{title}</div>
          <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', marginTop: 2 }}>{theme.emoji} module</div>
        </div>
        {isStoreUnconfigured && <Badge tone="warn" small>Not configured</Badge>}
      </div>
      <div style={{ padding: '12px 16px 14px' }}>
        <ProblemsBanner count={Number(problemCount) || 0} />
        <KpiGrid items={kpis} />
        {showHostCards && (
          <>
            <SubSectionTitle title="Host details" icon="🏷️" />
            {hosts.map(h => (
              <HostCard key={h.name} name={h.name} status={h.status} type={h.type} groups={h.groups} ips={h.ips} />
            ))}
          </>
        )}
        {hasTraffic && (
          <>
            <SubSectionTitle title="Interface traffic" icon="📈" />
            <TrafficList lines={bodyLines} maxTrafficBps={maxTrafficBps} />
          </>
        )}
        {bodyLines.map((line, i) => (
          <SectionLine key={i} line={line} maxTrafficBps={maxTrafficBps} skipTraffic={hasTraffic} />
        ))}
      </div>
    </div>
  )
}

function MessageHeader({ header }) {
  if (!header) return null
  const lines = header.split('\n').filter(l => l.trim())
  const titleLine = lines[0] || ''
  const meta = lines.slice(1)
  const isLive = /LIVE/i.test(titleLine)
  const liveMeta = titleLine.match(/\(LIVE\s*—\s*fetched\s*([^)]+)\)/i)
  const titleClean = titleLine.replace(/\(LIVE[^)]*\)/i, '').replace(/\s{2,}/g, ' ').trim()
  const isAnalysis = /analysis|report|summary/i.test(titleClean)
  const isIp = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(titleClean)

  return (
    <div className="ai-msg-header">
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: meta.length || liveMeta ? 8 : 0 }}>
          <span style={{ fontSize: 24 }}>{isIp ? '🔥' : isAnalysis ? '📊' : '📡'}</span>
          {isLive && <Badge tone="good" pulse>LIVE</Badge>}
          <span style={{ fontSize: 15, fontWeight: 800, color: C.text, lineHeight: 1.35, letterSpacing: '-0.02em' }}>{titleClean}</span>
        </div>
        {liveMeta && (
          <div style={{ fontSize: 11, color: C.text3, fontFamily: 'var(--mono)', marginBottom: meta.length ? 6 : 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>🕐</span> Fetched {liveMeta[1].trim()}
          </div>
        )}
        {meta.map((line, i) => (
          <div key={i} style={{ fontSize: 11, color: C.text2, fontFamily: 'var(--mono)', marginTop: i ? 3 : 0, padding: '4px 10px', borderRadius: 6, background: 'rgba(0,0,0,.12)', display: 'inline-block' }}>
            {line.trim()}
          </div>
        ))}
      </div>
    </div>
  )
}

function AnalysisBlock({ text }) {
  const blocks = []
  const lines = text.split('\n')
  let current = { title: null, lines: [] }

  const flush = () => {
    if (current.title || current.lines.some(l => l.trim())) blocks.push({ ...current })
    current = { title: null, lines: [] }
  }

  for (const line of lines) {
    const heading = line.match(/^\*\*(.+?)\*\*\s*$/)
    if (heading) {
      flush()
      current.title = heading[1]
      continue
    }
    current.lines.push(line)
  }
  flush()

  const sectionColors = {
    'Executive Summary': '#4f7ef5',
    'Key Findings': '#22d3a0',
    'Risks / Impact': '#f59e0b',
    Risks: '#f59e0b',
    'Recommended Actions': '#a78bfa',
  }

  return (
    <div className="ai-analysis-root" style={{ border: '1px solid rgba(34,211,160,.35)', background: 'linear-gradient(180deg, rgba(34,211,160,.1) 0%, rgba(79,126,245,.05) 100%)' }}>
      <div className="ai-analysis-head">
        <span style={{ fontSize: 22 }}>✨</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.green }}>AI Analysis</div>
          <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>SocMon AI · evidence-based</div>
        </div>
      </div>
      <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {blocks.map((block, i) => {
          const accent = sectionColors[block.title] || C.accent
          const icon = ANALYSIS_ICONS[block.title] || '📝'
          const isActions = /recommended actions/i.test(block.title || '')
          return (
            <div
              key={i}
              className="ai-analysis-block"
              style={{ border: `1px solid ${accent}33`, borderLeft: `4px solid ${accent}` }}
            >
              {block.title && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 800, color: accent, marginBottom: 10, fontFamily: 'var(--mono)' }}>
                  <span>{icon}</span>
                  {block.title}
                </div>
              )}
              {block.lines.map((line, j) => {
                const trimmed = line.trim()
                if (!trimmed) return null
                const num = trimmed.match(/^(\d+)\.\s+\*\*(.+?)\*\*:?\s*(.*)$/) || trimmed.match(/^(\d+)\.\s+\*\*(.+?)\*\*\s*(.*)$/)
                if (num || (isActions && trimmed.match(/^(\d+)\.\s+/))) {
                  const n = num || trimmed.match(/^(\d+)\.\s+(.+)$/)
                  const step = n[1]
                  const body = num ? `${num[2]}${num[3] ? `: ${num[3]}` : ''}` : n[2]
                  return (
                    <div key={j} style={{ display: 'flex', gap: 10, marginBottom: 10, fontSize: 12, lineHeight: 1.55, alignItems: 'flex-start' }}>
                      <div className="ai-action-num" style={{ background: `${accent}22`, color: accent, border: `1px solid ${accent}44` }}>{step}</div>
                      <span style={{ color: C.text2, paddingTop: 4 }}>{parseInlineBold(body)}</span>
                    </div>
                  )
                }
                const bullet = trimmed.match(/^[•\-\*]\s+(.+)$/)
                if (bullet) {
                  return (
                    <div key={j} style={{ display: 'flex', gap: 8, marginBottom: 7, fontSize: 12, lineHeight: 1.55, color: C.text2 }}>
                      <span style={{ color: accent, flexShrink: 0, fontWeight: 700 }}>▸</span>
                      <span>{parseInlineBold(bullet[1])}</span>
                    </div>
                  )
                }
                const starBullet = trimmed.match(/^\*\s+(.+)$/)
                if (starBullet) {
                  return (
                    <div key={j} style={{ display: 'flex', gap: 8, marginBottom: 6, fontSize: 12, color: C.text2, marginLeft: 4 }}>
                      <span style={{ color: accent }}>◦</span>
                      <span>{parseInlineBold(starBullet[1])}</span>
                    </div>
                  )
                }
                return (
                  <div key={j} style={{ fontSize: 13, color: C.text2, lineHeight: 1.6, marginBottom: 6 }}>
                    {parseInlineBold(trimmed)}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RichTextFallback({ content }) {
  const isWelcome = /^SocMon AI — four chat modes/i.test(String(content || ''))
  const lines = String(content || '').split('\n')

  if (isWelcome) {
    const modes = [
      { mode: 'Monitor', icon: '⚡', color: '#4f7ef5' },
      { mode: 'Agent', icon: '🧠', color: '#a78bfa' },
      { mode: 'Details', icon: '🔍', color: '#22d3a0' },
      { mode: 'RCA', icon: '🎯', color: '#f97316' },
    ]
    return (
      <div className="ai-welcome-compact">
        <div className="ai-welcome-compact-title">🤖 SocMon AI — pick a mode above, then ask.</div>
        <div className="ai-welcome-modes">
          {modes.map(m => (
            <span key={m.mode} className="ai-welcome-mode" style={{ color: m.color, borderColor: `${m.color}44` }}>
              {m.icon} {m.mode}
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="ai-prose-fallback">
      {lines.map((line, i) => {
        const trimmed = line.trim()
        if (!trimmed) return <div key={i} style={{ height: 8 }} />
        const heading = trimmed.match(/^\*\*(.+)\*\*$/)
        if (heading) {
          return <div key={i} className="ai-prose-heading" style={{ color: C.accent }}>{heading[1]}</div>
        }
        const num = trimmed.match(/^(\d+)\.\s+(.+)$/)
        if (num) {
          return (
            <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13, lineHeight: 1.55, color: C.text2, marginBottom: 6 }}>
              <span style={{ color: C.accent, fontWeight: 800, fontFamily: 'var(--mono)', minWidth: 20 }}>{num[1]}.</span>
              <span>{parseInlineBold(num[2])}</span>
            </div>
          )
        }
        const bullet = trimmed.match(/^[•\-\*]\s+(.+)$/)
        if (bullet) {
          return (
            <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13, lineHeight: 1.55, color: C.text2, marginBottom: 5 }}>
              <span style={{ color: C.accent, fontWeight: 700 }}>▸</span>
              <span>{parseInlineBold(bullet[1])}</span>
            </div>
          )
        }
        if (/LIVE/i.test(trimmed)) {
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              <Badge tone="good" pulse>LIVE</Badge>
              <span style={{ fontSize: 13, color: C.text2 }}>{parseInlineBold(trimmed.replace(/\(LIVE[^)]*\)/i, '').trim())}</span>
            </div>
          )
        }
        return (
          <div key={i} style={{ fontSize: 13, lineHeight: 1.6, color: C.text2, marginBottom: 4 }}>
            {parseInlineBold(trimmed)}
          </div>
        )
      })}
    </div>
  )
}

export default function AiMessageContent({ content }) {
  const parsed = parseStructuredMessage(content)

  if (!parsed.structured) {
    return <RichTextFallback content={content} />
  }

  return (
    <div className="ai-msg-root">
      <MessageHeader header={parsed.header} />
      {parsed.sections.map(s => (
        <SectionBlock key={s.title} title={s.title} lines={s.lines} />
      ))}
      {parsed.analysis && <AnalysisBlock text={parsed.analysis} />}
      {parsed.footer && (
        <div className="ai-footer-note">{parsed.footer.replace(/^\(|\)$/g, '')}</div>
      )}
    </div>
  )
}
