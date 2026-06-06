/**
 * Send store alert notifications to Slack, Google Chat, or Email.
 */
import nodemailer from 'nodemailer'
import http from 'http'
import https from 'https'
import { crashTypeLabel, isStoreOfflineForAlert } from './influxStore.js'

const SEV_EMOJI = { critical: '🔴', high: '🟠', warning: '🟡' }

const METRIC_LABELS = {
  offline:        'Store Offline',
  packet_loss:    'Packet Loss',
  latency:        'Latency (ms)',
  cpu:            'CPU Usage',
  memory:         'Memory Usage',
  download_mbps:  'Download Speed',
  upload_mbps:    'Upload Speed',
  isp_down:       'ISP Down',
  hotspot:        'Hotspot Active',
  dns_fail:       'DNS Failure',
  http_fail:      'HTTP Failure',
  crash_count:    'Crash Count',
}

const OP_LABELS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' }

function getConditionValue(cond, store) {
  const { metric, target } = cond
  if (metric === 'offline')   return isStoreOfflineForAlert(store) ? 1 : 0
  if (metric === 'isp_down')    return store.connState === 'isp_down' ? 1 : 0
  if (metric === 'hotspot')     return (store.isHotspot || store.connState === 'hotspot') ? 1 : 0
  if (metric === 'dns_fail')    return Object.values(store.dns  || {}).some((d) => d.success === false) ? 1 : 0
  if (metric === 'http_fail')   return Object.values(store.http || {}).some((h) => h.success === false) ? 1 : 0
  if (metric === 'crash_count') {
    const appName   = (cond.appName   || '').trim().toLowerCase()
    const crashType = (cond.crashType || '').trim().toLowerCase()
    if (store._crashCounts) {
      let total = 0
      for (const [key, cnt] of store._crashCounts.entries()) {
        const [kApp, kType] = key.split('||')
        if (appName   && kApp.toLowerCase()  !== appName)   continue
        if (crashType && kType.toLowerCase() !== crashType) continue
        total += cnt
      }
      return total
    }
    return store._crashCount ?? 0
  }
  if (metric === 'cpu')           return store.cpuPct
  if (metric === 'memory')        return store.memPct
  if (metric === 'download_mbps') return store.downloadMbps
  if (metric === 'upload_mbps')   return store.uploadMbps
  if (metric === 'packet_loss') {
    const key = target || '8.8.8.8'
    const p = store.ping?.[key] || Object.values(store.ping || {})[0]
    return p?.packetLossPct
  }
  if (metric === 'latency') {
    const key = target || '8.8.8.8'
    const p = store.ping?.[key] || Object.values(store.ping || {})[0]
    return p?.avgMs
  }
  return null
}

function formatValue(metric, value) {
  if (value == null) return '—'
  if (metric === 'offline' || metric === 'isp_down' || metric === 'hotspot' || metric === 'dns_fail' || metric === 'http_fail') {
    return value ? 'Yes' : 'No'
  }
  if (metric === 'cpu' || metric === 'memory' || metric === 'packet_loss') return `${value}%`
  if (metric === 'latency') return `${value} ms`
  if (metric === 'download_mbps' || metric === 'upload_mbps') return `${value} Mbps`
  return String(value)
}

function formatConditionLine(rule) {
  const c = rule.condition || {}
  const metric = c.metric || 'unknown'
  const label  = METRIC_LABELS[metric] || metric
  const op     = OP_LABELS[c.operator || 'gt'] || '>'
  const thr    = c.threshold ?? 0

  if (metric === 'offline' || metric === 'isp_down' || metric === 'hotspot' || metric === 'dns_fail' || metric === 'http_fail') {
    return `${label} detected`
  }

  let line = `${label} ${op} ${thr}`
  if ((metric === 'packet_loss' || metric === 'latency') && c.target) {
    line += ` (target ${c.target})`
  }
  if (metric === 'crash_count') {
    line += ' in last 15 min'
    if (c.appName)   line += ` · app: ${c.appName}`
    if (c.crashType) line += ` · type: ${crashTypeLabel(c.crashType) || c.crashType}`
  }
  if (metric === 'cpu' || metric === 'memory' || metric === 'packet_loss') line += '%'
  if (metric === 'download_mbps' || metric === 'upload_mbps') line += ' Mbps'
  if (metric === 'latency') line += ' ms'
  return line
}

