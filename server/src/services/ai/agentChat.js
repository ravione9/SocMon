/**
 * SocMon AI Agent — LLM orchestrates live portal tools, then synthesizes the answer.
 */
import { chatWithTools, getAIProvider } from './aiRouter.js'
import { getAgentToolDefinitions, executeAgentTool } from './agentTools.js'

const AGENT_SYSTEM = `You are SocMon AI Agent for Lenskart network and security operations.

RULES:
1. For ANY factual question about hosts, disk, bandwidth, stores, threats, firewall, or hostnames — you MUST call the appropriate tool first.
2. NEVER invent hostnames, IP addresses, event counts, disk percentages, or store status.
3. Use exact Zabbix host group names from the user (e.g. lenskart-database). For disk reports always use get_disk_report with the host group — not get_server_status.
4. After tool results, write a clear summary: bullet points or short tables, then 1–3 actionable recommendations when relevant.
5. If a tool returns an error, explain it and suggest what the user should check (Infra Monitoring page, group name spelling, permissions).
6. For follow-ups ("this group", "why only 3"), reuse host group names from the conversation and call the correct tool again.
7. For Sentinel/XDR hunts (failed login, DNS, IP Connect, country connections, PowerShell, threats) use get_xdr_investigation with the user's full question, or get_geo_connections for country traffic.`

const MAX_AGENT_TURNS = 5

/**
 * @param {{ role: string, content: string }[]} messages
 * @param {{ user: object, allowedPages: string[], ctx?: object }} opts
 */
export async function runAgentChat(messages, opts = {}) {
  const { user, allowedPages, ctx = null } = opts
  const tools = getAgentToolDefinitions()
  const toolsUsed = []
  const modulesUsed = new Set()
  let toolMs = 0
  let llmMs = 0
  let contextMeta = []
  let contextPreview = {}

  const llmMessages = messages.slice(-8).filter(m => m.role === 'user' || m.role === 'assistant')
  let agentMessages = llmMessages.map(m => ({ role: m.role, content: m.content }))
  const providerMessages = [...agentMessages]

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const llmStart = Date.now()
    const response = await chatWithTools(providerMessages, {
      system: AGENT_SYSTEM,
      tools,
      maxTokens: 1536,
    })
    llmMs += Date.now() - llmStart

    if (response.toolCalls?.length) {
      providerMessages.push({
        role: 'assistant',
        content: response.text || '',
        toolCalls: response.toolCalls,
      })

      for (const call of response.toolCalls) {
        const toolStart = Date.now()
        const result = await executeAgentTool(call.name, call.args, user, allowedPages, ctx)
        toolMs += Date.now() - toolStart

        toolsUsed.push({
          name: call.name,
          args: call.args,
          ok: result.ok,
          durationMs: result.durationMs,
        })
        if (result.contextMeta?.length) contextMeta = result.contextMeta
        if (result.contextPreview && Object.keys(result.contextPreview).length) {
          contextPreview = result.contextPreview
        }
        for (const m of result.modulesUsed || []) modulesUsed.add(m)

        const toolContent = result.ok
          ? result.content
          : `Error: ${result.error}`

        providerMessages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: toolContent,
        })
      }
      continue
    }

    const text = String(response.text || '').trim()
    if (text) {
      return {
        content: text,
        toolsUsed,
        modulesUsed: [...modulesUsed],
        contextMeta,
        contextPreview,
        toolMs,
        llmMs,
        provider: getAIProvider().name,
        turns: turn + 1,
      }
    }
  }

  return {
    content: 'Agent stopped after maximum tool rounds. Try a simpler question or use Monitor mode for a fast direct answer.',
    toolsUsed,
    modulesUsed: [...modulesUsed],
    contextMeta,
    contextPreview,
    toolMs,
    llmMs,
    provider: getAIProvider().name,
    turns: MAX_AGENT_TURNS,
  }
}
