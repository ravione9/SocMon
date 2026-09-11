/**
 * Generate apidoc.md from client/src/config/apiDocsCatalog.js
 * Usage: node scripts/gen-apidoc.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = path.join(root, 'client/src/config/apiDocsCatalog.js')
const outPath = path.join(root, 'apidoc.md')

const src = fs.readFileSync(catalogPath, 'utf8')
const tmp = path.join(root, 'scripts', '.apiDocsCatalog.tmp.mjs')
fs.writeFileSync(tmp, src)
const mod = await import(pathToFileURL(tmp).href)
fs.unlinkSync(tmp)

const { API_DOC_GROUPS, API_DOC_ENDPOINTS, API_DOCS_INTRO } = mod

function fmtJson(v) {
  return JSON.stringify(v, null, 2)
}

function paramsTable(params, kind) {
  if (!params?.length) return ''
  let s = `\n| ${kind} | Description | Example |\n|---|---|---|\n`
  for (const p of params) {
    s += `| \`${p.name}\` | ${p.description || ''} | ${p.example || p.placeholder || ''} |\n`
  }
  return `${s}\n`
}

let md = `# ${API_DOCS_INTRO.title}\n\n`
md += '> Generated from `client/src/config/apiDocsCatalog.js` (same catalog as the in-app **/api-docs** explorer).\n\n'
md += 'Interactive explorer: log into the portal and open **/api-docs**.\n\n'
md += 'Related: [docs/EXTERNAL-AGENT-API.md](docs/EXTERNAL-AGENT-API.md) · [docs/PORTAL-LLM-FLOWS.md](docs/PORTAL-LLM-FLOWS.md) · [server-mcp/README.md](server-mcp/README.md)\n\n'
md += '---\n\n'

for (const sec of API_DOCS_INTRO.sections) {
  md += `## ${sec.heading}\n\n`
  md += `${sec.body.split('\n').join('\n\n')}\n\n`
}

md += '---\n\n# Endpoints\n\n'

for (const g of API_DOC_GROUPS.filter((x) => !x.intro)) {
  const eps = API_DOC_ENDPOINTS.filter((e) => e.groupId === g.id)
  if (!eps.length) continue
  md += `## ${g.label}${g.pageKey ? ` (\`pageKey: ${g.pageKey}\`)` : ''}\n\n`
  for (const e of eps) {
    md += `### ${e.method} \`${e.path}\`\n\n`
    md += `**${e.title}**`
    if (e.auth === false) md += ' · *no auth*'
    if (e.sessionOnly) md += ' · *session JWT only*'
    if (e.pageKey) md += ` · requires page \`${e.pageKey}\``
    md += '\n\n'
    if (e.description) md += `${e.description}\n\n`
    md += paramsTable(e.pathParams, 'Path param')
    md += paramsTable(e.queryParams, 'Query param')
    if (e.sampleBody) {
      md += `**Sample body**\n\n\`\`\`json\n${fmtJson(e.sampleBody)}\n\`\`\`\n\n`
    }
    if (e.responseExample) {
      md += `**Example response**\n\n\`\`\`json\n${fmtJson(e.responseExample)}\n\`\`\`\n\n`
    }
    if (e.notes?.length) {
      md += '**Notes**\n\n'
      for (const n of e.notes) md += `- ${n}\n`
      md += '\n'
    }
  }
}

md += `---

## Other mounted prefixes

These are available on the server but not fully listed in the interactive catalog:

| Prefix | Notes |
|---|---|
| \`/api/solarwinds\` | SolarWinds Orion (JWT + \`solarwinds\` page) |
| \`/api/idcs\` | Oracle IDCS users |
| \`/api/ad\` | Active Directory |
| \`/api/nexs\` | Nexs auth service |
| \`/api/email-sim\` | Email simulation (JWT + \`emailSim\`) |
| \`/api/email-sim/pub\` | Public email-sim endpoints |
| \`/api/tickets\` | Tickets |
| \`/api/custom-roles\` | Custom role templates |
| \`/api/web-mgmt\` | Device web management |
| \`/api/rdp\` / \`/api/ssh-sessions\` | Remote access |
| \`/api/ssl\` | SSL helpers |
| \`/api/auth/saml\` | SAML SSO |
| \`/mcp\` | MCP Streamable HTTP (not a browser page; needs JWT + session) — see \`server-mcp/README.md\` |
`

fs.writeFileSync(outPath, md)
console.log(`Wrote ${path.relative(root, outPath)} (${md.length} chars, ${API_DOC_ENDPOINTS.length} endpoints)`)
