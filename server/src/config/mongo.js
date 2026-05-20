import mongoose from 'mongoose'
import EmailSimRecipient from '../models/EmailSimRecipient.js'

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

export async function connectMongo() {
  try {
    await mongoose.connect(process.env.MONGO_URI)
    console.log('MongoDB connected')
    await repairEmailSimRecipientIndexes()
  } catch (err) {
    console.error('MongoDB connection error:', err.message)
    process.exit(1)
  }
}
