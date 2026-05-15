import mongoose from 'mongoose'

const idcsAuditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: [
        'CREATE_USER', 'DELETE_USER',
        'BULK_CREATE_USERS', 'BULK_DELETE_USERS',
        'PASSWORD_RESET', 'ADD_TO_GROUP',
        'REMOVE_FROM_GROUP', 'EXPORT_USERS',
      ],
    },
    performedBy: {
      userId:   { type: String },
      email:    { type: String },
      username: { type: String },
    },
    targetUser: {
      idcsId:      { type: String },
      userName:    { type: String },
      email:       { type: String },
      displayName: { type: String },
    },
    targetGroup: {
      idcsId:      { type: String },
      displayName: { type: String },
    },
    status:  { type: String, enum: ['SUCCESS', 'FAILED', 'PARTIAL'], required: true },
    details: { type: mongoose.Schema.Types.Mixed },
    ipAddress: { type: String },
  },
  { timestamps: true, collection: 'idcs_audit_logs' }
)

idcsAuditLogSchema.index({ action: 1, createdAt: -1 })
idcsAuditLogSchema.index({ 'performedBy.email': 1, createdAt: -1 })
idcsAuditLogSchema.index({ 'targetUser.userName': 1 })

export default mongoose.model('IdcsAuditLog', idcsAuditLogSchema)
