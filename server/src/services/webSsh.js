import jwt from 'jsonwebtoken'
import { Client } from 'ssh2'
import User from '../models/User.js'
import Device from '../models/Device.js'
import SshSession from '../models/SshSession.js'
import { getPlainMgmtForUser } from '../utils/deviceUserCredential.js'

const MAX_TRANSCRIPT_CHARS = 450_000
const FLUSH_MS = 2500

function sshHost(ip) {
  if (!ip) return ''
  const s = String(ip).trim()
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
}

async function socketAuthUser(socket) {
  const token = socket.handshake.auth?.token
  if (!token) return null
  const decoded = jwt.verify(token, process.env.JWT_SECRET)
  const user = await User.findById(decoded.id).select('_id name email role active')
  if (!user?.active) return null
  return user
}

function attachTranscriptLogger(sessionMongooseId) {
  let pending = ''
  const timer = setInterval(() => {
    void flush()
  }, FLUSH_MS)

  async function flush() {
    if (!pending) return
    const chunk = pending
    pending = ''
    try {
      const sess = await SshSession.findById(sessionMongooseId)
      if (!sess || sess.transcriptTruncated) return
      let next = (sess.transcript || '') + chunk
      if (next.length > MAX_TRANSCRIPT_CHARS) {
        next = next.slice(0, MAX_TRANSCRIPT_CHARS) + '\n[... transcript truncated by Netpulse ...]\n'
        sess.transcriptTruncated = true
      }
      sess.transcript = next
      await sess.save()
    } catch (e) {
      console.error('web-ssh transcript flush', e.message)
    }
  }

  return {
    add(dir, text) {
      if (!text) return
      const safe = String(text).replace(/\r/g, '\\r')
      const line = dir === 'out' ? `\n[D→C] ${safe}` : `\n[C→D] ${safe}`
      pending += line
    },
    flush,
    async stop() {
      clearInterval(timer)
      await flush()
    },
  }
}

async function cleanupAttachment(socket) {
  const a = socket.webSsh
  if (!a) return
  socket.webSsh = null
  try {
    if (a.stream && a.onData) a.stream.off('data', a.onData)
    a.stream?.removeAllListeners()
    if (a.stream && !a.stream.destroyed) a.stream.close()
  } catch {
    /* ignore */
  }
  try {
    if (a.conn) {
      a.conn.removeAllListeners()
      a.conn.end()
    }
  } catch {
    /* ignore */
  }
  try {
    await a.logger?.stop()
  } catch {
    /* ignore */
  }
  try {
    await SshSession.findByIdAndUpdate(a.sessionDbId, {
      endedAt: new Date(),
      status: a.endStatus || 'closed',
      errorMessage: a.endError || undefined,
      bytesFromClient: a.bytesFromClient ?? 0,
      bytesFromDevice: a.bytesFromDevice ?? 0,
    })
  } catch {
    /* ignore */
  }
}

