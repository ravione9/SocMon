import OpenAI from 'openai'

let client
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

export const openaiProvider = {
  name: 'openai',
  async chat(messages, options = {}) {
    const res = await getClient().chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      max_tokens: options.maxTokens || 1024,
      messages: [
        { role: 'system', content: options.system || 'You are Lenskart AI, an assistant for network and security operations.' },
        ...messages,
      ],
    })
    return res.choices[0].message.content
  },
  async complete(prompt, options = {}) {
    return this.chat([{ role: 'user', content: prompt }], options)
  },
}
