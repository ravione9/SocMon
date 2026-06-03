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
  'Infra Zabbix': { accent: '#4f7ef5', bg: 'rgba(79,126,245,.1)', icon: '◆' },
  'Store Zabbix': { accent: '#a78bfa', bg: 'rgba(167,139,250,.1)', icon: '◇' },
  'Store Monitor': { accent: '#22d3a0', bg: 'rgba(34,211,160,.1)', icon: '●' },
  'FortiGate / SOC': { accent: '#f97316', bg: 'rgba(249,115,22,.1)', icon: '▣' },
  'SOC / firewall': { accent: '#f97316', bg: 'rgba(249,115,22,.1)', icon: '▣' },
  NOC: { accent: '#38bdf8', bg: 'rgba(56,189,248,.1)', icon: '◈' },
  Sentinel: { accent: '#fb7185', bg: 'rgba(251,113,133,.1)', icon: '◉' },
  XDR: { accent: '#e879f9', bg: 'rgba(232,121,249,.1)', icon: '◎' },
}

function themeForSection(title) {
  if (SECTION_THEMES[title]) return SECTION_THEMES[title]
  const key = Object.keys(SECTION_THEMES).find(k => title.toLowerCase().includes(k.toLowerCase()))
  if (key) return SECTION_THEMES[key]
  return { accent: C.accent, bg: 'rgba(79,126,245,.08)', icon: '▸' }
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

function severityTone(label) {
  const s = String(label || '').toLowerCase()
  if (/disaster|high|critical|down|unreachable|failed|error|deny/.test(s)) return 'bad'
  if (/average|warning|degraded|stale|unknown/.test(s)) return 'warn'
  if (/info|not classified/.test(s)) return 'info'
  if (/available|ok|reachable|allowed|up|live/.test(s)) return 'good'
  return 'neutral'
}

const TONE_STYLES = {
  good: { color: C.green, bg: 'rgba(34,211,160,.14)', border: 'rgba(34,211,160,.35)' },
  warn: { color: C.amber, bg: 'rgba(245,166,35,.14)', border: 'rgba(245,166,35,.35)' },
  bad: { color: C.red, bg: 'rgba(248,113,113,.14)', border: 'rgba(248,113,113,.35)' },
  info: { color: '#38bdf8', bg: 'rgba(56,189,248,.12)', border: 'rgba(56,189,248,.3)' },
  neutral: { color: C.text2, bg: C.bg2, border: C.border },
}

function Badge({ children, tone = 'neutral', small = false }) {
  const t = TONE_STYLES[tone] || TONE_STYLES.neutral
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: small ? '2px 7px' : '3px 10px',
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

function parseInlineBold(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    const m = part.match(/^\*\*(.+)\*\*$/)
    if (m) return <strong key={i} style={{ color: C.text, fontWeight: 700 }}>{m[1]}</strong>
    return part
  })
}

function parseMbps(str) {
  const m = String(str || '').match(/([\d.]+)\s*(Mbps|Kbps|bps|Gbps)/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  const mult = unit === 'gbps' ? 1e9 : unit === 'mbps' ? 1e6 : unit === 'kbps' ? 1e3 : 1
  return { display: `${m[1]} ${m[2]}`, bps: n * mult }
}

function TrafficBar({ label, inVal, outVal, status, maxBps }) {
  const inParsed = parseMbps(inVal)
  const outParsed = parseMbps(outVal)
  const inPct = inParsed && maxBps ? Math.min(100, (inParsed.bps / maxBps) * 100) : 0
  const outPct = outParsed && maxBps ? Math.min(100, (outParsed.bps / maxBps) * 100) : 0
  const stTone = status === 'up' ? 'good' : status === 'down' ? 'bad' : 'neutral'

  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 8,
        background: C.bg2,
        border: `1px solid ${C.border}`,
        marginBottom: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: 'var(--mono)' }}>{label}</span>
        {status && <Badge tone={stTone} small>{status}</Badge>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr auto', gap: '4px 8px', alignItems: 'center', fontSize: 11, fontFamily: 'var(--mono)' }}>
        <span style={{ color: '#38bdf8', fontWeight: 700 }}>IN</span>
        <div style={{ height: 6, borderRadius: 3, background: C.bg3, overflow: 'hidden' }}>
          <div style={{ width: `${inPct}%`, height: '100%', background: 'linear-gradient(90deg,#0ea5e9,#38bdf8)', borderRadius: 3 }} />
        </div>
        <span style={{ color: C.text2, whiteSpace: 'nowrap' }}>{inVal || '—'}</span>
        <span style={{ color: '#a78bfa', fontWeight: 700 }}>OUT</span>
        <div style={{ height: 6, borderRadius: 3, background: C.bg3, overflow: 'hidden' }}>
          <div style={{ width: `${outPct}%`, height: '100%', background: 'linear-gradient(90deg,#7c3aed,#a78bfa)', borderRadius: 3 }} />
        </div>
        <span style={{ color: C.text2, whiteSpace: 'nowrap' }}>{outVal || '—'}</span>
      </div>
    </div>
  )
}

