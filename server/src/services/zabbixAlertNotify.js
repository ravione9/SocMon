/**
 * Zabbix Store alert notifications — Slack, Teams, Google Chat, Email, Webhook.
 */
import nodemailer from 'nodemailer'
import http from 'http'
import https from 'https'

import { getRuleConditions } from '../utils/zabbixAlertConditions.js'

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

function formatSingleCondition(c) {
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

function formatConditionLine(rule) {
  const conditions = getRuleConditions(rule)
  const logic = (rule.logic || 'and').toUpperCase()
  const parts = conditions.map(formatSingleCondition)
  if (parts.length <= 1) return parts[0] || 'Unknown'
  return parts.join(` ${logic} `)
}

function fmtNum(v, decimals = 1) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  if (decimals === 0) return String(Math.round(n))
  return n.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

function fmtMs(v) {
  return v != null && Number.isFinite(Number(v)) ? fmtNum(v, 0) : '—'
}

function fmtPct(v) {
  return v != null && Number.isFinite(Number(v)) ? `${fmtNum(v, 1)}%` : '—'
}

/** Fixed-width column for Slack monospace table. */
function col(text, width, { align = 'left', mark = false } = {}) {
  let s = String(text ?? '—')
  if (mark) s = `${s}▲`
  if (s.length > width) s = s.slice(0, width - 1) + '…'
  return align === 'right' ? s.padStart(width) : s.padEnd(width)
}

function getHostTableColumns(rule) {
  const highlights = new Set()
  for (const c of getRuleConditions(rule)) {
    if (c.metric === 'latency') highlights.add('lat')
    else if (c.metric === 'jitter') highlights.add('jit')
    else if (c.metric === 'packet_loss') highlights.add('loss')
    else if (c.metric === 'cpu') highlights.add('cpu')
    else if (c.metric === 'memory') highlights.add('mem')
  }
  return {
    highlights,
    columns: [
      { id: 'store', title: 'Store', w: 8, align: 'left', get: (h) => storeCodeFromHost(h) },
      { id: 'host', title: 'Hostname', w: 22, align: 'left', get: (h) => h.hostname || h.name || '—' },
      { id: 'lat', title: 'Lat (ms)', w: 8, align: 'right', get: (h) => fmtMs(h.latency) },
      { id: 'jit', title: 'Jit (ms)', w: 8, align: 'right', get: (h) => fmtMs(h.jitter) },
      { id: 'loss', title: 'Loss', w: 6, align: 'right', get: (h) => (h.packetLoss != null ? `${fmtNum(h.packetLoss, 0)}%` : '—') },
      { id: 'cpu', title: 'CPU', w: 7, align: 'right', get: (h) => fmtPct(h.cpu) },
      { id: 'mem', title: 'Mem', w: 7, align: 'right', get: (h) => fmtPct(h.memory) },
    ],
  }
}

function orderHostsForTable(hosts, highlights) {
  if (!highlights?.size) return hosts
  const pick = (h) => {
    const vals = []
    if (highlights.has('lat')) vals.push(h.latency)
    if (highlights.has('jit')) vals.push(h.jitter)
    if (highlights.has('loss')) vals.push(h.packetLoss)
    if (highlights.has('cpu')) vals.push(h.cpu)
    if (highlights.has('mem')) vals.push(h.memory)
    return Math.max(...vals.filter((v) => v != null).map(Number), -1)
  }
  return [...hosts].sort((a, b) => pick(b) - pick(a))
}

function buildHostsTable(hosts, rule, { maxRows = 20 } = {}) {
  const { highlights, columns } = getHostTableColumns(rule)
  const ordered = orderHostsForTable(hosts, highlights)
  const slice = ordered.slice(0, maxRows)
  const header = columns.map((c) => col(c.title, c.w, { align: c.align || 'left' })).join('')
  const divider = columns.map((c) => '─'.repeat(c.w)).join('')
  const rows = slice.map((h) => columns.map((c) => col(
    c.get(h),
    c.w,
    { align: c.align || 'left', mark: highlights.has(c.id) },
  )).join(''))

  const lines = [header, divider, ...rows]
  if (hosts.length > maxRows) {
    lines.push(`… +${hosts.length - maxRows} more host(s)`)
  }
  return lines.join('\n')
}

/** Slack Block Kit native table (Aug 2025+). */
function buildSlackTableBlock(hosts, rule, { maxRows = 15 } = {}) {
  const { highlights, columns } = getHostTableColumns(rule)
  const ordered = orderHostsForTable(hosts, highlights).slice(0, maxRows)
  const cell = (text) => ({ type: 'raw_text', text: String(text ?? '—').slice(0, 120) })
  const rows = [
    columns.map((c) => cell(c.title)),
    ...ordered.map((h) => columns.map((c) => {
      let val = c.get(h)
      if (highlights.has(c.id) && val !== '—') val = `${val} ▲`
      return cell(val)
    })),
  ]
  if (hosts.length > maxRows) {
    const pad = columns.length - 1
    rows.push([
      cell(`… +${hosts.length - maxRows} more host(s)`),
      ...Array(Math.max(pad, 0)).fill(cell('')),
    ])
  }
  return {
    type: 'table',
    column_settings: columns.map((c) => ({ align: c.align || 'left', is_wrapped: false })),
    rows,
  }
}

export function buildZabbixAlertMessage(rule, hosts) {
  const emoji = SEV_EMOJI[rule.severity] || '⚠️'
  const title = `${emoji} Alert Notification — ${rule.name}`
  const tableText = buildHostsTable(hosts, rule)
  const hostsTable = `\`\`\`\n${tableText}\n\`\`\``
  const slackTableBlock = buildSlackTableBlock(hosts, rule)
  const targets = [...new Set(getRuleConditions(rule)
    .filter((c) => ['latency', 'jitter', 'packet_loss'].includes(c.metric))
    .map((c) => c.target || '8.8.8.8'))]
  const targetNote = targets.length ? targets.join(', ') : '8.8.8.8'
  const summary = [
    rule.description ? rule.description : null,
    `*Affected:* ${hosts.length} host(s) · ping target${targets.length > 1 ? 's' : ''} ${targetNote}`,
  ].filter(Boolean).join('\n')
  const storeSection = ['*Affected Hosts*', hostsTable].join('\n')
  const footer = `Netpulse Store Zabbix · ${new Date().toISOString()}`
  const body = [
    `*${rule.severity.toUpperCase()}* · ${rule.name}`,
    `*Condition:* ${formatConditionLine(rule)}`,
    '',
    tableText,
    '',
    footer,
  ].join('\n')

  return {
    title,
    body,
    summary,
    hostsTable,
    slackTableBlock,
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
      }, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => {
          resolve({
            ok: res.statusCode < 400,
            status: res.statusCode,
            error: res.statusCode >= 400 ? text.slice(0, 300) : undefined,
          })
        })
      })
      req.on('error', (e) => resolve({ ok: false, error: e.message }))
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
      req.write(body)
      req.end()
    } catch (e) {
      resolve({ ok: false, error: e.message })
    }
  })
}

