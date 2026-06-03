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
  async chatWithTools(messages, options = {}) {
    const openaiMessages = [{ role: 'system', content: options.system || 'You are Lenskart AI, an assistant for network and security operations.' }]

    for (const m of messages) {
      if (m.role === 'tool') {
        openaiMessages.push({
          role: 'tool',
          tool_call_id: m.toolCallId,
          content: m.content,
        })
        continue
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        openaiMessages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
          })),
        })
        continue
      }
      openaiMessages.push({ role: m.role, content: m.content })
    }

    const res = await getClient().chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      max_tokens: options.maxTokens || 1536,
      messages: openaiMessages,
      tools: (options.tools || []).map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: 'auto',
    })

    const msg = res.choices[0]?.message
    if (!msg) throw new Error('Empty response from OpenAI')

    if (msg.tool_calls?.length) {
      return {
        text: msg.content || '',
        toolCalls: msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments || '{}'),
        })),
        stopReason: 'tool_calls',
      }
    }

    return { text: msg.content || '', toolCalls: [], stopReason: 'end' }
  },
  async complete(prompt, options = {}) {
    return this.chat([{ role: 'user', content: prompt }], options)
  },
}
