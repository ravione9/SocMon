import mongoose from 'mongoose'

const emailSimCampaignSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailSimTemplate', required: true },
    smtpProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'SmtpProfile', required: true },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'launched', 'completed'],
      default: 'draft',
    },
    scheduledAt: { type: Date, default: null },
    launchedAt: { type: Date, default: null },
    mergeDefaults: { type: mongoose.Schema.Types.Mixed, default: {} },
    landingHtml: { type: String, default: '' },
    /** Optional merge vars for templates: {{trackingUrl}}, {{otherUrl}} */
    trackingUrl: { type: String, default: '', trim: true },
    otherUrl: { type: String, default: '', trim: true },
  },
  { timestamps: true },
)

emailSimCampaignSchema.index({ createdBy: 1, updatedAt: -1 })

export default mongoose.model('EmailSimCampaign', emailSimCampaignSchema)
