import mongoose from 'mongoose'

const emailSimGroupMemberSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailSimGroup', required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    mergeVars: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
)

emailSimGroupMemberSchema.index({ groupId: 1, email: 1 }, { unique: true })

export default mongoose.model('EmailSimGroupMember', emailSimGroupMemberSchema)
