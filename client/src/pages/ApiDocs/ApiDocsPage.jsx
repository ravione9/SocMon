import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuthStore } from '../../store/authStore'
import { resolvedPortalOrigin, portalAppUrl } from '../../utils/backendOrigin.js'
import {
  API_DOC_GROUPS,
  API_DOC_ENDPOINTS,
  API_DOCS_INTRO,
} from '../../config/apiDocsCatalog.js'

const C = {
  text: 'var(--text)',
  text2: 'var(--text2)',
  text3: 'var(--text3)',
  bg: 'var(--bg)',
  bg2: 'var(--bg2)',
  bg3: 'var(--bg3)',
  border: 'var(--border)',
  accent: 'var(--accent)',
  green: 'var(--green)',
  red: 'var(--red)',
  amber: 'var(--amber)',
  cyan: 'var(--cyan)',
}

const METHOD_COLORS = {
  GET: C.cyan,
  POST: C.green,
  PUT: C.amber,
  PATCH: C.amber,
  DELETE: C.red,
}

function canUseEndpoint(ep, allowedPages) {
  if (ep.pageKey && !allowedPages.includes(ep.pageKey)) return false
  const group = API_DOC_GROUPS.find((g) => g.id === ep.groupId)
  if (group?.pageKey && !allowedPages.includes(group.pageKey)) return false
  return true
}

function buildPath(template, params, queryHint) {
  let path = template
  for (const p of params || []) {
    const val = p.value?.trim() || p.placeholder
    path = path.replace(`{${p.name}}`, encodeURIComponent(val))
  }
  const q = (queryHint || '').trim()
  if (q.startsWith('?')) return path + q
  return path
}

async function executeApiRequest({ baseUrl, method, path, bearerToken, bodyText }) {
  const headers = { Accept: 'application/json' }
  if (bearerToken?.trim()) headers.Authorization = `Bearer ${bearerToken.trim()}`
  let body
  if (method !== 'GET' && method !== 'DELETE' && bodyText?.trim()) {
    headers['Content-Type'] = 'application/json'
    try {
      body = JSON.stringify(JSON.parse(bodyText))
    } catch {
      throw new Error('Request body is not valid JSON')
    }
  }
  const started = performance.now()
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, { method, headers, body })
  const elapsed = Math.round(performance.now() - started)
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, ok: res.ok, elapsed, data: parsed, raw: text }
}

