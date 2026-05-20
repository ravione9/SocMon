/** Starter templates — LensPulse branded; neutral wording for awareness simulations. */

export const EMAIL_SIM_INDUSTRY_TEMPLATES = [
  {
    name: 'LensPulse — Policy reminder',
    category: 'industry',
    subject: 'Action requested: acknowledge updated acceptable use guidelines',
    htmlBody: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5;">
<p>Hello {{firstName}},</p>
<p>Our security team published an update to the <strong>acceptable use policy</strong>. Please review and acknowledge within <strong>48 hours</strong> to avoid restricted access.</p>
<p><a href="https://example.com/policy">Open policy summary</a></p>
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
<p><a href="https://example.com/mfa-enroll">Complete MFA enrollment</a></p>
<p>If you did not expect this message, contact the IT service desk with reference <strong>{{reference}}</strong>.</p>
</div>`,
  },
]
