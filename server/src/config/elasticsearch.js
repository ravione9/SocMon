import { Client } from '@elastic/elasticsearch'
import { readFileSync } from 'fs'

let client

export function getESClient() {
  if (!client) {
    client = new Client({
      node: process.env.ES_HOST,
      auth: {
        username: process.env.ES_USER,
        password: process.env.ES_PASSWORD,
      },
      tls: {
        rejectUnauthorized: false,
      },
    })
    console.log('Elasticsearch client initialized')
  }
  return client
}
