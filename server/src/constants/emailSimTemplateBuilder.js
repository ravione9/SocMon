/**
 * Email-safe HTML builder for phishing-simulation templates.
 *
 * Constraints we honour:
 *   - Table-based layout (Outlook / Word-renderer compatibility)
 *   - Inline CSS only (Gmail / Outlook strip <style> in some clients)
 *   - No <link>, <script>, no SVG (Gmail strips), no background-image
 *   - 600 px max width, web-safe Arial fallback with system-ui hint
 *   - Big tappable CTA button (anchor inside a TD with bgcolor=)
 *   - All anchors point at {{landingUrl}} so buildTrackedHtml wraps them
 *
 * Returns a single string; both starter packs feed `htmlBody` from this.
 */

const FONT_STACK = "'Segoe UI',-apple-system,BlinkMacSystemFont,Arial,Helvetica,sans-serif"

function escapeHtmlAttr(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/**
 * Render an attractive simulation email.
 * Each opts field is optional except `title`, `paragraphs`, and `ctaLabel`.
 */
export function buildEmail({
  brand = 'LensPulse',
  brandTagline = 'Security Awareness',
  icon = '🛡',
  accentColor = '#2563eb',
  accentDark = null,
  headerBg = '#0f172a',
  headerBgEnd = '#1e293b',
  urgencyText = '',
  urgencyColor = '#ea580c',
  title,
  greeting = 'Hello {{firstName}},',
  paragraphs = [],
  ctaLabel = 'Open secure link',
  ctaArrow = '→',
  noteLine = '',
  footerLine = '',
  footerOrg = '© Lenskart · Security Operations',
}) {
  const darkAccent = accentDark || accentColor
  const para = (paragraphs || [])
    .map(
      (p) =>
        `<p style="margin:0 0 14px;color:#1f2937;font-size:15px;line-height:1.6;">${p}</p>`,
    )
    .join('')

  const urgency = urgencyText
    ? `<tr>
        <td bgcolor="${escapeHtmlAttr(urgencyColor)}" style="background:${escapeHtmlAttr(urgencyColor)};color:#ffffff;padding:11px 28px;font-size:13px;font-weight:600;letter-spacing:.3px;font-family:${FONT_STACK};">
          ${urgencyText}
        </td>
      </tr>`
    : ''

  const note = noteLine
    ? `<p style="margin:16px 0 0;font-size:12px;color:#6b7280;line-height:1.5;font-family:${FONT_STACK};">${noteLine}</p>`
    : ''

  const footer = footerLine
    ? `<tr>
        <td style="padding:0 28px;">
          <div style="border-top:1px solid #e5e7eb;height:1px;line-height:1px;font-size:0;">&nbsp;</div>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 28px 24px 28px;color:#6b7280;font-size:12px;line-height:1.55;font-family:${FONT_STACK};">
          <p style="margin:0 0 6px;">${footerLine}</p>
          <p style="margin:0;">If you have questions, reply to your IT service desk and quote the reference above.</p>
        </td>
      </tr>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtmlAttr(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:${FONT_STACK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
        <tr>
          <td bgcolor="${escapeHtmlAttr(headerBg)}" style="background:${escapeHtmlAttr(headerBg)};background-image:linear-gradient(135deg, ${escapeHtmlAttr(headerBg)} 0%, ${escapeHtmlAttr(headerBgEnd)} 100%);padding:20px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.3px;font-family:${FONT_STACK};">
                  <span style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;background:${escapeHtmlAttr(accentColor)};border-radius:8px;font-size:15px;vertical-align:middle;margin-right:10px;">${icon}</span>
                  <span style="vertical-align:middle;">${escapeHtmlAttr(brand)}</span>
                  <span style="vertical-align:middle;font-size:12px;opacity:.65;font-weight:500;margin-left:6px;">· ${escapeHtmlAttr(brandTagline)}</span>
                </td>
                <td align="right" style="color:#ffffff;font-size:11px;opacity:.7;font-family:${FONT_STACK};">Ref {{reference}}</td>
              </tr>
            </table>
          </td>
        </tr>
        ${urgency}
        <tr>
          <td style="padding:30px 28px 4px 28px;font-family:${FONT_STACK};">
            <h2 style="margin:0 0 16px;font-size:21px;line-height:1.3;font-weight:700;color:#0f172a;letter-spacing:-.2px;">${escapeHtmlAttr(title)}</h2>
            <p style="margin:0 0 14px;color:#1f2937;font-size:15px;line-height:1.6;">${greeting}</p>
            ${para}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:14px 28px 28px 28px;font-family:${FONT_STACK};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="${escapeHtmlAttr(accentColor)}" style="border-radius:10px;background:${escapeHtmlAttr(accentColor)};background-image:linear-gradient(135deg, ${escapeHtmlAttr(accentColor)} 0%, ${escapeHtmlAttr(darkAccent)} 100%);box-shadow:0 2px 6px rgba(37,99,235,0.25);">
                  <a href="{{landingUrl}}" style="display:inline-block;padding:14px 30px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;font-family:${FONT_STACK};border-radius:10px;letter-spacing:.2px;">
                    ${escapeHtmlAttr(ctaLabel)} <span style="margin-left:6px;">${ctaArrow}</span>
                  </a>
                </td>
              </tr>
            </table>
            ${note}
          </td>
        </tr>
        ${footer}
      </table>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr>
          <td align="center" style="padding:14px 0 4px;color:#9ca3af;font-size:11px;font-family:${FONT_STACK};letter-spacing:.2px;">
            ${escapeHtmlAttr(footerOrg)}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 0 18px;color:#cbd5e1;font-size:10px;font-family:${FONT_STACK};">
            This message is part of a sanctioned awareness simulation.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}
