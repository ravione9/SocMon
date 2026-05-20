import mongoose from 'mongoose'

const eventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['sent', 'opened', 'clicked', 'landing_view', 'submitted', 'send_failed'],
      required: true,
    },
    at: { type: Date, default: Date.now },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
)

const emailSimRecipientSchema = new mongoose.Schema(
  {
    /** Present on quick-send rows without a campaign. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailSimCampaign' },
    email: { type: String, required: true, trim: true, lowercase: true },
    mergeVars: { type: mongoose.Schema.Types.Mixed, default: {} },
    trackingToken: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed'],
      default: 'pending',
    },
    events: { type: [eventSchema], default: [] },
  },
  { timestamps: true },
)

/**
 * Unique per campaign + email only when tied to a campaign.
 * Rows without campaignId (e.g. “send test email”) are excluded so the same address can be used repeatedly.
 *
 * IMPORTANT: A legacy DB index on `{ campaign: 1, email: 1 }` (wrong field name) indexed every doc as
 * campaign:null and broke inserts — dropped on startup in mongo.js.
 */
emailSimRecipientSchema.index(
  { campaignId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { campaignId: { $exists: true, $ne: null } },
  },
)

export default mongoose.model('EmailSimRecipient', emailSimRecipientSchema)
