/** Email simulation — campaigns, audiences, templates, and tracking. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Line, Doughnut } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { useAuthStore } from '../../store/authStore'
import { canWritePage } from '../../utils/pageAccess'
import { buildFunnelDonutDataset, getFunnelStageColors, getThemeCssColors } from '../../utils/themeCssColors.js'
import { useThemeStore } from '../../store/themeStore.js'
import CampWorkspacePanel from './CampWorkspacePanel.jsx'
import { ES_ACCENT, ES_RADIUS, ES_RADIUS_SM, ES_SHADOW } from './emailSimTheme.js'
import './emailSimTheme.css'
import {
  addCampaignRecipients,
  addCampaignRecipientsFromSources,
  addGroupMember,
  createCampaign,
  createContact,
  createGroup,
  createSmtpProfile,
  createTemplate,
  deleteCampaign,
  deleteContact,
  deleteGroup,
  deleteGroupMember,
  deleteSmtpProfile,
  deleteTemplate,
  getCampaign,
  getCampaignAnalytics,
  getEmailSimMeta,
  getEmailSimStats,
  importContacts,
  importGroupMembers,
  injectCampaignRecipients,
  launchCampaign,
  listCampaigns,
  listContacts,
  listGroupMembers,
  listGroups,
  listSmtpProfiles,
  listTemplates,
  seedIndustryTemplates,
  seedWorkplaceTemplates,
  sendOneEmail,
  updateCampaign,
  updateContact,
  updateGroup,
  updateSmtpProfile,
  updateTemplate,
} from '../../api/emailSim'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Legend, Filler)

const EMAIL_SIM_INITIAL_TPL_FORM = {
  name: '',
  subject: '',
  htmlBody: '<p>Hello {{firstName}},</p>\n<p><a href="https://example.com">Example</a></p>',
  category: 'custom',
}

function sid(id) {
  return id == null ? '' : String(id)
}

/** Same ordering as dashboard/results campaign pickers (newest first). */
function sortEmailSimCampaignsRecentFirst(list) {
  return [...(list || [])].sort((a, b) => {
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime()
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime()
    return tb - ta
  })
}

function firstEmailSimCampaignId(list) {
  const s = sortEmailSimCampaignsRecentFirst(list)
  return s[0]?._id || ''
}

/**
 * Stable colour seed for avatar circles — emails with the same prefix get the
 * same swatch across renders. G-suite uses ~8 colour rotation.
 */
const AVATAR_PALETTE = ['#1a73e8', '#137333', '#a142f4', '#b06000', '#c5221f', '#5c6bc0', '#0b8043', '#e67c73']
function avatarColor(seed) {
  const s = String(seed || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}
function avatarInitials(firstName, lastName, email) {
  const fn = String(firstName || '').trim()
  const ln = String(lastName || '').trim()
  if (fn || ln) return `${(fn[0] || '').toUpperCase()}${(ln[0] || '').toUpperCase()}` || (fn[0] || '').toUpperCase()
  const e = String(email || '').trim()
  if (!e) return '?'
  const local = e.split('@')[0]
  const bits = local.split(/[._-]/).filter(Boolean)
  if (bits.length >= 2) return (bits[0][0] + bits[1][0]).toUpperCase()
  return local.slice(0, 2).toUpperCase()
}

function GsAvatar({ email, firstName, lastName, size = 28 }) {
  const color = avatarColor(email)
  return (
    <span
      title={email}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        color: '#fff',
        fontSize: Math.round(size * 0.42),
        fontWeight: 700,
        letterSpacing: 0.3,
        flexShrink: 0,
      }}
    >
      {avatarInitials(firstName, lastName, email)}
    </span>
  )
}

function GsChip({ label, tone = 'slate' }) {
  const tones = {
    slate: { bg: 'color-mix(in srgb, var(--bg4) 70%, transparent)', border: 'var(--border)', text: 'var(--text2)' },
    green: { bg: 'color-mix(in srgb, var(--green) 16%, transparent)', border: 'color-mix(in srgb, var(--green) 40%, var(--border))', text: 'var(--green)' },
  }
  const t = tones[tone] || tones.slate
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 999,
        border: `1px solid ${t.border}`,
        background: t.bg,
        color: t.text,
        whiteSpace: 'nowrap',
        maxWidth: 160,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
      title={label}
    >
      {label}
    </span>
  )
}

/**
 * Pull common per-recipient name fields out of mergeVars regardless of CSV
 * column casing (firstName / first_name / FirstName / etc.). Returns the
 * remaining merge vars as `other` for the "Other fields" column.
 */
function splitContactMergeVars(mergeVars) {
  const obj = mergeVars && typeof mergeVars === 'object' ? mergeVars : {}
  const out = { firstName: '', lastName: '', other: {} }
  const matchers = {
    firstName: /^(first[\s_-]?name|firstname|first)$/i,
    lastName: /^(last[\s_-]?name|lastname|last|surname)$/i,
  }
  for (const [k, v] of Object.entries(obj)) {
    if (matchers.firstName.test(k) && !out.firstName) {
      out.firstName = v == null ? '' : String(v)
      continue
    }
    if (matchers.lastName.test(k) && !out.lastName) {
      out.lastName = v == null ? '' : String(v)
      continue
    }
    out.other[k] = v
  }
  return out
}

function toggleStringId(prev, rawId) {
  const id = sid(rawId)
  const has = prev.some((x) => sid(x) === id)
  return has ? prev.filter((x) => sid(x) !== id) : [...prev, id]
}

/**
 * Compact "Upload CSV file" picker — reads a local .csv as text and pipes it
 * into the supplied callback. Keeps the existing paste-into-textarea flow as
 * the source of truth so users can still tweak rows before importing.
 */
function CsvFileUpload({ onLoad, disabled, label = 'Upload CSV file', maxBytes = 1_500_000 }) {
  const inputRef = useRef(null)
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        disabled={disabled}
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          if (file.size > maxBytes) {
            toast.error(`CSV is too large (${Math.round(file.size / 1024)} KB > ${Math.round(maxBytes / 1024)} KB).`)
            e.target.value = ''
            return
          }
          try {
            const text = await file.text()
            onLoad(text)
            toast.success(`Loaded ${file.name}`)
          } catch (err) {
            toast.error('Could not read the file')
          } finally {
            e.target.value = ''
          }
        }}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        style={{
          padding: '6px 12px',
          fontSize: 12,
          fontWeight: 600,
          borderRadius: 4,
          border: '1px solid var(--border)',
          background: 'var(--bg2)',
          color: disabled ? 'var(--text3)' : 'var(--text)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        ⇪ {label}
      </button>
    </div>
  )
}

/** Shared compact pagination row for contact/group directories */
function LibPaginationControls({ page, pageSize, total, disabled, onPrev, onNext }) {
  const n = typeof total === 'number' ? total : 0
  const totalPages = Math.max(1, Math.ceil(n / pageSize) || 1)
  const from = n === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(n, page * pageSize)
  const btnStyle = {
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--bg2)',
    color: 'var(--text)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 10,
        fontSize: 12,
        color: 'var(--text3)',
      }}
    >
      <span>
        {n === 0 ? 'No results' : `Showing ${from}–${to} of ${n}`}
        {totalPages > 1 ? ` · Page ${page} / ${totalPages}` : ''}
      </span>
      <span style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={btnStyle} disabled={disabled || page <= 1} onClick={onPrev}>
          Previous
        </button>
        <button type="button" style={btnStyle} disabled={disabled || page >= totalPages} onClick={onNext}>
          Next
        </button>
      </span>
    </div>
  )
}

