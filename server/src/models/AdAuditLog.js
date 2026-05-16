/**
 * Audit log for Active Directory mutations performed through Netpulse.
 *
 * Schema mirrors IdcsAuditLog so the UI can render both kinds of entries
 * consistently, but the target shape is AD-flavoured (we key off LDAP DNs,
 * not IDCS ids). Entries are written fire-and-forget from routes/ad.js so
 * audit failures can never break the actual directory mutation.
 *
 * IMPORTANT: callers MUST strip any password/secret fields from `details`
 * before calling this model. See utils/adAudit.js for the sanitiser.
 */
import mongoose from 'mongoose'

export const AD_AUDIT_ACTIONS = [
  'AD_USER_CREATE',
  'AD_USER_MODIFY',
  'AD_USER_PASSWORD_RESET',
  'AD_USER_ACCOUNT_FLAGS',
  'AD_USER_MOVE',
  'AD_GROUP_CREATE',
  'AD_GROUP_MODIFY',
  'AD_GROUP_MEMBER_ADD',
  'AD_GROUP_MEMBER_REMOVE',
  'AD_COMPUTER_MODIFY',
  'AD_COMPUTER_ACCOUNT_FLAGS',
  'AD_OU_CREATE',
  'AD_OU_MODIFY',
]

const TARGET_KINDS = ['user', 'group', 'computer', 'ou', 'other']

const adAuditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, enum: AD_AUDIT_ACTIONS },
    performedBy: {
      userId:   { type: String },
      email:    { type: String },
      username: { type: String },
    },
    target: {
      kind:     { type: String, enum: TARGET_KINDS, default: 'other' },
      dn:       { type: String },
      name:     { type: String },
      parentDn: { type: String },
    },
    status:    { type: String, enum: ['SUCCESS', 'FAILED'], required: true },
    details:   { type: mongoose.Schema.Types.Mixed },
    errorCode: { type: String },
    ipAddress: { type: String },
  },
  { timestamps: true, collection: 'ad_audit_logs' },
)

adAuditLogSchema.index({ action: 1, createdAt: -1 })
adAuditLogSchema.index({ status: 1, createdAt: -1 })
adAuditLogSchema.index({ 'performedBy.email': 1, createdAt: -1 })
adAuditLogSchema.index({ 'target.dn': 1, createdAt: -1 })

export default mongoose.model('AdAuditLog', adAuditLogSchema)
