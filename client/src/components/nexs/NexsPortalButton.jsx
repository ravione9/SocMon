import { useState } from 'react'
import toast from 'react-hot-toast'
import { getPortalCreds } from '../../api/nexsPortalCreds'
import { openNexsPortalRoles, resolvePortalRolesUrl } from '../../api/nexsPortal'
import { nexsBtnGhost, nexsCx } from './nexsTheme'

export default function NexsPortalButton({ meta, className = '' }) {
  const [loading, setLoading] = useState(false)
  const portalUrl = resolvePortalRolesUrl(meta)

  const handleOpen = async () => {
    const creds = getPortalCreds()
    if (!creds?.userName || !creds?.password) {
      toast.error('Sign out and sign in again on this page to enable Nexs portal launch.')
      return
    }
    setLoading(true)
    try {
      await openNexsPortalRoles({
        userName: creds.userName,
        password: creds.password,
        portalUrl,
        appId: meta?.portalAppId || 'nexs_search',
      })
      toast.success('Nexs portal opened — you should be signed in on the roles page.')
    } catch (e) {
      toast.error(e.message || 'Could not open Nexs portal')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <button
        type="button"
        onClick={handleOpen}
        disabled={loading}
        className={nexsBtnGhost()}
        title={portalUrl}
      >
        {loading ? 'Opening portal…' : 'Open Nexs portal (roles)'}
      </button>
      <a
        href={portalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`text-xs hover:underline ${nexsCx.text3}`}
        style={{ color: 'var(--accent)' }}
      >
        {portalUrl.replace(/^https?:\/\//, '')}
      </a>
    </div>
  )
}