function escapeCsvCell(v) {
  const s = v == null ? '' : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function firstEventIso(events, type) {
  const ev = (events || []).find((e) => e.type === type)
  return ev?.at ? new Date(ev.at).toISOString() : ''
}

function lastSubmittedPayloadJson(events) {
  const subs = (events || []).filter((e) => e.type === 'submitted')
  const ev = subs[subs.length - 1]
  if (!ev?.meta?.payload) return ''
  try {
    return JSON.stringify(ev.meta.payload)
  } catch {
    return ''
  }
}

/** Export per-recipient funnel timestamps + captured payload for spreadsheets / SOC review */
function downloadCampaignResultsCsv(detail) {
  const recipients = detail?.recipients || []
  const campaignName = detail?.campaign?.name || 'campaign'
  const headers = [
    'email',
    'status',
    'opened_at',
    'clicked_at',
    'landing_view_at',
    'submitted_at',
    'events_sequence',
    'submitted_payload_json',
  ]
  const rows = recipients.map((r) => [
    r.email,
    r.status,
    firstEventIso(r.events, 'opened'),
    firstEventIso(r.events, 'clicked'),
    firstEventIso(r.events, 'landing_view'),
    firstEventIso(r.events, 'submitted'),
    (r.events || []).map((e) => e.type).join('|'),
    lastSubmittedPayloadJson(r.events),
  ])
  const csv = [headers.join(','), ...rows.map((cols) => cols.map(escapeCsvCell).join(','))].join('\r\n')
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const safe = campaignName.replace(/[^\w\-]+/g, '_').slice(0, 80)
  a.download = `${safe}_results_${new Date().toISOString().slice(0, 10)}.csv`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

const USERS_PAGE_SIZE = 50
const GROUPS_PAGE_SIZE = 50
const CAMP_GROUP_PAGE_SIZE = 50
const CAMP_CONTACT_PAGE_SIZE = 100

const NAV = [
  { id: 'dash', label: 'Dashboard', icon: '▣' },
  { id: 'camp', label: 'Campaigns', icon: '◎' },
  { id: 'results', label: 'Results', icon: '▤' },
  { id: 'audience', label: 'Users & Groups', icon: '▦' },
  { id: 'tpl', label: 'Email Templates', icon: '✉' },
  { id: 'smtp', label: 'Sending Profiles', icon: '⚡' },
  { id: 'one', label: 'Send Test Email', icon: '➤' },
]

export default function EmailSimulationPage() {
  const user = useAuthStore((s) => s.user)
  const write = canWritePage(user, 'emailSim')

  const [tab, setTab] = useState('dash')
  const [audienceView, setAudienceView] = useState('groups')
  const [meta, setMeta] = useState(null)
  const [stats, setStats] = useState(null)
  /** Prevents a slow in-flight refresh from overwriting newer state after delete. */
  const dataLoadEpochRef = useRef(0)
  const [profiles, setProfiles] = useState([])
  const [templates, setTemplates] = useState([])
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading] = useState(true)

  const [libraryRev, setLibraryRev] = useState(0)

  const [usersLib, setUsersLib] = useState({ items: [], total: 0, loading: false })
  const [usersPage, setUsersPage] = useState(1)
  const [usersSearchIn, setUsersSearchIn] = useState('')
  const [usersSearchQ, setUsersSearchQ] = useState('')

  const [groupsLib, setGroupsLib] = useState({ items: [], total: 0, loading: false })
  const [groupsPage, setGroupsPage] = useState(1)
  const [groupsSearchIn, setGroupsSearchIn] = useState('')
  const [groupsSearchQ, setGroupsSearchQ] = useState('')

  const [campGroupsLib, setCampGroupsLib] = useState({ items: [], total: 0, loading: false })
  const [campGroupPage, setCampGroupPage] = useState(1)
  const [campGroupSearchIn, setCampGroupSearchIn] = useState('')
  const [campGroupSearchQ, setCampGroupSearchQ] = useState('')

  const [campContactsLib, setCampContactsLib] = useState({ items: [], total: 0, loading: false })
  const [campContactPage, setCampContactPage] = useState(1)
  const [campContactSearchIn, setCampContactSearchIn] = useState('')
  const [campContactSearchQ, setCampContactSearchQ] = useState('')

  const initialSmtpForm = () => ({
    name: '',
    host: '',
    port: 587,
    secure: false,
    username: '',
    password: '',
    fromEmail: '',
    fromName: '',
  })
  const [smtpForm, setSmtpForm] = useState(initialSmtpForm)
  const [smtpEditingId, setSmtpEditingId] = useState(null)
  const [tplForm, setTplForm] = useState(() => ({ ...EMAIL_SIM_INITIAL_TPL_FORM }))
  const [tplModalOpen, setTplModalOpen] = useState(false)
  const [tplEditingId, setTplEditingId] = useState(null)
  const [campForm, setCampForm] = useState({
    name: '',
    templateId: '',
    smtpProfileId: '',
    landingHtml: '',
    trackingUrl: '',
    otherUrl: '',
  })
  const [campWorkspaceUrls, setCampWorkspaceUrls] = useState({ trackingUrl: '', otherUrl: '' })
  const [recipientBulk, setRecipientBulk] = useState('')
  const [selectedCampId, setSelectedCampId] = useState('')
  const [campDetail, setCampDetail] = useState(null)

  const [oneForm, setOneForm] = useState({ templateId: '', smtpProfileId: '', to: '', mergeJson: '{}' })

  const [dashCampaignId, setDashCampaignId] = useState('')
  const [campaignAnalytics, setCampaignAnalytics] = useState(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsRev, setAnalyticsRev] = useState(0)

  const [injectMode, setInjectMode] = useState('csv')
  const [injectCsv, setInjectCsv] = useState('email,firstName,lastName,employeeCode\nuser@example.com,Jane,Doe,E123')
  const [injectJson, setInjectJson] = useState(
    '[\n  { "email": "user@example.com", "firstName": "Jane", "lastName": "Doe", "reference": "REF-001" }\n]',
  )

  /** Plain firstName/lastName fields + arbitrary key/value extras — replaces the JSON textarea. */
  const [contactForm, setContactForm] = useState({ email: '', firstName: '', lastName: '', extraJson: '{}' })
  const [contactModalOpen, setContactModalOpen] = useState(false)
  const [contactEditingId, setContactEditingId] = useState(null)
  /** Optional: imported contacts also get added to this group. */
  const [contactImportGroupId, setContactImportGroupId] = useState('')

  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [groupEditingId, setGroupEditingId] = useState(null)
  const [contactCsv, setContactCsv] = useState('email,firstName,lastName\nuser@example.com,Jane,Doe')

  const [groupForm, setGroupForm] = useState({ name: '', description: '' })
  const [selectedLibraryGroupId, setSelectedLibraryGroupId] = useState('')
  const [groupDetail, setGroupDetail] = useState(null)
  const [memberForm, setMemberForm] = useState({ email: '', mergeJson: '{}' })
  const [memberCsv, setMemberCsv] = useState('email,firstName,lastName\nuser@example.com,Jane,Doe')

  const [fromSourcesGroupIds, setFromSourcesGroupIds] = useState([])
  const [fromSourcesContactIds, setFromSourcesContactIds] = useState([])

  const [campModalOpen, setCampModalOpen] = useState(false)
  const [resultsCampId, setResultsCampId] = useState('')
  const [resultsAnalytics, setResultsAnalytics] = useState(null)
  const [resultsRecipientsDetail, setResultsRecipientsDetail] = useState(null)
  const [resultsLoading, setResultsLoading] = useState(false)

  const theme = useThemeStore((s) => s.theme)
  const chartColors = useMemo(() => getThemeCssColors(), [theme])
  const overviewLineOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: chartColors.text2 } },
        tooltip: {
          titleColor: chartColors.text,
          bodyColor: chartColors.text2,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label || ''}: ${ctx.parsed.y}%`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: chartColors.text3, maxRotation: 45, maxTicksLimit: 10 },
          grid: { color: `${chartColors.text3}22` },
        },
        y: {
          min: 0,
          max: 100,
          ticks: {
            color: chartColors.text3,
            callback: (v) => `${v}%`,
          },
          grid: { color: `${chartColors.text3}22` },
        },
      },
    }),
    [chartColors],
  )

  const donutOpts = useMemo(
    () => ({
      cutout: '82%',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 480 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: chartColors.bg2,
          titleColor: chartColors.text,
          bodyColor: chartColors.text2,
          borderColor: chartColors.border,
          borderWidth: 1,
          callbacks: {
            label: (ctx) => {
              const label = ctx.chart?.data?.datasets?.[0]?.label || ctx.label || ''
              const v = ctx.raw
              const pct = typeof v === 'number' ? `${Math.round(v * 10) / 10}%` : String(v)
              return label ? `${label}: ${pct}` : pct
            },
          },
        },
      },
    }),
    [chartColors],
  )

  /** Full list for pickers & registry (draft, scheduled, launched, completed). */
  const allCampaignsSorted = useMemo(() => sortEmailSimCampaignsRecentFirst(campaigns), [campaigns])

  const resultsLineData = useMemo(() => {
    if (!resultsAnalytics?.timeline?.length) return null
    return {
      labels: resultsAnalytics.timeline.map((t) => t.date),
      datasets: [
        {
          label: '% captured (cumulative)',
          data: resultsAnalytics.timeline.map((t) => t.successPct),
          borderColor: '#ef5350',
          backgroundColor: 'rgba(239, 83, 80, 0.14)',
          fill: true,
          tension: 0.25,
          pointRadius: 3,
          pointBackgroundColor: '#ef5350',
          borderWidth: 2,
        },
      ],
    }
  }, [resultsAnalytics])

  const applyDashboardSnapshot = useCallback((epoch, summary, campaignsList) => {
    if (epoch !== dataLoadEpochRef.current) return false
    if (summary) setStats({ ...summary })
    if (campaignsList) setCampaigns(campaignsList)
    setAnalyticsRev((x) => x + 1)
    return true
  }, [])

  const refreshAll = useCallback(async (opts = {}) => {
    const silent = Boolean(opts.silent)
    const epoch = ++dataLoadEpochRef.current
    if (!silent) setLoading(true)
    let result = null
    try {
      const [m, st, pr, tp, cp] = await Promise.all([
        getEmailSimMeta(),
        getEmailSimStats(),
        listSmtpProfiles(),
        listTemplates(),
        listCampaigns(),
      ])
      if (epoch !== dataLoadEpochRef.current) return null
      const campaignsList = cp.campaigns || []
      setMeta(m)
      setStats(st)
      setProfiles(pr.profiles || [])
      setTemplates(tp.templates || [])
      setCampaigns(campaignsList)
      result = { campaigns: campaignsList, stats: st }
    } catch (e) {
      if (epoch === dataLoadEpochRef.current) {
        toast.error(e.response?.data?.error || e.message || 'Failed to load email simulation')
      }
    } finally {
      if (epoch === dataLoadEpochRef.current) {
        if (!silent) setLoading(false)
        setAnalyticsRev((x) => x + 1)
        setLibraryRev((x) => x + 1)
      }
    }
    return result
  }, [])

  /** Dashboard cards + campaign lists only (no full-page loading overlay). */
  const refreshSummarySilent = useCallback(async () => {
    const epoch = ++dataLoadEpochRef.current
    try {
      const [st, cp] = await Promise.all([getEmailSimStats(), listCampaigns()])
      if (epoch !== dataLoadEpochRef.current) return null
      const campaignsList = cp.campaigns || []
      setStats(st)
      setCampaigns(campaignsList)
      setAnalyticsRev((x) => x + 1)
      return { summary: st, campaigns: campaignsList }
    } catch (e) {
      if (epoch === dataLoadEpochRef.current) {
        toast.error(e.response?.data?.error || e.message || 'Failed to refresh dashboard')
      }
      return null
    }
  }, [])

  const fixCampaignPickersAfterDelete = useCallback((deletedCampaignId, campaignsList) => {
    const next = campaignsList ?? []
    const first = firstEmailSimCampaignId(next)
    setDashCampaignId((prev) => {
      if (sid(prev) === sid(deletedCampaignId)) return first
      if (prev && !next.some((c) => sid(c._id) === sid(prev))) return first
      return prev
    })
    setResultsCampId((prev) => {
      if (sid(prev) === sid(deletedCampaignId)) return first
      if (prev && !next.some((c) => sid(c._id) === sid(prev))) return first
      return prev
    })
    setCampaignAnalytics(null)
  }, [])

  /** Delete campaign, then force dashboard summary + lists to match server (no stale refresh race). */
  const deleteCampaignAndRefresh = useCallback(
    async (campaignId) => {
      const del = await deleteCampaign(campaignId)
      dataLoadEpochRef.current += 1
      const epoch = ++dataLoadEpochRef.current

      const campaignsFromDel = Array.isArray(del?.campaigns) ? del.campaigns : null
      applyDashboardSnapshot(epoch, del?.summary, campaignsFromDel)
      fixCampaignPickersAfterDelete(campaignId, campaignsFromDel ?? [])

      const fresh = await refreshSummarySilent()
      if (fresh) {
        applyDashboardSnapshot(dataLoadEpochRef.current, fresh.summary, fresh.campaigns)
        fixCampaignPickersAfterDelete(campaignId, fresh.campaigns)
      }
      return del
    },
    [applyDashboardSnapshot, fixCampaignPickersAfterDelete, refreshSummarySilent],
  )

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  useEffect(() => {
    if (!dashCampaignId && allCampaignsSorted.length > 0) {
      setDashCampaignId(allCampaignsSorted[0]._id)
    }
  }, [allCampaignsSorted, dashCampaignId])

  useEffect(() => {
    if (!dashCampaignId) return
    if (!allCampaignsSorted.some((c) => sid(c._id) === sid(dashCampaignId))) {
      setDashCampaignId(allCampaignsSorted[0]?._id || '')
    }
  }, [allCampaignsSorted, dashCampaignId])

  useEffect(() => {
    if (tab !== 'dash' || !dashCampaignId) {
      setCampaignAnalytics(null)
      return
    }
    let cancelled = false
    ;(async () => {
      setAnalyticsLoading(true)
      try {
        const data = await getCampaignAnalytics(dashCampaignId)
        if (!cancelled) setCampaignAnalytics(data)
      } catch {
        if (!cancelled) setCampaignAnalytics(null)
      }
      if (!cancelled) setAnalyticsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [tab, dashCampaignId, analyticsRev])

  useEffect(() => {
    if (tab !== 'results') return
    const ok = allCampaignsSorted.some((c) => sid(c._id) === sid(resultsCampId))
    if (!resultsCampId || !ok) {
      setResultsCampId(allCampaignsSorted[0]?._id || '')
    }
  }, [tab, allCampaignsSorted, resultsCampId])

  useEffect(() => {
    if (tab !== 'results') return
    if (!resultsCampId) {
      setResultsAnalytics(null)
      setResultsRecipientsDetail(null)
      return
    }
    let cancelled = false
    ;(async () => {
      setResultsLoading(true)
      try {
        const [an, det] = await Promise.all([getCampaignAnalytics(resultsCampId), getCampaign(resultsCampId)])
        if (!cancelled) {
          setResultsAnalytics(an)
          setResultsRecipientsDetail(det)
        }
      } catch {
        if (!cancelled) {
          setResultsAnalytics(null)
          setResultsRecipientsDetail(null)
        }
      }
      if (!cancelled) setResultsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [tab, resultsCampId, analyticsRev])

  useEffect(() => {
    if (!campModalOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') setCampModalOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [campModalOpen])

  useEffect(() => {
    if (!campModalOpen) return
    setCampForm({
      name: '',
      templateId: '',
      smtpProfileId: '',
      landingHtml: '',
      trackingUrl: '',
      otherUrl: '',
    })
  }, [campModalOpen])

  useEffect(() => {
    if (!tplModalOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setTplModalOpen(false)
        setTplEditingId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tplModalOpen])

  useEffect(() => {
    if (!selectedCampId) {
      setCampDetail(null)
      return
    }
    ;(async () => {
      try {
        const d = await getCampaign(selectedCampId)
        setCampDetail(d)
      } catch {
        setCampDetail(null)
      }
    })()
  }, [selectedCampId])

  useEffect(() => {
    const c = campDetail?.campaign
    if (!c) {
      setCampWorkspaceUrls({ trackingUrl: '', otherUrl: '' })
      return
    }
    setCampWorkspaceUrls({
      trackingUrl: c.trackingUrl ?? '',
      otherUrl: c.otherUrl ?? '',
    })
  }, [campDetail?.campaign])

  useEffect(() => {
    setFromSourcesGroupIds([])
    setFromSourcesContactIds([])
    setCampGroupPage(1)
    setCampContactPage(1)
    setCampGroupSearchIn('')
    setCampContactSearchIn('')
    setCampGroupSearchQ('')
    setCampContactSearchQ('')
  }, [selectedCampId])

  useEffect(() => {
    const t = setTimeout(() => setUsersSearchQ(usersSearchIn.trim()), 350)
    return () => clearTimeout(t)
  }, [usersSearchIn])

  useEffect(() => {
    setUsersPage(1)
  }, [usersSearchQ])

  useEffect(() => {
    const t = setTimeout(() => setGroupsSearchQ(groupsSearchIn.trim()), 350)
    return () => clearTimeout(t)
  }, [groupsSearchIn])

  useEffect(() => {
    setGroupsPage(1)
  }, [groupsSearchQ])

  useEffect(() => {
    const t = setTimeout(() => setCampContactSearchQ(campContactSearchIn.trim()), 350)
    return () => clearTimeout(t)
  }, [campContactSearchIn])

  useEffect(() => {
    const t = setTimeout(() => setCampGroupSearchQ(campGroupSearchIn.trim()), 350)
    return () => clearTimeout(t)
  }, [campGroupSearchIn])

  useEffect(() => {
    setCampContactPage(1)
  }, [campContactSearchQ, selectedCampId])

  useEffect(() => {
    setCampGroupPage(1)
  }, [campGroupSearchQ, selectedCampId])

  // Both lists are loaded whenever the merged Users & Groups tab is open:
  // groupsLib also powers the "Also add to group" picker in the contacts CSV
  // import panel, so it can't be gated on audienceView.
  useEffect(() => {
    if (tab !== 'audience') return
    let cancelled = false
    ;(async () => {
      setUsersLib((s) => ({ ...s, loading: true }))
      try {
        const data = await listContacts({
          q: usersSearchQ || undefined,
          page: usersPage,
          limit: USERS_PAGE_SIZE,
        })
        if (cancelled) return
        setUsersLib({
          items: data.contacts || [],
          total: typeof data.total === 'number' ? data.total : (data.contacts || []).length,
          loading: false,
        })
      } catch {
        if (!cancelled) setUsersLib({ items: [], total: 0, loading: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tab, usersSearchQ, usersPage, libraryRev])

  useEffect(() => {
    if (tab !== 'audience') return
    let cancelled = false
    ;(async () => {
      setGroupsLib((s) => ({ ...s, loading: true }))
      try {
        const data = await listGroups({
          q: groupsSearchQ || undefined,
          page: groupsPage,
          limit: GROUPS_PAGE_SIZE,
        })
        if (cancelled) return
        setGroupsLib({
          items: data.groups || [],
          total: typeof data.total === 'number' ? data.total : (data.groups || []).length,
          loading: false,
        })
      } catch {
        if (!cancelled) setGroupsLib({ items: [], total: 0, loading: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tab, groupsSearchQ, groupsPage, libraryRev])

  useEffect(() => {
    if (tab !== 'camp' || !selectedCampId) return
    let cancelled = false
    ;(async () => {
      setCampContactsLib((s) => ({ ...s, loading: true }))
      try {
        const data = await listContacts({
          q: campContactSearchQ || undefined,
          page: campContactPage,
          limit: CAMP_CONTACT_PAGE_SIZE,
        })
        if (cancelled) return
        setCampContactsLib({
          items: data.contacts || [],
          total: typeof data.total === 'number' ? data.total : 0,
          loading: false,
        })
      } catch {
        if (!cancelled) setCampContactsLib({ items: [], total: 0, loading: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tab, selectedCampId, campContactSearchQ, campContactPage, libraryRev])

  useEffect(() => {
    if (tab !== 'camp' || !selectedCampId) return
    let cancelled = false
    ;(async () => {
      setCampGroupsLib((s) => ({ ...s, loading: true }))
      try {
        const data = await listGroups({
          q: campGroupSearchQ || undefined,
          page: campGroupPage,
          limit: CAMP_GROUP_PAGE_SIZE,
        })
        if (cancelled) return
        setCampGroupsLib({
          items: data.groups || [],
          total: typeof data.total === 'number' ? data.total : 0,
          loading: false,
        })
      } catch {
        if (!cancelled) setCampGroupsLib({ items: [], total: 0, loading: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tab, selectedCampId, campGroupSearchQ, campGroupPage, libraryRev])

  useEffect(() => {
    if (!selectedLibraryGroupId) {
      setGroupDetail(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const d = await listGroupMembers(selectedLibraryGroupId)
        if (!cancelled) setGroupDetail(d)
      } catch {
        if (!cancelled) setGroupDetail(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedLibraryGroupId])

  function cancelSmtpEdit() {
    setSmtpEditingId(null)
    setSmtpForm(initialSmtpForm())
  }

  function startEditSmtpProfile(p) {
    setSmtpEditingId(p._id)
    setSmtpForm({
      name: p.name || '',
      host: p.host || '',
      port: Number(p.port) || 587,
      secure: Boolean(p.secure),
      username: p.username || '',
      password: '',
      fromEmail: p.fromEmail || '',
      fromName: p.fromName || '',
    })
  }

  async function onSaveSmtp(e) {
    e.preventDefault()
    try {
      if (smtpEditingId) {
        const payload = {
          name: smtpForm.name,
          host: smtpForm.host,
          port: smtpForm.port,
          secure: smtpForm.secure,
          username: smtpForm.username,
          fromEmail: smtpForm.fromEmail,
          fromName: smtpForm.fromName,
        }
        if (smtpForm.password && String(smtpForm.password).trim()) {
          payload.password = smtpForm.password
        }
        await updateSmtpProfile(smtpEditingId, payload)
        toast.success('Sending profile updated')
        cancelSmtpEdit()
      } else {
        await createSmtpProfile(smtpForm)
        toast.success('Sending profile saved')
        setSmtpForm((f) => ({ ...f, password: '' }))
      }
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    }
  }

  function closeTplModal() {
    setTplModalOpen(false)
    setTplEditingId(null)
  }

  function openTplCreateModal() {
    setTplEditingId(null)
    setTplForm({ ...EMAIL_SIM_INITIAL_TPL_FORM })
    setTplModalOpen(true)
  }

  function openTplEditModal(t) {
    setTplEditingId(t._id)
    setTplForm({
      name: t.name || '',
      subject: t.subject || '',
      htmlBody: t.htmlBody || '',
      category: t.category || 'custom',
    })
    setTplModalOpen(true)
  }

  async function onSubmitTplModal(e) {
    e.preventDefault()
    try {
      const cat = String(tplForm.category || '').trim() || 'custom'
      if (tplEditingId) {
        await updateTemplate(tplEditingId, {
          name: tplForm.name,
          subject: tplForm.subject,
          htmlBody: tplForm.htmlBody,
          category: cat,
        })
        toast.success('Template updated')
      } else {
        await createTemplate({
          name: tplForm.name,
          subject: tplForm.subject,
          htmlBody: tplForm.htmlBody,
          category: cat,
        })
        toast.success('Template created')
      }
      closeTplModal()
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    }
  }

  async function onCreateCamp(e) {
    e.preventDefault()
    try {
      await createCampaign({
        name: campForm.name,
        templateId: campForm.templateId,
        smtpProfileId: campForm.smtpProfileId,
        landingHtml: campForm.landingHtml || '',
        trackingUrl: campForm.trackingUrl?.trim() || '',
        otherUrl: campForm.otherUrl?.trim() || '',
      })
      toast.success('Campaign created')
      setCampModalOpen(false)
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    }
  }

  async function onSaveCampaignUrls(e) {
    e.preventDefault()
    if (!selectedCampId) return toast.error('Select a campaign')
    if (campDetail?.campaign?.status !== 'draft') return toast.error('URLs can only be edited while campaign is draft')
    try {
      await updateCampaign(selectedCampId, {
        trackingUrl: campWorkspaceUrls.trackingUrl.trim(),
        otherUrl: campWorkspaceUrls.otherUrl.trim(),
      })
      toast.success('Campaign URLs saved')
      const d = await getCampaign(selectedCampId)
      setCampDetail(d)
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    }
  }

  async function onAddRecipients(e) {
    e.preventDefault()
    if (!selectedCampId) return toast.error('Select a campaign')
    try {
      const out = await addCampaignRecipients(selectedCampId, recipientBulk)
      toast.success(`Imported ${out.inserted || 0} addresses`)
      setRecipientBulk('')
      const d = await getCampaign(selectedCampId)
      setCampDetail(d)
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed')
    }
  }

  async function onLaunch() {
    if (!selectedCampId) return toast.error('Select a campaign')
    try {
      const out = await launchCampaign(selectedCampId)
      toast.success(`Campaign launched (${out.originUsed})`)
      refreshAll()
      const d = await getCampaign(selectedCampId)
      setCampDetail(d)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Launch failed')
    }
  }

  async function onSendOne(e) {
    e.preventDefault()
    let mergeVars = {}
    try {
      mergeVars = JSON.parse(oneForm.mergeJson || '{}')
    } catch {
      return toast.error('Merge fields must be valid JSON')
    }
    try {
      await sendOneEmail({
        templateId: oneForm.templateId,
        smtpProfileId: oneForm.smtpProfileId,
        to: oneForm.to,
        mergeVars,
      })
      toast.success('Test email sent')
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Send failed')
    }
  }

  async function onInject(e) {
    e.preventDefault()
    if (!selectedCampId) return toast.error('Select a campaign')
    if (campDetail?.campaign?.status !== 'draft') return toast.error('Data inject is only allowed while campaign is draft')
    try {
      let body
      if (injectMode === 'csv') body = { csv: injectCsv }
      else {
        const rows = JSON.parse(injectJson || '[]')
        if (!Array.isArray(rows)) throw new Error('JSON must be an array of objects')
        body = { rows }
      }
      const out = await injectCampaignRecipients(selectedCampId, body)
      toast.success(`Inserted ${out.inserted}${out.skipped ? `, skipped ${out.skipped} (already listed)` : ''}`)
      const d = await getCampaign(selectedCampId)
      setCampDetail(d)
      refreshAll()
      setAnalyticsRev((x) => x + 1)
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Inject failed')
    }
  }

  function openCreateContactModal() {
    setContactEditingId(null)
    setContactForm({ email: '', firstName: '', lastName: '', extraJson: '{}' })
    setContactModalOpen(true)
  }

  function openEditContactModal(c) {
    const split = splitContactMergeVars(c.mergeVars)
    setContactEditingId(c._id)
    setContactForm({
      email: c.email || '',
      firstName: split.firstName || '',
      lastName: split.lastName || '',
      extraJson: Object.keys(split.other).length ? JSON.stringify(split.other, null, 2) : '{}',
    })
    setContactModalOpen(true)
  }

  function closeContactModal() {
    setContactModalOpen(false)
    setContactEditingId(null)
  }

  async function onSaveContact(e) {
    e.preventDefault()
    let extra = {}
    try {
      const parsed = JSON.parse(contactForm.extraJson || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed
      else return toast.error('Extra fields must be a JSON object')
    } catch {
      return toast.error('Extra fields must be valid JSON')
    }
    const mergeVars = {
      ...(contactForm.firstName.trim() ? { firstName: contactForm.firstName.trim() } : {}),
      ...(contactForm.lastName.trim() ? { lastName: contactForm.lastName.trim() } : {}),
      ...extra,
    }
    try {
      if (contactEditingId) {
        await updateContact(contactEditingId, { email: contactForm.email.trim(), mergeVars })
        toast.success('Contact updated')
      } else {
        await createContact({ email: contactForm.email.trim(), mergeVars })
        toast.success('Contact saved')
      }
      closeContactModal()
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    }
  }

  function openCreateGroupModal() {
    setGroupEditingId(null)
    setGroupForm({ name: '', description: '' })
    setGroupModalOpen(true)
  }

  function openEditGroupModal(g) {
    setGroupEditingId(g._id)
    setGroupForm({ name: g.name || '', description: g.description || '' })
    setGroupModalOpen(true)
  }

  function closeGroupModal() {
    setGroupModalOpen(false)
    setGroupEditingId(null)
  }

  async function onSaveGroupModal(e) {
    e.preventDefault()
    const name = String(groupForm.name || '').trim()
    if (!name) return toast.error('Name is required')
    try {
      if (groupEditingId) {
        await updateGroup(groupEditingId, { name, description: String(groupForm.description || '').trim() })
        toast.success('Group updated')
      } else {
        await createGroup({ name, description: String(groupForm.description || '').trim() })
        toast.success('Group created')
      }
      closeGroupModal()
      setGroupForm({ name: '', description: '' })
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    }
  }

  async function onImportContactsCsvSubmit(e) {
    e.preventDefault()
    if (!String(contactCsv || '').trim()) return toast.error('Paste or upload a CSV first')
    try {
      const out = await importContacts({
        csv: contactCsv,
        ...(contactImportGroupId ? { groupId: contactImportGroupId } : {}),
      })
      const groupSuffix = out?.groupAdded
        ? ` · ${out.groupAdded} added to "${out.groupName || 'group'}"`
        : ''
      toast.success(`Imported / updated ${out.upserted || 0} contacts${groupSuffix}`)
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed')
    }
  }


  async function onAddGroupMemberSubmit(e) {
    e.preventDefault()
    if (!selectedLibraryGroupId) return toast.error('Select a group')
    let mergeVars = {}
    try {
      mergeVars = JSON.parse(memberForm.mergeJson || '{}')
    } catch {
      return toast.error('Merge fields must be valid JSON')
    }
    try {
      const out = await addGroupMember(selectedLibraryGroupId, { email: memberForm.email.trim(), mergeVars })
      const mirrorMsg = out?.contactsMirrored ? ` · synced to saved contacts` : ''
      toast.success(`Member added${mirrorMsg}`)
      setMemberForm({ email: '', mergeJson: '{}' })
      const d = await listGroupMembers(selectedLibraryGroupId)
      setGroupDetail(d)
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    }
  }

  async function onImportMembersCsvSubmit(e) {
    e.preventDefault()
    if (!selectedLibraryGroupId) return toast.error('Select a group')
    if (!String(memberCsv || '').trim()) return toast.error('Paste or upload a CSV first')
    try {
      const out = await importGroupMembers(selectedLibraryGroupId, { csv: memberCsv })
      const mirrorMsg = out?.contactsMirrored
        ? ` · ${out.contactsMirrored} contact${out.contactsMirrored === 1 ? '' : 's'} synced`
        : ''
      toast.success(`Imported / updated ${out.upserted || 0} members${mirrorMsg}`)
      const d = await listGroupMembers(selectedLibraryGroupId)
      setGroupDetail(d)
      refreshAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed')
    }
  }

  async function onAddFromSources(e) {
    e.preventDefault()
    if (!selectedCampId) return toast.error('Select a campaign')
    if (campDetail?.campaign?.status !== 'draft') return toast.error('Only draft campaigns accept new targets')
    if (!fromSourcesGroupIds.length && !fromSourcesContactIds.length) {
      return toast.error('Choose at least one group or saved contact')
    }
    try {
      const out = await addCampaignRecipientsFromSources(selectedCampId, {
        groupIds: fromSourcesGroupIds,
        contactIds: fromSourcesContactIds,
      })
      toast.success(
        `Added ${out.inserted ?? 0}${out.skipped ? `, skipped ${out.skipped} (already on campaign)` : ''}`,
      )
      setFromSourcesGroupIds([])
      setFromSourcesContactIds([])
      const d = await getCampaign(selectedCampId)
      setCampDetail(d)
      refreshAll()
      setAnalyticsRev((x) => x + 1)
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Failed')
    }
  }

  const draftCampaign = campDetail?.campaign?.status === 'draft'
  const audiencePickerDisabled = !write || !draftCampaign

  function selectAllCampContactsPage() {
    const ids = campContactsLib.items.map((c) => sid(c._id))
    setFromSourcesContactIds((prev) => {
      const next = new Set(prev.map(sid))
      ids.forEach((id) => next.add(id))
      return [...next]
    })
  }

  function clearCampContactsPageSelection() {
    const drop = new Set(campContactsLib.items.map((c) => sid(c._id)))
    setFromSourcesContactIds((prev) => prev.filter((id) => !drop.has(sid(id))))
  }

  function selectAllCampGroupsPage() {
    const ids = campGroupsLib.items.map((g) => sid(g._id))
    setFromSourcesGroupIds((prev) => {
      const next = new Set(prev.map(sid))
      ids.forEach((id) => next.add(id))
      return [...next]
    })
  }

  function clearCampGroupsPageSelection() {
    const drop = new Set(campGroupsLib.items.map((g) => sid(g._id)))
    setFromSourcesGroupIds((prev) => prev.filter((id) => !drop.has(sid(id))))
  }

  const navActive = NAV.find((n) => n.id === tab)

  return (
    <div
      className="es-app es-shell"
      style={{
        margin: '-16px -20px',
        minHeight: 'calc(var(--app-vh, 100vh) - 52px)',
        display: 'flex',
      }}
    >
      <aside className="es-sidebar">
        <div className="es-brand">
          <div className="es-brand-mark">
            <span className="es-brand-icon" aria-hidden>
              ES
            </span>
            <div>
              <div className="es-brand-title">Email Simulation</div>
              <div className="es-brand-sub">Phishing console</div>
            </div>
          </div>
        </div>

        <nav className="es-nav">
          {NAV.map((item) => {
            const active = tab === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`es-nav-btn${active ? ' es-nav-active' : ''}`}
              >
                <span className="es-nav-icon" aria-hidden>
                  {item.icon}
                </span>
                <span className="es-nav-label">{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="es-sidebar-foot">Security awareness</div>
      </aside>

      <div className="es-main">
        <header className="es-topbar">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <h1 className="es-page-title">{navActive?.label}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" className="es-btn-ghost" onClick={() => refreshAll()} disabled={loading}>
                ↻ Refresh
              </button>
            </div>
          </div>

          {!write && (
            <EsAlert tone="warn">
              <strong>Read-only access.</strong> Contact an administrator to make changes.
            </EsAlert>
          )}

          {meta?.trackingOriginWarning && (
            <EsAlert tone="warn">
              <strong>Tracking not configured.</strong> Set <code>EMAIL_SIM_PUBLIC_ORIGIN</code> to your production HTTPS URL.
            </EsAlert>
          )}
        </header>

        <div className="es-content">
          {loading ? (
            <p style={{ color: 'var(--text3)', fontSize: 14 }}>Loading…</p>
          ) : (
            <>
              {tab === 'dash' && stats && (
                <>
                  <EsSectionTitle>Overview</EsSectionTitle>
                  <div
                    key={`es-stats-${stats.campaigns}-${stats.recipients}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                      gap: 16,
                      marginBottom: 28,
                    }}
                  >
                    <GpStat icon="◇" label="Campaigns" value={stats.campaigns} tint="blue" />
                    <GpStat icon="✉" label="Recipients" value={stats.recipients} tint="slate" />
                    <GpStat icon="✓" label="Sent" value={stats.recipientStatus?.sent} tint="green" />
                    <GpStat icon="◇" label="Pending" value={stats.recipientStatus?.pending} tint="amber" />
                    <GpStat icon="◎" label="Opens" value={stats.events?.opened ?? 0} tint="teal" />
                    <GpStat icon="↗" label="Clicks" value={stats.events?.clicked ?? 0} tint="purple" />
                    <GpStat icon="⌂" label="Landings" value={stats.events?.landing_view ?? 0} tint="blue" />
                    <GpStat icon="✎" label="Captured" value={stats.events?.submitted ?? 0} tint="green" />
                  </div>

                  <GpPanel
                    title="Campaign funnel"
                    actions={
                      <label style={{ ...gpSelectLabel, margin: 0 }}>
                        <span style={{ display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 600, color: 'var(--text3)' }}>
                          Campaign
                        </span>
                        <select
                          value={dashCampaignId}
                          onChange={(e) => setDashCampaignId(e.target.value)}
                          style={{ ...gpSelect, minWidth: 240, marginTop: 0 }}
                        >
                          <option value="">Select campaign…</option>
                          {allCampaignsSorted.map((c) => (
                            <option key={c._id} value={c._id}>
                              {c.name} · {c.status}
                            </option>
                          ))}
                        </select>
                      </label>
                    }
                  >
                    {!dashCampaignId ? (
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)' }}>
                        Select a campaign to view engagement metrics.
                      </p>
                    ) : analyticsLoading ? (
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)' }}>Loading…</p>
                    ) : !campaignAnalytics ? (
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)' }}>Could not load analytics.</p>
                    ) : (
                      <>
                        <EsKpiRow
                          items={[
                            { label: 'Targets', value: campaignAnalytics.totals.total },
                            { label: 'Sent', value: campaignAnalytics.totals.sent },
                            { label: 'Failed', value: campaignAnalytics.totals.failed },
                            { label: 'Pending', value: campaignAnalytics.totals.pending },
                          ]}
                        />
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                            gap: 14,
                          }}
                        >
                          <GpDonutCard
                            title="Sent"
                            stage="sent"
                            pct={campaignAnalytics.rates.sentPctOfTargets}
                            sub={`${campaignAnalytics.totals.sent} / ${campaignAnalytics.totals.total}`}
                            chartColors={chartColors}
                            donutOpts={donutOpts}
                          />
                          <GpDonutCard
                            title="Opened"
                            stage="opened"
                            pct={campaignAnalytics.rates.openedPctOfSent}
                            sub={`${campaignAnalytics.funnel.opened} recipient${campaignAnalytics.funnel.opened === 1 ? '' : 's'}`}
                            chartColors={chartColors}
                            donutOpts={donutOpts}
                          />
                          <GpDonutCard
                            title="Clicked"
                            stage="clicked"
                            pct={campaignAnalytics.rates.clickedPctOfSent}
                            sub={`${campaignAnalytics.funnel.clicked} recipient${campaignAnalytics.funnel.clicked === 1 ? '' : 's'}`}
                            chartColors={chartColors}
                            donutOpts={donutOpts}
                          />
                          <GpDonutCard
                            title="Submitted"
                            stage="submitted"
                            pct={campaignAnalytics.rates.submittedPctOfSent}
                            sub={`${campaignAnalytics.funnel.submitted} recipient${campaignAnalytics.funnel.submitted === 1 ? '' : 's'}`}
                            chartColors={chartColors}
                            donutOpts={donutOpts}
                          />
                        </div>
                      </>
                    )}
                  </GpPanel>

                  <GpPanel title="Recent campaigns">
                    <GpTable>
                      <thead>
                        <tr style={{ background: 'color-mix(in srgb, var(--bg4) 70%, transparent)' }}>
                          <GpTh>Name</GpTh>
                          <GpTh>Status</GpTh>
                          <GpTh>Updated</GpTh>
                          <GpTh style={{ width: 200 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {campaigns.length === 0 ? (
                          <tr>
                            <td colSpan={4} style={{ padding: '18px 14px', color: 'var(--text3)', fontSize: 13 }}>
                              No campaigns yet — switch to <strong>Campaigns</strong> to create one.
                            </td>
                          </tr>
                        ) : (
                          [...campaigns]
                            .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
                            .slice(0, 12)
                            .map((c) => (
                              <tr key={c._id} style={{ borderTop: '1px solid var(--border)' }}>
                                <GpTd style={{ fontWeight: 600 }}>{c.name}</GpTd>
                                <GpTd>
                                  <StatusBadge status={c.status} />
                                </GpTd>
                                <GpTd style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text3)' }}>
                                  {c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '—'}
                                </GpTd>
                                <GpTd style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                                  <button
                                    type="button"
                                    style={gpLinkBtn}
                                    onClick={() => {
                                      setDashCampaignId(c._id)
                                      setSelectedCampId(c._id)
                                      setTab('camp')
                                    }}
                                  >
                                    Manage
                                  </button>
                                  {write ? (
                                    <button
                                      type="button"
                                      style={{ ...gpLinkBtn, color: '#c62828' }}
                                      onClick={async () => {
                                        if (!confirm(`Delete "${c.name}" and all targets? This cannot be undone.`)) return
                                        try {
                                          await deleteCampaignAndRefresh(c._id)
                                          toast.success('Campaign deleted')
                                          if (sid(selectedCampId) === sid(c._id)) {
                                            setSelectedCampId('')
                                            setCampDetail(null)
                                          }
                                        } catch (err) {
                                          toast.error(err.response?.data?.error || 'Delete failed')
                                        }
                                      }}
                                    >
                                      Delete
                                    </button>
                                  ) : null}
                                </GpTd>
                              </tr>
                            ))
                        )}
                      </tbody>
                    </GpTable>
                  </GpPanel>
                </>
              )}

              {tab === 'smtp' && (
                <>
                  <GpPanel
                    title={smtpEditingId ? 'Edit sending profile' : 'New sending profile'}
                    actions={
                      write ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          {smtpEditingId ? (
                            <GpSecondaryButton type="button" onClick={cancelSmtpEdit}>
                              Cancel edit
                            </GpSecondaryButton>
                          ) : null}
                          <GpPrimaryButton type="submit" form="form-smtp">
                            {smtpEditingId ? 'Update profile' : 'Save profile'}
                          </GpPrimaryButton>
                        </span>
                      ) : null
                    }
                  >
                    <form id="form-smtp" onSubmit={onSaveSmtp}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
                        <GpField label="Profile name" value={smtpForm.name} onChange={(v) => setSmtpForm((f) => ({ ...f, name: v }))} disabled={!write} />
                        <GpField label="SMTP host" value={smtpForm.host} onChange={(v) => setSmtpForm((f) => ({ ...f, host: v }))} disabled={!write} />
                        <GpField label="Port" value={String(smtpForm.port)} onChange={(v) => setSmtpForm((f) => ({ ...f, port: Number(v) || 587 }))} disabled={!write} />
                        <label style={gpCheckbox}>
                          <input
                            type="checkbox"
                            checked={smtpForm.secure}
                            onChange={(e) => setSmtpForm((f) => ({ ...f, secure: e.target.checked }))}
                            disabled={!write}
                          />
                          TLS / SSL (implicit)
                        </label>
                        <GpField label="Username" value={smtpForm.username} onChange={(v) => setSmtpForm((f) => ({ ...f, username: v }))} disabled={!write} />
                        <GpField
                          label="Password"
                          value={smtpForm.password}
                          onChange={(v) => setSmtpForm((f) => ({ ...f, password: v }))}
                          disabled={!write}
                          password
                          placeholder={smtpEditingId ? 'Leave blank to keep current' : undefined}
                        />
                        <GpField label="From address" value={smtpForm.fromEmail} onChange={(v) => setSmtpForm((f) => ({ ...f, fromEmail: v }))} disabled={!write} />
                        <GpField label="From name" value={smtpForm.fromName} onChange={(v) => setSmtpForm((f) => ({ ...f, fromName: v }))} disabled={!write} />
                      </div>
                    </form>
                  </GpPanel>

                  <GpPanel title="Configured profiles">
                    <GpTable>
                      <thead>
                        <tr style={{ background: 'color-mix(in srgb, var(--bg4) 70%, transparent)' }}>
                          <GpTh>Name</GpTh>
                          <GpTh>Host</GpTh>
                          <GpTh>From</GpTh>
                          <GpTh style={{ width: 160 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {profiles.length === 0 ? (
                          <tr>
                            <td colSpan={4} style={{ padding: 18, color: 'var(--text3)', fontSize: 13 }}>
                              No sending profiles yet.
                            </td>
                          </tr>
                        ) : (
                          profiles.map((p) => (
                            <tr key={p._id} style={{ borderTop: '1px solid var(--border)' }}>
                              <GpTd style={{ fontWeight: 600 }}>{p.name}</GpTd>
                              <GpTd style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                                {p.host}:{p.port}
                              </GpTd>
                              <GpTd style={{ fontSize: 13 }}>{p.fromEmail}</GpTd>
                              <GpTd>
                                {write && (
                                  <>
                                    <button type="button" style={gpLinkBtn} onClick={() => startEditSmtpProfile(p)}>
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      style={{ ...gpLinkBtn, color: '#c62828', marginLeft: 10 }}
                                      onClick={async () => {
                                        if (!confirm('Delete this sending profile?')) return
                                        if (smtpEditingId === p._id) cancelSmtpEdit()
                                        await deleteSmtpProfile(p._id)
                                        toast.success('Deleted')
                                        refreshAll()
                                      }}
                                    >
                                      Delete
                                    </button>
                                  </>
                                )}
                              </GpTd>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </GpTable>
                  </GpPanel>
                </>
              )}

              {tab === 'tpl' && (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'center' }}>
                    {write ? (
                      <GpPrimaryButton type="button" onClick={openTplCreateModal}>
                        + New template
                      </GpPrimaryButton>
                    ) : null}
                    <GpSecondaryButton
                      disabled={!write}
                      onClick={async () => {
                        await seedIndustryTemplates()
                        toast.success('Default templates imported')
                        refreshAll()
                      }}
                    >
                      Import default pack
                    </GpSecondaryButton>
                    <GpSecondaryButton
                      disabled={!write}
                      onClick={async () => {
                        await seedWorkplaceTemplates()
                        toast.success('Portal templates imported')
                        refreshAll()
                      }}
                    >
                      Import portal pack
                    </GpSecondaryButton>
                  </div>

                  <GpPanel title="Templates">
                    <GpTable>
                      <thead>
                        <tr style={{ background: 'color-mix(in srgb, var(--bg4) 70%, transparent)' }}>
                          <GpTh>Name</GpTh>
                          <GpTh>Subject</GpTh>
                          <GpTh>Category</GpTh>
                          <GpTh style={{ width: 160 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {templates.length === 0 ? (
                          <tr>
                            <td colSpan={4} style={{ padding: 18, color: 'var(--text3)', fontSize: 13 }}>
                              No templates — import a pack or use <strong>New template</strong>.
                            </td>
                          </tr>
                        ) : (
                          templates.map((t) => (
                            <tr key={t._id} style={{ borderTop: '1px solid var(--border)' }}>
                              <GpTd style={{ fontWeight: 600 }}>{t.name}</GpTd>
                              <GpTd style={{ fontSize: 13 }}>{t.subject}</GpTd>
                              <GpTd style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text3)' }}>{t.category || 'custom'}</GpTd>
                              <GpTd>
                                {write && (
                                  <>
                                    <button type="button" style={gpLinkBtn} onClick={() => openTplEditModal(t)}>
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      style={{ ...gpLinkBtn, color: '#c62828', marginLeft: 10 }}
                                      onClick={async () => {
                                        if (!confirm('Delete this template?')) return
                                        try {
                                          await deleteTemplate(t._id)
                                          toast.success('Deleted')
                                          refreshAll()
                                        } catch (err) {
                                          toast.error(err.response?.data?.error || 'Delete failed')
                                        }
                                      }}
                                    >
                                      Delete
                                    </button>
                                  </>
                                )}
                              </GpTd>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </GpTable>
                  </GpPanel>
                </>
              )}

              {tab === 'camp' && (
                <>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 16,
                      flexWrap: 'wrap',
                      marginBottom: 18,
                    }}
                  >
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>Campaigns</h2>
                    {write ? (
                      <GpPrimaryButton type="button" onClick={() => setCampModalOpen(true)}>
                        + New campaign
                      </GpPrimaryButton>
                    ) : null}
                  </div>

                  <GpPanel title="All campaigns">
                    <GpTable>
                      <thead>
                        <tr style={{ background: 'color-mix(in srgb, var(--bg4) 70%, transparent)' }}>
                          <GpTh>Name</GpTh>
                          <GpTh>Status</GpTh>
                          <GpTh>Modified</GpTh>
                          <GpTh style={{ width: 200 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {!allCampaignsSorted.length ? (
                          <tr>
                            <td colSpan={4} style={{ padding: 22, color: 'var(--text3)', fontSize: 13 }}>
                              No campaigns yet — create one with <strong>New campaign</strong>.
                            </td>
                          </tr>
                        ) : (
                          allCampaignsSorted.map((c) => (
                            <tr
                              key={c._id}
                              style={{
                                borderTop: '1px solid var(--border)',
                                background:
                                  sid(selectedCampId) === sid(c._id)
                                    ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
                                    : undefined,
                                transition: 'background 0.12s ease',
                              }}
                            >
                              <GpTd style={{ fontWeight: 650 }}>{c.name}</GpTd>
                              <GpTd>
                                <StatusBadge status={c.status} />
                              </GpTd>
                              <GpTd style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text3)' }}>
                                {c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '—'}
                              </GpTd>
                              <GpTd style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                                <button
                                  type="button"
                                  style={gpLinkBtn}
                                  onClick={() => {
                                    setSelectedCampId(c._id)
                                    setDashCampaignId(c._id)
                                    setResultsCampId(c._id)
                                  }}
                                >
                                  {sid(selectedCampId) === sid(c._id) ? 'Working' : 'Open'}
                                </button>
                                {write ? (
                                  <button
                                    type="button"
                                    style={{ ...gpLinkBtn, color: '#c62828' }}
                                    onClick={async () => {
                                      if (!confirm(`Delete "${c.name}" and all targets? This cannot be undone.`)) return
                                      try {
                                        await deleteCampaignAndRefresh(c._id)
                                        toast.success('Campaign deleted')
                                        if (sid(selectedCampId) === sid(c._id)) {
                                          setSelectedCampId('')
                                          setCampDetail(null)
                                        }
                                      } catch (err) {
                                        toast.error(err.response?.data?.error || 'Delete failed')
                                      }
                                    }}
                                  >
                                    Delete
                                  </button>
                                ) : null}
                              </GpTd>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </GpTable>
                  </GpPanel>

                  <GpPanel
                    title="Campaign workspace"
                  >
                    {!selectedCampId ? (
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)' }}>Select a campaign from the list above.</p>
                    ) : (
                      <CampWorkspacePanel
                        campDetail={campDetail}
                        write={write}
                        draftCampaign={draftCampaign}
                        audiencePickerDisabled={audiencePickerDisabled}
                        campWorkspaceUrls={campWorkspaceUrls}
                        setCampWorkspaceUrls={setCampWorkspaceUrls}
                        onSaveCampaignUrls={onSaveCampaignUrls}
                        injectMode={injectMode}
                        setInjectMode={setInjectMode}
                        injectCsv={injectCsv}
                        setInjectCsv={setInjectCsv}
                        injectJson={injectJson}
                        setInjectJson={setInjectJson}
                        onInject={onInject}
                        CsvFileUpload={CsvFileUpload}
                        fromSourcesGroupIds={fromSourcesGroupIds}
                        setFromSourcesGroupIds={setFromSourcesGroupIds}
                        fromSourcesContactIds={fromSourcesContactIds}
                        setFromSourcesContactIds={setFromSourcesContactIds}
                        campGroupSearchIn={campGroupSearchIn}
                        setCampGroupSearchIn={setCampGroupSearchIn}
                        campContactSearchIn={campContactSearchIn}
                        setCampContactSearchIn={setCampContactSearchIn}
                        campGroupsLib={campGroupsLib}
                        campContactsLib={campContactsLib}
                        campGroupPage={campGroupPage}
                        setCampGroupPage={setCampGroupPage}
                        campContactPage={campContactPage}
                        setCampContactPage={setCampContactPage}
                        campGroupSearchQ={campGroupSearchQ}
                        campContactSearchQ={campContactSearchQ}
                        campGroupPageSize={CAMP_GROUP_PAGE_SIZE}
                        campContactPageSize={CAMP_CONTACT_PAGE_SIZE}
                        selectAllCampGroupsPage={selectAllCampGroupsPage}
                        clearCampGroupsPageSelection={clearCampGroupsPageSelection}
                        selectAllCampContactsPage={selectAllCampContactsPage}
                        clearCampContactsPageSelection={clearCampContactsPageSelection}
                        onAddFromSources={onAddFromSources}
                        recipientBulk={recipientBulk}
                        setRecipientBulk={setRecipientBulk}
                        onAddRecipients={onAddRecipients}
                        onLaunch={onLaunch}
                        onDeleteCampaign={async () => {
                          if (!confirm('Delete this campaign and all targets? This cannot be undone.')) return
                          try {
                            const id = selectedCampId
                            await deleteCampaignAndRefresh(id)
                            toast.success('Campaign deleted')
                            setSelectedCampId('')
                            setCampDetail(null)
                          } catch (err) {
                            toast.error(err.response?.data?.error || 'Delete failed')
                          }
                        }}
                        toggleStringId={toggleStringId}
                        sid={sid}
                      />
                    )}
                  </GpPanel>
                </>
              )}

              {tab === 'results' && (
                <>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'flex-end',
                      justifyContent: 'space-between',
                      gap: 14,
                      marginBottom: 18,
                      padding: '16px 18px',
                      borderRadius: 10,
                      border: '1px solid color-mix(in srgb, var(--border) 85%, transparent)',
                      background: 'var(--bg2)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
                    }}
                  >
                    <label style={{ ...gpSelectLabel, margin: 0, flex: '1 1 260px' }}>
                      <span
                        style={{
                          display: 'block',
                          marginBottom: 8,
                          fontSize: 11,
                          letterSpacing: '0.07em',
                          textTransform: 'uppercase',
                          color: 'var(--text3)',
                          fontWeight: 700,
                        }}
                      >
                        Campaign
                      </span>
                      <select
                        value={resultsCampId}
                        onChange={(e) => setResultsCampId(e.target.value)}
                        style={{ ...gpSelect, minWidth: 280, width: '100%' }}
                      >
                        <option value="">Select campaign…</option>
                        {allCampaignsSorted.map((c) => (
                          <option key={c._id} value={c._id}>
                            {c.name} · {c.status}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      <GpSecondaryButton
                        type="button"
                        disabled={!resultsRecipientsDetail?.recipients?.length}
                        onClick={() => {
                          downloadCampaignResultsCsv(resultsRecipientsDetail)
                          toast.success('CSV downloaded')
                        }}
                      >
                        Export CSV
                      </GpSecondaryButton>
                      <GpSecondaryButton
                        type="button"
                        disabled={resultsLoading || !resultsCampId}
                        onClick={() => setAnalyticsRev((x) => x + 1)}
                      >
                        Reload data
                      </GpSecondaryButton>
                    </div>
                  </div>

                  {!resultsCampId ? (
                    <GpPanel title="Results">
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)', lineHeight: 1.55 }}>
                        {campaigns.length === 0
                          ? 'No campaigns yet — create one under Campaigns.'
                          : 'Choose a campaign from the list above.'}
                      </p>
                    </GpPanel>
                  ) : resultsLoading ? (
                    <GpPanel title="Results">
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)' }}>Loading…</p>
                    </GpPanel>
                  ) : !resultsAnalytics ? (
                    <GpPanel title="Results">
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)' }}>Retry with Reload data.</p>
                    </GpPanel>
                  ) : (
                    <>
                      <GpPanel
                        title={resultsAnalytics.campaign?.name || 'Campaign'}
                        actions={<StatusBadge status={resultsAnalytics.campaign?.status} />}
                      >
                        {resultsAnalytics.campaign?.launchedAt && (
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)', marginBottom: 14 }}>
                            Launch {new Date(resultsAnalytics.campaign.launchedAt).toLocaleString()}
                          </div>
                        )}

                        <div style={{ marginBottom: 22 }}>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: 'var(--text3)',
                              marginBottom: 10,
                              letterSpacing: '0.08em',
                              textTransform: 'uppercase',
                            }}
                          >
                            Engagement over time
                          </div>
                          <div
                            style={{
                              height: 268,
                              background: 'var(--bg3)',
                              borderRadius: 8,
                              padding: 12,
                              border: '1px solid var(--border)',
                            }}
                          >
                            {resultsLineData ? (
                              <Line data={resultsLineData} options={overviewLineOptions} />
                            ) : (
                              <div style={{ padding: 28, color: 'var(--text3)', fontSize: 13, lineHeight: 1.55 }}>
                                No engagement data yet.
                              </div>
                            )}
                          </div>
                        </div>

                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                            gap: 16,
                          }}
                        >
                          <GpDonutCard
                            title="Sent / targets"
                            stage="sent"
                            pct={resultsAnalytics.rates.sentPctOfTargets}
                            sub={`${resultsAnalytics.totals.sent} / ${resultsAnalytics.totals.total}`}
                            chartColors={chartColors}
                            donutOpts={donutOpts}
                          />
                          <GpDonutCard
                            title="Opened"
                            stage="opened"
                            pct={resultsAnalytics.rates.openedPctOfSent}
                            sub={`${resultsAnalytics.funnel.opened} uniq`}
                            chartColors={chartColors}
                            donutOpts={donutOpts}
                          />
                          <GpDonutCard
                            title="Clicked"
                            stage="clicked"
                            pct={resultsAnalytics.rates.clickedPctOfSent}
                            sub={`${resultsAnalytics.funnel.clicked} uniq`}
                            chartColors={chartColors}
                            donutOpts={donutOpts}
                          />
                          <GpDonutCard
                            title="Landing"
                            stage="landing"
                            pct={resultsAnalytics.rates.landingPctOfSent}
                            sub={`${resultsAnalytics.funnel.landing_view} uniq`}
                            chartColors={chartColors}
                            donutOpts={donutOpts}
                          />
                          <GpDonutCard
                            title="Submitted"
                            stage="submitted"
                            pct={resultsAnalytics.rates.submittedPctOfSent}
                            sub={`${resultsAnalytics.funnel.submitted} uniq`}
                            chartColors={chartColors}
                            donutOpts={donutOpts}
                          />
                        </div>
                      </GpPanel>

                      <GpPanel title="Recipients">
                        <GpTable>
                          <thead>
                            <tr style={{ background: 'color-mix(in srgb, var(--bg4) 70%, transparent)' }}>
                              <GpTh>Email</GpTh>
                              <GpTh>Delivery</GpTh>
                              <GpTh>Open</GpTh>
                              <GpTh>Click</GpTh>
                              <GpTh>Capture</GpTh>
                              <GpTh>Sequence</GpTh>
                            </tr>
                          </thead>
                          <tbody>
                            {!(resultsRecipientsDetail?.recipients || []).length ? (
                              <tr>
                                <td colSpan={6} style={{ padding: 18, color: 'var(--text3)', fontSize: 13 }}>
                                  No targets recorded on this campaign.
                                </td>
                              </tr>
                            ) : (
                              resultsRecipientsDetail.recipients.map((r) => {
                                const ev = r.events || []
                                const has = (t) => ev.some((e) => e.type === t)
                                return (
                                  <tr key={r._id} style={{ borderTop: '1px solid var(--border)' }}>
                                    <GpTd style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.email}</GpTd>
                                    <GpTd style={{ textTransform: 'capitalize', fontSize: 12 }}>{r.status}</GpTd>
                                    <GpTd style={{ fontSize: 12, color: has('opened') ? ES_ACCENT : 'var(--text3)', fontWeight: 600 }}>
                                      {has('opened') ? '●' : '—'}
                                    </GpTd>
                                    <GpTd style={{ fontSize: 12, color: has('clicked') ? ES_ACCENT : 'var(--text3)', fontWeight: 600 }}>
                                      {has('clicked') ? '●' : '—'}
                                    </GpTd>
                                    <GpTd style={{ fontSize: 12, color: has('submitted') ? '#ef5350' : 'var(--text3)', fontWeight: 600 }}>
                                      {has('submitted') ? '●' : '—'}
                                    </GpTd>
                                    <GpTd style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                                      {(ev.map((e) => e.type).join(' → ') || '—').slice(0, 120)}
                                    </GpTd>
                                  </tr>
                                )
                              })
                            )}
                          </tbody>
                        </GpTable>
                      </GpPanel>
                    </>
                  )}
                </>
              )}

              {tab === 'audience' && (
                <>
                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      padding: 4,
                      marginBottom: 18,
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--bg2)',
                      width: 'fit-content',
                    }}
                  >
                    {[
                      { id: 'groups', label: 'Groups' },
                      { id: 'contacts', label: 'Saved contacts' },
                    ].map((opt) => {
                      const active = audienceView === opt.id
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setAudienceView(opt.id)}
                          style={{
                            padding: '8px 14px',
                            fontSize: 13,
                            fontWeight: 700,
                            borderRadius: 4,
                            border: 'none',
                            cursor: 'pointer',
                            background: active ? 'var(--accent)' : 'transparent',
                            color: active ? '#fff' : 'var(--text2)',
                            transition: 'background 0.12s ease',
                          }}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}

              {tab === 'audience' && audienceView === 'contacts' && (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 18 }}>
                    {write && (
                      <GpPrimaryButton type="button" onClick={openCreateContactModal}>
                        + Add contact
                      </GpPrimaryButton>
                    )}
                  </div>

                  <GpPanel
                    title="Import contacts"
                    actions={
                      write ? (
                        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                          <CsvFileUpload
                            disabled={!write}
                            onLoad={(text) => setContactCsv(text)}
                            label="Upload CSV file"
                          />
                          <GpSecondaryButton type="submit" form="form-es-contact-csv">
                            Import CSV
                          </GpSecondaryButton>
                        </span>
                      ) : null
                    }
                  >
                    <form id="form-es-contact-csv" onSubmit={onImportContactsCsvSubmit}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 10 }}>
                        <label style={{ ...gpSelectLabel, margin: 0, minWidth: 240 }}>
                          Also add to group (optional)
                          <select
                            value={contactImportGroupId}
                            onChange={(e) => setContactImportGroupId(e.target.value)}
                            disabled={!write}
                            style={{ ...gpSelect, minWidth: 240 }}
                          >
                            <option value="">— Library only —</option>
                            {groupsLib.items.map((g) => (
                              <option key={sid(g._id)} value={sid(g._id)}>
                                {g.name} ({g.memberCount ?? 0})
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <textarea
                        value={contactCsv}
                        disabled={!write}
                        onChange={(e) => setContactCsv(e.target.value)}
                        rows={8}
                        style={gpTextArea}
                      />
                    </form>
                  </GpPanel>

                  <GpPanel
                    title="All saved contacts"
                    
                  >
                    <input
                      type="search"
                      value={usersSearchIn}
                      onChange={(e) => setUsersSearchIn(e.target.value)}
                      placeholder="Filter by email…"
                      autoComplete="off"
                      style={{ ...gpSelect, width: '100%', maxWidth: 440, marginBottom: 12 }}
                    />
                    {usersLib.loading ? (
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)' }}>Loading contacts…</p>
                    ) : (
                      <>
                        <GpTable>
                          <thead>
                            <tr style={{ background: 'color-mix(in srgb, var(--bg4) 70%, transparent)' }}>
                              <GpTh style={{ width: 44 }} aria-label="Avatar" />
                              <GpTh>Email</GpTh>
                              <GpTh style={{ width: 140 }}>First name</GpTh>
                              <GpTh style={{ width: 140 }}>Last name</GpTh>
                              <GpTh>Groups</GpTh>
                              <GpTh>Other fields</GpTh>
                              <GpTh style={{ width: 130 }} />
                            </tr>
                          </thead>
                          <tbody>
                            {!usersLib.items.length ? (
                              <tr>
                                <td colSpan={7} style={{ padding: 0 }}>
                                  <div style={{ padding: '36px 18px', textAlign: 'center', color: 'var(--text3)' }}>
                                    <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.5 }}>◎</div>
                                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)' }}>
                                      {usersSearchQ ? `No contacts match “${usersSearchQ}”.` : 'No saved contacts yet'}
                                    </div>
                                    <div style={{ fontSize: 12, marginTop: 6, marginBottom: 14 }}>
                                      {usersSearchQ ? 'Adjust your filter, or add a new contact.' : 'Add a contact or import a CSV — they appear here and in groups.'}
                                    </div>
                                    {write && !usersSearchQ && (
                                      <GpPrimaryButton type="button" onClick={openCreateContactModal}>
                                        + Add contact
                                      </GpPrimaryButton>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ) : (
                              usersLib.items.map((c) => {
                                const split = splitContactMergeVars(c.mergeVars)
                                const otherKeys = Object.keys(split.other)
                                const groupChips = Array.isArray(c.groups) ? c.groups : []
                                return (
                                  <tr key={sid(c._id)} style={{ borderTop: '1px solid var(--border)' }}>
                                    <GpTd>
                                      <GsAvatar email={c.email} firstName={split.firstName} lastName={split.lastName} />
                                    </GpTd>
                                    <GpTd style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{c.email}</GpTd>
                                    <GpTd style={{ fontSize: 13 }}>{split.firstName || <span style={{ color: 'var(--text3)' }}>—</span>}</GpTd>
                                    <GpTd style={{ fontSize: 13 }}>{split.lastName || <span style={{ color: 'var(--text3)' }}>—</span>}</GpTd>
                                    <GpTd>
                                      {groupChips.length ? (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                          {groupChips.slice(0, 4).map((g) => (
                                            <GsChip key={sid(g._id)} label={g.name} tone="green" />
                                          ))}
                                          {groupChips.length > 4 && (
                                            <GsChip label={`+${groupChips.length - 4} more`} />
                                          )}
                                        </div>
                                      ) : (
                                        <span style={{ fontSize: 12, color: 'var(--text3)' }}>—</span>
                                      )}
                                    </GpTd>
                                    <GpTd style={{ fontSize: 12, color: 'var(--text3)', wordBreak: 'break-word', maxWidth: 240 }}>
                                      {otherKeys.length ? JSON.stringify(split.other) : <span>—</span>}
                                    </GpTd>
                                    <GpTd>
                                      {write && (
                                        <span style={{ display: 'inline-flex', gap: 10 }}>
                                          <button type="button" style={gpLinkBtn} onClick={() => openEditContactModal(c)}>
                                            Edit
                                          </button>
                                          <button
                                            type="button"
                                            style={{ ...gpLinkBtn, color: '#c62828' }}
                                            onClick={async () => {
                                              if (!confirm('Remove this saved contact?')) return
                                              try {
                                                await deleteContact(c._id)
                                                toast.success('Removed')
                                                refreshAll()
                                              } catch (err) {
                                                toast.error(err.response?.data?.error || 'Delete failed')
                                              }
                                            }}
                                          >
                                            Delete
                                          </button>
                                        </span>
                                      )}
                                    </GpTd>
                                  </tr>
                                )
                              })
                            )}
                          </tbody>
                        </GpTable>
                        <LibPaginationControls
                          page={usersPage}
                          pageSize={USERS_PAGE_SIZE}
                          total={usersLib.total}
                          disabled={usersLib.loading}
                          onPrev={() => setUsersPage((p) => Math.max(1, p - 1))}
                          onNext={() => setUsersPage((p) => p + 1)}
                        />
                      </>
                    )}
                  </GpPanel>
                </>
              )}

              {tab === 'audience' && audienceView === 'groups' && (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 18 }}>
                    {write && (
                      <GpPrimaryButton type="button" onClick={openCreateGroupModal}>
                        + New group
                      </GpPrimaryButton>
                    )}
                  </div>

                  <GpPanel
                    title="Your groups"
                    
                  >
                    <input
                      type="search"
                      value={groupsSearchIn}
                      onChange={(e) => setGroupsSearchIn(e.target.value)}
                      placeholder="Search group names…"
                      autoComplete="off"
                      style={{ ...gpSelect, width: '100%', maxWidth: 440, marginBottom: 12 }}
                    />
                    {groupsLib.loading ? (
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)' }}>Loading groups…</p>
                    ) : (
                      <>
                        <GpTable>
                          <thead>
                            <tr style={{ background: 'color-mix(in srgb, var(--bg4) 70%, transparent)' }}>
                              <GpTh>Name</GpTh>
                              <GpTh>Description</GpTh>
                              <GpTh style={{ width: 110 }}>Members</GpTh>
                              <GpTh style={{ width: 260 }} />
                            </tr>
                          </thead>
                          <tbody>
                            {!groupsLib.items.length ? (
                              <tr>
                                <td colSpan={4} style={{ padding: 0 }}>
                                  <div style={{ padding: '36px 18px', textAlign: 'center', color: 'var(--text3)' }}>
                                    <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.5 }}>▦</div>
                                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)' }}>
                                      {groupsSearchQ ? `No groups match “${groupsSearchQ}”.` : 'No groups yet'}
                                    </div>
                                    <div style={{ fontSize: 12, marginTop: 6, marginBottom: 14 }}>
                                      {groupsSearchQ ? 'Adjust your filter, or create a new group.' : 'Create a group to organize recipients. Members can be added via CSV.'}
                                    </div>
                                    {write && !groupsSearchQ && (
                                      <GpPrimaryButton type="button" onClick={openCreateGroupModal}>
                                        + New group
                                      </GpPrimaryButton>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ) : (
                              groupsLib.items.map((g) => (
                                <tr
                                  key={sid(g._id)}
                                  style={{
                                    borderTop: '1px solid var(--border)',
                                    background:
                                      sid(selectedLibraryGroupId) === sid(g._id)
                                        ? 'color-mix(in srgb, var(--accent) 8%, transparent)'
                                        : undefined,
                                  }}
                                >
                                  <GpTd style={{ fontWeight: 600 }}>{g.name}</GpTd>
                                  <GpTd style={{ fontSize: 12, color: 'var(--text3)', maxWidth: 380 }}>
                                    {g.description ? g.description : <span>—</span>}
                                  </GpTd>
                                  <GpTd>
                                    <GsChip label={`${g.memberCount ?? 0} members`} tone="green" />
                                  </GpTd>
                                  <GpTd>
                                    <span style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap' }}>
                                      <button
                                        type="button"
                                        style={gpLinkBtn}
                                        onClick={() =>
                                          setSelectedLibraryGroupId(sid(selectedLibraryGroupId) === sid(g._id) ? '' : sid(g._id))
                                        }
                                      >
                                        {sid(selectedLibraryGroupId) === sid(g._id) ? 'Hide members' : 'Manage members'}
                                      </button>
                                      {write && (
                                        <>
                                          <button type="button" style={gpLinkBtn} onClick={() => openEditGroupModal(g)}>
                                            Edit
                                          </button>
                                          <button
                                            type="button"
                                            style={{ ...gpLinkBtn, color: '#c62828' }}
                                            onClick={async () => {
                                              if (!confirm('Delete this group and all its members?')) return
                                              try {
                                                await deleteGroup(g._id)
                                                toast.success('Group deleted')
                                                if (sid(selectedLibraryGroupId) === sid(g._id)) setSelectedLibraryGroupId('')
                                                refreshAll()
                                              } catch (err) {
                                                toast.error(err.response?.data?.error || 'Delete failed')
                                              }
                                            }}
                                          >
                                            Delete
                                          </button>
                                        </>
                                      )}
                                    </span>
                                  </GpTd>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </GpTable>
                        <LibPaginationControls
                          page={groupsPage}
                          pageSize={GROUPS_PAGE_SIZE}
                          total={groupsLib.total}
                          disabled={groupsLib.loading}
                          onPrev={() => setGroupsPage((p) => Math.max(1, p - 1))}
                          onNext={() => setGroupsPage((p) => p + 1)}
                        />
                      </>
                    )}
                  </GpPanel>

                  {selectedLibraryGroupId && groupDetail?.group && (
                    <GpPanel
                      title={`Members · ${groupDetail.group.name}`}
                      actions={
                        write ? (
                          <>
                            <GpSecondaryButton type="submit" form="form-es-member-csv">
                              Import CSV to group
                            </GpSecondaryButton>
                            <GpPrimaryButton type="submit" form="form-es-member">
                              Add member
                            </GpPrimaryButton>
                          </>
                        ) : null
                      }
                    >
                      <form id="form-es-member" onSubmit={onAddGroupMemberSubmit} style={{ marginBottom: 18 }}>
                        <div style={{ display: 'grid', gap: 14 }}>
                          <GpField
                            label="Email"
                            value={memberForm.email}
                            onChange={(v) => setMemberForm((f) => ({ ...f, email: v }))}
                            disabled={!write}
                          />
                          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>
                            Merge variables (JSON)
                            <textarea
                              value={memberForm.mergeJson}
                              disabled={!write}
                              onChange={(e) => setMemberForm((f) => ({ ...f, mergeJson: e.target.value }))}
                              rows={4}
                              style={{ ...gpTextArea, marginTop: 8 }}
                              placeholder='{ "firstName": "Jane" }'
                            />
                          </label>
                        </div>
                      </form>
                      <form id="form-es-member-csv" onSubmit={onImportMembersCsvSubmit}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>
                            CSV (email column required)
                          </span>
                          {write && (
                            <CsvFileUpload
                              disabled={!write}
                              onLoad={(text) => setMemberCsv(text)}
                              label="Upload CSV file"
                            />
                          )}
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                            Imported rows are also added to <strong>Saved contacts</strong> automatically.
                          </span>
                        </div>
                        <textarea
                          value={memberCsv}
                          disabled={!write}
                          onChange={(e) => setMemberCsv(e.target.value)}
                          rows={7}
                          style={{ ...gpTextArea }}
                        />
                      </form>

                      <div style={{ marginTop: 22 }}>
                        <GpTable>
                          <thead>
                            <tr style={{ background: 'color-mix(in srgb, var(--bg4) 70%, transparent)' }}>
                              <GpTh style={{ width: 44 }} aria-label="Avatar" />
                              <GpTh>Email</GpTh>
                              <GpTh style={{ width: 160 }}>First name</GpTh>
                              <GpTh style={{ width: 160 }}>Last name</GpTh>
                              <GpTh>Other fields</GpTh>
                              <GpTh style={{ width: 90 }} />
                            </tr>
                          </thead>
                          <tbody>
                            {!groupDetail.members?.length ? (
                              <tr>
                                <td colSpan={6} style={{ padding: 16, color: 'var(--text3)', fontSize: 13 }}>
                                  No members yet — import CSV or add one above.
                                </td>
                              </tr>
                            ) : (
                              groupDetail.members.map((m) => {
                                const split = splitContactMergeVars(m.mergeVars)
                                const otherKeys = Object.keys(split.other)
                                return (
                                  <tr key={m._id} style={{ borderTop: '1px solid var(--border)' }}>
                                    <GpTd>
                                      <GsAvatar email={m.email} firstName={split.firstName} lastName={split.lastName} />
                                    </GpTd>
                                    <GpTd style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{m.email}</GpTd>
                                    <GpTd style={{ fontSize: 13 }}>{split.firstName || <span style={{ color: 'var(--text3)' }}>—</span>}</GpTd>
                                    <GpTd style={{ fontSize: 13 }}>{split.lastName || <span style={{ color: 'var(--text3)' }}>—</span>}</GpTd>
                                    <GpTd style={{ fontSize: 12, color: 'var(--text3)', wordBreak: 'break-word', maxWidth: 320 }}>
                                      {otherKeys.length ? JSON.stringify(split.other) : <span>—</span>}
                                    </GpTd>
                                    <GpTd>
                                      {write && (
                                        <button
                                          type="button"
                                          style={{ ...gpLinkBtn, color: '#c62828' }}
                                          onClick={async () => {
                                            await deleteGroupMember(selectedLibraryGroupId, m._id)
                                            toast.success('Removed')
                                            const d = await listGroupMembers(selectedLibraryGroupId)
                                            setGroupDetail(d)
                                            refreshAll()
                                          }}
                                        >
                                          Remove
                                        </button>
                                      )}
                                    </GpTd>
                                  </tr>
                                )
                              })
                            )}
                          </tbody>
                        </GpTable>
                      </div>
                    </GpPanel>
                  )}
                </>
              )}

              {tab === 'one' && (
                <GpPanel
                  title="Test send"
                  actions={
                    write ? (
                      <GpPrimaryButton type="submit" form="form-one">
                        Send test
                      </GpPrimaryButton>
                    ) : null
                  }
                >
                  <form id="form-one" onSubmit={onSendOne}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14, marginBottom: 14 }}>
                      <label style={gpSelectLabel}>
                        Template
                        <select
                          value={oneForm.templateId}
                          disabled={!write}
                          onChange={(e) => setOneForm((f) => ({ ...f, templateId: e.target.value }))}
                          style={gpSelect}
                        >
                          <option value="">Select…</option>
                          {templates.map((t) => (
                            <option key={t._id} value={t._id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label style={gpSelectLabel}>
                        Sending profile
                        <select
                          value={oneForm.smtpProfileId}
                          disabled={!write}
                          onChange={(e) => setOneForm((f) => ({ ...f, smtpProfileId: e.target.value }))}
                          style={gpSelect}
                        >
                          <option value="">Select…</option>
                          {profiles.map((p) => (
                            <option key={p._id} value={p._id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <GpField label="Recipient email" value={oneForm.to} onChange={(v) => setOneForm((f) => ({ ...f, to: v }))} disabled={!write} />
                    </div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>
                      Merge variables (JSON)
                      <textarea
                        value={oneForm.mergeJson}
                        disabled={!write}
                        onChange={(e) => setOneForm((f) => ({ ...f, mergeJson: e.target.value }))}
                        rows={6}
                        style={{ ...gpTextArea, marginTop: 8 }}
                      />
                    </label>
                  </form>
                </GpPanel>
              )}
            </>
          )}
        </div>

        {campModalOpen && (
          <div
            role="presentation"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10050,
              background: 'rgba(5, 9, 14, 0.82)',
              backdropFilter: 'blur(5px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 22,
            }}
            onClick={() => setCampModalOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="es-modal-new-campaign-title"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 'min(560px, 100%)',
                maxHeight: 'min(90vh, 700px)',
                overflowY: 'auto',
                borderRadius: 12,
                border: '1px solid color-mix(in srgb, var(--accent) 35%, var(--border))',
                background: 'linear-gradient(175deg, var(--bg2) 0%, color-mix(in srgb, var(--bg3) 92%, transparent) 100%)',
                boxShadow: '0 28px 90px rgba(0,0,0,0.5)',
                padding: '22px 24px 22px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start', marginBottom: 18 }}>
                <div style={{ minWidth: 0 }}>
                  <div id="es-modal-new-campaign-title" style={{ fontSize: 19, fontWeight: 780, letterSpacing: '-0.03em' }}>
                    New campaign
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setCampModalOpen(false)}
                  style={{
                    flexShrink: 0,
                    border: 'none',
                    background: 'color-mix(in srgb, var(--bg4) 75%, transparent)',
                    color: 'var(--text2)',
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    fontSize: 20,
                    lineHeight: 1,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>

              <form id="form-camp-modal" onSubmit={onCreateCamp}>
                <div style={{ display: 'grid', gap: 14 }}>
                  <GpField label="Campaign name" value={campForm.name} onChange={(v) => setCampForm((f) => ({ ...f, name: v }))} disabled={!write} />
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
                    <label style={gpSelectLabel}>
                      Email template
                      <select
                        value={campForm.templateId}
                        disabled={!write}
                        onChange={(e) => setCampForm((f) => ({ ...f, templateId: e.target.value }))}
                        style={gpSelect}
                      >
                        <option value="">Select template…</option>
                        {templates.map((t) => (
                          <option key={t._id} value={t._id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={gpSelectLabel}>
                      Sending profile
                      <select
                        value={campForm.smtpProfileId}
                        disabled={!write}
                        onChange={(e) => setCampForm((f) => ({ ...f, smtpProfileId: e.target.value }))}
                        style={gpSelect}
                      >
                        <option value="">Select profile…</option>
                        {profiles.map((p) => (
                          <option key={p._id} value={p._id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
                    <GpField
                      label="Tracking URL (optional)"
                      value={campForm.trackingUrl}
                      onChange={(v) => setCampForm((f) => ({ ...f, trackingUrl: v }))}
                      disabled={!write}
                      placeholder="https://…"
                    />
                    <GpField
                      label="Other URL (optional)"
                      value={campForm.otherUrl}
                      onChange={(v) => setCampForm((f) => ({ ...f, otherUrl: v }))}
                      disabled={!write}
                      placeholder="https://…"
                    />
                  </div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>
                    Landing page HTML (optional)
                    <textarea
                      value={campForm.landingHtml}
                      disabled={!write}
                      onChange={(e) => setCampForm((f) => ({ ...f, landingHtml: e.target.value }))}
                      rows={5}
                      placeholder="Leave blank for default capture page…"
                      style={{ ...gpTextArea, marginTop: 8 }}
                    />
                  </label>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
                  <GpSecondaryButton type="button" onClick={() => setCampModalOpen(false)}>
                    Cancel
                  </GpSecondaryButton>
                  <GpPrimaryButton type="submit" disabled={!write}>
                    Create campaign
                  </GpPrimaryButton>
                </div>
              </form>
            </div>
          </div>
        )}

        {tplModalOpen && (
          <div
            role="presentation"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10050,
              background: 'rgba(5, 9, 14, 0.82)',
              backdropFilter: 'blur(5px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 22,
            }}
            onClick={closeTplModal}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="es-modal-tpl-title"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 'min(640px, 100%)',
                maxHeight: 'min(92vh, 820px)',
                overflowY: 'auto',
                borderRadius: 12,
                border: '1px solid color-mix(in srgb, var(--accent) 35%, var(--border))',
                background: 'linear-gradient(175deg, var(--bg2) 0%, color-mix(in srgb, var(--bg3) 92%, transparent) 100%)',
                boxShadow: '0 28px 90px rgba(0,0,0,0.5)',
                padding: '22px 24px 22px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start', marginBottom: 18 }}>
                <div style={{ minWidth: 0 }}>
                  <div id="es-modal-tpl-title" style={{ fontSize: 19, fontWeight: 780, letterSpacing: '-0.03em' }}>
                    {tplEditingId ? 'Edit template' : 'New template'}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={closeTplModal}
                  style={{
                    flexShrink: 0,
                    border: 'none',
                    background: 'color-mix(in srgb, var(--bg4) 75%, transparent)',
                    color: 'var(--text2)',
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    fontSize: 20,
                    lineHeight: 1,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>

              <form id="form-tpl-modal" onSubmit={onSubmitTplModal}>
                <div style={{ display: 'grid', gap: 14 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
                    <GpField label="Template name" value={tplForm.name} onChange={(v) => setTplForm((f) => ({ ...f, name: v }))} disabled={!write} />
                    <GpField label="Category" value={tplForm.category} onChange={(v) => setTplForm((f) => ({ ...f, category: v }))} disabled={!write} placeholder="custom, industry, …" />
                  </div>
                  <GpField label="Subject line" value={tplForm.subject} onChange={(v) => setTplForm((f) => ({ ...f, subject: v }))} disabled={!write} />
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>
                    HTML email body
                    <textarea
                      value={tplForm.htmlBody}
                      disabled={!write}
                      onChange={(e) => setTplForm((f) => ({ ...f, htmlBody: e.target.value }))}
                      rows={14}
                      style={{ ...gpTextArea, marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12 }}
                    />
                  </label>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
                  <GpSecondaryButton type="button" onClick={closeTplModal}>
                    Cancel
                  </GpSecondaryButton>
                  <GpPrimaryButton type="submit" disabled={!write}>
                    {tplEditingId ? 'Save changes' : 'Save template'}
                  </GpPrimaryButton>
                </div>
              </form>
            </div>
          </div>
        )}

        {contactModalOpen && (
          <div
            role="presentation"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10050,
              background: 'rgba(5, 9, 14, 0.82)',
              backdropFilter: 'blur(5px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 22,
            }}
            onClick={closeContactModal}
          >
            <div
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 'min(540px, 100%)',
                maxHeight: 'min(90vh, 700px)',
                overflowY: 'auto',
                borderRadius: 12,
                border: '1px solid color-mix(in srgb, var(--accent) 35%, var(--border))',
                background: 'linear-gradient(175deg, var(--bg2) 0%, color-mix(in srgb, var(--bg3) 92%, transparent) 100%)',
                boxShadow: '0 28px 90px rgba(0,0,0,0.5)',
                padding: '22px 24px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start', marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 780, letterSpacing: '-0.03em' }}>
                    {contactEditingId ? 'Edit contact' : 'Add contact'}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={closeContactModal}
                  style={{
                    flexShrink: 0,
                    border: 'none',
                    background: 'color-mix(in srgb, var(--bg4) 75%, transparent)',
                    color: 'var(--text2)',
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    fontSize: 20,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>
              <form onSubmit={onSaveContact}>
                <div style={{ display: 'grid', gap: 14 }}>
                  <GpField label="Email" value={contactForm.email} onChange={(v) => setContactForm((f) => ({ ...f, email: v }))} disabled={!write} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    <GpField label="First name" value={contactForm.firstName} onChange={(v) => setContactForm((f) => ({ ...f, firstName: v }))} disabled={!write} />
                    <GpField label="Last name" value={contactForm.lastName} onChange={(v) => setContactForm((f) => ({ ...f, lastName: v }))} disabled={!write} />
                  </div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>
                    Extra merge fields (JSON object, optional)
                    <textarea
                      value={contactForm.extraJson}
                      disabled={!write}
                      onChange={(e) => setContactForm((f) => ({ ...f, extraJson: e.target.value }))}
                      rows={5}
                      style={{ ...gpTextArea, marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12 }}
                      placeholder='{ "employeeCode": "E123", "department": "Eng" }'
                    />
                  </label>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                  <GpSecondaryButton type="button" onClick={closeContactModal}>
                    Cancel
                  </GpSecondaryButton>
                  <GpPrimaryButton type="submit" disabled={!write}>
                    {contactEditingId ? 'Save changes' : 'Save contact'}
                  </GpPrimaryButton>
                </div>
              </form>
            </div>
          </div>
        )}

        {groupModalOpen && (
          <div
            role="presentation"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10050,
              background: 'rgba(5, 9, 14, 0.82)',
              backdropFilter: 'blur(5px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 22,
            }}
            onClick={closeGroupModal}
          >
            <div
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 'min(520px, 100%)',
                maxHeight: 'min(90vh, 640px)',
                overflowY: 'auto',
                borderRadius: 12,
                border: '1px solid color-mix(in srgb, var(--accent) 35%, var(--border))',
                background: 'linear-gradient(175deg, var(--bg2) 0%, color-mix(in srgb, var(--bg3) 92%, transparent) 100%)',
                boxShadow: '0 28px 90px rgba(0,0,0,0.5)',
                padding: '22px 24px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start', marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 780, letterSpacing: '-0.03em' }}>
                    {groupEditingId ? 'Edit group' : 'New group'}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={closeGroupModal}
                  style={{
                    flexShrink: 0,
                    border: 'none',
                    background: 'color-mix(in srgb, var(--bg4) 75%, transparent)',
                    color: 'var(--text2)',
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    fontSize: 20,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>
              <form onSubmit={onSaveGroupModal}>
                <div style={{ display: 'grid', gap: 14 }}>
                  <GpField label="Name" value={groupForm.name} onChange={(v) => setGroupForm((f) => ({ ...f, name: v }))} disabled={!write} />
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>
                    Description (optional)
                    <textarea
                      value={groupForm.description}
                      disabled={!write}
                      onChange={(e) => setGroupForm((f) => ({ ...f, description: e.target.value }))}
                      rows={3}
                      style={{ ...gpTextArea, marginTop: 8 }}
                      placeholder="e.g. India · Customer Support team"
                    />
                  </label>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                  <GpSecondaryButton type="button" onClick={closeGroupModal}>
                    Cancel
                  </GpSecondaryButton>
                  <GpPrimaryButton type="submit" disabled={!write}>
                    {groupEditingId ? 'Save changes' : 'Create group'}
                  </GpPrimaryButton>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function EsAlert({ tone = 'warn', children }) {
  const icon = tone === 'info' ? 'ℹ' : '⚠'
  return (
    <div className={`es-alert es-alert-${tone === 'info' ? 'info' : 'warn'}`}>
      <span style={{ fontSize: 16, lineHeight: 1.4, flexShrink: 0, opacity: 0.9 }} aria-hidden>
        {icon}
      </span>
      <div>{children}</div>
    </div>
  )
}

function EsKpiRow({ items }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(108px, 1fr))',
        gap: 10,
        marginBottom: 20,
      }}
    >
      {items.map((item) => (
        <div key={item.label} className="es-kpi">
          <div className="es-kpi-label">{item.label}</div>
          <div className="es-kpi-value">{item.value ?? '—'}</div>
        </div>
      ))}
    </div>
  )
}

function EsSectionTitle({ children, action }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 14,
        flexWrap: 'wrap',
      }}
    >
      <h2 className="es-section-title">{children}</h2>
      {action}
    </div>
  )
}

function GpDonutCard({ title, pct, sub, stage, chartColors, donutOpts }) {
  const p = Math.round((Number(pct) || 0) * 10) / 10
  const palette = getFunnelStageColors(chartColors)[stage] || getFunnelStageColors(chartColors).sent
  const data = buildFunnelDonutDataset(p, palette.fill, palette.track)
  const active = p > 0
  return (
    <div className="es-donut-card">
      <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--text2)', marginBottom: 12 }}>{title}</div>
      <div style={{ position: 'relative', width: 128, height: 128, margin: '0 auto' }}>
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: `8px solid ${palette.trackMuted}`,
            boxSizing: 'border-box',
          }}
        />
        <div style={{ position: 'absolute', inset: 4 }}>
          <Doughnut data={data} options={donutOpts} />
        </div>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            fontWeight: 800,
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              color: active ? palette.fill : 'var(--text3)',
              lineHeight: 1,
            }}
          >
            {p}%
          </span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 10, lineHeight: 1.4 }}>{sub}</div>
    </div>
  )
}

