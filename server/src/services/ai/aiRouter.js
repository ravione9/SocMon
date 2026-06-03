import { claudeProvider } from './providers/claude.js'
import { openaiProvider } from './providers/openai.js'
import { geminiProvider } from './providers/gemini.js'
import { ollamaProvider } from './providers/ollama.js'

const providers = {
  claude: claudeProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
}

function trimEnv(name) {
  return String(process.env[name] || '').trim()
}

function hasAnthropicKey() {
  const k = trimEnv('ANTHROPIC_API_KEY')
  return k.length > 10 && !/^(your_|changeme|xxx)/i.test(k)
}

function hasOpenAiKey() {
  const k = trimEnv('OPENAI_API_KEY')
  return k.length > 10 && !/^(your_|changeme|xxx)/i.test(k)
}

function hasGeminiKey() {
  const k = trimEnv('GEMINI_API_KEY')
  return k.length > 10 && !/^(your_|changeme|xxx)/i.test(k)
}

function hasOllamaHost() {
  return !!trimEnv('OLLAMA_HOST')
}

/** Env AI_PROVIDER, with automatic fallback to Ollama when cloud keys are missing. */
export function resolveProviderName() {
  const configured = (trimEnv('AI_PROVIDER') || 'claude').toLowerCase()
  if (configured === 'ollama') return 'ollama'
  if (configured === 'openai') {
    if (hasOpenAiKey()) return 'openai'
    if (hasOllamaHost()) return 'ollama'
    return 'openai'
  }
  if (configured === 'gemini') {
    if (hasGeminiKey()) return 'gemini'
    if (hasOllamaHost()) return 'ollama'
    return 'gemini'
  }
  if (configured === 'claude') {
    if (hasAnthropicKey()) return 'claude'
    if (hasOllamaHost()) return 'ollama'
    return 'claude'
  }
  return configured
}

export function getAIProvider() {
  const name = resolveProviderName()
  const provider = providers[name]
  if (!provider) throw new Error(`Unknown AI provider: ${name}`)
  return provider
}

/** Diagnostics for Admin / AI Assistant UI. */
export function getAIProviderConfigStatus() {
  const configured = trimEnv('AI_PROVIDER') || 'claude'
  const active = resolveProviderName()
  const ollamaHost = trimEnv('OLLAMA_HOST')
  const providerReady = {
    ollama: hasOllamaHost,
    claude: hasAnthropicKey,
    openai: hasOpenAiKey,
    gemini: hasGeminiKey,
  }
  const rows = [
    {
      key: 'active',
      label: 'Active provider (in use now)',
      value: active,
      ok: (providerReady[active] || (() => false))(),
    },
    {
      key: 'configured',
      label: 'AI_PROVIDER in .env',
      value: configured,
      ok: true,
    },
    {
      key: 'claude',
      label: 'Anthropic (ANTHROPIC_API_KEY)',
      value: hasAnthropicKey() ? 'set' : 'missing or placeholder',
      ok: hasAnthropicKey(),
    },
    {
      key: 'openai',
      label: 'OpenAI (OPENAI_API_KEY)',
      value: hasOpenAiKey() ? 'set' : 'missing or placeholder',
      ok: hasOpenAiKey(),
    },
    {
      key: 'gemini',
      label: 'Google Gemini (GEMINI_API_KEY)',
      value: hasGeminiKey() ? 'set' : 'missing or placeholder',
      ok: hasGeminiKey(),
    },
    {
      key: 'ollama',
      label: 'Ollama (OLLAMA_HOST)',
      value: ollamaHost || 'not set',
      ok: hasOllamaHost(),
    },
    {
      key: 'ollama_model',
      label: 'Ollama model (OLLAMA_MODEL)',
      value: trimEnv('OLLAMA_MODEL') || 'llama3 (default)',
      ok: hasOllamaHost(),
    },
    {
      key: 'gemini_model',
      label: 'Gemini model (GEMINI_MODEL)',
      value: trimEnv('GEMINI_MODEL') || 'gemini-2.0-flash (default)',
      ok: hasGeminiKey(),
    },
  ]

  let hint = null
  if (active !== configured) {
    hint = `Using "${active}" because ${configured} is not configured (missing API key). Set AI_PROVIDER=ollama in .env or use Admin → System → AI provider.`
  } else if (active === 'claude' && !hasAnthropicKey()) {
    hint = hasOllamaHost()
      ? 'Claude key is missing but OLLAMA_HOST is set — server should auto-use Ollama after restart. If you still see Claude errors, switch provider in Admin → System.'
      : 'Set ANTHROPIC_API_KEY or configure Ollama (OLLAMA_HOST + AI_PROVIDER=ollama).'
  } else if (active === 'gemini' && !hasGeminiKey()) {
    hint = hasOllamaHost()
      ? 'Gemini key is missing but OLLAMA_HOST is set — server should auto-use Ollama after restart. If you still see Gemini errors, switch provider in Admin → System.'
      : 'Set GEMINI_API_KEY from Google AI Studio, or configure Ollama (OLLAMA_HOST + AI_PROVIDER=ollama).'
  } else if (active === 'ollama' && !hasOllamaHost()) {
    hint = 'Set OLLAMA_HOST (e.g. http://127.0.0.1:11434) and restart the server.'
  }

  return { configured, active, rows, hint, autoFallback: active !== configured }
}