function formatCrashBreakdown(store, cond) {
  const appName   = (cond.appName   || '').trim().toLowerCase()
  const crashType = (cond.crashType || '').trim().toLowerCase()
  const lines = []

  if (!store._crashCounts?.size) return lines

  for (const [key, cnt] of store._crashCounts.entries()) {
    if (!cnt) continue
    const [kApp, kType] = key.split('||')
    if (appName   && kApp.toLowerCase()  !== appName)   continue
    if (crashType && kType.toLowerCase() !== crashType) continue
    const app  = kApp || '(app not reported)'
    const type = crashTypeLabel(kType) || kType || 'app_crash'
    lines.push(`↳ ${app} · ${type}: *${cnt}*`)
  }
  return lines
}

function formatStoreLine(store, rule) {
  const cond   = rule.condition || {}
  const metric = cond.metric
  const value  = getConditionValue(cond, store)
  const lines  = [`• *${store.hostname}* (${store.serial || '—'})`]

  const statusParts = []
  statusParts.push(store.online ? '🟢 Online' : '🔴 Offline')
  if (store.connState) statusParts.push(`Conn: ${store.connState}`)
  if (store.gatewayVendor && store.gatewayVendor !== 'unknown') statusParts.push(`Vendor: ${store.gatewayVendor}`)
  if (store.gatewayIp) statusParts.push(`GW: ${store.gatewayIp}`)
  lines.push(`  ${statusParts.join(' · ')}`)

  if (metric === 'crash_count') {
    lines.push(`  *Crashes: ${value ?? 0}* (threshold ${OP_LABELS[cond.operator || 'gt'] || '>'} ${cond.threshold ?? 0})`)
    for (const b of formatCrashBreakdown(store, cond)) lines.push(`  ${b}`)
  } else if (metric === 'offline') {
    if (store.heartbeatValue != null) lines.push(`  Heartbeat: ${store.heartbeatValue === 1 ? 'online' : 'offline'} (${store.heartbeatValue})`)
    if (store.lastHeartbeatAt || store.lastSeen) lines.push(`  Last heartbeat: ${store.lastHeartbeatAt || store.lastSeen}`)
    if (store.onlineReason === 'activity') lines.push('  Note: dashboard shows online via recent metrics (alert still fired on agent/offline signal)')
  } else if (metric === 'packet_loss' || metric === 'latency') {
    const target = cond.target || '8.8.8.8'
    lines.push(`  *${METRIC_LABELS[metric]}:* ${formatValue(metric, value)} (target ${target})`)
  } else if (['cpu', 'memory', 'download_mbps', 'upload_mbps'].includes(metric)) {
    lines.push(`  *${METRIC_LABELS[metric]}:* ${formatValue(metric, value)} (threshold ${OP_LABELS[cond.operator || 'gt'] || '>'} ${cond.threshold})`)
  } else {
    lines.push(`  *Triggered:* ${formatValue(metric, value)}`)
  }

  return lines.join('\n')
}

