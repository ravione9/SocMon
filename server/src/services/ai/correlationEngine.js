/**
 * Cross-source event correlation for RCA and advanced monitoring.
 * Normalizes signals from Store Monitor, Sentinel, SOC, NOC, crashes, and problems
 * into a single timeline and ranked hypotheses.
 */

/** @typedef {{ ts: string|null, source: string, category: string, severity: 'critical'|'high'|'medium'|'low', summary: string, detail?: string }} TimelineEvent */
/** @typedef {{ rank: number, confidence: 'high'|'medium'|'low', title: string, reasoning: string, evidenceIds: number[] }} Hypothesis */

export function normalizeEvent({ ts, source, category, severity = 'medium', summary, detail = '' }) {
  return {
    ts: ts || null,
    source: String(source || 'unknown'),
    category: String(category || 'event'),
    severity: severity || 'medium',
    summary: String(summary || '').slice(0, 200),
    detail: String(detail || '').slice(0, 300),
  }
}

export function mergeTimeline(events) {
  return (events || [])
    .filter(e => e && (e.ts || e.summary))
    .sort((a, b) => {
      const ta = a.ts ? new Date(a.ts).getTime() : 0
      const tb = b.ts ? new Date(b.ts).getTime() : 0
      return tb - ta
    })
}

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }

export function rankHypotheses(signals, store = null) {
  /** @type {Hypothesis[]} */
  const out = []
  let rank = 1

  const push = (confidence, title, reasoning, evidenceIds = []) => {
    out.push({ rank: rank++, confidence, title, reasoning, evidenceIds })
  }

  if (store && store.online === false) {
    const loss = store.packetLossPct
    const ping = store.avgPingMs
    if (loss != null && Number(loss) >= 50) {
      push('high', 'Store connectivity loss',
        `Store is offline with ${loss}% packet loss${ping != null ? ` (ping ${ping} ms)` : ''} — likely gateway, ISP, or SD-WAN path failure.`,
        signals.filter(s => s.category === 'connectivity').map((_, i) => i))
    } else {
      push('high', 'Store agent offline',
        'Store Monitor reports the agent offline — check power, local network, or agent service at the site.',
        signals.filter(s => s.category === 'connectivity').map((_, i) => i))
    }
  }

  const updown = signals.filter(s => s.category === 'interface_down' || s.source === 'noc')
  if (updown.length >= 2) {
    push('high', 'Network interface instability',
      `${updown.length} Cisco UPDOWN / interface events in the window — link flap or upstream switch issue may have caused outage.`,
      updown.map((_, i) => i))
  } else if (updown.length === 1) {
    push('medium', 'Network interface change',
      'A Cisco interface state change was logged near the incident window — verify switch port and uplink.',
      [0])
  }

  const agentDisc = signals.filter(s => s.category === 'agent_disconnect')
  if (agentDisc.length >= 2 && store?.online !== false) {
    push('medium', 'Endpoint agent connectivity',
      `${agentDisc.length} Sentinel agent disconnect events while store metrics may still show online — agent or management path issue.`,
      agentDisc.map((_, i) => i))
  }

  const usbDisc = signals.filter(s => s.category === 'usb_disconnect')
  if (usbDisc.length >= 5) {
    push('medium', 'Peripheral / USB instability',
      `${usbDisc.length} USB disconnect events — local USB/peripheral churn; usually not root cause of store outage unless POS devices affected.`,
      usbDisc.map((_, i) => i))
  }

  const threats = signals.filter(s => s.category === 'threat')
  if (threats.length) {
    push('high', 'Security threat activity',
      `${threats.length} threat-related events on this host — review SentinelOne quarantine/mitigation status.`,
      threats.map((_, i) => i))
  }

  const denies = signals.filter(s => s.category === 'firewall_deny')
  if (denies.length >= 10) {
    push('medium', 'Elevated firewall denies',
      `${denies.length} deny events scoped to this host — policy block or attack traffic may affect applications.`,
      denies.map((_, i) => i))
  }

  const crashes = signals.filter(s => s.category === 'crash')
  if (crashes.length) {
    const total = crashes.reduce((n, c) => n + (c.count || 1), 0)
    push('medium', 'Application crashes',
      `${total} app crash events in window — POS or store apps may be unstable; check crash type and affected app.`,
      crashes.map((_, i) => i))
  }

  const problems = signals.filter(s => s.category === 'problem_tracker')
  if (problems.length) {
    push('medium', 'Active store problem tracker entry',
      `${problems.length} open problem(s) in Store Problem History — review ongoing issue types and duration.`,
      problems.map((_, i) => i))
  }

  if (!out.length) {
    push('low', 'No dominant pattern detected',
      'Signals were collected but no strong correlation pattern matched. Review the timeline manually or widen the time window.',
      [])
  }

  return out.slice(0, 6)
}

