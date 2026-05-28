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

async function reloadNginxWith(confContent) {
  // Write config to a temp location on the shared certs volume then exec copy+reload
  const tmpConf = resolve(CERTS_DIR, 'nginx-netpulse.conf')
  writeFileSync(tmpConf, confContent + '\n', { mode: 0o644 })

  const nginxConfPath = '/etc/nginx/conf.d/default.conf'
  const cmd =
    `docker exec ${NGINX_CTR} sh -c "cp /etc/nginx/certs/nginx-netpulse.conf ${nginxConfPath} && nginx -t && nginx -s reload"`
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 15_000 })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (dockerErr) {
    // fallback: host nginx
    try {
      await execAsync('nginx -s reload', { timeout: 10_000 })
      return { ok: true, stdout: 'host nginx reloaded' }
    } catch {
      return { ok: false, error: dockerErr.message, manual: `docker exec ${NGINX_CTR} nginx -s reload` }
    }
  }
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
    const nginxCertPath = '/etc/nginx/certs/' + CERT_FILE
    const nginxKeyPath  = '/etc/nginx/certs/' + KEY_FILE
    writeMode('https')
    const result = await reloadNginxWith(HTTPS_NGINX_CONF(nginxCertPath, nginxKeyPath))
    return res.json({ ok: result.ok, mode: 'https', message: result.ok ? 'HTTPS enabled — nginx reloaded' : 'HTTPS mode saved but nginx reload failed', ...result })
  }

  // HTTP mode
  writeMode('http')
  const result = await reloadNginxWith(HTTP_ONLY_NGINX_CONF)
  return res.json({ ok: result.ok, mode: 'http', message: result.ok ? 'Switched to HTTP — nginx reloaded' : 'HTTP mode saved but nginx reload failed', ...result })
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
    writeFileSync(CERT_PATH, certPem + '\n', { mode: 0o640 })
    writeFileSync(KEY_PATH,  keyPem  + '\n', { mode: 0o640 })
    res.json({ ok: true, cert: readCertInfo() })
  } catch (err) {
    res.status(500).json({ error: `Failed to write certificate files: ${err.message}` })
  }
})

// ── POST /api/ssl/reload ────────────────────────────────────────────────────
// Triggers `nginx -s reload` inside the nginx container — graceful reload,
// no service restart, zero dropped connections.
router.post('/reload', authenticate, authorize('admin'), async (_req, res) => {
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
    return res.status(400).json({ error: 'No certificate installed. Upload a certificate first.' })
  }

  // Attempt 1: Docker exec into the nginx sidecar
  try {
    const { stdout, stderr } = await execAsync(
      `docker exec ${NGINX_CTR} nginx -t && docker exec ${NGINX_CTR} nginx -s reload`,
      { timeout: 15_000 },
    )
    return res.json({
      ok:      true,
      message: 'Nginx config tested and reloaded gracefully',
      stdout:  stdout.trim(),
      stderr:  stderr.trim(),
    })
  } catch (dockerErr) {
    // Attempt 2: nginx running on the host (non-Docker deployments)
    try {
      const { stdout } = await execAsync('nginx -s reload', { timeout: 10_000 })
      return res.json({ ok: true, message: 'Nginx reloaded gracefully (host)', stdout: stdout.trim() })
    } catch {
      // Neither worked — return the Docker error with manual instructions
      return res.status(500).json({
        ok:      false,
        error:   'Automatic nginx reload failed. Run the command below manually.',
        detail:  dockerErr.message,
        manual:  `docker exec ${NGINX_CTR} nginx -s reload`,
      })
    }
  }
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
