import { GoogleGenerativeAI } from '@google/generative-ai'

let client

function getClient() {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not configured')
  if (!client) client = new GoogleGenerativeAI(key)
  return client
}

function toGeminiRole(role) {
  return role === 'assistant' ? 'model' : 'user'
}

export const geminiProvider = {
  name: 'gemini',
  async chat(messages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('messages array is required')
    }

    const model = getClient().getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      systemInstruction: options.system || 'You are Lenskart AI, an assistant for network and security operations.',
      generationConfig: {
        maxOutputTokens: options.maxTokens || 1024,
      },
    })

    const history = messages.slice(0, -1).map((m) => ({
      role: toGeminiRole(m.role),
      parts: [{ text: m.content }],
    }))
    const last = messages[messages.length - 1]
    const session = model.startChat({ history })
    const result = await session.sendMessage(last.content)
    const text = result?.response?.text?.()
    if (!text) throw new Error('Empty response from Gemini')
    return text
  },
  async complete(prompt, options = {}) {
    return this.chat([{ role: 'user', content: prompt }], options)
  },
}
