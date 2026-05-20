/** Starter templates — LensPulse branded; neutral wording for awareness simulations. */

export const EMAIL_SIM_INDUSTRY_TEMPLATES = [
  {
    name: 'LensPulse — Policy reminder',
    category: 'industry',
    subject: 'Action requested: acknowledge updated acceptable use guidelines',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello {{firstName}},</p>
<p>Our security team published an update to the <strong>acceptable use policy</strong>. Please review and acknowledge within <strong>48 hours</strong> to avoid restricted access.</p>
<p><a href="{{landingUrl}}">Open policy summary</a></p>
<p style="font-size:12px;color:#666;">Sent by LensPulse awareness programme · Ref {{reference}}</p>
</div>`,
  },
  {
    name: 'LensPulse — MFA enrollment',
    category: 'industry',
    subject: 'Finish securing your account — MFA enrollment',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hi {{firstName}},</p>
<p>Multi-factor authentication is now required for your role. Complete enrollment using the link below from a trusted device.</p>
<p><a href="{{landingUrl}}">Complete MFA enrollment</a></p>
<p>If you did not expect this message, contact the IT service desk with reference <strong>{{reference}}</strong>.</p>
</div>`,
  },
  {
    name: 'LensPulse — Password expiry notice',
    category: 'industry',
    subject: 'Password expiry reminder for {{firstName}}',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello {{firstName}},</p>
<p>Your corporate password is scheduled to expire soon. Review the account security checklist to avoid interruption to business applications.</p>
<p><a href="{{landingUrl}}">Review account security</a></p>
<p style="font-size:12px;color:#666;">Security Operations · Ticket {{reference}}</p>
</div>`,
  },
  {
    name: 'LensPulse — VPN access review',
    category: 'industry',
    subject: 'VPN access review required',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hi {{firstName}},</p>
<p>We are validating VPN access for employees with remote connectivity. Confirm whether your assigned access is still required.</p>
<p><a href="{{landingUrl}}">Confirm VPN access</a></p>
<p style="font-size:12px;color:#666;">This awareness template should be used only for approved simulations.</p>
</div>`,
  },
  {
    name: 'LensPulse — HR document acknowledgement',
    category: 'industry',
    subject: 'HR document acknowledgement pending',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello {{firstName}},</p>
<p>A revised workplace document has been assigned to your employee profile. Please acknowledge receipt before the close of business.</p>
<p><a href="{{landingUrl}}">Open assigned document</a></p>
<p style="font-size:12px;color:#666;">Employee code: {{employeeCode}}</p>
</div>`,
  },
  {
    name: 'LensPulse — Payroll update confirmation',
    category: 'industry',
    subject: 'Confirm payroll information update',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>{{firstName}},</p>
<p>Payroll records for your profile were updated recently. Confirm the request if this change was expected.</p>
<p><a href="{{landingUrl}}">Confirm payroll request</a></p>
<p>If you did not request a change, report this message to the service desk.</p>
</div>`,
  },
  {
    name: 'LensPulse — Vendor invoice review',
    category: 'industry',
    subject: 'Invoice awaiting department review',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello {{firstName}},</p>
<p>A vendor invoice has been routed to your department queue for review. Please validate whether it should be approved or rejected.</p>
<p><a href="{{landingUrl}}">Review invoice</a></p>
<p style="font-size:12px;color:#666;">Finance workflow reference {{reference}}</p>
</div>`,
  },
  {
    name: 'LensPulse — Device compliance alert',
    category: 'industry',
    subject: 'Device compliance check required',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hi {{firstName}},</p>
<p>Your assigned device has not completed its latest compliance check. Connect to the portal to review the status and remediation steps.</p>
<p><a href="{{landingUrl}}">Open device status</a></p>
<p style="font-size:12px;color:#666;">Endpoint compliance · {{reference}}</p>
</div>`,
  },
  {
    name: 'LensPulse — Shared drive permission',
    category: 'industry',
    subject: 'Shared drive permission request',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello {{firstName}},</p>
<p>A permission request for a shared drive folder is waiting for your response. Review the request before access is granted.</p>
<p><a href="{{landingUrl}}">Review access request</a></p>
<p style="font-size:12px;color:#666;">Access governance simulation · {{reference}}</p>
</div>`,
  },
  {
    name: 'LensPulse — Travel desk itinerary',
    category: 'industry',
    subject: 'Travel itinerary confirmation needed',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hi {{firstName}},</p>
<p>The travel desk has generated an itinerary for your profile. Please confirm or reject the schedule from the travel portal.</p>
<p><a href="{{landingUrl}}">View itinerary</a></p>
<p style="font-size:12px;color:#666;">Travel desk · Employee {{employeeCode}}</p>
</div>`,
  },
  {
    name: 'LensPulse — Benefits enrollment',
    category: 'industry',
    subject: 'Benefits enrollment window closing',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello {{firstName}},</p>
<p>The benefits enrollment window is closing soon. Review your selections to ensure your profile is up to date.</p>
<p><a href="{{landingUrl}}">Review benefit selections</a></p>
<p style="font-size:12px;color:#666;">Human Resources · {{reference}}</p>
</div>`,
  },
  {
    name: 'LensPulse — Security awareness assessment',
    category: 'industry',
    subject: 'Complete your security awareness assessment',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hi {{firstName}},</p>
<p>Your security awareness assessment is pending. Complete the short assessment to keep your training record current.</p>
<p><a href="{{landingUrl}}">Start assessment</a></p>
<p style="font-size:12px;color:#666;">Awareness program · {{reference}}</p>
</div>`,
  },
]
