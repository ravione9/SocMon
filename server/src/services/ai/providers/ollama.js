export const ollamaProvider = {
  name: 'ollama',
  async chat(messages, options = {}) {
    const host = process.env.OLLAMA_HOST
    if (!host) throw new Error('OLLAMA_HOST is not configured')

    let res
    try {
      res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL || 'llama3',
          messages: [
            { role: 'system', content: options.system || 'You are Lenskart AI.' },
            ...messages,
          ],
          stream: false,
          options: {
            num_predict: options.maxTokens || 1024,
          },
        }),
      })
    } catch (err) {
      throw new Error(`Cannot reach Ollama at ${host}: ${err.message}`)
    }

    let data
    try {
      data = await res.json()
    } catch {
      throw new Error(`Ollama returned invalid JSON (HTTP ${res.status})`)
    }

    if (!res.ok) {
      throw new Error(data?.error || `Ollama HTTP ${res.status}`)
    }
    if (!data?.message?.content) {
      throw new Error('Empty response from Ollama — is the model pulled?')
    }
    return data.message.content
  },
  async complete(prompt, options = {}) {
    return this.chat([{ role: 'user', content: prompt }], options)
  },
}
