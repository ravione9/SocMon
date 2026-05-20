/** Workplace verification-style starters — use only in sanctioned simulations. */

export const EMAIL_SIM_WORKPLACE_TEMPLATES = [
  {
    name: 'Portal — Sign-in verification',
    category: 'workplace',
    subject: 'Verify your recent portal sign-in',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello,</p>
<p>We detected a sign-in to the workplace portal from an unrecognized browser. Confirm this was you.</p>
<p><a href="https://example.com/verify-session">Verify activity</a> · Or review your active sessions from the security dashboard.</p>
<p style="font-size:12px;color:#666;">Workspace · Employee {{employeeCode}}</p>
</div>`,
  },
  {
    name: 'Portal — Mailbox quota',
    category: 'workplace',
    subject: 'Mailbox approaching quota — optional cleanup',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>{{firstName}},</p>
<p>Your mailbox is above <strong>90%</strong> of its quota. Large attachments may bounce until space is freed.</p>
<p><a href="https://example.com/mail-settings">Review storage</a></p>
<p>This is an informational simulation template — replace links before use.</p>
</div>`,
  },
]
