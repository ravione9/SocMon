/**
 * Zabbix Store alert notifications — Slack, Teams, Google Chat, Email, Webhook.
 */
import nodemailer from 'nodemailer'
import http from 'http'
import https from 'https'

const SEV_EMOJI = { disaster: '🆘', critical: '🔴', high: '🟠', warning: '🟡' }

const METRIC_LABELS = {
  host_down: 'Host Down',
  agent_down: 'Agent Down',
  interface_down: 'Interface Down',
  cpu: 'CPU Usage',
  memory: 'Memory Usage',
  disk: 'Disk Usage',
  latency: 'Latency',
  jitter: 'Jitter',
  packet_loss: 'Packet Loss',
  bandwidth: 'Bandwidth',
  zabbix_problem: 'Zabbix Problem',
}

const OP_LABELS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', between: 'between' }

function storeCodeFromHost(host) {
  const h = String(host?.hostname || host?.name || '').trim()
  const m = h.match(/^(RP\d+)/i)
  return m ? m[1].toUpperCase() : h.split('-')[0] || h
}

function formatConditionLine(rule) {
  const c = rule.condition || {}
  const label = METRIC_LABELS[c.metric] || c.metric
  const op = OP_LABELS[c.operator || 'gt'] || '>'
  if (c.metric === 'host_down' || c.metric === 'agent_down' || c.metric === 'interface_down') {
    return `${label} detected`
  }
  if (c.operator === 'between') {
    return `${label} ${op} ${c.threshold}–${c.thresholdMax} ms`
  }
  let line = `${label} ${op} ${c.threshold}`
  if (['latency', 'jitter', 'packet_loss'].includes(c.metric) && c.target) {
    line += ` (target ${c.target})`
  }
  if (c.metric === 'cpu' || c.metric === 'memory' || c.metric === 'disk' || c.metric === 'packet_loss') {
    line += '%'
  } else if (c.metric === 'latency' || c.metric === 'jitter') {
    line += ' ms'
  }
  return line
}

function formatHostLine(host, rule) {
  const lines = [
    `• *${host.name || host.hostname}* (${host.hostname || '—'})`,
    `  Store: ${storeCodeFromHost(host)}`,
  ]
  if (host.pingTarget) lines.push(`  Ping target: ${host.pingTarget}`)
  if (host.sensorKeys?.latency) lines.push(`  src latency: \`${host.sensorKeys.latency}\``)
  if (host.sensorKeys?.jitter) lines.push(`  src jitter: \`${host.sensorKeys.jitter}\``)
  if (host.sensorKeys?.packetLoss) lines.push(`  src loss: \`${host.sensorKeys.packetLoss}\``)
  if (host.trigger) lines.push(`  Trigger: ${host.trigger}`)
  const parts = []
  if (host.latency != null) parts.push(`Latency: ${host.latency} ms`)
  if (host.jitter != null) parts.push(`Jitter: ${host.jitter} ms`)
  if (host.packetLoss != null) parts.push(`Packet Loss: ${host.packetLoss}%`)
  if (host.cpu != null) parts.push(`CPU: ${host.cpu}%`)
  if (host.memory != null) parts.push(`Memory: ${host.memory}%`)
  if (host.triggeredValue != null && !parts.length) {
    parts.push(`Value: ${host.triggeredValue}`)
  }
  if (parts.length) lines.push(`  ${parts.join(' · ')}`)
  return lines.join('\n')
}

export function buildZabbixAlertMessage(rule, hosts) {
  const emoji = SEV_EMOJI[rule.severity] || '⚠️'
  const title = `${emoji} Alert Notification — ${rule.name}`
  const first = hosts[0] || {}
  const summary = [
    `🚨 *${rule.severity.toUpperCase()}* · ${rule.name}`,
    rule.description || `Condition: ${formatConditionLine(rule)}`,
    '',
    `*Store:* ${storeCodeFromHost(first)}`,
    `*Hostname:* ${first.hostname || first.name || '—'}`,
    `*Severity:* ${rule.severity}`,
    `*Trigger:* ${formatConditionLine(rule)}`,
    `*Latency:* ${first.latency != null ? `${first.latency} ms` : '—'}`,
    `*Jitter:* ${first.jitter != null ? `${first.jitter} ms` : '—'}`,
    `*Packet Loss:* ${first.packetLoss != null ? `${first.packetLoss}%` : '—'}`,
  ].join('\n')

  const hostLines = hosts.slice(0, 15).map((h) => formatHostLine(h, rule))
  const more = hosts.length > 15 ? `\n_…and ${hosts.length - 15} more host(s)_` : ''
  const storeSection = ['*Affected Hosts:*', ...hostLines].join('\n\n') + more
  const footer = `Netpulse Store Zabbix · ${new Date().toISOString()}`
  const body = [summary, '', storeSection, '', footer].join('\n')

  return {
    title,
    body,
    summary,
    storeSection,
    footer,
    fields: [
      { label: 'Severity', value: rule.severity.toUpperCase() },
      { label: 'Affected', value: `${hosts.length} host(s)` },
      { label: 'Condition', value: formatConditionLine(rule) },
    ],
  }
}

async function postWebhook(url, payload, { method = 'POST', headers = {} } = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url)
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      const lib = u.protocol === 'https:' ? https : http
      const req = lib.request({
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers },
        timeout: 12000,
      }, (res) => { res.resume(); resolve({ ok: res.statusCode < 400, status: res.statusCode }) })
      req.on('error', (e) => resolve({ ok: false, error: e.message }))
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
      req.write(body)
      req.end()
    } catch (e) {
      resolve({ ok: false, error: e.message })
    }
  })
}

