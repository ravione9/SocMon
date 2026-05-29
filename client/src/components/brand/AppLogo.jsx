/**
 * SocMon / Netpulse brand mark — matches public/favicon.svg (ITOps-style network globe).
 */
export default function AppLogo({ size = 36, style, className, title = 'SocMon' }) {
  const s = Number(size) || 36
  return (
    <img
      src="/favicon.svg"
      alt=""
      width={s}
      height={s}
      title={title}
      className={className}
      style={{
        display: 'block',
        width: s,
        height: s,
        borderRadius: Math.max(6, Math.round(s * 0.22)),
        boxShadow: '0 2px 12px rgba(79,126,245,0.25)',
        ...style,
      }}
    />
  )
}
