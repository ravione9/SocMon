import dotenv from 'dotenv'
import { runSentinelOnePowerQuery } from '../src/utils/sentinelOneApi.js'

dotenv.config({ path: '../.env' })

const base = "event.type = 'DNS Resolved'"
const tests = [
  base,
  `${base} | limit 3`,
  `${base} | columns * | limit 3`,
  `${base} | fields * | limit 3`,
  `${base} | select * | limit 3`,
  `${base} | project * | limit 3`,
]

for (const q of tests) {
  try {
    const r = await runSentinelOnePowerQuery({
      query: q,
      start: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
      end: new Date().toISOString(),
      limit: 50,
    })
    console.log('\nQ:', q)
    console.log(
      'status=',
      r.status,
      'rows=',
      r.rows?.length,
      'cols=',
      r.columns?.length,
      'sampleCols=',
      (r.columns || []).slice(0, 12),
    )
    if (r.rows?.length) console.log('row0=', r.rows[0])
  } catch (e) {
    console.log('\nQ:', q)
    console.log('ERR:', e.message)
    if (e.body?.attempts) console.log('LAST:', e.body.attempts[e.body.attempts.length - 1])
  }
}