function StatPills({ line }) {
  const m = line.match(/^(\s*)([^:]+):\s*(.+)$/)
  if (!m) return null
  const label = m[2].trim()
  const rest = m[3]
  const parts = rest.split(/\s·\s/)
  if (parts.length < 2) return null

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {parts.map((p, i) => {
          const kv = p.match(/^(\w[\w\s]*?)\s+([\d.,]+|%|[\w]+)/) || p.match(/^([^:]+)$/)
          const text = p.trim()
          let tone = 'neutral'
          if (/available|online|reachable|ok|up|allowed/i.test(text)) tone = 'good'
          else if (/down|offline|unreachable|deny|critical|disaster|high/i.test(text)) tone = 'bad'
          else if (/unknown|degraded|warning|average|issues|stale/i.test(text)) tone = 'warn'
          return <Badge key={i} tone={tone}>{text}</Badge>
        })}
      </div>
    </div>
  )
}

function ProblemItem({ line }) {
  const m = line.match(/^\s*•\s*\[([^\]]+)\]\s*(.+)$/)
  if (!m) return <div style={{ fontSize: 12, color: C.text2, marginLeft: 8 }}>{parseInlineBold(line.trim())}</div>
  const tone = severityTone(m[1])
  const rest = m[2]
  const since = rest.match(/ · since (.+)$/)
  const name = since ? rest.slice(0, since.index) : rest
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '8px 10px',
        marginBottom: 6,
        borderRadius: 8,
        background: TONE_STYLES[tone].bg,
        border: `1px solid ${TONE_STYLES[tone].border}`,
      }}
    >
      <Badge tone={tone} small>{m[1]}</Badge>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, lineHeight: 1.4 }}>{name.trim()}</div>
        {since && (
          <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', marginTop: 3 }}>
            since {since[1]}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionLine({ line, maxTrafficBps }) {
  const trimmed = line.trimEnd()
  if (!trimmed) return <div style={{ height: 6 }} />

  if (/^Not configured/i.test(trimmed)) {
    return (
      <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(245,166,35,.1)', border: `1px solid ${C.amber}`, color: C.amber, fontSize: 12, lineHeight: 1.5 }}>
        ⚠ {trimmed.replace(/^\s+/, '')}
      </div>
    )
  }

  if (/^Unreachable:/i.test(trimmed)) {
    return (
      <div style={{ padding: '10px 12px', borderRadius: 8, background: TONE_STYLES.bad.bg, border: `1px solid ${TONE_STYLES.bad.border}`, color: C.red, fontSize: 12 }}>
        {trimmed.replace(/^\s+/, '')}
      </div>
    )
  }

  const statPills = trimmed.match(/^(Version|Total monitored|Active problems|Ping \/ ICMP|Reachable|Latency avg):/i)
  if (statPills) {
    const stat = StatPills({ line: trimmed })
    if (stat) return stat
  }

  const subHeader = trimmed.match(/^\s{2}([A-Za-z][^:]+):$/)
  if (subHeader) {
    return (
      <div style={{ fontSize: 11, fontWeight: 700, color: C.text2, margin: '10px 0 6px', fontFamily: 'var(--mono)', letterSpacing: '0.02em' }}>
        {subHeader[1]}
      </div>
    )
  }

  const iface = trimmed.match(/^\s*•\s*(.+?) · in (.+?) · out (.+?)(?: · (\w+))?\s*$/)
  if (iface) {
    return (
      <TrafficBar
        label={iface[1]}
        inVal={iface[2]}
        outVal={iface[3]}
        status={iface[4]}
        maxBps={maxTrafficBps}
      />
    )
  }

  const problem = trimmed.match(/^\s*•\s*\[[^\]]+\]/)
  if (problem) return <ProblemItem line={trimmed} />

  const hostBullet = trimmed.match(/^\s*•\s*(.+?)(?:\s—\s|\s-\s)(available|unavailable|down|unknown|up)$/i)
  if (hostBullet) {
    const tone = severityTone(hostBullet[2])
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4, fontSize: 12 }}>
        <span style={{ color: C.text2 }}>• {hostBullet[1]}</span>
        <Badge tone={tone} small>{hostBullet[2]}</Badge>
      </div>
    )
  }

  const pingLine = trimmed.match(/^\s*•\s*(.+?) · ping (OK|FAIL|unreachable)/i)
  if (pingLine) {
    const tone = /ok/i.test(pingLine[2]) ? 'good' : 'bad'
    return (
      <div
        style={{
          padding: '8px 10px',
          borderRadius: 8,
          background: TONE_STYLES[tone].bg,
          border: `1px solid ${TONE_STYLES[tone].border}`,
          fontSize: 12,
          color: C.text2,
          fontFamily: 'var(--mono)',
          marginBottom: 6,
        }}
      >
        {trimmed.replace(/^\s*•\s*/, '')}
      </div>
    )
  }

  const indent = trimmed.match(/^(\s+)•\s*(.+)$/) || trimmed.match(/^(\s{4,})(.+)$/)
  if (indent) {
    return (
      <div style={{ marginLeft: 16, fontSize: 11, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 3, lineHeight: 1.45 }}>
        {parseInlineBold(indent[2] || indent[1])}
      </div>
    )
  }

  const bullet = trimmed.match(/^\s*•\s*(.+)$/)
  if (bullet) {
    return (
      <div style={{ fontSize: 12, color: C.text2, marginBottom: 4, paddingLeft: 4, lineHeight: 1.45 }}>
        <span style={{ color: C.accent, marginRight: 6 }}>•</span>
        {parseInlineBold(bullet[1])}
      </div>
    )
  }

  return (
    <div style={{ fontSize: 12, color: C.text2, lineHeight: 1.5, marginBottom: 2 }}>
      {parseInlineBold(trimmed.replace(/^\s{2}/, ''))}
    </div>
  )
}

