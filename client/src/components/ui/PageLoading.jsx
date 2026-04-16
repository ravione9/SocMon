/** Lightweight fallback for React.lazy route chunks (keeps main bundle small). */
export default function PageLoading() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '40vh',
        color: 'var(--text3)',
        fontFamily: 'var(--mono)',
        fontSize: 12,
        gap: 10,
      }}
      aria-busy="true"
      aria-label="Loading page"
    >
      <span className="np-page-loading-dot" />
      Loading…
    </div>
  )
}