export default function ApiDocsPage() {
  const user = useAuthStore((s) => s.user)
  const sessionToken = useAuthStore((s) => s.token)
  const allowedPages = user?.allowedPages || []

  const baseUrl = resolvedPortalOrigin()
  const [bearerToken, setBearerToken] = useState(sessionToken || '')
  const [selectedId, setSelectedId] = useState('intro')
  const [pathParamValues, setPathParamValues] = useState({})
  const [bodyText, setBodyText] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState(null)

  const visibleGroups = useMemo(() => {
    return API_DOC_GROUPS.filter((g) => {
      if (g.intro) return true
      if (g.pageKey && !allowedPages.includes(g.pageKey)) return false
      const hasEndpoint = API_DOC_ENDPOINTS.some(
        (ep) => ep.groupId === g.id && canUseEndpoint(ep, allowedPages),
      )
      return g.intro || hasEndpoint
    })
  }, [allowedPages])

  const visibleEndpoints = useMemo(
    () => API_DOC_ENDPOINTS.filter((ep) => canUseEndpoint(ep, allowedPages)),
    [allowedPages],
  )

  const selected = useMemo(() => {
    if (selectedId === 'intro') return { intro: true }
    return visibleEndpoints.find((ep) => ep.id === selectedId) || visibleEndpoints[0]
  }, [selectedId, visibleEndpoints])

  useEffect(() => {
    if (!selected || selected.intro) return
    setBodyText(
      selected.sampleBody ? JSON.stringify(selected.sampleBody, null, 2) : '',
    )
    const init = {}
    for (const p of selected.pathParams || []) {
      init[p.name] = pathParamValues[p.name] || ''
    }
    setPathParamValues(init)
    setResponse(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset body when endpoint changes
  }, [selectedId])

  const runTest = useCallback(async () => {
    if (!selected || selected.intro) return
    if (selected.auth && !bearerToken.trim()) {
      toast.error('Add a Bearer token (portal session or API JWT)')
      return
    }
    const path = buildPath(
      selected.path,
      (selected.pathParams || []).map((p) => ({
        ...p,
        value: pathParamValues[p.name],
      })),
      selected.queryHint,
    )
    setLoading(true)
    setResponse(null)
    try {
      const result = await executeApiRequest({
        baseUrl,
        method: selected.method,
        path,
        bearerToken,
        bodyText,
      })
      setResponse(result)
    } catch (err) {
      setResponse({
        status: 0,
        ok: false,
        elapsed: 0,
        data: { error: err.message },
        raw: err.message,
      })
    } finally {
      setLoading(false)
    }
  }, [selected, bearerToken, baseUrl, bodyText, pathParamValues])

  const copyCurl = useCallback(() => {
    if (!selected || selected.intro) return
    const path = buildPath(
      selected.path,
      (selected.pathParams || []).map((p) => ({
        ...p,
        value: pathParamValues[p.name] || p.placeholder,
      })),
      selected.queryHint,
    )
    const url = `${baseUrl.replace(/\/$/, '')}${path}`
    let curl = `curl -s -X ${selected.method} "${url}"`
    if (bearerToken.trim()) curl += ` \\\n  -H "Authorization: Bearer ${bearerToken.trim()}"`
    if (selected.method !== 'GET' && bodyText.trim()) {
      curl += ` \\\n  -H "Content-Type: application/json" \\\n  -d '${bodyText.replace(/'/g, "'\\''")}'`
    }
    void navigator.clipboard.writeText(curl).then(
      () => toast.success('cURL copied'),
      () => toast.error('Copy failed'),
    )
  }, [selected, baseUrl, bearerToken, bodyText, pathParamValues])

  return (
    <div
      style={{
        minHeight: '100vh',
        background: C.bg,
        color: C.text,
        fontFamily: 'var(--sans)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '14px 20px',
          borderBottom: `1px solid ${C.border}`,
          background: C.bg2,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>NetPulse API documentation</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: C.text3 }}>
            Browse endpoints and send test requests with your JWT.
          </p>
        </div>
        <a
          href={portalAppUrl('/')}
          style={{
            fontSize: 12,
            color: C.accent,
            fontFamily: 'var(--mono)',
            textDecoration: 'none',
          }}
        >
          ← Back to portal
        </a>
      </header>

      <div
        style={{
          padding: '12px 20px',
          borderBottom: `1px solid ${C.border}`,
          background: C.bg2,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
          alignItems: 'end',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, color: C.text3 }}>
          Base URL
          <input
            readOnly
            value={baseUrl}
            style={inputStyle()}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, color: C.text3, gridColumn: 'span 2' }}>
          Bearer token (portal session or API JWT)
          <input
            type="password"
            value={bearerToken}
            onChange={(e) => setBearerToken(e.target.value)}
            placeholder="eyJhbGciOiJIUzI1NiIs..."
            style={inputStyle()}
          />
        </label>
        <button
          type="button"
          onClick={() => setBearerToken(sessionToken || '')}
          style={btnGhost()}
        >
          Use portal session
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        <nav
          style={{
            width: 260,
            flexShrink: 0,
            borderRight: `1px solid ${C.border}`,
            overflowY: 'auto',
            padding: '12px 0',
            background: C.bg2,
          }}
        >
          {visibleGroups.map((group) => (
            <div key={group.id} style={{ marginBottom: 12 }}>
              <div
                style={{
                  padding: '6px 16px',
                  fontSize: 10,
                  fontWeight: 700,
                  color: C.text3,
                  textTransform: 'uppercase',
                  letterSpacing: 0.8,
                  fontFamily: 'var(--mono)',
                }}
              >
                {group.label}
              </div>
              {group.intro ? (
                <button
                  type="button"
                  onClick={() => setSelectedId('intro')}
                  style={navBtn(selectedId === 'intro')}
                >
                  Overview
                </button>
              ) : (
                visibleEndpoints
                  .filter((ep) => ep.groupId === group.id)
                  .map((ep) => (
                    <button
                      key={ep.id}
                      type="button"
                      onClick={() => setSelectedId(ep.id)}
                      style={navBtn(selectedId === ep.id)}
                    >
                      <span style={{ color: METHOD_COLORS[ep.method] || C.text2, marginRight: 6 }}>
                        {ep.method}
                      </span>
                      {ep.title}
                    </button>
                  ))
              )}
            </div>
          ))}
        </nav>

        <main style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {selected?.intro ? (
            <IntroPanel />
          ) : selected ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    fontWeight: 700,
                    color: METHOD_COLORS[selected.method],
                  }}
                >
                  {selected.method}
                </span>
                <code style={{ fontSize: 13, color: C.cyan, fontFamily: 'var(--mono)' }}>{selected.path}</code>
                {selected.sessionOnly && (
                  <span style={{ fontSize: 10, color: C.amber, fontFamily: 'var(--mono)' }}>portal session only</span>
                )}
              </div>
              <h2 style={{ margin: '0 0 8px', fontSize: 17 }}>{selected.title}</h2>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: C.text2, lineHeight: 1.55 }}>{selected.description}</p>

              {(selected.pathParams || []).map((p) => (
                <label key={p.name} style={{ display: 'block', marginBottom: 10, fontSize: 11, color: C.text3 }}>
                  Path: {p.name}
                  <input
                    value={pathParamValues[p.name] || ''}
                    onChange={(e) =>
                      setPathParamValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                    }
                    placeholder={p.placeholder}
                    style={{ ...inputStyle(), marginTop: 4 }}
                  />
                </label>
              ))}

              {selected.queryHint && (
                <p style={{ fontSize: 11, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 12 }}>
                  Query example: <code style={{ color: C.cyan }}>{selected.queryHint}</code>
                </p>
              )}

              {selected.method !== 'GET' && (
                <label style={{ display: 'block', marginBottom: 12, fontSize: 11, color: C.text3 }}>
                  Request body (JSON)
                  <textarea
                    value={bodyText}
                    onChange={(e) => setBodyText(e.target.value)}
                    rows={10}
                    spellCheck={false}
                    style={{
                      ...inputStyle(),
                      marginTop: 4,
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      resize: 'vertical',
                      minHeight: 120,
                    }}
                  />
                </label>
              )}

              <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
                <button type="button" onClick={runTest} disabled={loading} style={btnPrimary()}>
                  {loading ? 'Sending…' : 'Send request'}
                </button>
                <button type="button" onClick={copyCurl} style={btnGhost()}>
                  Copy as cURL
                </button>
              </div>

              {response && <ResponsePanel response={response} />}
            </>
          ) : (
            <p style={{ color: C.text3 }}>No endpoints available for your account.</p>
          )}
        </main>
      </div>
    </div>
  )
}

