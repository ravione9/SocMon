import mongoose from 'mongoose'
import EmailSimRecipient from '../models/EmailSimRecipient.js'
import StoreProblemHistory from '../models/StoreProblemHistory.js'

/** Legacy typo indexed `campaign` while the schema uses `campaignId`, so every doc keyed as campaign:null → duplicate key on email. */
async function repairEmailSimRecipientIndexes() {
  const collName = EmailSimRecipient.collection.collectionName
  const coll = mongoose.connection.collection(collName)
  try {
    const idx = await coll.indexes()
    const legacy = idx.find((x) => x.name === 'campaign_1_email_1')
    if (legacy) {
      await coll.dropIndex('campaign_1_email_1')
      console.log(`[mongo] dropped legacy index campaign_1_email_1 on ${collName}`)
    }
  } catch (e) {
    console.warn('[mongo] EmailSimRecipient legacy index cleanup:', e.message || e)
  }
  try {
    await EmailSimRecipient.syncIndexes()
    console.log('[mongo] EmailSimRecipient indexes synced')
  } catch (e) {
    console.warn('[mongo] EmailSimRecipient.syncIndexes failed:', e.message || e)
  }
}

/**
 * Guarantee retention semantics for `storeproblemhistories`:
 *   - Active records (resolvedAt: null) live forever — driven by `sparse: true`.
 *   - Resolved records expire exactly PROBLEM_HISTORY_TTL_DAYS after `resolvedAt`
 *     (default 60 days).
 *
 * Mongoose creates a TTL index on first model registration, but `syncIndexes()`
 * will NOT change `expireAfterSeconds` or `sparse` on an existing index — so a
 * collection that was deployed earlier with a shorter TTL (or with sparse=false)
 * keeps the old behaviour silently. We detect drift here and use `collMod` to
 * adjust expireAfterSeconds in place; if `sparse` changed we drop+recreate
 * because collMod cannot toggle sparse.
 */
async function repairStoreProblemHistoryIndexes() {
  const TTL_DAYS = parseInt(process.env.PROBLEM_HISTORY_TTL_DAYS || '60', 10)
  const desiredSeconds = (Number.isFinite(TTL_DAYS) && TTL_DAYS > 0 ? TTL_DAYS : 60) * 86400
  const collName = StoreProblemHistory.collection.collectionName
  const coll = mongoose.connection.collection(collName)

  try {
    const idx = await coll.indexes()
    const ttl = idx.find(
      (i) => i.key && Object.keys(i.key).length === 1 && i.key.resolvedAt === 1 && typeof i.expireAfterSeconds === 'number',
    )

    if (!ttl) {
      // First deploy (or the index was dropped) — let syncIndexes() create it.
    } else if (!ttl.sparse) {
      await coll.dropIndex(ttl.name)
      console.log(`[mongo] dropped non-sparse TTL index ${ttl.name} on ${collName} — active records were at risk of expiry`)
    } else if (ttl.expireAfterSeconds !== desiredSeconds) {
      await mongoose.connection.db.command({
        collMod: collName,
        index: { name: ttl.name, expireAfterSeconds: desiredSeconds },
      })
      console.log(
        `[mongo] StoreProblemHistory TTL updated: ${ttl.expireAfterSeconds}s → ${desiredSeconds}s `
        + `(${desiredSeconds / 86400} days)`,
      )
    }
  } catch (e) {
    console.warn('[mongo] StoreProblemHistory TTL repair:', e.message || e)
  }

  try {
    await StoreProblemHistory.syncIndexes()
    console.log(`[mongo] StoreProblemHistory indexes synced (resolvedAt TTL = ${desiredSeconds / 86400} days, sparse)`)
  } catch (e) {
    console.warn('[mongo] StoreProblemHistory.syncIndexes failed:', e.message || e)
  }
}

export async function connectMongo() {
  try {
    await mongoose.connect(process.env.MONGO_URI)
    console.log('MongoDB connected')
    await repairEmailSimRecipientIndexes()
    await repairStoreProblemHistoryIndexes()
  } catch (err) {
    console.error('MongoDB connection error:', err.message)
    process.exit(1)
  }
}