export function initWebSsh(io) {
  const nsp = io.of('/web-ssh')

  nsp.use(async (socket, next) => {
    try {
      const user = await socketAuthUser(socket)
      if (!user) return next(new Error('Unauthorized'))
      socket.userId = user._id
      socket.userDoc = user
      next()
    } catch {
      next(new Error('Unauthorized'))
    }
  })

  nsp.on('connection', (socket) => {
    socket.webSsh = null

    socket.on('disconnect', () => {
      if (socket.webSsh) {
        socket.webSsh.endStatus = 'closed'
        void cleanupAttachment(socket)
      }
    })

    socket.on('web-ssh:close', () => {
      if (socket.webSsh) {
        socket.webSsh.endStatus = 'closed'
        void cleanupAttachment(socket).then(() => socket.emit('web-ssh:closed'))
      } else {
        socket.emit('web-ssh:closed')
      }
    })

    socket.on('web-ssh:resize', ({ cols, rows }) => {
      const a = socket.webSsh
      if (!a?.stream || a.stream.destroyed) return
      const c = Math.min(Math.max(Number(cols) || 80, 40), 500)
      const r = Math.min(Math.max(Number(rows) || 24, 5), 200)
      try {
        a.stream.setWindow(r, c, 600, 800)
      } catch {
        /* ignore */
      }
    })

    socket.on('web-ssh:input', (data) => {
      const a = socket.webSsh
      if (!a?.stream || a.stream.destroyed) return
      const s = typeof data === 'string' ? data : ''
      if (!s) return
      try {
        a.logger?.add('in', s)
        a.bytesFromClient = (a.bytesFromClient || 0) + Buffer.byteLength(s, 'utf8')
        a.stream.write(s)
      } catch {
        /* ignore */
      }
    })

    socket.on('web-ssh:start', async (payload) => {
      if (socket.webSsh) {
        socket.webSsh.endStatus = 'closed'
        await cleanupAttachment(socket)
      }

      const { deviceId, password: sessionPassword, cols = 80, rows = 24 } = payload || {}
      if (!deviceId) {
        socket.emit('web-ssh:error', { message: 'deviceId required' })
        return
      }

      let sessionDbId
      try {
        const device = await Device.findById(deviceId).populate('site', 'name')
        if (!device) {
          socket.emit('web-ssh:error', { message: 'Device not found' })
          return
        }

        const plain = await getPlainMgmtForUser(socket.userId, device._id)
        const username = (plain.mgmtUsername || '').trim()
        if (!username) {
          socket.emit('web-ssh:error', { message: 'No management username saved for you on this device. Edit the device and set credentials.' })
          return
        }

        let password = plain.password || ''
        if (!password && sessionPassword) password = String(sessionPassword)
        if (!password) {
          socket.emit('web-ssh:error', {
            message: 'No saved password for your user on this device — edit the device, enter your password, and tick save.',
          })
          return
        }

        const host = sshHost(device.ip)
        const port = Number(device.sshPort) > 0 ? Number(device.sshPort) : 22
        const siteName = device.site?.name ? String(device.site.name) : ''

        const sessionDoc = await SshSession.create({
          user: socket.userId,
          device: device._id,
          deviceName: device.name,
          siteName,
          host,
          port,
          sshUser: username,
          status: 'active',
        })
        sessionDbId = sessionDoc._id
        const logger = attachTranscriptLogger(sessionDoc._id)

        const conn = new Client()
        const c = Math.min(Math.max(Number(cols) || 80, 40), 500)
        const r = Math.min(Math.max(Number(rows) || 24, 5), 200)

        const attachment = {
          conn,
          stream: null,
          sessionDbId,
          logger,
          bytesFromClient: 0,
          bytesFromDevice: 0,
          endStatus: 'closed',
          endError: null,
          onData: null,
        }
        socket.webSsh = attachment

        conn
          .on('ready', () => {
            conn.shell({ term: 'xterm-256color', cols: c, rows: r }, (err, stream) => {
              if (err) {
                attachment.endStatus = 'error'
                attachment.endError = err.message
                socket.emit('web-ssh:error', { message: err.message })
                void cleanupAttachment(socket)
                return
              }
              attachment.stream = stream
              attachment.onData = (buf) => {
                const out = buf.toString('utf8')
                attachment.bytesFromDevice = (attachment.bytesFromDevice || 0) + Buffer.byteLength(out, 'utf8')
                logger.add('out', out)
                socket.emit('web-ssh:data', out)
              }
              stream.on('data', attachment.onData)
              stream.on('close', () => {
                attachment.endStatus = 'closed'
                void cleanupAttachment(socket).then(() => socket.emit('web-ssh:closed'))
              })
              socket.emit('web-ssh:ready', { sessionId: String(sessionDbId) })
            })
          })
          .on('error', (err) => {
            attachment.endStatus = 'error'
            attachment.endError = err.message
            socket.emit('web-ssh:error', { message: err.message })
            void cleanupAttachment(socket)
          })
          .connect({
            host,
            port,
            username,
            password,
            readyTimeout: 25_000,
            keepaliveInterval: 10_000,
          })
      } catch (e) {
        console.error('web-ssh:start', e)
        if (sessionDbId) {
          await SshSession.findByIdAndUpdate(sessionDbId, {
            endedAt: new Date(),
            status: 'error',
            errorMessage: e.message || 'start failed',
          }).catch(() => {})
        }
        socket.emit('web-ssh:error', { message: e.message || 'SSH start failed' })
        await cleanupAttachment(socket)
      }
    })
  })
}
