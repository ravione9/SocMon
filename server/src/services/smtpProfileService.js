import nodemailer from 'nodemailer'
import SmtpProfile from '../models/SmtpProfile.js'
import { decryptPassword, encryptPassword } from '../utils/deviceCrypto.js'

export async function getOwnedProfile(userId, profileId) {
  return SmtpProfile.findOne({ _id: profileId, createdBy: userId }).lean()
}

export async function createTransportForProfile(profileLean) {
  const pass = profileLean.authPassEncrypted ? decryptPassword(profileLean.authPassEncrypted) : ''
  return nodemailer.createTransport({
    host: profileLean.host,
    port: profileLean.port || 587,
    secure: Boolean(profileLean.secure),
    auth:
      profileLean.username || pass
        ? {
            user: profileLean.username || '',
            pass,
          }
        : undefined,
  })
}

export function encryptSmtpPassword(plain) {
  return encryptPassword(plain)
}
