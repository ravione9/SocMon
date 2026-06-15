/**
 * External agent API — export portal context and forward to other agents.
 * Auth: NetPulse JWT (Bearer) OR X-Netpulse-Agent-Key / Bearer agent API key.
 */
import { Router } from 'express'
import { authenticateUserOrAgent, isAgentApiKeyConfigured, getConfiguredAgentApiKeys } from '../middleware/agentAuth.js'
import { computeUserPageAccess } from '../utils/computeUserPageAccess.js'
import { AI_CONTEXT_MODULES } from '../services/ai/portalContextBuilder.js'
import {
  exportPortalContextForAgent,
  runAgentPortalQuery,
  buildAgentPayload,
  forwardPayloadToAgents,
} from '../services/ai/agentPortal.js'

const router = Router()

router.use(authenticateUserOrAgent)

router.get('/meta', async (req, res) => {
  try {
    const { allowedPages } = await computeUserPageAccess(req.user)
    res.json({
      version: '1',
      authMethod: req.authMethod,
      agentKeyConfigured: isAgentApiKeyConfigured(),
      agentKeyCount: getConfiguredAgentApiKeys().length,
      serviceUser: { email: req.user.email, role: req.user.role },
      allowedPages,
      endpoints: {
        modules: 'GET /api/agent/modules',
        context: 'POST /api/agent/context',
        query: 'POST /api/agent/query',
        forward: 'POST /api/agent/forward',
        deliver: 'POST /api/agent/deliver (query + forward in one call)',
      },
      forwardUrlsConfigured: Boolean(
        process.env.NETPULSE_AGENT_FORWARD_URL
          || process.env.NETPULSE_AGENT_FORWARD_URLS,
      ),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/modules', async (req, res) => {
  try {
    const { allowedPages } = await computeUserPageAccess(req.user)
    const modules = AI_CONTEXT_MODULES.filter(m => allowedPages.includes(m.pageKey)).map(m => ({
      id: m.id,
      label: m.label,
      freshness: m.freshness,
      description: m.description,
    }))
    res.json({ modules, authMethod: req.authMethod })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** Export JSON context (+ optional LLM prompt block) without calling an LLM. */
router.post('/context', async (req, res) => {
  try {
    const { modules, question, autoModules = true, format = 'json', historyFrom, historyTo } = req.body || {}
    const exported = await exportPortalContextForAgent(req.user, {
      modules,
      question: question ? String(question) : '',
      autoModules,
      historyFrom,
      historyTo,
    })

    const payload = {
      authMethod: req.authMethod,
      fetchedAt: new Date().toISOString(),
      modulesUsed: exported.modulesUsed,
      contextPreview: exported.contextPreview,
      portalContext: exported.portalContext,
      availableModules: exported.availableModules,
    }

    if (format === 'prompt' || format === 'both') {
      payload.prompt = exported.prompt
    }
    if (format === 'json') {
      delete payload.prompt
    }

    res.json(payload)
  } catch (err) {
    const status = err.status || 500
    res.status(status).json({ error: err.message })
  }
})

/** Run fast-path direct answers + optional context build (no NetPulse LLM). */
router.post('/query', async (req, res) => {
  try {
    const {
      question,
      modules,
      autoModules = true,
      includeContext = true,
      historyFrom,
      historyTo,
    } = req.body || {}

    const result = await runAgentPortalQuery(req.user, {
      question: String(question || ''),
      modules,
      autoModules,
      includeContext,
      historyFrom,
      historyTo,
    })

    const envelope = buildAgentPayload({
      question: result.question,
      portalContext: result.portalContext,
      contextPreview: result.contextPreview,
      prompt: result.prompt,
      directAnswer: result.directAnswer,
      modulesUsed: result.modulesUsed,
      authMethod: req.authMethod,
    })

    res.json({
      ...envelope,
      queryContext: result.queryContext,
      hasDirectAnswer: result.hasDirectAnswer,
    })
  } catch (err) {
    const status = err.status || 500
    res.status(status).json({ error: err.message })
  }
})

/** POST standard payload to downstream agent URL(s) — other LLM, n8n, Cursor hook, etc. */
router.post('/forward', async (req, res) => {
  try {
    const {
      url,
      question,
      modules,
      autoModules = true,
      includeContext = true,
      includeQuery = true,
      payload: customPayload,
    } = req.body || {}

    let envelope = customPayload
    if (!envelope || typeof envelope !== 'object') {
      if (!includeQuery && !question) {
        return res.status(400).json({
          error: 'Provide question (with includeQuery) or a custom payload object',
        })
      }

      if (includeQuery && question) {
        const result = await runAgentPortalQuery(req.user, {
          question: String(question),
          modules,
          autoModules,
          includeContext,
        })
        envelope = buildAgentPayload({
          question: result.question,
          portalContext: result.portalContext,
          contextPreview: result.contextPreview,
          prompt: result.prompt,
          directAnswer: result.directAnswer,
          modulesUsed: result.modulesUsed,
          authMethod: req.authMethod,
        })
      } else {
        const exported = await exportPortalContextForAgent(req.user, {
          modules,
          question: question ? String(question) : '',
          autoModules,
        })
        envelope = buildAgentPayload({
          question: question || null,
          portalContext: exported.portalContext,
          contextPreview: exported.contextPreview,
          prompt: exported.prompt,
          modulesUsed: exported.modulesUsed,
          authMethod: req.authMethod,
        })
      }
    }

    const forward = await forwardPayloadToAgents(envelope, { url })
    res.status(forward.allOk ? 200 : 502).json({
      ok: forward.allOk,
      delivered: forward.results,
      payload: envelope,
    })
  } catch (err) {
    const status = err.status || 500
    res.status(status).json({ error: err.message, code: err.code })
  }
})

/** Query NetPulse data then forward to configured / requested agent URL(s) in one request. */
router.post('/deliver', async (req, res) => {
  try {
    const {
      url,
      question,
      modules,
      autoModules = true,
      includeContext = true,
    } = req.body || {}

    const q = String(question || '').trim()
    if (!q) return res.status(400).json({ error: 'question is required' })

    const result = await runAgentPortalQuery(req.user, {
      question: q,
      modules,
      autoModules,
      includeContext,
    })

    const envelope = buildAgentPayload({
      question: result.question,
      portalContext: result.portalContext,
      contextPreview: result.contextPreview,
      prompt: result.prompt,
      directAnswer: result.directAnswer,
      modulesUsed: result.modulesUsed,
      authMethod: req.authMethod,
    })

    const forward = await forwardPayloadToAgents(envelope, { url })

    res.status(forward.allOk ? 200 : 502).json({
      ok: forward.allOk,
      hasDirectAnswer: result.hasDirectAnswer,
      queryContext: result.queryContext,
      contextPreview: result.contextPreview,
      modulesUsed: result.modulesUsed,
      delivered: forward.results,
      payload: envelope,
    })
  } catch (err) {
    const status = err.status || 500
    res.status(status).json({ error: err.message, code: err.code })
  }
})

export default router
