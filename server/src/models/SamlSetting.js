import mongoose from 'mongoose'

/**
 * Single-document SAML SSO configuration (Admin → SSO tab).
 */
const samlSettingSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  /** When true, password login remains available on the login page. */
  allowLocalLogin: { type: Boolean, default: true },
  /** Create Mongo users on first successful SAML sign-in. */
  autoProvision: { type: Boolean, default: false },
  /** Role assigned to auto-provisioned users. */
  defaultRole: {
    type: String,
    enum: ['admin', 'custom_admin', 'role_template', 'analyst', 'viewer'],
    default: 'viewer',
  },
  idpEntityId: { type: String, default: '' },
  idpSsoUrl: { type: String, default: '' },
  /** IdP X.509 certificate PEM (public). */
  idpCertPem: { type: String, default: '' },
  /** Optional SP entity ID; auto-derived from PUBLIC_APP_URL when empty. */
  spEntityId: { type: String, default: '' },
  /** SAML attribute for email (fallback chain applied in service). */
  emailAttribute: { type: String, default: 'email' },
  /** SAML attribute for display name. */
  nameAttribute: { type: String, default: 'displayName' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

export default mongoose.model('SamlSetting', samlSettingSchema)
