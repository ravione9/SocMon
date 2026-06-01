import dotenv from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Repo root .env then server/.env so local dev works whether vars live in project root or server/
dotenv.config({ path: resolve(__dirname, '../../.env') })
dotenv.config({ path: resolve(__dirname, '../.env') })

import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import morgan from 'morgan'
import rateLimit from 'express-rate-limit'
import { connectMongo } from './config/mongo.js'
import { connectRedis } from './config/redis.js'
import { migrateLegacyPageKeys } from './utils/migrateLegacyPageKeys.js'
import { applyCurrentSslNginx } from './routes/ssl.js'
import { initWebSocket } from './services/websocket.js'
import { startAlertEngine } from './services/alertEngine.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/users.js'
import deviceRoutes from './routes/devices.js'
import siteRoutes from './routes/sites.js'
import ticketRoutes from './routes/tickets.js'
import logsRoutes from './routes/logs.js'
import alertRoutes from './routes/alerts.js'
import aiRoutes from './routes/ai.js'
import statsRoutes from './routes/stats.js'
import sentinelRoutes from './routes/sentinel.js'
import sentinelOneRoutes from './routes/sentinelOne.js'
import zabbixRoutes from './routes/zabbix.js'
import storeZabbixRoutes from './routes/storeZabbix.js'
import storeMonitorRoutes from './routes/storeMonitor.js'
import storeAlertsRoutes from './routes/storeAlerts.js'
import { startStoreAlertEngine } from './services/storeAlertEngine.js'
import { startProblemSnapshotter } from './services/storeProblemSnapshotter.js'
import sshSessionRoutes from './routes/sshSessions.js'
import webMgmtRoutes, { proxyWsUpgrade } from './routes/webMgmt.js'
import solarwindsRoutes from './routes/solarwinds.js'
import rdpRoutes, { proxyRdpWsUpgrade } from './routes/rdp.js'
import idcsRoutes from './routes/idcs.js'
import adRoutes from './routes/ad.js'
import nexsRoutes from './routes/nexs.js'
import emailSimRoutes from './routes/emailSim.js'
import emailSimPublicRoutes from './routes/emailSimPublic.js'
import customRoleRoutes from './routes/customRoles.js'
import sslRoutes from './routes/ssl.js'
import { errorHandler } from './middleware/errorHandler.js'

/** CORS: localhost and 127.0.0.1 are different browser origins; allow both when either is configured. */
function resolveCorsOrigins() {
  const parsed = process.env.CORS_ORIGIN
    ? String(process.env.CORS_ORIGIN)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : []
  if (!parsed.length) {
    return ['http://localhost:3000', 'http://127.0.0.1:3000']
  }
  const extra = []
  for (const o of parsed) {
    if (o === 'http://localhost:3000') extra.push('http://127.0.0.1:3000')
    if (o === 'http://127.0.0.1:3000') extra.push('http://localhost:3000')
  }
  return [...new Set([...parsed, ...extra])]
}

const corsOrigins = resolveCorsOrigins()

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: corsOrigins, methods: ['GET', 'POST'] },
})

// WebSocket proxies — registered AFTER Socket.IO so all handlers coexist on the
// same HTTP server.  Each handler checks its own path prefix and returns early
// for anything that doesn't match, leaving Socket.IO's handler unaffected.
httpServer.on('upgrade', proxyWsUpgrade)       // /api/web-mgmt/p/<token>  (FortiGate, Cisco web UI)
httpServer.on('upgrade', proxyRdpWsUpgrade)    // /api/rdp/ws              (Windows Server RDP via guacd)

