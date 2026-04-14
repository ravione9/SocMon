import { useAuthStore } from '../../store/authStore'

export default function NoAccessPage() {
  const { user, logout } = useAuthStore()
  return (
    <div style={{ maxWidth: 480, margin: '48px auto', textAlign: 'center', fontFamily: 'var(--sans)' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>No page access</h1>
      <p style={{ fontSize: 13, color: 'var(--text3)', lineHeight: 1.5, marginBottom: 20 }}>
        Your account is active but no application pages are assigned. Ask an administrator to grant page access in Admin → Users.
      </p>
      {user && (
        <p style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 20 }}>
          Signed in as {user.email}
        </p>
      )}
      <button
        type="button"
        onClick={() => logout()}
        style={{
          padding: '10px 20px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--bg3)',
          color: 'var(--text)',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Sign out
      </button>
    </div>
  )
}
