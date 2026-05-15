/**
 * Web RDP — browser-based Remote Desktop via Apache Guacamole protocol.
 *
 * Architecture
 * ────────────
 *   Browser (guacamole-common-js)
 *       ↕  WebSocket  /api/rdp/ws?token=TOKEN
 *   Netpulse server  (this file)
 *       ↕  TCP  127.0.0.1:4822  (configurable via GUACD_HOST / GUACD_PORT)
 *   guacd daemon  (apt-get install guacd  OR  docker run -d -p 4822:4822 guacamole/guacd)
 *       ↕  RDP  device:3389
 *   Windows Server
 *
 * Token security
 * ──────────────
 * Credentials never appear in the WebSocket URL.  Instead:
 *   1. Browser calls POST /api/rdp/session/:deviceId (authenticated REST).
 *   2. Server creates an AES-256-CBC encrypted token containing the device IP,
 *      RDP port, username, and password.
 *   3. Token is returned to the browser; browser opens WebSocket with the token
 *      as a query param.
 *   4. Server decrypts the token, performs the Guacamole handshake with guacd,
 *      and INTERCEPTS the client's `connect` instruction to inject the real
 *      credentials (the browser JS never has to know them).
 *
 * Guacamole handshake (what we do at WS connect time)
 * ──────────────────────────────────────────────────────
 *   Client → WS → Server: "6.select,3.rdp;"
 *   Server → guacd TCP:   "6.select,3.rdp;"
 *   guacd  → Server:      "4.args,hostname,port,username,…;"
 *   Server → WS → Client: "4.args,hostname,port,username,…;"   (forwarded)
 *   Client → WS → Server: "7.connect,<placeholder values>;"    (client doesn't know password)
 *   Server → guacd TCP:   "7.connect,<real values from token>;" (INTERCEPTED — real creds injected)
 *   guacd  → Server:      "5.ready,<connection-id>;"
 *   Server → WS → Client: "5.ready,<connection-id>;"           (forwarded)
 *   ──── bidirectional proxy from here on ────
 */

import { Router }       from 'express'
import net              from 'net'
import crypto           from 'crypto'
import { WebSocketServer } from 'ws'
import Device           from '../models/Device.js'
import { authenticate } from '../middleware/auth.js'
import { getPlainMgmtForUser } from '../utils/deviceUserCredential.js'

const router = Router()

// ── Token encryption ──────────────────────────────────────────────────────────
// AES-256-CBC with a 32-byte key and a fixed 16-byte IV.
// The token is opaque to the browser; credentials are never exposed in the URL.
const RAW_KEY  = process.env.GUAC_CRYPT_KEY || 'netpulse-guac-key-change-in-prod!'
const GUAC_KEY = Buffer.from(RAW_KEY.padEnd(32, '!').slice(0, 32), 'utf8')
const GUAC_IV  = Buffer.from('netpulseguacamol', 'utf8') // exactly 16 bytes

function encryptRdpToken(payload) {
  const cipher = crypto.createCipheriv('AES-256-CBC', GUAC_KEY, GUAC_IV)
  const json    = JSON.stringify(payload)
  return Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]).toString('base64url')
}

