/**
 * Kafka Producer — singleton that publishes store-monitor events to Kafka topics.
 *
 * Topics (all configurable via env vars):
 *   KAFKA_TOPIC_ALERTS   → store-monitor.alerts   (alert rule fires)
 *   KAFKA_TOPIC_PROBLEMS → store-monitor.problems  (problem detected / resolved)
 *   KAFKA_TOPIC_OVERVIEW → store-monitor.overview  (periodic store snapshot)
 *
 * Required env vars:
 *   KAFKA_BROKERS   — comma-separated list, e.g. "192.168.1.10:9092,192.168.1.11:9092"
 *
 * Optional env vars:
 *   KAFKA_CLIENT_ID     — default: "netpulse-store-monitor"
 *   KAFKA_USERNAME      — SASL plain username (if broker requires auth)
 *   KAFKA_PASSWORD      — SASL plain password
 *   KAFKA_SSL           — "true" to enable TLS
 *   KAFKA_TOPIC_ALERTS   — default: "store-monitor.alerts"
 *   KAFKA_TOPIC_PROBLEMS — default: "store-monitor.problems"
 *   KAFKA_TOPIC_OVERVIEW — default: "store-monitor.overview"
 */
import { Kafka, logLevel } from 'kafkajs'

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || '')
  .split(',').map((b) => b.trim()).filter(Boolean)

const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'netpulse-store-monitor'
const KAFKA_USERNAME  = process.env.KAFKA_USERNAME  || ''
const KAFKA_PASSWORD  = process.env.KAFKA_PASSWORD  || ''
const KAFKA_SSL       = process.env.KAFKA_SSL === 'true'

export const TOPICS = {
  ALERTS:   process.env.KAFKA_TOPIC_ALERTS   || 'store-monitor.alerts',
  PROBLEMS: process.env.KAFKA_TOPIC_PROBLEMS || 'store-monitor.problems',
  OVERVIEW: process.env.KAFKA_TOPIC_OVERVIEW || 'store-monitor.overview',
}

let _producer     = null
let _connected    = false
let _connectError = null
let _connectAt    = null
let _attempts     = 0
let _retryTimer   = null

export function isKafkaConfigured() {
  return KAFKA_BROKERS.length > 0
}

export function getKafkaStatus() {
  return {
    configured:    isKafkaConfigured(),
    connected:     _connected,
    brokers:       KAFKA_BROKERS,
    clientId:      KAFKA_CLIENT_ID,
    topics:        TOPICS,
    ssl:           KAFKA_SSL,
    connectAttempts: _attempts,
    connectedAt:   _connectAt,
    lastError:     _connectError,
  }
}

async function connect() {
  if (!isKafkaConfigured()) return
  clearTimeout(_retryTimer)
  _attempts++
  try {
    const sasl = (KAFKA_USERNAME && KAFKA_PASSWORD)
      ? { mechanism: 'plain', username: KAFKA_USERNAME, password: KAFKA_PASSWORD }
      : undefined

    const kafka = new Kafka({
      clientId: KAFKA_CLIENT_ID,
      brokers:  KAFKA_BROKERS,
      ssl:      KAFKA_SSL || undefined,
      sasl,
      logLevel: logLevel.WARN,
      retry: { retries: 8, initialRetryTime: 3000, multiplier: 1.5, maxRetryTime: 60_000 },
    })

    _producer = kafka.producer({
      allowAutoTopicCreation: true,
      transactionTimeout:     30_000,
    })

    _producer.on(_producer.events.DISCONNECT, () => {
      _connected = false
      console.warn('[kafkaProducer] Disconnected — reconnecting in 30s')
      _retryTimer = setTimeout(connect, 30_000)
    })

    await _producer.connect()
    _connected    = true
    _connectError = null
    _connectAt    = new Date().toISOString()
    console.log(`[kafkaProducer] Connected to ${KAFKA_BROKERS.join(', ')} (topics: ${Object.values(TOPICS).join(', ')})`)
  } catch (err) {
    _connected    = false
    _connectError = err.message
    console.error('[kafkaProducer] Connection failed:', err.message, '— retry in 30s')
    _retryTimer = setTimeout(connect, 30_000)
  }
}

/**
 * Publish a message to a Kafka topic.
 * @param {string} topic     - One of the TOPICS values
 * @param {object} payload   - JSON-serialisable payload
 * @param {string} [key]     - Optional message key (e.g. storeTag or ruleId for partitioning)
 * @returns {Promise<boolean>} true if sent successfully
 */
export async function publishToKafka(topic, payload, key = null) {
  if (!_connected || !_producer) {
    if (isKafkaConfigured()) {
      console.warn(`[kafkaProducer] Not connected — dropping message to ${topic}`)
    }
    return false
  }
  try {
    const message = {
      value: JSON.stringify({ ...payload, _publishedAt: new Date().toISOString() }),
    }
    if (key != null) message.key = String(key)

    await _producer.send({ topic, messages: [message] })
    return true
  } catch (err) {
    console.error(`[kafkaProducer] Send failed (${topic}):`, err.message)
    if (/disconnect|connection/i.test(err.message)) {
      _connected = false
      _retryTimer = setTimeout(connect, 5_000)
    }
    return false
  }
}

/** Convenience wrappers — strongly-typed per data class */

export function publishAlertEvent(alertEvent) {
  return publishToKafka(TOPICS.ALERTS, {
    type:          'alert_fired',
    ruleId:        alertEvent.ruleId,
    ruleName:      alertEvent.ruleName,
    severity:      alertEvent.severity,
    group:         alertEvent.group,
    condition:     alertEvent.condition,
    affectedCount: alertEvent.affectedCount,
    stores:        alertEvent.stores,
    hasMore:       alertEvent.hasMore,
    firedAt:       alertEvent.firedAt,
  }, String(alertEvent.ruleId))
}

export function publishProblemEvent(type, problems, meta = {}) {
  return publishToKafka(TOPICS.PROBLEMS, {
    type,             // 'problems_detected' | 'problems_resolved' | 'problems_snapshot'
    problems,
    ...meta,
    checkedAt: meta.checkedAt || new Date().toISOString(),
  })
}

export function publishOverviewSnapshot(stores, summary) {
  return publishToKafka(TOPICS.OVERVIEW, {
    type:      'store_overview',
    storeCount: Array.isArray(stores) ? stores.length : 0,
    summary,
    stores,
    snapshotAt: new Date().toISOString(),
  })
}

export async function startKafkaProducer() {
  if (!isKafkaConfigured()) {
    console.log('[kafkaProducer] KAFKA_BROKERS not configured — Kafka publishing disabled')
    return
  }
  await connect()
}

export async function stopKafkaProducer() {
  clearTimeout(_retryTimer)
  if (_producer && _connected) {
    try {
      await _producer.disconnect()
      _connected = false
      console.log('[kafkaProducer] Gracefully disconnected')
    } catch (err) {
      console.error('[kafkaProducer] Error on disconnect:', err.message)
    }
  }
}
