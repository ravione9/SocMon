import { Router } from 'express'
import { X509Certificate } from 'crypto'
import { createSecureContext } from 'tls'
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { promisify } from 'util'
import { authenticate, authorize } from '../middleware/auth.js'

// Keep in sync with docker/nginx/default.conf — Admin SSL mode writes these into prod nginx.
const NGINX_STATIC_PREFIX = `
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
`.trim()

const NGINX_APP_LOCATIONS = `
    location = /api/rdp/ws {
        proxy_pass http://server:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
    location /api/web-mgmt/ {
        proxy_pass http://server:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
    location /api/solarwinds/ {
        proxy_pass http://server:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
    location /api/idcs/export {
        proxy_pass http://server:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
        proxy_buffering off;
    }
    location ~ ^/api/(sentinel/events/export|logs/export|sentinel-one/xdr/powerQuery/export)$ {
        proxy_pass http://server:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 1800s;
        proxy_read_timeout 1800s;
        proxy_buffering off;
    }
    location /api/store-monitor/ {
        proxy_pass http://server:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
        proxy_buffering off;
    }
    location /api/ai/ {
        proxy_pass http://server:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 1800s;
        proxy_read_timeout 1800s;
        proxy_buffering off;
    }
    location /api/ {
        proxy_pass http://server:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    # /mcp uses Docker's embedded DNS (127.0.0.11) and a variable upstream so
    # name resolution is deferred to request time. With a static upstream, a
    # missing mcp container fails the whole nginx config at load time and takes
    # the UI down; with the variable form, only /mcp returns 502 while mcp is
    # absent.
    location /mcp {
        resolver 127.0.0.11 ipv6=off valid=10s;
        set $netpulse_mcp_upstream mcp:5050;
        proxy_pass http://$netpulse_mcp_upstream;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_connect_timeout 60s;
        proxy_send_timeout 86400s;
        proxy_read_timeout 86400s;
    }
    location /health {
        proxy_pass http://server:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
    location /socket.io/ {
        proxy_pass http://server:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
    location / {
        try_files $uri /index.html;
    }
`.trim()

const HTTP_ONLY_NGINX_CONF = `
server {
    listen 80;
    server_name _;
${NGINX_STATIC_PREFIX}
${NGINX_APP_LOCATIONS}
}
`.trim()

const HTTPS_NGINX_CONF = (certPath, keyPath) => `
server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name _;
    ssl_certificate     ${certPath};
    ssl_certificate_key ${keyPath};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
${NGINX_STATIC_PREFIX}
${NGINX_APP_LOCATIONS}
}
`.trim()

const execAsync = promisify(exec)
const router    = Router()

const __dir      = dirname(fileURLToPath(import.meta.url))
const CERTS_DIR  = process.env.CERTS_DIR  || resolve(__dir, '../../../certs')
const CERT_FILE  = process.env.SSL_CERT_FILE || 'netpulse.crt'
const KEY_FILE   = process.env.SSL_KEY_FILE  || 'netpulse.key'
const CERT_PATH  = resolve(CERTS_DIR, CERT_FILE)
const KEY_PATH   = resolve(CERTS_DIR, KEY_FILE)
const NGINX_CTR  = process.env.NGINX_CONTAINER || 'netpulse-nginx'
/** Shared host file also mounted into the nginx container (prod docker-compose). */
const NGINX_CONF_PATH = process.env.NGINX_CONF_PATH
  ? resolve(process.env.NGINX_CONF_PATH)
  : null

/** Ensure the certs directory exists (creates it if the volume is fresh). */
function ensureCertsDir() {
  if (!existsSync(CERTS_DIR)) mkdirSync(CERTS_DIR, { recursive: true })
}

/** Parse an installed certificate and return human-readable fields. */
function readCertInfo() {
  if (!existsSync(CERT_PATH)) return null
  try {
    const pem  = readFileSync(CERT_PATH, 'utf8')
    const cert = new X509Certificate(pem)
    return {
      subject:        cert.subject,
      issuer:         cert.issuer,
      validFrom:      cert.validFrom,
      validTo:        cert.validTo,
      fingerprint:    cert.fingerprint,
      fingerprint256: cert.fingerprint256,
      serialNumber:   cert.serialNumber,
      expired:        new Date(cert.validTo) < new Date(),
      daysLeft:       Math.ceil((new Date(cert.validTo) - new Date()) / 86_400_000),
    }
  } catch {
    return null
  }
}

