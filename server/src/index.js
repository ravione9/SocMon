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
import zabbixRoutes from './routes/zabbix.js'
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

app.use(helmet())
app.use(compression())
app.use(cors({ origin: corsOrigins }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(morgan('dev'))
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }))

app.use('/api/auth',    authRoutes)
app.use('/api/users',   userRoutes)
app.use('/api/devices', deviceRoutes)
app.use('/api/sites',   siteRoutes)
app.use('/api/tickets', ticketRoutes)
app.use('/api/logs',    logsRoutes)
app.use('/api/alerts',  alertRoutes)
app.use('/api/ai',      aiRoutes)
app.use('/api/stats',   statsRoutes)
app.use('/api/sentinel', sentinelRoutes)
app.use('/api/zabbix', zabbixRoutes)
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', ai: process.env.AI_PROVIDER || 'claude' }))
app.use(errorHandler)

async function start() {
  await connectMongo()
  await connectRedis()
  initWebSocket(io)
  startAlertEngine(io)
  const PORT = process.env.PORT || 5000
  httpServer.listen(PORT, () => {
    console.log(`Lenskart server running on port ${PORT}`)
    console.log(`AI provider: ${process.env.AI_PROVIDER || 'claude'}`)
  })
}

start().catch(console.error)