function decryptRdpToken(token) {
  try {
    const buf     = Buffer.from(token, 'base64url')
    const decipher = crypto.createDecipheriv('AES-256-CBC', GUAC_KEY, GUAC_IV)
    const json     = Buffer.concat([decipher.update(buf), decipher.final()]).toString('utf8')
    const payload  = JSON.parse(json)
    if (!payload.expiresAt || payload.expiresAt < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

// ── Guacamole protocol helpers ────────────────────────────────────────────────

/**
 * Encode a Guacamole instruction.
 *   guacFmt('select', 'rdp')  →  "6.select,3.rdp;"
 *   guacFmt('connect', 'admin', 'pass', '3389')  →  "7.connect,5.admin,4.pass,4.3389;"
 */
function guacFmt(opcode, ...args) {
  return [opcode, ...args]
    .map(v => { const s = String(v ?? ''); return `${s.length}.${s}` })
    .join(',') + ';'
}

/**
 * Parse a complete Guacamole instruction string into an array of element strings.
 *   parseGuac("4.args,8.hostname,4.port;")  →  ['args', 'hostname', 'port']
 */
function parseGuac(str) {
  const elems = []
  let i = 0
  while (i < str.length) {
    const dot = str.indexOf('.', i)
    if (dot < 0) break
    const len = parseInt(str.slice(i, dot), 10)
    if (Number.isNaN(len)) break
    elems.push(str.slice(dot + 1, dot + 1 + len))
    i = dot + 1 + len
    const sep = str[i]
    if (sep === ';') break
    if (sep === ',') i++
  }
  return elems
}

// ── TCP reachability probe ────────────────────────────────────────────────────

function tcpReachable(host, port, ms = 5000) {
  return new Promise(resolve => {
    const s = new net.Socket()
    let settled = false
    const done = (ok) => { if (!settled) { settled = true; s.destroy(); resolve(ok) } }
    s.setTimeout(ms)
    s.on('connect',  () => done(true))
    s.on('timeout',  () => done(false))
    s.on('error',    () => done(false))
    s.connect(port, host.replace(/^\[|\]$/g, ''))
  })
}

// ── REST: probe RDP port ──────────────────────────────────────────────────────

router.get('/probe/:deviceId', authenticate, async (req, res) => {
  try {
    const dev = await Device.findById(req.params.deviceId)
    if (!dev) return res.status(404).json({ error: 'Device not found' })
    const ip   = String(dev.ip || '').trim()
    const port = Number(dev.rdpPort) > 0 ? Number(dev.rdpPort) : 3389
    const ok   = await tcpReachable(ip, port)
    res.json({ ip, rdpPort: port, ok })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── REST: create RDP session token ───────────────────────────────────────────

router.post('/session/:deviceId', authenticate, async (req, res) => {
  try {
    const dev = await Device.findById(req.params.deviceId)
    if (!dev) return res.status(404).json({ error: 'Device not found' })
    if (!dev.ip) return res.status(400).json({ error: 'Device has no IP address' })

    const ip       = String(dev.ip).trim().replace(/^\[|\]$/g, '')
    const rdpPort  = Number(dev.rdpPort) > 0 ? Number(dev.rdpPort) : 3389
    const domain = dev.rdpDomain || req.body?.domain || ''
    const plain  = await getPlainMgmtForUser(req.user._id, dev._id)
    const username = plain.mgmtUsername || ''
    const password = plain.password || ''

    // Optional display params from client (defaults used when absent)
    const width    = Math.max(800, Math.min(4096, Number(req.body?.width)  || 1280))
    const height   = Math.max(600, Math.min(2160, Number(req.body?.height) || 800))
    const security = ['any', 'rdp', 'nla', 'nla-ext', 'tls'].includes(req.body?.security)
      ? req.body.security : 'any'

    const token = encryptRdpToken({
      ip, rdpPort, domain, username, password,
      width, height, security,
      ignoreCert:   req.body?.ignoreCert !== false,
      certTofu:     req.body?.certTofu === true,
      resizeMethod: req.body?.resizeMethod,
      enableWallpaper:      req.body?.enableWallpaper      === true,
      enableFontSmoothing:  req.body?.enableFontSmoothing  !== false,
      colorDepth:           req.body?.colorDepth           || 16,
      expiresAt: Date.now() + 15 * 60 * 1000,  // 15 min
    })

    res.json({
      token,
      wsPath: '/api/rdp/ws',
      device: { id: dev._id, name: dev.name, ip, rdpPort },
      hasCredentials: Boolean(username && password),
      warning: (!username || !password)
        ? 'No credentials saved for your account on this device — RDP may show its own login. Edit the device and save your username/password (stored per user).'
        : null,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router

// ── WebSocket upgrade handler ─────────────────────────────────────────────────
// Registered on the raw httpServer so it runs alongside Socket.IO's handler.
// Only processes requests whose path is exactly /api/rdp/ws; returns immediately
// for every other path so Socket.IO can handle them.

const rdpWss = new WebSocketServer({ noServer: true })

const GUACD_HOST = () => process.env.GUACD_HOST || '127.0.0.1'
const GUACD_PORT = () => Number(process.env.GUACD_PORT) || 4822

/**
 * Resize method passed to guacd.  Valid values per Guacamole 1.6.0:
 *   ''               — no resize (default; safest across Windows versions)
 *   'reconnect'      — disconnect & reconnect on resize
 *   'display-update' — RDP Display Update virtual channel (can drop sessions
 *                      on some Windows builds right after ready)
 *
 * NB: 'none' is NOT a valid value — guacd logs it as invalid and on some
 * FreeRDP builds the worker thread dies after keymap load.  Map any unknown
 * value (including the legacy 'none') to '' so guacd treats it as no-resize.
 */
function rdpResizeMethod(session) {
  const raw = session?.resizeMethod ?? process.env.RDP_RESIZE_METHOD ?? ''
  const v = String(raw).toLowerCase().trim()
  return ['reconnect', 'display-update'].includes(v) ? v : ''
}

export async function proxyRdpWsUpgrade(req, socket, head) {
  // Only handle our RDP WebSocket path
  let parsedUrl
  try { parsedUrl = new URL(req.url, 'http://localhost') } catch { return }
  if (parsedUrl.pathname !== '/api/rdp/ws') return

  // Decrypt session token
  const rawToken = parsedUrl.searchParams.get('token')
  const session  = rawToken ? decryptRdpToken(rawToken) : null
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
    return
  }

  // Upgrade the browser connection to a WebSocket
  rdpWss.handleUpgrade(req, socket, head, (ws) => {
    setupRdpTunnel(ws, session)
  })
}

/**
 * Resolve guacd `connect` arg names to our configured values.
 * Names are normally hyphenated (e.g. ignore-cert); tolerate underscore variants.
 */
function lookupGuacdSetting(settings, name) {
  if (/^VERSION_\d/.test(name)) return name
  const candidates = [name]
  if (name.includes('_')) candidates.push(name.replace(/_/g, '-'))
  if (name.includes('-')) candidates.push(name.replace(/-/g, '_'))
  for (const k of candidates) {
    if (Object.prototype.hasOwnProperty.call(settings, k)) return settings[k]
  }
  return ''
}

/**
 * Wire the browser WebSocket to a guacd TCP connection.
 *
 * Guacamole protocol flow:
 *   1. client → select   : which protocol (rdp)
 *   2. guacd  → args     : which settings it needs
 *   3. client → connect  : INTERCEPTED — real creds injected from session token
 *   4. guacd  → ready    : connection established
 *   5. bidirectional proxy for all subsequent display/input instructions
 */
function setupRdpTunnel(ws, session) {
  const tag = `[rdp-proxy ${session.ip}:${session.rdpPort}]`

  const guacdOpcodeTrail = []
  let lastGuacdErrorText = null
  function traceGuacdOpcode(op) {
    if (!op || op === 'blob') return
    guacdOpcodeTrail.push(op)
    if (guacdOpcodeTrail.length > 16) guacdOpcodeTrail.shift()
  }

  // Map from guacd arg name → value from session token
  const rdpSettings = buildRdpSettings(session)

  const guacd = new net.Socket()
  let guacdBuf      = ''    // incomplete instruction buffer from guacd
  let argNames      = []    // filled when guacd sends 'args' during handshake
  let handshakeDone = false
  let guacdReady    = false // true once TCP connect succeeds
  let sessionReady  = false // true once guacd sends 'ready' (RDP session established)

  // Messages from the browser that arrive before guacd TCP is established.
  // Normally only the client's `select` arrives in this window; we handle that
  // ourselves, so this buffer just ensures we don't drop anything unexpected.
  const clientQueue = []

  // ── guacd → client ──────────────────────────────────────────────────────────
  guacd.on('data', (chunk) => {
    guacdBuf += chunk.toString('utf8')

    let end
    while ((end = guacdBuf.indexOf(';')) >= 0) {
      const msg   = guacdBuf.slice(0, end + 1)
      guacdBuf    = guacdBuf.slice(end + 1)
      const elems = parseGuac(msg)

      if (!handshakeDone && elems[0] === 'args') {
        // Capture arg names guacd expects so we can fill them at connect time.
        argNames = elems.slice(1)
        console.log(`${tag} guacd args: [${argNames.slice(0, 8).join(', ')}…] (${argNames.length} total)`)

        // ── Step 1: send 'size' BEFORE 'connect' ─────────────────────────────
        // guacd stores the Guacamole client's screen size in user->info.optimal_width/height.
        // Normally set via the HTTP tunnel handshake; our direct TCP proxy never does it.
        // Result: optimal_width = 0, which some guacd/FreeRDP code paths divide by →
        // SIGFPE → child process dies immediately after sending 'ready' with no display data.
        // Sending 'size' here (after 'args', before 'connect') populates user->info in time
        // for the RDP plugin to read it safely.  'size' is valid at any point after select.
        const pw = String(session.width  || 1280)
        const ph = String(session.height || 800)
        if (guacd.writable) guacd.write(guacFmt('size', pw, ph, '96'))

        // ── Step 2: send real 'connect' with credentials from encrypted token ─
        const realValues = argNames.map(name => lookupGuacdSetting(rdpSettings, name))
        const realConnect = guacFmt('connect', ...realValues)
        const dbg = ['width','height','dpi','security','ignore-cert','color-depth','username','hostname']
          .map(k => `${k}=${realValues[argNames.indexOf(k)] ?? '(missing)'}`)
          .join(' | ')
        console.log(`${tag} injecting connect (${argNames.length} args) for ${session.ip} — ${dbg}`)
        if (guacd.writable) guacd.write(realConnect)
        handshakeDone = true

        // Now forward the original 'args' instruction to the browser so the
        // guacamole-common-js / guacamole.js client state machine advances normally.
        if (ws.readyState === ws.OPEN) {
          try { ws.send(msg) } catch { /* ignore */ }
        }
        continue
      }

      // Log guacd-level errors and mark session ready on success.
      if (elems[0] === 'error') {
        console.error(`${tag} guacd error: "${elems[1]}" (code ${elems[2]})`)
        lastGuacdErrorText = elems.slice(1).join(' | ')
      }
      if (elems[0] === 'ready') {
        sessionReady = true
        // NB: 'ready' is the Guacamole-protocol handshake completing — guacd has
        // parsed our connect args and is *about to* start the FreeRDP backend.
        // It does NOT mean the RDP session to Windows is up.  Display data
        // ('img', 'png', etc.) starting to flow is the real signal.
        console.log(`${tag} guacamole handshake ready — FreeRDP backend starting`)
      }

      // Forward everything else (ready, sync, display instructions, error…) to the browser.
      if (ws.readyState === ws.OPEN) {
        try { ws.send(msg) } catch { /* ignore */ }
      }
      if (elems[0]) traceGuacdOpcode(elems[0])
    }
  })

  // ── client → guacd ──────────────────────────────────────────────────────────
  ws.on('message', (raw) => {
    const msg   = typeof raw === 'string' ? raw : raw.toString('utf8')
    const elems = parseGuac(msg)

    if (!guacdReady) {
      // guacd TCP not open yet — queue (only non-select messages matter)
      if (elems[0] !== 'select') clientQueue.push(msg)
      return
    }

    // Server injects the real `connect` when guacd sends `args`. The browser still
    // sends a placeholder `connect` for its state machine — it must never reach guacd
    // or the session corrupts (often seen as WebSocket closed code 1005).
    if (elems[0] === 'select') return
    if (elems[0] === 'connect') return

    // Post-handshake: input events (key, mouse, sync, clipboard…) — forward as-is
    if (guacd.writable) guacd.write(msg)
  })

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  ws.on('close', () => {
    console.log(`${tag} browser disconnected`)
    guacd.destroy()
  })
  ws.on('error', (e) => {
    console.error(`${tag} WebSocket error:`, e.message)
    guacd.destroy()
  })
  guacd.on('connect', () => {
    guacdReady = true
    console.log(`${tag} guacd TCP connected — sending select,rdp`)

    // SERVER initiates the Guacamole handshake.  select MUST be the very first
    // instruction sent to guacd — anything else (including size) causes an
    // immediate protocol rejection and connection close.
    guacd.write(guacFmt('select', 'rdp'))

    // Flush any queued client messages (should rarely be non-empty)
    for (const msg of clientQueue) {
      if (guacd.writable) guacd.write(msg)
    }
    clientQueue.length = 0
  })
  guacd.on('close', () => {
    console.log(`${tag} guacd closed (sessionReady=${sessionReady})`)
    if (sessionReady && guacdOpcodeTrail.length) {
      console.warn(
        `${tag} guacd dropped active session — opcode trail: ${guacdOpcodeTrail.join(' → ')}`,
      )
      if (lastGuacdErrorText) console.warn(`${tag} last guacd error instruction: ${lastGuacdErrorText}`)
    }
    if (ws.readyState !== ws.OPEN) return

    if (!sessionReady) {
      const hint = [
        `RDP connection to ${session.ip}:${session.rdpPort} was rejected by the server.`,
        `Most likely causes:`,
        `(1) No credentials saved — go to Admin → Devices → Edit → add Username + Password and tick "Save password".`,
        `(2) Wrong credentials — Windows rejected NLA authentication.`,
        `(3) Windows Server requires NLA — open RDP Settings and try Security Mode "Classic RDP" or "NLA" with correct creds.`,
        `(4) Windows Firewall blocks the Docker subnet — add an inbound RDP rule for 172.16.0.0/12.`,
      ].join(' ')
      console.error(`${tag} ${hint}`)
      try { ws.send(guacFmt('error', hint, '516')) } catch { /* ignore */ }
      try { ws.close(1000, 'rdp handshake failed') } catch { /* ignore */ }
      return
    }

    // Normal / mid-session guacd teardown: Guacamole `disconnect` then a proper WS close frame ASAP.
    // Waiting hundreds of ms lets browsers/proxies report synthetic 1005 (no status) more often.
    try { ws.send(guacFmt('disconnect')) } catch { /* ignore */ }
    const finishWs = () => {
      try {
        if (ws.readyState === ws.OPEN) ws.close(1000, 'guacd ended')
      } catch { /* ignore */ }
    }
    setImmediate(finishWs)
    const watchdog = setTimeout(finishWs, 1200)
    ws.once('close', () => clearTimeout(watchdog))
  })
  guacd.on('error', (e) => {
    console.error(`${tag} guacd error:`, e.message)
    const hint = e.code === 'ECONNREFUSED'
      ? `guacd is not running at ${GUACD_HOST()}:${GUACD_PORT()}. Run: docker run -d -p 4822:4822 guacamole/guacd`
      : e.message
    const errMsg = guacFmt('error', hint, '516') // 516 = UPSTREAM_ERROR
    if (ws.readyState === ws.OPEN) {
      try { ws.send(errMsg) } catch { /* ignore */ }
      try { ws.close(1011, 'guacd tcp error') } catch { /* ignore */ }
    }
  })

  // Connect to guacd
  const host = GUACD_HOST()
  const port = GUACD_PORT()
  console.log(`${tag} connecting to guacd ${host}:${port}`)
  guacd.connect(port, host)
}

/**
 * Map guacd arg names (which vary slightly by guacd version) to values from
 * the session token.  Unknown args get an empty string (guacd ignores them).
 *
 * RDP_MINIMAL=1 in .env switches to a stripped-down parameter set that mirrors
 * what `xfreerdp /v: /u: /p: /cert:ignore +auth-only` sends — used as a
 * bisection tool when libguac-rdp's child crashes during init.  If RDP works
 * in minimal mode but fails in the default mode, one of the dropped params
 * is the culprit.
 */
function buildRdpSettings(s) {
  const ignoreCert = s.ignoreCert !== false
  const certTofu = ignoreCert ? false : (s.certTofu === true)

  if (process.env.RDP_MINIMAL === '1') {
    // Bare-minimum parameter set — matches what xfreerdp default uses.
    // Everything else is left to guacd/FreeRDP defaults.
    return {
      hostname:      s.ip,
      port:          String(s.rdpPort),
      username:      s.username || '',
      password:      s.password || '',
      'ignore-cert': 'true',
      width:         String(s.width  || 1280),
      height:        String(s.height || 800),
      dpi:           '96',
      'color-depth': '32',                // matches xfreerdp default
      security:      'nla',                // matches what xfreerdp negotiated
    }
  }

  return {
    // Core connection
    hostname:           s.ip,
    port:               String(s.rdpPort),
    username:           s.username || '',
    password:           s.password || '',
    domain:             s.domain   || '',
    // Security — ignore-cert matches approving unknown TLS certs for the RDP server (like Yes in mstsc)
    security:           s.security || 'any',
    'ignore-cert':      ignoreCert ? 'true' : 'false',
    'cert-tofu':        certTofu ? 'true' : 'false',
    'cert-fingerprints':'',
    'disable-auth':     'false',
    // Display
    width:              String(s.width  || 1280),
    height:             String(s.height || 800),
    dpi:                '96',
    'color-depth':      String(s.colorDepth || 16),
    // Performance — keep defaults sane for a VPN/LAN connection
    'enable-wallpaper':          s.enableWallpaper     ? 'true' : 'false',
    'enable-font-smoothing':     s.enableFontSmoothing !== false ? 'true' : 'false',
    'enable-full-window-drag':   'false',
    'enable-menu-animations':    'false',
    'enable-desktop-composition':'false',
    'disable-bitmap-caching':    'false',
    'disable-offscreen-caching': 'false',
    'disable-glyph-caching':     'false',
    'resize-method':             rdpResizeMethod(s),
    // RDPGFX (RDP Graphics Pipeline) — disabled by default; field-confirmed
    // SIGFPE in libguac-client-rdp.so otherwise:
    //
    //   traps: guacd[N] trap divide error ip:... in libguac-client-rdp.so.0.0.0
    //
    // Reproduced on Ubuntu prod (Lenskart, May 2026) with guacd 1.6.0 against
    // Windows Server 2019/2022.  GFX requires 32-bpp + a compatible FreeRDP ↔
    // Windows handshake; when that combination fails, libguac-rdp's child does
    // a divide-by-zero on width/height optimal values and the entire RDP
    // session is killed immediately after `ready`.  Classic bitmap rendering
    // (disable-gfx=true) is what mstsc falls back to and works universally.
    //
    // Set RDP_DISABLE_GFX=false in env to opt back in (only if you've confirmed
    // your specific Windows host + guacd version don't hit the SIGFPE).
    'disable-gfx': process.env.RDP_DISABLE_GFX === 'false' ? 'false' : 'true',
    // Features (disabled by default — enable via env or future UI toggle)
    'enable-audio':              'false',
    'enable-drive':              'false',
    'create-drive-path':         'false',
    'enable-printing':           'false',
    // NLA / certificate
    'server-layout':             '',
    'timezone':                  '',
    'remote-app':                '',
    'remote-app-dir':            '',
    'remote-app-args':           '',
    'preconnection-id':          '',
    'preconnection-blob':        '',
    'gateway-hostname':          '',
    'gateway-port':              '',
    'gateway-domain':            '',
    'gateway-username':          '',
    'gateway-password':          '',
    'load-balance-info':         '',
    'recording-path':            '',
    'recording-name':            '',
    'recording-exclude-output':  'false',
    'recording-exclude-mouse':   'false',
    'recording-include-keys':    'false',
    'create-recording-path':     'false',
    'sftp-hostname':             '',
    'sftp-host-key':             '',
    'sftp-port':                 '',
    'sftp-username':             '',
    'sftp-password':             '',
    'sftp-private-key':          '',
    'sftp-passphrase':           '',
    'sftp-root-directory':       '',
    'sftp-directory':            '',
    'sftp-server-alive-interval':'0',
    'enable-sftp':               'false',
    'wol-send-packet':           'false',
    'wol-mac-addr':              '',
    'wol-broadcast-addr':        '',
    'wol-udp-port':              '',
    'wol-wait-time':             '',
    'normalize-clipboard':       'preserve',
    'force-lossless':            'false',
    'read-only':                 'false',
    'console-audio':             'false',
    'console':                   'false',
    'initial-program':           '',
    'static-channels':           '',
    'client-name':               'netpulse',
  }
}
