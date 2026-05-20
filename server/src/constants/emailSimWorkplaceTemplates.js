/** Workplace verification-style starters — use only in sanctioned simulations. */

export const EMAIL_SIM_WORKPLACE_TEMPLATES = [
  {
    name: 'Portal — Sign-in verification',
    category: 'workplace',
    subject: 'Verify your recent portal sign-in',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello,</p>
<p>We detected a sign-in to the workplace portal from an unrecognized browser. Confirm this was you.</p>
<p><a href="{{landingUrl}}">Verify activity</a> · Or review your active sessions from the security dashboard.</p>
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
<p><a href="{{landingUrl}}">Review storage</a></p>
<p>This is an informational simulation template — replace links before use.</p>
</div>`,
  },
  {
    name: 'Portal — Teams file share',
    category: 'workplace',
    subject: '{{firstName}}, a file was shared with you',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello {{firstName}},</p>
<p>A workplace file has been shared with you for review. Open the secure workspace link to view the document details.</p>
<p><a href="{{landingUrl}}">Open shared file</a></p>
<p style="font-size:12px;color:#666;">Workspace notifications · Ref {{reference}}</p>
</div>`,
  },
  {
    name: 'Portal — Meeting recording',
    category: 'workplace',
    subject: 'Meeting recording available',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hi {{firstName}},</p>
<p>A meeting recording has been processed and is available for your review.</p>
<p><a href="{{landingUrl}}">View recording</a></p>
<p style="font-size:12px;color:#666;">Workspace media · {{reference}}</p>
</div>`,
  },
  {
    name: 'Portal — DLP hold notification',
    category: 'workplace',
    subject: 'Message held for data protection review',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello,</p>
<p>A message associated with your mailbox was held for data protection review. Confirm if this was a business-approved transmission.</p>
<p><a href="{{landingUrl}}">Review held message</a></p>
<p style="font-size:12px;color:#666;">Data protection · Employee {{employeeCode}}</p>
</div>`,
  },
  {
    name: 'Portal — Document signature',
    category: 'workplace',
    subject: 'Document signature requested',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>{{firstName}},</p>
<p>A document is waiting for your electronic signature in the workplace portal.</p>
<p><a href="{{landingUrl}}">Review and sign</a></p>
<p style="font-size:12px;color:#666;">Document workflow · {{reference}}</p>
</div>`,
  },
  {
    name: 'Portal — Calendar invite update',
    category: 'workplace',
    subject: 'Updated calendar invite requires response',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello {{firstName}},</p>
<p>A calendar invite was updated and requires your response before the organizer can finalize attendance.</p>
<p><a href="{{landingUrl}}">Respond to invite</a></p>
<p style="font-size:12px;color:#666;">Calendar service · {{reference}}</p>
</div>`,
  },
  {
    name: 'Portal — Expense report returned',
    category: 'workplace',
    subject: 'Expense report returned for correction',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hi {{firstName}},</p>
<p>Your expense report was returned for a quick correction. Review the comments before resubmitting.</p>
<p><a href="{{landingUrl}}">Open expense report</a></p>
<p style="font-size:12px;color:#666;">Expense portal · {{reference}}</p>
</div>`,
  },
  {
    name: 'Portal — Secure message',
    category: 'workplace',
    subject: 'You received a secure message',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello,</p>
<p>A secure message is waiting in the workplace portal. Sign in to view the message and any attached files.</p>
<p><a href="{{landingUrl}}">Open secure message</a></p>
<p style="font-size:12px;color:#666;">Secure messaging · Employee {{employeeCode}}</p>
</div>`,
  },
  {
    name: 'Portal — Helpdesk ticket update',
    category: 'workplace',
    subject: 'Helpdesk ticket requires your input',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hi {{firstName}},</p>
<p>The helpdesk team needs additional input on your ticket before it can be resolved.</p>
<p><a href="{{landingUrl}}">Open ticket</a></p>
<p style="font-size:12px;color:#666;">Ticket reference {{reference}}</p>
</div>`,
  },
  {
    name: 'Portal — Cloud app authorization',
    category: 'workplace',
    subject: 'New cloud app authorization request',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello {{firstName}},</p>
<p>A cloud application has requested access to your workplace account. Review the authorization request before granting access.</p>
<p><a href="{{landingUrl}}">Review app request</a></p>
<p style="font-size:12px;color:#666;">Identity portal · {{reference}}</p>
</div>`,
  },
  {
    name: 'Portal — Storage cleanup',
    category: 'workplace',
    subject: 'Cloud storage cleanup recommended',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>{{firstName}},</p>
<p>Your cloud storage contains files that may be archived. Review the cleanup list before automatic retention rules apply.</p>
<p><a href="{{landingUrl}}">Review cleanup list</a></p>
<p style="font-size:12px;color:#666;">Storage service · {{reference}}</p>
</div>`,
  },
]
