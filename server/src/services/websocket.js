import { getESClient } from '../config/elasticsearch.js'
import { initWebSsh } from './webSsh.js'

/**
 * Live-events poller.
 *
 * Performance design:
 *  - Skips the ES query entirely when no clients are connected (was previously running
 *    every 5s round-the-clock, hammering ES even when the dashboard was closed).
 *  - 15s cadence (was 5s) — UI tabs that need true real-time can also subscribe to
 *    `socket.join('live')` and we'll honour that with a 5s cadence.
 *  - Only re-runs when the previous request has finished — avoids overlapping ES
 *    requests piling up if the cluster slows down.
 *  - Last 30s window (was 10s) so we don't drop events between ticks at the slower cadence.
 *  - Last result `_id` is tracked so we only emit *new* hits — saves bandwidth and
 *    React reconciliation churn.
 */
const SLOW_INTERVAL_MS = 15_000
const FAST_INTERVAL_MS = 5_000

export function initWebSocket(io) {
  initWebSsh(io)

  let liveSubscribers = 0
  io.on('connection', socket => {
    console.log('Client connected:', socket.id)
    socket.on('subscribe', ({ index }) => {
      socket.join(index)
      console.log(`${socket.id} subscribed to ${index}`)
    })
    // Pages that want push events join 'live' (SOC/NOC do an implicit io.emit broadcast,
    // so any connected client counts).
    socket.on('subscribe:live', () => {
      socket.join('live')
      liveSubscribers += 1
    })
    socket.on('unsubscribe:live', () => {
      socket.leave('live')
      liveSubscribers = Math.max(0, liveSubscribers - 1)
    })
    socket.on('disconnect', () => {
      // If this socket was in the 'live' room, decrement.
      if (socket.rooms.has('live')) liveSubscribers = Math.max(0, liveSubscribers - 1)
      console.log('Client disconnected:', socket.id)
    })
  })

  let inFlight = false
  let lastSeenId = null
  async function pollOnce() {
    if (inFlight) return
    // Skip the ES round-trip entirely when the broadcast has no audience.
    if (io.engine.clientsCount === 0) return
    inFlight = true
    try {
      const es = getESClient()
      const result = await es.search({
        index: 'firewall-*,cisco-*',
        body: {
          size: 10,
          sort: [{ '@timestamp': { order: 'desc' } }],
          query: { range: { '@timestamp': { gte: 'now-30s' } } },
        },
      })
      const hits = result.hits?.hits || []
      if (!hits.length) return
      // Drop hits we already shipped (same _id seen on the previous tick).
      let firstNewIdx = 0
      if (lastSeenId) {
        const idx = hits.findIndex(h => h._id === lastSeenId)
        if (idx === 0) return
        if (idx > 0) firstNewIdx = 0 // emit only docs above the last seen one
        const cut = hits.slice(0, idx === -1 ? hits.length : idx)
        if (!cut.length) return
        lastSeenId = cut[0]._id
        io.emit('live:events', cut.map(h => h._source))
        return
      }
      lastSeenId = hits[firstNewIdx]._id
      io.emit('live:events', hits.map(h => h._source))
    } catch {
      /* swallow — ES outages shouldn't crash the loop */
    } finally {
      inFlight = false
    }
  }

  function schedule() {
    const interval = liveSubscribers > 0 ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS
    setTimeout(async () => {
      await pollOnce()
      schedule()
    }, interval)
  }
  schedule()
}