export function buildTimelineFromEvidence({
  store = null,
  historyStats = [],
  env = {},
  crashes = [],
  problems = [],
}) {
  /** @type {TimelineEvent[]} */
  const events = []

  if (store) {
    if (store.online === false) {
      events.push(normalizeEvent({
        ts: store.lastSeen || null,
        source: 'store',
        category: 'connectivity',
        severity: 'critical',
        summary: `Store offline · ${store.connState || 'unknown'}`,
        detail: `Ping: ${store.avgPingMs ?? '—'} ms · loss ${store.packetLossPct ?? '—'}%`,
      }))
    }
    for (const issue of (store.issues || []).slice(0, 8)) {
      events.push(normalizeEvent({
        ts: store.lastSeen || null,
        source: 'store',
        category: 'issue',
        severity: issue.severity === 'critical' ? 'critical' : 'medium',
        summary: issue.message || issue.type || 'Store issue',
      }))
    }
  }

  for (const s of env.sentinel?.usbSamples || []) {
    const disc = /disconnect/i.test(String(s.action || s.message || ''))
    events.push(normalizeEvent({
      ts: s.ts,
      source: 'sentinel',
      category: disc ? 'usb_disconnect' : 'usb',
      severity: 'low',
      summary: `USB ${s.action || 'event'}${s.device ? ` · ${s.device}` : ''}`,
      detail: s.message,
    }))
  }
  for (const s of env.sentinel?.threatSamples || []) {
    events.push(normalizeEvent({
      ts: s.ts,
      source: 'sentinel',
      category: 'threat',
      severity: 'high',
      summary: s.name || 'Threat detected',
      detail: s.action,
    }))
  }
  if ((env.sentinel?.agentDisconnected?.count ?? env.sentinel?.agentDisconnected ?? 0) > 0) {
    events.push(normalizeEvent({
      ts: null,
      source: 'sentinel',
      category: 'agent_disconnect',
      severity: 'medium',
      summary: `Agent disconnect events: ${env.sentinel.agentDisconnected?.count ?? env.sentinel.agentDisconnected}`,
    }))
  }

  for (const s of env.soc?.samples || []) {
    const deny = String(s.action || '').toLowerCase() === 'deny'
    events.push(normalizeEvent({
      ts: s.ts,
      source: 'soc',
      category: deny ? 'firewall_deny' : 'firewall',
      severity: deny ? 'medium' : 'low',
      summary: `${s.action}/${s.subtype} · ${s.src} → ${s.dst}`,
      detail: s.msg,
    }))
  }

  for (const s of env.noc?.samples || []) {
    const down = /down|updown/i.test(String(s.mnemonic || s.msg || ''))
    events.push(normalizeEvent({
      ts: s.ts,
      source: 'noc',
      category: down ? 'interface_down' : 'switch',
      severity: down ? 'high' : 'low',
      summary: `${s.device} · ${s.mnemonic}${s.iface ? ` · ${s.iface}` : ''}`,
      detail: s.msg,
    }))
  }

  for (const c of crashes.slice(0, 10)) {
    events.push(normalizeEvent({
      ts: c.lastSeen || c.lastCrashAt || null,
      source: 'crash',
      category: 'crash',
      severity: c.criticalEvents > 0 ? 'high' : 'medium',
      summary: `${c.appName || c.crashType || 'crash'} · ${c.totalCrashes || 1} events`,
      detail: c.lastMessage,
      count: c.totalCrashes || 1,
    }))
  }

  for (const p of problems.slice(0, 8)) {
    events.push(normalizeEvent({
      ts: p.lastSeenAt || p.startedAt || null,
      source: 'problems',
      category: 'problem_tracker',
      severity: p.severity === 'critical' ? 'critical' : 'medium',
      summary: `${p.problemType || p.issueType || 'problem'} · ${p.status || 'active'}`,
      detail: p.message || p.details,
    }))
  }

  for (const stat of historyStats.slice(0, 4)) {
    if (stat.name && stat.min != null && stat.max != null && stat.max - stat.min > 0) {
      events.push(normalizeEvent({
        ts: null,
        source: 'store',
        category: 'metric',
        severity: 'low',
        summary: `${stat.name}: min ${stat.min} · max ${stat.max} · avg ${stat.avg?.toFixed?.(1) ?? stat.avg}`,
      }))
    }
  }

  return mergeTimeline(events)
}

export function recommendedActions(hypotheses, store = null) {
  const actions = []
  const titles = new Set(hypotheses.map(h => h.title))

  if (titles.has('Store connectivity loss') || titles.has('Store agent offline')) {
    actions.push('Verify ISP and SD-WAN tunnel status at the store gateway.')
    actions.push('Ping store gateway and check Store Monitor ping/loss trend.')
  }
  if (titles.has('Network interface instability') || titles.has('Network interface change')) {
    actions.push('Check NOC interface events for the site switch and uplink port.')
  }
  if (titles.has('Security threat activity')) {
    actions.push('Open Sentinel → review threat mitigation and quarantine status.')
  }
  if (titles.has('Application crashes')) {
    actions.push('Review Store Crashes for app/type and affected POS terminals.')
  }
  if (titles.has('Endpoint agent connectivity')) {
    actions.push('Confirm SentinelOne agent service and management connectivity on the endpoint.')
  }
  if (store?.hostname) {
    actions.push(`Open Store Monitor and filter hostname ${store.hostname} for live metrics.`)
  }
  if (!actions.length) {
    actions.push('Widen the time window and re-run RCA if the incident started earlier.')
    actions.push('Cross-check Zabbix infra status if the issue involves network devices.')
  }
  return [...new Set(actions)].slice(0, 6)
}
