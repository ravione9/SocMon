/**
 * Send store alert notifications to Slack, Google Chat, or Email.
 */
import nodemailer from 'nodemailer'
import http from 'http'
import https from 'https'

const SEV_EMOJI = { critical: '🔴', high: '🟠', warning: '🟡' }

function buildMessage(rule, stores) {
  const emoji = SEV_EMOJI[rule.severity] || '⚠️'
  const storeList = stores.slice(0, 10).map((s) => `• ${s.hostname} (${s.serial})`).join('\n')
  const more = stores.length > 10 ? `\n…and ${stores.length - 10} more` : ''
  return {
    title: `${emoji} [${rule.severity.toUpperCase()}] ${rule.name}`,
    body: [
      rule.description ? rule.description : `Alert: ${rule.condition.metric} threshold triggered`,
      `Group: ${rule.group}`,
      `Affected stores (${stores.length}):`,
      storeList + more,
    ].join('\n'),
  }
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
  return postWebhook(webhookUrl, {
    text: `*${msg.title}*`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: msg.title, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: '```' + msg.body + '```' } },
    ],
  })
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
  return results
}

export async function testChannel(channel) {
  const msg = { title: '✅ Test notification from Netpulse Store Monitor', body: 'If you see this, notifications are working correctly.' }
  if (channel.type === 'slack') return sendSlack(channel.webhookUrl, msg)
  if (channel.type === 'google_chat') return sendGoogleChat(channel.webhookUrl, msg)
  if (channel.type === 'email') return sendEmail(channel.emails, msg)
  return { ok: false, error: 'Unknown channel type' }
}