// ── Mode flag (persists HTTPS/HTTP choice across restarts) ──────────────────
const MODE_FILE = resolve(CERTS_DIR, '.ssl_mode')

function readMode() {
  try { return readFileSync(MODE_FILE, 'utf8').trim() } catch { return 'http' }
}
function writeMode(mode) {
  ensureCertsDir()
  writeFileSync(MODE_FILE, mode, { mode: 0o644 })
}

function nginxCertPathsInsideContainer() {
  return {
    cert: `/etc/nginx/certs/${CERT_FILE}`,
    key: `/etc/nginx/certs/${KEY_FILE}`,
  }
}

function buildNginxConfForMode(mode) {
  if (mode === 'https') {
    const { cert, key } = nginxCertPathsInsideContainer()
    return HTTPS_NGINX_CONF(cert, key)
  }
  return HTTP_ONLY_NGINX_CONF
}

function writeNginxConfFiles(confContent) {
  ensureCertsDir()
  const written = []
  const payload = `${confContent.trim()}\n`
  const backup = resolve(CERTS_DIR, 'nginx-netpulse.conf')
  writeFileSync(backup, payload, { mode: 0o644 })
  written.push(backup)
  if (NGINX_CONF_PATH) {
    writeFileSync(NGINX_CONF_PATH, payload, { mode: 0o644 })
    written.push(NGINX_CONF_PATH)
  }
  return written
}

async function reloadNginxContainer() {
  const cmd = `docker exec ${NGINX_CTR} nginx -t && docker exec ${NGINX_CTR} nginx -s reload`
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 15_000 })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (dockerErr) {
    try {
      await execAsync('nginx -t && nginx -s reload', { timeout: 10_000 })
      return { ok: true, stdout: 'host nginx reloaded' }
    } catch {
      return {
        ok: false,
        error: dockerErr.message,
        manual: `docker exec ${NGINX_CTR} nginx -t && docker exec ${NGINX_CTR} nginx -s reload`,
      }
    }
  }
}

async function reloadNginxWith(confContent) {
  const written = writeNginxConfFiles(confContent)
  const reload = await reloadNginxContainer()
  return { ...reload, written }
}

/** Apply persisted HTTP/HTTPS mode to nginx config (used on reload + server startup). */
export async function applyCurrentSslNginx() {
  const mode = readMode()
  if (mode === 'https') {
    if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
      return { ok: false, skipped: true, error: 'HTTPS mode saved but certificate files are missing' }
    }
    return reloadNginxWith(buildNginxConfForMode('https'))
  }
  return reloadNginxWith(buildNginxConfForMode('http'))
}

// ── GET /api/ssl/status ─────────────────────────────────────────────────────
router.get('/status', authenticate, authorize('admin'), (_req, res) => {
  const certInfo = readCertInfo()
  res.json({
    hasCert: !!certInfo,
    hasKey:  existsSync(KEY_PATH),
    cert:    certInfo,
    mode:    readMode(),
    paths:   { cert: CERT_PATH, key: KEY_PATH },
  })
})

// ── POST /api/ssl/mode ──────────────────────────────────────────────────────
// Body: { mode: 'https' | 'http' }
// Writes the appropriate nginx config to the shared certs volume and reloads nginx.
router.post('/mode', authenticate, authorize('admin'), async (req, res) => {
  const mode = String(req.body?.mode || '').toLowerCase()
  if (mode !== 'https' && mode !== 'http') {
    return res.status(400).json({ error: 'mode must be "https" or "http"' })
  }

  if (mode === 'https') {
    if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
      return res.status(400).json({ error: 'Upload a certificate and key before enabling HTTPS.' })
    }
    writeMode('https')
    const result = await reloadNginxWith(buildNginxConfForMode('https'))
    return res.json({
      ok: result.ok,
      mode: 'https',
      message: result.ok
        ? 'HTTPS enabled — nginx config written and reloaded'
        : 'HTTPS config written but nginx reload failed — restart the nginx container or run the manual command',
      ...result,
    })
  }

  // HTTP mode
  writeMode('http')
  const result = await reloadNginxWith(buildNginxConfForMode('http'))
  return res.json({
    ok: result.ok,
    mode: 'http',
    message: result.ok
      ? 'Switched to HTTP — nginx config written and reloaded'
      : 'HTTP config written but nginx reload failed',
    ...result,
  })
})

