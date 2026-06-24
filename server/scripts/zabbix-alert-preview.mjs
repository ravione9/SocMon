#!/usr/bin/env node
/** Run inside netpulse-prod-server: node scripts/zabbix-alert-preview.mjs */
import mongoose from 'mongoose'
import { previewZabbixAlertEvaluation } from '../src/services/zabbixAlertInstant.js'

const uri = process.env.MONGO_URI
if (!uri) {
  console.error('MONGO_URI not set')
  process.exit(1)
}

await mongoose.connect(uri)
try {
  const out = await previewZabbixAlertEvaluation()
  console.log(JSON.stringify(out, null, 2))
} finally {
  await mongoose.disconnect()
}