async function sendSlack(webhookUrl, msg) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: msg.title, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: msg.summary || msg.body } },
  ]
  if (msg.storeSection) {
    blocks.push({ type: 'divider' })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: msg.storeSection } })
  }
  if (msg.footer) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: msg.footer }] })
  }
  return postWebhook(webhookUrl, { text: msg.title, blocks })
}

async function sendTeams(webhookUrl, msg) {
  return postWebhook(webhookUrl, {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: 'EA4300',
    summary: msg.title,
    sections: [{ activityTitle: msg.title, text: msg.body }],
  })
}

async function sendGoogleChat(webhookUrl, msg) {
  return postWebhook(webhookUrl, { text: `*${msg.title}*\n${msg.body}` })
}

async function sendEmail(emails, msg) {
  const host = process.env.SMTP_HOST || process.env.MAIL_HOST
  const port = parseInt(process.env.SMTP_PORT || process.env.MAIL_PORT || '587', 10)
  const user = process.env.SMTP_USER || process.env.MAIL_USER
  const pass = process.env.SMTP_PASS || process.env.MAIL_PASS
  const from = process.env.SMTP_FROM || process.env.MAIL_FROM || user
  if (!host) return { ok: false, error: 'SMTP not configured' }
  try {
    const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: user ? { user, pass } : undefined })
    await transporter.sendMail({
      from,
      to: emails.join(', '),
      subject: msg.title,
      text: msg.body,
      html: `<pre style="font-family:monospace">${msg.body.replace(/</g, '&lt;')}</pre>`,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function renderWebhookTemplate(rule, hosts, template) {
  const first = hosts[0] || {}
  const vars = {
    store_code: storeCodeFromHost(first),
    store_name: first.name || first.hostname || '',
    hostname: first.hostname || '',
    severity: rule.severity || '',
    trigger: formatConditionLine(rule),
    trigger_name: formatConditionLine(rule),
    latency: first.latency != null ? String(first.latency) : '',
    jitter: first.jitter != null ? String(first.jitter) : '',
    packet_loss: first.packetLoss != null ? String(first.packetLoss) : '',
    region: '',
    isp: '',
    event_time: new Date().toISOString(),
    event_status: 'problem',
  }
  let out = template || JSON.stringify(vars, null, 2)
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v)
  }
  return out
}

async function sendGenericWebhook(ch, rule, hosts, msg) {
  try {
    const raw = renderWebhookTemplate(rule, hosts, ch.webhookTemplate)
    const payload = JSON.parse(raw)
    return postWebhook(ch.webhookUrl, payload, { method: ch.method || 'POST', headers: ch.headers || {} })
  } catch {
    return postWebhook(ch.webhookUrl, {
      title: msg.title,
      body: msg.body,
      severity: rule.severity,
      hosts: hosts.slice(0, 20),
    }, { method: ch.method || 'POST', headers: ch.headers || {} })
  }
}

export async function dispatchZabbixAlertNotifications(rule, affectedHosts) {
  const msg = buildZabbixAlertMessage(rule, affectedHosts)
  const results = []
  const channels = (rule.channels || []).filter((ch) => {
    if (ch.type === 'email') return ch.emails?.length
    if (ch.type === 'slack' || ch.type === 'teams' || ch.type === 'google_chat' || ch.type === 'webhook') {
      return String(ch.webhookUrl || '').trim().length > 0
    }
    return false
  })
  for (const ch of channels) {
    if (ch.type === 'slack' && ch.webhookUrl) {
      results.push({ channel: 'slack', ...(await sendSlack(ch.webhookUrl, msg)) })
    } else if (ch.type === 'teams' && ch.webhookUrl) {
      results.push({ channel: 'teams', ...(await sendTeams(ch.webhookUrl, msg)) })
    } else if (ch.type === 'google_chat' && ch.webhookUrl) {
      results.push({ channel: 'google_chat', ...(await sendGoogleChat(ch.webhookUrl, msg)) })
    } else if (ch.type === 'email' && ch.emails?.length) {
      results.push({ channel: 'email', ...(await sendEmail(ch.emails, msg)) })
    } else if (ch.type === 'webhook' && ch.webhookUrl) {
      results.push({ channel: 'webhook', ...(await sendGenericWebhook(ch, rule, affectedHosts, msg)) })
    }
  }
  if (!results.length) {
    console.warn(`[zabbixAlertNotify] Rule "${rule.name}" has no valid channels (check Slack webhook URL is saved on the rule)`)
    results.push({ channel: 'none', ok: false, error: 'no valid notification channels on rule' })
  }
  return results
}

export async function testZabbixAlertChannel(channel) {
  const sampleRule = {
    name: 'Test Alert Rule',
    severity: 'warning',
    condition: { metric: 'latency', operator: 'gt', threshold: 150, target: '8.8.8.8' },
  }
  const sampleHosts = [{
    hostid: '0',
    hostname: 'RP2806-TEST',
    name: 'RP2806 Test Store',
    latency: 180,
    jitter: 25,
    packetLoss: 3,
    triggeredValue: 180,
  }]
  const msg = buildZabbixAlertMessage(sampleRule, sampleHosts)
  msg.title = '✅ Test notification from Netpulse Store Zabbix Alerts'
  if (channel.type === 'slack') return sendSlack(channel.webhookUrl, msg)
  if (channel.type === 'teams') return sendTeams(channel.webhookUrl, msg)
  if (channel.type === 'google_chat') return sendGoogleChat(channel.webhookUrl, msg)
  if (channel.type === 'email') return sendEmail(channel.emails, msg)
  if (channel.type === 'webhook') return sendGenericWebhook(channel, sampleRule, sampleHosts, msg)
  return { ok: false, error: 'Unknown channel type' }
}
