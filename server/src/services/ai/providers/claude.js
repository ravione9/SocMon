import Anthropic from '@anthropic-ai/sdk'

let client
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return client
}

export const claudeProvider = {
  name: 'claude',
  async chat(messages, options = {}) {
    const res = await getClient().messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: options.maxTokens || 1024,
      system: options.system || 'You are Lenskart AI, an assistant for network and security operations.',
      messages,
    })
    return res.content[0].text
  },
  async complete(prompt, options = {}) {
    return this.chat([{ role: 'user', content: prompt }], options)
  },
}