export function isLlmAuthError(err) {
  const msg = String(err?.message || err || '')
  return /authentication_error|invalid x-api-key|invalid api key|incorrect api key|api key not valid|api_key_invalid|401|403/i.test(msg)
}

export function formatLlmErrorForClient(err) {
  const msg = String(err?.message || 'AI request failed')
  const authFailed = isLlmAuthError(err)
  const status = getAIProviderConfigStatus()
  const active = status.active

  let short = msg
  try {
    const jsonStart = msg.indexOf('{')
    if (jsonStart >= 0) {
      const parsed = JSON.parse(msg.slice(jsonStart))
      const inner = parsed?.error?.message || parsed?.error?.type || parsed?.message
      if (inner) short = String(inner)
    }
  } catch {
    /* keep msg */
  }

  if (authFailed) {
    short =
      active === 'ollama'
        ? 'Cannot reach Ollama or model is missing — check OLLAMA_HOST and run ollama pull on the model tag.'
        : active === 'openai'
          ? 'OpenAI API key is invalid or missing.'
          : active === 'gemini'
            ? 'Google Gemini API key is invalid or missing.'
            : 'Anthropic (Claude) API key is invalid or missing.'
  }

  const errorTable = [
    { what: 'Problem', detail: short },
    { what: 'Provider in use', detail: `${active} · ${providerModelName(active)}` },
    { what: 'Why', detail: authFailed ? 'Cloud LLM rejected the API key (401 authentication_error).' : msg.slice(0, 240) },
    {
      what: 'Fix',
      detail: hasOllamaHost()
        ? '1) Admin → System → click **ollama**, or set AI_PROVIDER=ollama in .env and restart.\n2) Ensure OLLAMA_HOST is reachable from the server (curl /api/tags).\n3) For store/hostname questions, use **Details** mode — answers come from live data without LLM.'
        : 'Set a valid API key for your provider (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY), or install Ollama and set OLLAMA_HOST + AI_PROVIDER=ollama in .env, then restart the server.',
    },
  ]

  return {
    error: short,
    code: authFailed ? 'LLM_AUTH_FAILED' : 'LLM_ERROR',
    provider: active,
    errorTable,
    providerStatus: status,
  }
}

function providerModelName(name = resolveProviderName()) {
  if (name === 'ollama') return trimEnv('OLLAMA_MODEL') || 'llama3'
  if (name === 'openai') return trimEnv('OPENAI_MODEL') || 'gpt-4o'
  if (name === 'gemini') return trimEnv('GEMINI_MODEL') || 'gemini-2.0-flash'
  return trimEnv('CLAUDE_MODEL') || 'claude-sonnet-4-20250514'
}

export async function chat(messages, options = {}) {
  const primary = resolveProviderName()
  try {
    return await providers[primary].chat(messages, options)
  } catch (err) {
    if (primary !== 'ollama' && hasOllamaHost() && (isLlmAuthError(err) || primary === 'claude' || primary === 'openai' || primary === 'gemini')) {
      try {
        return await ollamaProvider.chat(messages, options)
      } catch (ollamaErr) {
        throw new Error(`${err.message} (Ollama fallback also failed: ${ollamaErr.message})`)
      }
    }
    throw err
  }
}

/** JSON planner fallback when provider has no native tool API. */
async function chatWithToolsJsonFallback(messages, options = {}) {
  const toolList = (options.tools || []).map(t =>
    `- ${t.name}: ${t.description} params=${JSON.stringify(t.parameters?.properties || {})}`,
  ).join('\n')

  const plannerSystem = `${options.system || ''}

Available tools:
${toolList}

Respond with ONLY valid JSON — no markdown:
{"action":"tool","tool":"TOOL_NAME","args":{...}}
or {"action":"answer","text":"your final answer"}

Use action=tool when live data is needed. Use action=answer only after you have tool results in the conversation.`

  const transcript = messages.map(m => {
    if (m.role === 'tool') return `[tool:${m.name}] ${m.content}`
    return `${m.role}: ${m.content}`
  }).join('\n\n')

  const raw = await chat(
    [{ role: 'user', content: transcript }],
    { system: plannerSystem, maxTokens: options.maxTokens || 1536 },
  )

  let parsed
  try {
    const jsonStr = String(raw).replace(/^```json?\s*|\s*```$/g, '').trim()
    parsed = JSON.parse(jsonStr)
  } catch {
    return { text: raw, toolCalls: [], stopReason: 'end' }
  }

  if (parsed.action === 'tool' && parsed.tool) {
    return {
      text: '',
      toolCalls: [{
        id: `json-${Date.now()}`,
        name: parsed.tool,
        args: parsed.args || {},
      }],
      stopReason: 'tool_calls',
    }
  }

  return {
    text: parsed.text || raw,
    toolCalls: [],
    stopReason: 'end',
  }
}

export async function chatWithTools(messages, options = {}) {
  const primary = resolveProviderName()
  const provider = providers[primary]

  if (typeof provider.chatWithTools === 'function') {
    try {
      return await provider.chatWithTools(messages, options)
    } catch (err) {
      if (primary !== 'ollama' && hasOllamaHost() && isLlmAuthError(err)) {
        return chatWithToolsJsonFallback(messages, options)
      }
      throw err
    }
  }

  return chatWithToolsJsonFallback(messages, options)
}

export async function complete(prompt, options = {}) {
  return chat([{ role: 'user', content: prompt }], options)
}

export { providerModelName }