function IntroPanel() {
  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={{ margin: '0 0 16px', fontSize: 20 }}>{API_DOCS_INTRO.title}</h2>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13,
          marginBottom: 24,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <tbody>
          {API_DOCS_INTRO.sections.map((s) => (
            <tr key={s.heading} style={{ borderTop: `1px solid ${C.border}` }}>
              <td
                style={{
                  width: '28%',
                  padding: '12px 14px',
                  verticalAlign: 'top',
                  fontWeight: 700,
                  color: C.text2,
                  background: C.bg3,
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                }}
              >
                {s.heading}
              </td>
              <td style={{ padding: '12px 14px', color: C.text2, lineHeight: 1.55 }}>{s.body}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 12, color: C.text3 }}>
        Select an endpoint in the sidebar to view parameters and run a live test.
      </p>
    </div>
  )
}

function ResponsePanel({ response }) {
  const display =
    typeof response.data === 'object'
      ? JSON.stringify(response.data, null, 2)
      : String(response.raw ?? response.data ?? '')

  return (
    <div
      style={{
        borderRadius: 10,
        border: `1px solid ${response.ok ? C.green : C.red}`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          background: response.ok ? 'rgba(34,211,160,.1)' : 'rgba(248,113,113,.1)',
          display: 'flex',
          gap: 16,
          fontSize: 12,
          fontFamily: 'var(--mono)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ color: response.ok ? C.green : C.red, fontWeight: 700 }}>
          HTTP {response.status || '—'}
        </span>
        <span style={{ color: C.text3 }}>{response.elapsed} ms</span>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 14,
          fontSize: 11,
          fontFamily: 'var(--mono)',
          color: C.text2,
          background: C.bg3,
          overflow: 'auto',
          maxHeight: 420,
          lineHeight: 1.45,
        }}
      >
        {display}
      </pre>
    </div>
  )
}

function inputStyle() {
  return {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.bg3,
    color: C.text,
    fontSize: 12,
    fontFamily: 'var(--mono)',
    boxSizing: 'border-box',
  }
}

function navBtn(active) {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '8px 16px',
    border: 'none',
    background: active ? 'rgba(79,126,245,.12)' : 'transparent',
    color: active ? C.text : C.text2,
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'var(--mono)',
  }
}

function btnPrimary() {
  return {
    padding: '10px 18px',
    borderRadius: 8,
    border: 'none',
    background: C.accent,
    color: '#fff',
    fontWeight: 700,
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'var(--mono)',
  }
}

function btnGhost() {
  return {
    padding: '10px 14px',
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.bg3,
    color: C.text2,
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'var(--mono)',
  }
}