function buildMessage(rule, stores) {
  const emoji  = SEV_EMOJI[rule.severity] || '⚠️'
  const title  = `${emoji} [${rule.severity.toUpperCase()}] ${rule.name}`
  const cond   = rule.condition || {}
  const metric = cond.metric

  const summary = [
    rule.description || `Store monitor alert: *${METRIC_LABELS[metric] || metric}*`,
    `*Condition:* ${formatConditionLine(rule)}`,
  ].join('\n')

  const fields = [
    { label: 'Severity', value: rule.severity.toUpperCase() },
    { label: 'Group', value: rule.group || 'all' },
    { label: 'Affected', value: `${stores.length} store(s)` },
  ]

  if (metric === 'crash_count') {
    const totalCrashes = stores.reduce((sum, s) => sum + (getConditionValue(cond, s) || 0), 0)
    fields.push({ label: 'Total Crashes', value: String(totalCrashes) })
    fields.push({ label: 'Window', value: 'Last 15 minutes' })
    if (cond.appName)   fields.push({ label: 'App Filter', value: cond.appName })
    if (cond.crashType) fields.push({ label: 'Crash Type', value: crashTypeLabel(cond.crashType) || cond.crashType })
  } else {
    fields.push({ label: 'Threshold', value: `${OP_LABELS[cond.operator || 'gt'] || '>'} ${cond.threshold ?? 0}` })
  }

  const storeLines = stores.slice(0, 10).map((s) => formatStoreLine(s, rule))
  const more = stores.length > 10 ? `\n_…and ${stores.length - 10} more store(s)_` : ''
  let storeSection
  if (metric === 'offline' && stores.length > 25) {
    const names = stores.slice(0, 20).map((s) => s.hostname || s.storeTag || '—')
    storeSection = [
      '*Affected Stores (compact):*',
      names.join(', '),
      stores.length > 20 ? `_…and ${stores.length - 20} more_` : '',
      '',
      '_Open Store Monitor for full offline list._',
    ].filter(Boolean).join('\n')
  } else {
    storeSection = ['*Affected Stores:*', ...storeLines].join('\n\n') + more
  }
  const footer = `Netpulse Store Monitor · ${new Date().toISOString()}`

  const body = [summary, '', storeSection, '', footer].join('\n')

  return { title, body, summary, fields, storeSection, footer }
}

async function postWebhook(url, payload) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url)
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      const lib = u.protocol === 'https:' ? https : http
      const req = lib.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        timeout: 10000,
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

  if (msg.fields?.length) {
    blocks.push({
      type: 'section',
      fields: msg.fields.slice(0, 10).map((f) => ({
        type: 'mrkdwn',
        text: `*${f.label}*\n${f.value}`,
      })),
    })
  }

  if (msg.storeSection) {
    blocks.push({ type: 'divider' })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: msg.storeSection } })
  }

  if (msg.footer) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: msg.footer }],
    })
  }

  return postWebhook(webhookUrl, { text: msg.title, blocks })
}

async function sendGoogleChat(webhookUrl, msg) {
  return postWebhook(webhookUrl, {
    text: `*${msg.title}*\n${msg.body}`,
  })
}

async function sendEmail(emails, msg) {
  const host = process.env.SMTP_HOST || process.env.MAIL_HOST
  const port = parseInt(process.env.SMTP_PORT || process.env.MAIL_PORT || '587')
  const user = process.env.SMTP_USER || process.env.MAIL_USER
  const pass = process.env.SMTP_PASS || process.env.MAIL_PASS
  const from = process.env.SMTP_FROM || process.env.MAIL_FROM || user

  if (!host) return { ok: false, error: 'SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM)' }

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

export async function dispatchAlertNotifications(rule, affectedStores) {
  const msg = buildMessage(rule, affectedStores)
  const results = []
  for (const ch of (rule.channels || [])) {
    if (ch.type === 'slack' && ch.webhookUrl) {
      results.push({ channel: 'slack', ...(await sendSlack(ch.webhookUrl, msg)) })
    } else if (ch.type === 'google_chat' && ch.webhookUrl) {
      results.push({ channel: 'google_chat', ...(await sendGoogleChat(ch.webhookUrl, msg)) })
    } else if (ch.type === 'email' && ch.emails?.length) {
      results.push({ channel: 'email', ...(await sendEmail(ch.emails, msg)) })
    }
  }
  if (!results.length) {
    results.push({ channel: 'none', ok: false, error: 'no valid notification channels on rule' })
  }
  return results
}

export async function testChannel(channel) {
  const msg = { title: '✅ Test notification from Netpulse Store Monitor', body: 'If you see this, notifications are working correctly.' }
  if (channel.type === 'slack') return sendSlack(channel.webhookUrl, msg)
  if (channel.type === 'google_chat') return sendGoogleChat(channel.webhookUrl, msg)
  if (channel.type === 'email') return sendEmail(channel.emails, msg)
  return { ok: false, error: 'Unknown channel type' }
}
