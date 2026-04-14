export const ollamaProvider = {
  name: 'ollama',
  async chat(messages, options = {}) {
    const res = await fetch(`${process.env.OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3',
        messages: [
          { role: 'system', content: options.system || 'You are Lenskart AI.' },
          ...messages,
        ],
        stream: false,
      }),
    })
    const data = await res.json()
    return data.message.content
  },
  async complete(prompt, options = {}) {
    return this.chat([{ role: 'user', content: prompt }], options)
  },
}
