import { claudeProvider } from './providers/claude.js'
import { openaiProvider } from './providers/openai.js'
import { ollamaProvider } from './providers/ollama.js'

const providers = { claude: claudeProvider, openai: openaiProvider, ollama: ollamaProvider }

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
  const rows = [
    {
      key: 'active',
      label: 'Active provider (in use now)',
      value: active,
      ok: active === 'ollama' ? hasOllamaHost() : active === 'claude' ? hasAnthropicKey() : hasOpenAiKey(),
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
  ]

  let hint = null
  if (active !== configured) {
    hint = `Using "${active}" because ${configured} is not configured (missing API key). Set AI_PROVIDER=ollama in .env or use Admin → System → AI provider.`
  } else if (active === 'claude' && !hasAnthropicKey()) {
    hint = hasOllamaHost()
      ? 'Claude key is missing but OLLAMA_HOST is set — server should auto-use Ollama after restart. If you still see Claude errors, switch provider in Admin → System.'
      : 'Set ANTHROPIC_API_KEY or configure Ollama (OLLAMA_HOST + AI_PROVIDER=ollama).'
  } else if (active === 'ollama' && !hasOllamaHost()) {
    hint = 'Set OLLAMA_HOST (e.g. http://127.0.0.1:11434) and restart the server.'
  }

  return { configured, active, rows, hint, autoFallback: active !== configured }
}

export function isLlmAuthError(err) {
  const msg = String(err?.message || err || '')
  return /authentication_error|invalid x-api-key|invalid api key|incorrect api key|401/i.test(msg)
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
        : 'Set a valid ANTHROPIC_API_KEY, or install Ollama and set OLLAMA_HOST + AI_PROVIDER=ollama in .env, then restart the server.',
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
  return trimEnv('CLAUDE_MODEL') || 'claude-sonnet-4-20250514'
}

export async function chat(messages, options = {}) {
  const primary = resolveProviderName()
  try {
    return await providers[primary].chat(messages, options)
  } catch (err) {
    if (primary !== 'ollama' && hasOllamaHost() && (isLlmAuthError(err) || primary === 'claude' || primary === 'openai')) {
      try {
        return await ollamaProvider.chat(messages, options)
      } catch (ollamaErr) {
        throw new Error(`${err.message} (Ollama fallback also failed: ${ollamaErr.message})`)
      }
    }
    throw err
  }
}

export async function complete(prompt, options = {}) {
  return chat([{ role: 'user', content: prompt }], options)
}

export { providerModelName }