function maxTrafficFromLines(lines) {
  let max = 0
  for (const line of lines) {
    const m = line.match(/in ([\d.]+\s*(?:Mbps|Kbps|Gbps|bps))/i)
    if (m) {
      const p = parseMbps(m[1])
      if (p?.bps > max) max = p.bps
    }
    const m2 = line.match(/out ([\d.]+\s*(?:Mbps|Kbps|Gbps|bps))/i)
    if (m2) {
      const p = parseMbps(m2[1])
      if (p?.bps > max) max = p.bps
    }
  }
  return max || 1e6
}

function SectionBlock({ title, lines }) {
  const theme = themeForSection(title)
  const maxTrafficBps = maxTrafficFromLines(lines)
  const isStoreUnconfigured = lines.some(l => /Not configured/i.test(l))

  return (
    <div
      style={{
        borderRadius: 12,
        overflow: 'hidden',
        border: `1px solid ${theme.accent}44`,
        background: theme.bg,
        marginBottom: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          background: `linear-gradient(90deg, ${theme.accent}22, transparent)`,
          borderBottom: `1px solid ${theme.accent}33`,
        }}
      >
        <span style={{ color: theme.accent, fontSize: 14 }}>{theme.icon}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: theme.accent, letterSpacing: '0.01em' }}>{title}</span>
        {isStoreUnconfigured && <Badge tone="warn" small>Not configured</Badge>}
      </div>
      <div style={{ padding: '10px 14px 12px' }}>
        {lines.map((line, i) => (
          <SectionLine key={i} line={line} maxTrafficBps={maxTrafficBps} />
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
  const titleClean = titleLine
    .replace(/\(LIVE[^)]*\)/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return (
    <div
      style={{
        marginBottom: 12,
        padding: '12px 14px',
        borderRadius: 12,
        background: 'linear-gradient(135deg, rgba(79,126,245,.18) 0%, rgba(34,211,160,.08) 100%)',
        border: `1px solid ${C.accent}55`,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: meta.length || liveMeta ? 6 : 0 }}>
        {isLive && <Badge tone="good">LIVE</Badge>}
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text, lineHeight: 1.35 }}>{titleClean}</span>
      </div>
      {liveMeta && (
        <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', marginBottom: meta.length ? 4 : 0 }}>
          Fetched {liveMeta[1].trim()}
        </div>
      )}
      {meta.map((line, i) => (
        <div key={i} style={{ fontSize: 11, color: C.text3, fontFamily: 'var(--mono)', marginTop: i ? 2 : 0 }}>
          {line.trim()}
        </div>
      ))}
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
    'Risks / Impact': C.amber,
    'Risks': C.amber,
    'Recommended Actions': '#a78bfa',
  }

  return (
    <div
      style={{
        marginTop: 4,
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid rgba(34,211,160,.35)',
        background: 'linear-gradient(180deg, rgba(34,211,160,.12) 0%, rgba(79,126,245,.06) 100%)',
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid rgba(34,211,160,.25)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 16 }}>✦</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.green }}>AI Analysis</span>
      </div>
      <div style={{ padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {blocks.map((block, i) => {
          const accent = sectionColors[block.title] || C.accent
          return (
            <div
              key={i}
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                background: C.bg2,
                border: `1px solid ${accent}33`,
                borderLeft: `3px solid ${accent}`,
              }}
            >
              {block.title && (
                <div style={{ fontSize: 12, fontWeight: 700, color: accent, marginBottom: 8, fontFamily: 'var(--mono)' }}>
                  {block.title}
                </div>
              )}
              {block.lines.map((line, j) => {
                const trimmed = line.trim()
                if (!trimmed) return null
                const num = trimmed.match(/^(\d+)\.\s+\*\*(.+?)\*\*:?\s*(.*)$/)
                if (num) {
                  return (
                    <div key={j} style={{ display: 'flex', gap: 8, marginBottom: 8, fontSize: 12, lineHeight: 1.5 }}>
                      <span style={{ color: accent, fontWeight: 700, fontFamily: 'var(--mono)', flexShrink: 0 }}>{num[1]}.</span>
                      <span style={{ color: C.text2 }}>
                        <strong style={{ color: C.text }}>{num[2]}</strong>
                        {num[3] ? `: ${num[3]}` : ''}
                      </span>
                    </div>
                  )
                }
                const bullet = trimmed.match(/^[•\-\*]\s+\*\*(.+?)\*\*:?\s*(.*)$/) || trimmed.match(/^[•\-\*]\s+(.+)$/)
                if (bullet) {
                  const boldPart = trimmed.match(/\*\*(.+?)\*\*/)
                  return (
                    <div key={j} style={{ display: 'flex', gap: 8, marginBottom: 6, fontSize: 12, lineHeight: 1.5, color: C.text2 }}>
                      <span style={{ color: accent, flexShrink: 0 }}>•</span>
                      <span>{parseInlineBold(bullet[2] || bullet[1] || trimmed.replace(/^[•\-\*]\s+/, ''))}</span>
                    </div>
                  )
                }
                const starBullet = trimmed.match(/^\*\s+(.+)$/)
                if (starBullet) {
                  return (
                    <div key={j} style={{ display: 'flex', gap: 8, marginBottom: 6, fontSize: 12, color: C.text2, marginLeft: 8 }}>
                      <span style={{ color: accent }}>◦</span>
                      <span>{parseInlineBold(starBullet[1])}</span>
                    </div>
                  )
                }
                return (
                  <div key={j} style={{ fontSize: 12, color: C.text2, lineHeight: 1.55, marginBottom: 4 }}>
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
  const lines = String(content || '').split('\n')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {lines.map((line, i) => {
        const trimmed = line.trim()
        if (!trimmed) return <div key={i} style={{ height: 6 }} />
        const heading = trimmed.match(/^\*\*(.+)\*\*$/)
        if (heading) {
          return (
            <div key={i} style={{ fontSize: 13, fontWeight: 700, color: C.accent, marginTop: 8, marginBottom: 4 }}>
              {heading[1]}
            </div>
          )
        }
        const num = trimmed.match(/^(\d+)\.\s+(.+)$/)
        if (num) {
          return (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.5, color: C.text2 }}>
              <span style={{ color: C.accent, fontWeight: 700, fontFamily: 'var(--mono)' }}>{num[1]}.</span>
              <span>{parseInlineBold(num[2])}</span>
            </div>
          )
        }
        const bullet = trimmed.match(/^[•\-\*]\s+(.+)$/)
        if (bullet) {
          return (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.5, color: C.text2, paddingLeft: 4 }}>
              <span style={{ color: C.accent }}>•</span>
              <span>{parseInlineBold(bullet[1])}</span>
            </div>
          )
        }
        if (/LIVE/i.test(trimmed)) {
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Badge tone="good">LIVE</Badge>
              <span style={{ fontSize: 13, color: C.text2 }}>{parseInlineBold(trimmed.replace(/\(LIVE[^)]*\)/i, '').trim())}</span>
            </div>
          )
        }
        return (
          <div key={i} style={{ fontSize: 13, lineHeight: 1.55, color: C.text2 }}>
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
    <div style={{ width: '100%' }}>
      <MessageHeader header={parsed.header} />
      {parsed.sections.map(s => (
        <SectionBlock key={s.title} title={s.title} lines={s.lines} />
      ))}
      {parsed.analysis && <AnalysisBlock text={parsed.analysis} />}
      {parsed.footer && (
        <div style={{ marginTop: 8, fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', textAlign: 'center' }}>
          {parsed.footer.replace(/^\(|\)$/g, '')}
        </div>
      )}
    </div>
  )
}