// ── POST /api/ssl/upload ────────────────────────────────────────────────────
// Body: { cert: string (PEM), key: string (PEM) }
// Validates the pair with tls.createSecureContext before writing to disk.
router.post('/upload', authenticate, authorize('admin'), (req, res) => {
  const { cert, key } = req.body
  if (!cert || !key) return res.status(400).json({ error: 'cert and key fields are required' })

  // Strip Windows-style line endings in case browser / copy-paste introduced them
  const certPem = cert.replace(/\r\n/g, '\n').trim()
  const keyPem  = key.replace(/\r\n/g, '\n').trim()

  if (!certPem.includes('-----BEGIN CERTIFICATE-----')) {
    return res.status(400).json({ error: 'cert does not look like a PEM certificate' })
  }
  if (!keyPem.includes('-----BEGIN')) {
    return res.status(400).json({ error: 'key does not look like a PEM private key' })
  }

  // Validate cert/key pair cryptographically — catches mismatches before writing
  try {
    createSecureContext({ cert: certPem, key: keyPem })
  } catch (err) {
    return res.status(400).json({ error: `Certificate/key mismatch or invalid PEM: ${err.message}` })
  }

  try {
    ensureCertsDir()
    // nginx (uid 101) must read these from a separate container via shared volume
    writeFileSync(CERT_PATH, certPem + '\n', { mode: 0o644 })
    writeFileSync(KEY_PATH,  keyPem  + '\n', { mode: 0o644 })
    res.json({ ok: true, cert: readCertInfo() })
  } catch (err) {
    res.status(500).json({ error: `Failed to write certificate files: ${err.message}` })
  }
})

// ── POST /api/ssl/reload ────────────────────────────────────────────────────
// Writes the saved HTTP/HTTPS nginx config, then reloads nginx.
router.post('/reload', authenticate, authorize('admin'), async (_req, res) => {
  const mode = readMode()
  if (mode === 'https' && (!existsSync(CERT_PATH) || !existsSync(KEY_PATH))) {
    return res.status(400).json({ error: 'No certificate installed. Upload a certificate first.' })
  }

  const result = await applyCurrentSslNginx()
  if (!result.ok) {
    return res.status(result.skipped ? 400 : 500).json({
      ok: false,
      error: result.error || 'Automatic nginx reload failed. Run the command below manually.',
      detail: result.error,
      manual: result.manual,
      written: result.written,
    })
  }

  return res.json({
    ok: true,
    mode,
    message: mode === 'https'
      ? 'HTTPS nginx config applied and reloaded'
      : 'HTTP nginx config applied and reloaded',
    written: result.written,
    stdout: result.stdout,
    stderr: result.stderr,
  })
})

// ── POST /api/ssl/test ──────────────────────────────────────────────────────
// Dry-run: validate PEM pair without writing to disk.
router.post('/test', authenticate, authorize('admin'), (req, res) => {
  const { cert, key } = req.body
  if (!cert || !key) return res.status(400).json({ error: 'cert and key are required' })
  try {
    createSecureContext({ cert, key })
    const x = new X509Certificate(cert)
    res.json({
      ok:      true,
      cert: {
        subject:   x.subject,
        issuer:    x.issuer,
        validFrom: x.validFrom,
        validTo:   x.validTo,
        daysLeft:  Math.ceil((new Date(x.validTo) - new Date()) / 86_400_000),
        expired:   new Date(x.validTo) < new Date(),
      },
    })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})

// ── DELETE /api/ssl ─────────────────────────────────────────────────────────
router.delete('/', authenticate, authorize('admin'), (req, res) => {
  try {
    if (existsSync(CERT_PATH)) unlinkSync(CERT_PATH)
    if (existsSync(KEY_PATH))  unlinkSync(KEY_PATH)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
