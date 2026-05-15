/**
 * guacamole.js — Minimal Apache Guacamole protocol client
 *
 * Implements the subset of guacamole-common-js used by RdpFrame:
 *   Guacamole.WebSocketTunnel, Guacamole.Client,
 *   Guacamole.Mouse, Guacamole.Keyboard
 *
 * Protocol reference: https://guacamole.apache.org/doc/gug/guacamole-protocol.html
 * Apache License 2.0 compatible implementation — no external dependencies.
 */

// ── Guacamole protocol encode / decode ───────────────────────────────────────

/** Encode an array of elements into a Guacamole instruction string.
 *  guacEncode(['select','rdp']) → "6.select,3.rdp;"
 */
function guacEncode(elements) {
  return elements.map(v => { const s = String(v ?? ''); return `${s.length}.${s}` }).join(',') + ';'
}

/** Decode a complete Guacamole instruction string into an array of strings.
 *  guacDecode("4.args,8.hostname,4.port;") → ['args','hostname','port']
 */
function guacDecode(str) {
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

// ── WebSocketTunnel ───────────────────────────────────────────────────────────

/**
 * Guacamole.WebSocketTunnel
 *
 * Connects to the Netpulse RDP WebSocket endpoint, frames messages using the
 * Guacamole text protocol, and fires oninstruction for each complete instruction.
 *
 * Callbacks:
 *   onopen()                        — fired when WebSocket is open
 *   oninstruction(opcode, args[])   — fired for each decoded instruction
 *   onerror({ message })            — fired on WebSocket/tunnel error
 *   onstatechange(state)            — 0=connecting, 1=open, 2=closed
 */
function WebSocketTunnel(url) {
  let ws = null
  let recvBuf = ''
  /** True after local disconnect() — avoids treating peer RST / missing close frame as a hard failure */
  let intentionalClose = false
  const self = this

  this.onopen        = null
  this.oninstruction = null
  this.onerror       = null
  this.onstatechange = null

  function setState(s) {
    if (self.onstatechange) self.onstatechange(s)
  }

  function drainBuffer() {
    let end
    while ((end = recvBuf.indexOf(';')) >= 0) {
      const msg  = recvBuf.slice(0, end + 1)
      recvBuf    = recvBuf.slice(end + 1)
      const elems = guacDecode(msg)
      if (elems.length > 0 && self.oninstruction) {
        try {
          self.oninstruction(elems[0], elems.slice(1))
        } catch (e) {
          console.error('[guacamole] instruction handler error:', elems[0], e)
        }
      }
    }
  }

  this.connect = function () {
    intentionalClose = false
    setState(0)
    ws = new WebSocket(url)

    ws.onopen = () => {
      setState(1)
      if (self.onopen) self.onopen()
    }

    ws.onmessage = (evt) => {
      recvBuf += (typeof evt.data === 'string') ? evt.data : evt.data.toString()
      drainBuffer()
    }

    ws.onerror = () => {
      if (self.onerror) self.onerror({ message: 'WebSocket connection failed' })
    }

    ws.onclose = (evt) => {
      setState(2)
      const code = evt.code
      if (code === 1000 || code === 1001) return
      // Ordered teardown but peer reset TCP before the close handshake finished (common with proxies / container restarts).
      if (intentionalClose && (code === 1005 || code === 1006)) return
      const detail =
        code === 1005
          ? 'The RDP tunnel closed without a WebSocket close frame (1005). Typical causes: Windows or guacd ended the session immediately after connect; the Netpulse API restarted mid-session (e.g. Redis errors with node --watch); a reverse proxy dropped the WebSocket without forwarding close; or brief network loss. Check docker logs for netpulse-server and guacd; in Settings try Classic RDP vs NLA and a lower display resolution.'
          : `WebSocket closed (code ${code})`
      if (self.onerror) self.onerror({ message: detail })
    }
  }

  this.disconnect = function () {
    intentionalClose = true
    if (ws && ws.readyState < WebSocket.CLOSING) {
      try { ws.close(1000, 'tunnel closed') } catch { /* ignore */ }
    }
  }

  /** Send an instruction. elements = [opcode, arg1, arg2, …] */
  this.sendMessage = function (elements) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try { ws.send(guacEncode(elements)) } catch { /* ignore */ }
  }
}

// ── Display ───────────────────────────────────────────────────────────────────

/**
 * Manages a stack of canvas layers that represent the remote display.
 *
 * Layer 0 is always present (the root layer).
 * Additional layers (for windows, cursors, etc.) are composited on top.
 */