function buildSlackBlocks(msg, { includeTable = true, useNativeTable = true } = {}) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: msg.title, emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity*\n${msg.fields?.[0]?.value || '—'}` },
        { type: 'mrkdwn', text: `*Affected*\n${msg.fields?.[1]?.value || '—'}` },
        { type: 'mrkdwn', text: `*Condition*\n${msg.fields?.[2]?.value || '—'}` },
      ],
    },
  ]
  if (msg.summary) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: msg.summary } })
  }
  if (includeTable) {
    blocks.push({ type: 'divider' })
    if (useNativeTable && msg.slackTableBlock) {
      blocks.push(msg.slackTableBlock)
    } else if (msg.hostsTable) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Affected Hosts*\n${msg.hostsTable}` },
      })
    }
  }
  if (msg.footer) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: msg.footer }] })
  }
  return blocks
}

async function sendSlack(webhookUrl, msg) {
  const fallbackText = [msg.title, msg.summary, msg.hostsTable?.replace(/```/g, '')].filter(Boolean).join('\n\n')
  let result = await postWebhook(webhookUrl, {
    text: fallbackText,
    blocks: buildSlackBlocks(msg, { useNativeTable: true }),
  })
  if (!result.ok && msg.slackTableBlock) {
    result = await postWebhook(webhookUrl, {
      text: fallbackText,
      blocks: buildSlackBlocks(msg, { useNativeTable: false }),
    })
    if (result.ok) result.fallback = 'code_block_table'
  }
  return result
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
  const sampleHosts = [
    {
      hostid: '0',
      hostname: 'RP2453-E547CP8C',
      name: 'RP2453 Store',
      latency: 126,
      jitter: 95,
      packetLoss: 0,
      cpu: 6.7,
      memory: 47.9,
      triggeredValue: 95,
    },
    {
      hostid: '1',
      hostname: 'RP1618-E519BNYF',
      name: 'RP1618 Store',
      latency: 18,
      jitter: 31,
      packetLoss: 0,
      cpu: 6.3,
      memory: 41.7,
      triggeredValue: 31,
    },
  ]
  const sampleRule = {
    name: 'Jitter',
    severity: 'high',
    description: 'RP System jitter',
    condition: { metric: 'jitter', operator: 'gt', threshold: 30, target: '8.8.8.8' },
  }
  const msg = buildZabbixAlertMessage(sampleRule, sampleHosts)
  msg.title = '✅ Test notification from Netpulse Store Zabbix Alerts'
  if (channel.type === 'slack') return sendSlack(channel.webhookUrl, msg)
  if (channel.type === 'teams') return sendTeams(channel.webhookUrl, msg)
  if (channel.type === 'google_chat') return sendGoogleChat(channel.webhookUrl, msg)
  if (channel.type === 'email') return sendEmail(channel.emails, msg)
  if (channel.type === 'webhook') return sendGenericWebhook(channel, sampleRule, sampleHosts, msg)
  return { ok: false, error: 'Unknown channel type' }
}
