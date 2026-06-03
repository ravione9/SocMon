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
  async chatWithTools(messages, options = {}) {
    const claudeMessages = []

    for (const m of messages) {
      if (m.role === 'tool') {
        claudeMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
          }],
        })
        continue
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const blocks = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const tc of m.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.args || {},
          })
        }
        claudeMessages.push({ role: 'assistant', content: blocks })
        continue
      }
      claudeMessages.push({ role: m.role, content: m.content })
    }

    const res = await getClient().messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: options.maxTokens || 1536,
      system: options.system || 'You are Lenskart AI, an assistant for network and security operations.',
      tools: (options.tools || []).map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      messages: claudeMessages,
    })

    const toolCalls = []
    let text = ''
    for (const block of res.content || []) {
      if (block.type === 'text') text += block.text
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input || {},
        })
      }
    }

    if (toolCalls.length) {
      return { text, toolCalls, stopReason: 'tool_calls' }
    }
    return { text, toolCalls: [], stopReason: 'end' }
  },
  async complete(prompt, options = {}) {
    return this.chat([{ role: 'user', content: prompt }], options)
  },
}
