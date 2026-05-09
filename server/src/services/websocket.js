import { getESClient } from '../config/elasticsearch.js'

export function initWebSocket(io) {
  io.on('connection', socket => {
    console.log('Client connected:', socket.id)
    socket.on('subscribe', ({ index }) => {
      socket.join(index)
      console.log(`${socket.id} subscribed to ${index}`)
    })
    socket.on('disconnect', () => console.log('Client disconnected:', socket.id))
  })

  setInterval(async () => {
    try {
      const es = getESClient()
      const result = await es.search({
        index: 'firewall-*,cisco-*',
        body: {
          size: 10,
          sort: [{ '@timestamp': { order: 'desc' } }],
          query: { range: { '@timestamp': { gte: 'now-10s' } } },
        },
      })
      if (result.hits.hits.length > 0) {
        io.emit('live:events', result.hits.hits.map(h => h._source))
      }
    } catch { }
  }, 5000)
}