const GP_STAT_TINTS = {
  blue: { mix: 'var(--cyan)', icon: 'var(--cyan)' },
  green: { mix: 'var(--green)', icon: 'var(--green)' },
  teal: { mix: 'var(--accent)', icon: 'var(--accent)' },
  purple: { mix: 'var(--accent2)', icon: 'var(--accent2)' },
  amber: { mix: 'var(--amber)', icon: 'var(--amber)' },
  slate: { mix: 'var(--text2)', icon: 'var(--text2)' },
}

function GpStat({ icon, label, value, tint = 'slate' }) {
  const c = GP_STAT_TINTS[tint] || GP_STAT_TINTS.slate
  return (
    <div
      className="es-stat"
      style={{
        borderRadius: ES_RADIUS,
        border: '1px solid var(--border)',
        background: `color-mix(in srgb, ${c.mix} 14%, var(--bg3))`,
        padding: '16px 16px',
        display: 'flex',
        gap: 14,
        alignItems: 'center',
        boxShadow: ES_SHADOW,
      }}
    >
      <div
        className="es-stat-icon"
        style={{
          width: 44,
          height: 44,
          borderRadius: 6,
          background: `color-mix(in srgb, ${c.mix} 22%, var(--bg2))`,
          border: `1px solid color-mix(in srgb, ${c.mix} 35%, var(--border))`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          flexShrink: 0,
          color: c.icon,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="es-stat-value" style={{ color: c.mix }}>
          {value ?? '—'}
        </div>
        <div className="es-stat-label">{label}</div>
      </div>
    </div>
  )
}

function GpPanel({ title, subtitle, children, actions }) {
  return (
    <section className="es-panel" style={{ marginBottom: 24 }}>
      <div className="es-panel-head">
        <div>
          <div className="es-panel-title">{title}</div>
          {subtitle ? <div className="es-panel-sub">{subtitle}</div> : null}
        </div>
        {actions ? <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{actions}</div> : null}
      </div>
      <div className="es-panel-body">{children}</div>
    </section>
  )
}

function GpTable({ children }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="es-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        {children}
      </table>
    </div>
  )
}

function GpTh({ children, style }) {
  return (
    <th style={{ textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text3)', ...style }}>
      {children}
    </th>
  )
}

function GpTd({ children, style }) {
  return <td style={{ padding: '11px 14px', verticalAlign: 'middle', ...style }}>{children}</td>
}

function StatusBadge({ status }) {
  const s = String(status || 'draft').toLowerCase()
  const cls =
    s === 'completed'
      ? 'es-badge-completed'
      : s === 'launched'
        ? 'es-badge-launched'
        : s === 'scheduled'
          ? 'es-badge-scheduled'
          : 'es-badge-draft'
  return <span className={`es-badge ${cls}`}>{s}</span>
}

function GpPrimaryButton({ children, style, ...props }) {
  return (
    <button {...props} className="es-btn-primary" style={style}>
      {children}
    </button>
  )
}

function GpSecondaryButton({ children, style, ...props }) {
  return (
    <button {...props} className="es-btn-secondary" style={style}>
      {children}
    </button>
  )
}

const gpLinkBtn = {
  padding: 0,
  border: 'none',
  background: 'none',
  color: ES_ACCENT,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: 2,
}

const gpInput = {
  marginTop: 6,
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  fontSize: 13,
  borderRadius: ES_RADIUS_SM,
  border: '1px solid var(--border)',
  background: 'var(--bg2)',
  color: 'var(--text)',
}

const gpTextArea = {
  ...gpInput,
  fontFamily: 'var(--mono)',
  fontSize: 12,
  lineHeight: 1.45,
  resize: 'vertical',
}

const gpSelect = {
  ...gpInput,
  marginTop: 6,
  cursor: 'pointer',
}

const gpSelectLabel = { fontSize: 12, fontWeight: 600, color: 'var(--text2)', display: 'block' }

const gpCheckbox = { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text2)', marginTop: 22 }

function GpField({ label, value, onChange, disabled, password, placeholder }) {
  return (
    <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', display: 'block' }}>
      {label}
      <input
        type={password ? 'password' : 'text'}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={gpInput}
      />
    </label>
  )
}
