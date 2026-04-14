import AlertRule from '../models/AlertRule.js'
import { getESClient } from '../config/elasticsearch.js'

export function startAlertEngine(io) {
  console.log('Alert engine started')
  setInterval(async () => {
    try {
      const rules = await AlertRule.find({ enabled: true })
      for (const rule of rules) {
        await evaluateRule(rule, io)
      }
    } catch (err) {
      console.error('Alert engine error:', err.message)
    }
  }, 60000)
}

async function evaluateRule(rule, io) {
  try {
    const cooldownSec = Number(rule.cooldown)
    const cooldownMs = (Number.isFinite(cooldownSec) && cooldownSec > 0 ? cooldownSec : 300) * 1000
    if (rule.lastFired) {
      const elapsed = Date.now() - new Date(rule.lastFired).getTime()
      if (elapsed < cooldownMs) return
    }

    const es = getESClient()
    const { condition } = rule
    const result = await es.count({
      index: rule.source === 'fortigate' ? 'firewall-*' : rule.source === 'cisco' ? 'cisco-*' : 'firewall-*,cisco-*',
      body: {
        query: {
          bool: {
            must: [
              { range: { '@timestamp': { gte: `now-${condition.window || '5m'}` } } },
              ...(condition.filters || []),
            ],
          },
        },
      },
    })
    if (result.count >= (condition.threshold || 100)) {
      const alert = { rule: rule.name, severity: rule.severity, count: result.count, firedAt: new Date() }
      io.emit('alert:fired', alert)
      await AlertRule.findByIdAndUpdate(rule._id, { lastFired: new Date() })
    }
  } catch { }
}