function Display() {
  const container = document.createElement('div')
  container.style.cssText = 'position:relative;overflow:hidden;'

  let displayW = 1280
  let displayH =  800
  let scale    = 1.0

  const layers  = {}    // idx → <canvas>
  const ctxs    = {}    // idx → CanvasRenderingContext2D
  const streams = {}    // streamIdx → { mime, layerIdx, dx, dy, chunks[] }

  // ── Layer management ─────────────────────────────────────────────────────────

  function ensureLayer(idx) {
    if (layers[idx]) return
    const cv = document.createElement('canvas')
    cv.width  = displayW
    cv.height = displayH
    cv.style.cssText = `position:absolute;top:0;left:0;z-index:${idx};`
    container.appendChild(cv)
    layers[idx] = cv
    ctxs[idx]   = cv.getContext('2d')
  }

  function ctx(idx) {
    ensureLayer(idx)
    return ctxs[idx]
  }

  // Initialise default layer
  ensureLayer(0)

  // ── Public getters ────────────────────────────────────────────────────────────

  this.getElement  = () => container
  this.getWidth    = () => displayW
  this.getHeight   = () => displayH

  this.scale = function (s) {
    scale = s
    container.style.width           = displayW + 'px'
    container.style.height          = displayH + 'px'
    container.style.transform       = `scale(${s})`
    container.style.transformOrigin = '0 0'
  }

  // ── Instruction handler ───────────────────────────────────────────────────────

  this.handleInstruction = function (opcode, args) {
    switch (opcode) {

      // ── Viewport & layers ─────────────────────────────────────────────────────

      case 'size': {
        // size LAYER W H
        const layerIdx = parseInt(args[0], 10)
        const w = parseInt(args[1], 10)
        const h = parseInt(args[2], 10)
        if (!w || !h) break
        ensureLayer(layerIdx)
        layers[layerIdx].width  = w
        layers[layerIdx].height = h
        if (layerIdx === 0) {
          displayW = w
          displayH = h
          container.style.width  = w * scale + 'px'
          container.style.height = h * scale + 'px'
        }
        break
      }

      case 'move': {
        // move LAYER PARENT X Y Z — protocol-reference.html
        const layerIdx = parseInt(args[0], 10)
        const x = parseInt(args[2], 10)
        const y = parseInt(args[3], 10)
        ensureLayer(layerIdx)
        layers[layerIdx].style.left = x + 'px'
        layers[layerIdx].style.top  = y + 'px'
        break
      }

      case 'shade': {
        // shade LAYER OPACITY(0-255)
        const layerIdx = parseInt(args[0], 10)
        ensureLayer(layerIdx)
        layers[layerIdx].style.opacity = String(parseInt(args[1], 10) / 255)
        break
      }

      case 'dispose': {
        // dispose LAYER
        const layerIdx = parseInt(args[0], 10)
        if (layers[layerIdx] && layerIdx !== 0) {
          container.removeChild(layers[layerIdx])
          delete layers[layerIdx]
          delete ctxs[layerIdx]
        }
        break
      }

      // ── Drawing ───────────────────────────────────────────────────────────────

      case 'rect': {
        // rect MASK LAYER X Y WIDTH HEIGHT
        const layerIdx = parseInt(args[1], 10)
        const c = ctx(layerIdx)
        c.beginPath()
        c.rect(parseInt(args[2], 10), parseInt(args[3], 10),
               parseInt(args[4], 10), parseInt(args[5], 10))
        break
      }

      case 'cfill': {
        // cfill MASK LAYER R G B A
        const layerIdx = parseInt(args[1], 10)
        const c = ctx(layerIdx)
        c.fillStyle = `rgba(${args[2]},${args[3]},${args[4]},${parseInt(args[5], 10) / 255})`
        c.fill()
        break
      }

      case 'cstroke': {
        // cstroke MASK LAYER CAP JOIN THICKNESS R G B A
        const caps  = ['butt', 'round', 'square']
        const joins = ['bevel', 'miter', 'round']
        const layerIdx = parseInt(args[1], 10)
        const c = ctx(layerIdx)
        c.lineCap     = caps[parseInt(args[2], 10)]  ?? 'butt'
        c.lineJoin    = joins[parseInt(args[3], 10)] ?? 'miter'
        c.lineWidth   = parseFloat(args[4]) || 1
        c.strokeStyle = `rgba(${args[5]},${args[6]},${args[7]},${parseInt(args[8], 10) / 255})`
        c.stroke()
        break
      }

      case 'copy': {
        // copy SRC_LAYER SX SY SW SH MASK DST_LAYER DX DY
        ensureLayer(parseInt(args[0], 10))
        const srcCv = layers[parseInt(args[0], 10)]
        const dc    = ctx(parseInt(args[6], 10))
        dc.drawImage(srcCv,
          parseInt(args[1], 10), parseInt(args[2], 10),
          parseInt(args[3], 10), parseInt(args[4], 10),
          parseInt(args[7], 10), parseInt(args[8], 10),
          parseInt(args[3], 10), parseInt(args[4], 10))
        break
      }

      case 'transfer': {
        // transfer SRCLAYER SRCX SRCY SRCWIDTH SRCHEIGHT FUNCTION DSTLAYER DSTX DSTY
        ensureLayer(parseInt(args[0], 10))
        const srcCv = layers[parseInt(args[0], 10)]
        const dc    = ctx(parseInt(args[6], 10))
        dc.drawImage(srcCv,
          parseInt(args[1], 10), parseInt(args[2], 10),
          parseInt(args[3], 10), parseInt(args[4], 10),
          parseInt(args[7], 10), parseInt(args[8], 10),
          parseInt(args[3], 10), parseInt(args[4], 10))
        break
      }

      // ── Image streaming ───────────────────────────────────────────────────────

      case 'img': {
        // Wire format: img STREAM_INDEX COMPOSITE_MODE DST_LAYER X Y MIME_TYPE
        // args[0] = stream index
        // args[1] = compositing mode  (integer, e.g. 14 = "over" — ignored by us)
        // args[2] = destination layer index
        // args[3] = x position
        // args[4] = y position
        // args[5] = MIME type (e.g. "image/jpeg", "image/png")
        streams[args[0]] = {
          mime:     args[5] || 'image/jpeg',
          layerIdx: parseInt(args[2], 10),
          dx:       parseInt(args[3], 10),
          dy:       parseInt(args[4], 10),
          chunks:   [],
        }
        break
      }

      case 'blob': {
        // blob STREAM B64DATA
        if (streams[args[0]]) streams[args[0]].chunks.push(args[1])
        break
      }

      case 'end': {
        // end STREAM
        const s = streams[args[0]]
        if (!s) break
        delete streams[args[0]]
        const url = `data:${s.mime};base64,${s.chunks.join('')}`
        const img = new Image()
        const dc  = ctx(s.layerIdx)
        const dx  = s.dx
        const dy  = s.dy
        img.onload = () => dc.drawImage(img, dx, dy)
        img.src    = url
        break
      }

      // ── Cursor ────────────────────────────────────────────────────────────────

      case 'cursor': {
        // cursor HOTSPOT_X HOTSPOT_Y SRCLAYER SRCX SRCY SRCWIDTH SRCHEIGHT
        const sw = parseInt(args[5], 10)
        const sh = parseInt(args[6], 10)
        if (sw <= 0 || sh <= 0) { container.style.cursor = 'default'; break }
        ensureLayer(parseInt(args[2], 10))
        const srcCv = layers[parseInt(args[2], 10)]
        const tmp   = document.createElement('canvas')
        tmp.width = sw; tmp.height = sh
        tmp.getContext('2d').drawImage(srcCv,
          parseInt(args[3], 10), parseInt(args[4], 10), sw, sh, 0, 0, sw, sh)
        container.style.cursor =
          `url(${tmp.toDataURL()}) ${args[0]} ${args[1]}, default`
        break
      }

      // ── Path ops (partial) ────────────────────────────────────────────────────

      case 'start': {
        // start LAYER X Y
        const c = ctx(parseInt(args[0], 10))
        c.beginPath()
        c.moveTo(parseInt(args[1], 10), parseInt(args[2], 10))
        break
      }

      case 'line': {
        // line LAYER X Y
        const c = ctx(parseInt(args[0], 10))
        c.lineTo(parseInt(args[1], 10), parseInt(args[2], 10))
        break
      }

      case 'arc': {
        // arc LAYER X Y RADIUS START END NEGATIVE(int)
        const c = ctx(parseInt(args[0], 10))
        c.arc(parseFloat(args[1]), parseFloat(args[2]), parseFloat(args[3]),
              parseFloat(args[4]), parseFloat(args[5]), parseInt(args[6], 10) !== 0)
        break
      }

      case 'curve': {
        // curve LAYER CP1X CP1Y CP2X CP2Y X Y
        const c = ctx(parseInt(args[0], 10))
        c.bezierCurveTo(parseFloat(args[1]), parseFloat(args[2]),
                        parseFloat(args[3]), parseFloat(args[4]),
                        parseFloat(args[5]), parseFloat(args[6]))
        break
      }

      case 'close': {
        // close LAYER
        ctx(parseInt(args[0], 10)).closePath()
        break
      }

      case 'clip': {
        // clip LAYER
        ctx(parseInt(args[0], 10)).clip()
        break
      }

      case 'reset': {
        // reset LAYER
        const c = ctx(parseInt(args[0], 10))
        c.restore()
        c.beginPath()
        break
      }

      case 'push': {
        // push LAYER
        ctx(parseInt(args[0], 10)).save()
        break
      }

      case 'pop': {
        // pop LAYER
        ctx(parseInt(args[0], 10)).restore()
        break
      }

      // ── Intentionally ignored (audio, video, file streams, etc.) ──────────────
      case 'audio':
      case 'video':
      case 'file':
      case 'pipe':
      case 'nest':
      case 'identity':
      case 'distort':
      case 'ack':
      case 'name':
        break

      default:
        break
    }
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * Guacamole.Client
 *
 * Drives the Guacamole session lifecycle:
 *   connect() → tunnel open → "select,rdp;" → receive "args" → send "connect" →
 *   receive "ready" → bidirectional display/input → disconnect()
 *
 * State codes match guacamole-common-js:
 *   0=IDLE, 1=CONNECTING, 2=WAITING, 3=CONNECTED, 4=DISCONNECTING, 5=DISCONNECTED
 */
function Client(tunnel) {
  const self    = this
  const display = new Display()
  let   state   = 0

  this.onstatechange = null
  this.onerror       = null
  this.onname        = null

  function setState(s) {
    state = s
    if (self.onstatechange) self.onstatechange(s)
  }

  // ── Tunnel callbacks ─────────────────────────────────────────────────────────

  tunnel.onopen = function () {
    // Initiate Guacamole handshake
    tunnel.sendMessage(['select', 'rdp'])
  }

  tunnel.onerror = function (err) {
    setState(5)
    if (self.onerror) self.onerror(err)
  }

  tunnel.oninstruction = function (opcode, args) {
    switch (opcode) {

      case 'args': {
        // Server has already sent the real 'connect' to guacd on our behalf.
        // We still send a placeholder 'connect' so the server's state machine
        // sees it and marks handshakeDone (it ignores the actual values).
        setState(2)
        tunnel.sendMessage(['connect', ...args.map(() => '')])
        break
      }

      case 'ready': {
        setState(3)
        break
      }

      case 'error': {
        const msg = args[0] || 'Guacamole error'
        setState(5)
        if (self.onerror) self.onerror({ message: msg, code: parseInt(args[1], 10) || 0 })
        tunnel.disconnect()
        break
      }

      case 'disconnect': {
        setState(5)
        tunnel.disconnect()
        break
      }

      case 'sync': {
        // Echo the timestamp back so guacd knows we're alive
        tunnel.sendMessage(['sync', args[0]])
        break
      }

      case 'nop': {
        // No-op keep-alive — echo back
        tunnel.sendMessage(['nop'])
        break
      }

      case 'name': {
        if (self.onname) self.onname(args[0])
        break
      }

      default: {
        // Everything else is a display instruction
        display.handleInstruction(opcode, args)
        break
      }
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  this.getDisplay = function () { return display }

  this.connect = function () {
    setState(1)
    tunnel.connect()
  }

  this.disconnect = function () {
    setState(4)
    try { tunnel.sendMessage(['disconnect']) } catch { /* ignore */ }
    tunnel.disconnect()
    setState(5)
  }

  this.sendKeyEvent = function (pressed, keysym) {
    if (state !== 3) return
    tunnel.sendMessage(['key', String(keysym), pressed ? '1' : '0'])
  }

  this.sendMouseState = function (mouseState) {
    if (state !== 3) return
    let mask = 0
    if (mouseState.left)   mask |= 0x01
    if (mouseState.middle) mask |= 0x02
    if (mouseState.right)  mask |= 0x04
    if (mouseState.up)     mask |= 0x08
    if (mouseState.down)   mask |= 0x10
    tunnel.sendMessage([
      'mouse',
      String(Math.round(mouseState.x)),
      String(Math.round(mouseState.y)),
      String(mask),
    ])
  }
}

// ── Mouse ─────────────────────────────────────────────────────────────────────

/**
 * Guacamole.Mouse
 *
 * Translates DOM mouse events on the given element into Guacamole mouse-state
 * objects and calls onmousedown / onmouseup / onmousemove accordingly.
 *
 * State object: { x, y, left, middle, right, up, down }
 */
function Mouse(element) {
  this.onmousedown = null
  this.onmouseup   = null
  this.onmousemove = null

  const self = this

  function makeState(evt, overrides) {
    const r = element.getBoundingClientRect()
    return {
      x:      evt.clientX - r.left,
      y:      evt.clientY - r.top,
      left:   !!(evt.buttons & 1),
      middle: !!(evt.buttons & 4),
      right:  !!(evt.buttons & 2),
      up:     false,
      down:   false,
      ...overrides,
    }
  }

  element.addEventListener('mousedown',   e => { e.preventDefault(); if (self.onmousedown) self.onmousedown(makeState(e)) })
  element.addEventListener('mouseup',     e => { e.preventDefault(); if (self.onmouseup)   self.onmouseup(makeState(e)) })
  element.addEventListener('mousemove',   e => { if (self.onmousemove) self.onmousemove(makeState(e)) })
  element.addEventListener('contextmenu', e => e.preventDefault())

  element.addEventListener('wheel', e => {
    e.preventDefault()
    const up   = e.deltaY < 0
    const down = e.deltaY > 0
    const s    = makeState(e, { up, down })
    if (self.onmousedown) self.onmousedown(s)
    setTimeout(() => {
      if (self.onmouseup) self.onmouseup({ ...s, up: false, down: false })
    }, 50)
  }, { passive: false })
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

/**
 * Guacamole.Keyboard
 *
 * Translates DOM keyboard events into X11 keysyms and calls
 * onkeydown / onkeyup.
 */

const KEYSYM_MAP = {
  'Backspace': 0xFF08, 'Tab': 0xFF09, 'Enter': 0xFF0D, 'Pause': 0xFF13,
  'Escape': 0xFF1B, 'Delete': 0xFFFF,
  'Home': 0xFF50, 'ArrowLeft': 0xFF51, 'Left': 0xFF51,
  'ArrowUp': 0xFF52, 'Up': 0xFF52,
  'ArrowRight': 0xFF53, 'Right': 0xFF53,
  'ArrowDown': 0xFF54, 'Down': 0xFF54,
  'PageUp': 0xFF55, 'PageDown': 0xFF56, 'End': 0xFF57, 'Insert': 0xFF63,
  'F1':  0xFFBE, 'F2':  0xFFBF, 'F3':  0xFFC0, 'F4':  0xFFC1,
  'F5':  0xFFC2, 'F6':  0xFFC3, 'F7':  0xFFC4, 'F8':  0xFFC5,
  'F9':  0xFFC6, 'F10': 0xFFC7, 'F11': 0xFFC8, 'F12': 0xFFC9,
  'Shift': 0xFFE1, 'Control': 0xFFE3, 'Alt': 0xFFE9, 'AltGraph': 0xFFEA,
  'Meta': 0xFFE7, 'Super': 0xFFEB, 'CapsLock': 0xFFE5,
  'NumLock': 0xFF7F, 'ScrollLock': 0xFF14, 'PrintScreen': 0xFF61,
}

// Keys that should prevent browser default when pressed inside the RDP frame
const PREVENT_KEYS = new Set([
  'Tab', 'Backspace', 'Delete', 'Enter', 'Escape', 'Insert',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
])

function Keyboard(element) {
  this.onkeydown = null
  this.onkeyup   = null

  const self = this

  function keysym(evt) {
    if (KEYSYM_MAP[evt.key] !== undefined) return KEYSYM_MAP[evt.key]
    if (evt.key && evt.key.length === 1) return evt.key.codePointAt(0)
    return null
  }

  function handleKeyDown(e) {
    if (PREVENT_KEYS.has(e.key) || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) {
      e.preventDefault()
    }
    const k = keysym(e)
    if (k !== null && self.onkeydown) self.onkeydown(k)
  }

  function handleKeyUp(e) {
    const k = keysym(e)
    if (k !== null && self.onkeyup) self.onkeyup(k)
  }

  element.addEventListener('keydown', handleKeyDown)
  element.addEventListener('keyup', handleKeyUp)

  this.destroy = function destroyKeyboard() {
    element.removeEventListener('keydown', handleKeyDown)
    element.removeEventListener('keyup', handleKeyUp)
    self.onkeydown = null
    self.onkeyup = null
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

const Guacamole = {
  WebSocketTunnel,
  Client,
  Display,
  Mouse,
  Keyboard,
}

export default Guacamole