// Allow same-origin iframes (the device Web UI proxy renders inside Netpulse).
app.use(
  helmet({
    frameguard: { action: 'sameorigin' },
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  }),
)
app.use(morgan('dev'))
// CORS BEFORE the proxy so cross-origin preflight (OPTIONS) carries Access-Control-* headers.
app.use(cors({ origin: corsOrigins }))
// Web-mgmt proxy is mounted BEFORE compression / json so streamed device responses pass through untouched.
app.use('/api/web-mgmt', webMgmtRoutes)
app.use('/api/solarwinds', solarwindsRoutes)
/** Streaming exports (CSV/ZIP) — skip gzip so rows flush to the client and nginx can pass them through. */
function isStreamingExportUrl(url) {
  const u = String(url || '')
  return (
    u.includes('/api/idcs/export') ||
    u.includes('/api/sentinel/events/export') ||
    u.includes('/api/logs/export') ||
    u.includes('/api/sentinel-one/xdr/powerQuery/export')
  )
}
app.use(
  compression({
    filter: (req, res) => {
      if (isStreamingExportUrl(req.originalUrl || req.url)) return false
      return compression.filter(req, res)
    },
  }),
)
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
/** Tracking pixels/clicks — avoid JWT and keep modest throughput separate from bulk API limits. */
app.use('/api/email-sim/pub', emailSimPublicRoutes)
app.use(
  '/api/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    validate: { xForwardedForHeader: false },
    skip: (req) =>
      req.path.startsWith('/web-mgmt/p/') ||
      req.path.startsWith('/solarwinds/p/') ||
      (req.originalUrl || req.url || '').includes('idcs/export') ||
      (req.originalUrl || req.url || '').includes('/email-sim/pub'),
  }),
)

app.use('/api/auth',    authRoutes)
app.use('/api/users',   userRoutes)
app.use('/api/custom-roles', customRoleRoutes)
app.use('/api/devices', deviceRoutes)
app.use('/api/sites',   siteRoutes)
app.use('/api/tickets', ticketRoutes)
app.use('/api/logs',    logsRoutes)
app.use('/api/alerts',  alertRoutes)
app.use('/api/ai',      aiRoutes)
app.use('/api/stats',   statsRoutes)
app.use('/api/sentinel', sentinelRoutes)
app.use('/api/sentinel-one', sentinelOneRoutes)
app.use('/api/zabbix', zabbixRoutes)
app.use('/api/store-zabbix', storeZabbixRoutes)
app.use('/api/store-monitor', storeMonitorRoutes)
app.use('/api/store-alerts', storeAlertsRoutes)
app.use('/api/ssh-sessions', sshSessionRoutes)
app.use('/api/rdp',  rdpRoutes)
app.use('/api/idcs', idcsRoutes)
app.use('/api/ad', adRoutes)
app.use('/api/nexs', nexsRoutes)
app.use('/api/email-sim', emailSimRoutes)
app.use('/api/ssl', sslRoutes)
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', ai: process.env.AI_PROVIDER || 'claude' }))

app.use(errorHandler)

/**
 * Last-resort guards: keep the HTTP server alive on stray async errors (e.g. ldapjs Client
 * emitting 'error' on a dropped socket). Without these, a single bad downstream call
 * crashes Node and the browser sees ERR_EMPTY_RESPONSE on unrelated requests.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})

async function start() {
  await connectMongo()
  await migrateLegacyPageKeys()
  try {
    const ssl = await applyCurrentSslNginx()
    if (ssl?.written?.length) {
      console.log(`[ssl] nginx config written on startup (${ssl.written.length} file(s))`)
    }
    if (ssl && !ssl.ok && !ssl.skipped) {
      console.warn('[ssl] nginx reload failed on startup:', ssl.error || ssl.manual)
    }
  } catch (e) {
    console.warn('[ssl] could not apply saved nginx mode:', e?.message || e)
  }
  await connectRedis()
  initWebSocket(io)
  startAlertEngine(io)
  startStoreAlertEngine(io)
  startProblemSnapshotter()
  const PORT = process.env.PORT || 5000
  httpServer.listen(PORT, () => {
    console.log(`Lenskart server running on port ${PORT}`)
    console.log(`AI provider: ${process.env.AI_PROVIDER || 'claude'}`)
  })
}

start().catch(console.error)


