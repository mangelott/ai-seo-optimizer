const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendPasswordResetEmail(to, resetUrl) {
  await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject: 'Reset your password',
    html: `
      <p>We received a request to reset your password.</p>
      <p><a href="${resetUrl}">Click here to choose a new password</a>. This link expires in 1 hour.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}

function domainLabel(domain) {
  return domain.replace(/^https?:\/\//, '');
}

async function sendAuditReadyEmail(to, { domain, score, reportUrl }) {
  await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject: `Your scheduled SEO audit for ${domainLabel(domain)} is ready (score: ${score})`,
    html: `
      <p>Your scheduled audit for <strong>${domainLabel(domain)}</strong> just finished.</p>
      <p>Score: <strong>${score} / 100</strong></p>
      <p><a href="${reportUrl}">View the full report</a></p>
    `,
  });
}

async function sendScoreDropAlertEmail(to, { domain, previousScore, score, reportUrl }) {
  await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject: `⚠️ SEO score dropped for ${domainLabel(domain)}: ${previousScore} → ${score}`,
    html: `
      <p>Heads up — the SEO score for <strong>${domainLabel(domain)}</strong> dropped from
      <strong>${previousScore}</strong> to <strong>${score}</strong> since the last audit.</p>
      <p><a href="${reportUrl}">See what changed</a></p>
    `,
  });
}

const PROVIDER_LABELS = { chatgpt: 'ChatGPT', perplexity: 'Perplexity' };

async function sendCompetitorCitationAlertEmail(to, { domain, query, competitors, reportUrl }) {
  const list = competitors
    .map((c) => `<li><strong>${domainLabel(c.competitorDomain)}</strong> (${PROVIDER_LABELS[c.provider] || c.provider})</li>`)
    .join('');

  await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject: `⚠️ A competitor is now cited for "${query}" — ${domainLabel(domain)} isn't`,
    html: `
      <p>For the tracked query <strong>"${query}"</strong> on <strong>${domainLabel(domain)}</strong>,
      the following competitor(s) are now cited by an AI assistant where you aren't:</p>
      <ul>${list}</ul>
      <p><a href="${reportUrl}">See your AI visibility report</a></p>
    `,
  });
}

async function sendTeamInviteEmail(to, { teamName, inviterEmail, appUrl }) {
  await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject: `${inviterEmail} invited you to join ${teamName} on AI SEO Optimizer`,
    html: `
      <p><strong>${inviterEmail}</strong> invited you to join the <strong>${teamName}</strong> team on AI SEO Optimizer.</p>
      <p><a href="${appUrl}">Create an account or log in</a> with this email address to join automatically.</p>
    `,
  });
}

module.exports = {
  sendPasswordResetEmail,
  sendAuditReadyEmail,
  sendScoreDropAlertEmail,
  sendCompetitorCitationAlertEmail,
  sendTeamInviteEmail,
};
