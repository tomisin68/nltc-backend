const { Resend } = require('resend');
const logger     = require('../utils/logger');
const { EMAILS_ENABLED, ADMIN_EMAILS_ENABLED, PAYMENT_EMAILS_ENABLED } = require('../config/emailConfig');

let resend = null;

function getResend(enabled) {
  if (!enabled) {
    logger.info('Email sending disabled — skipping');
    return null;
  }
  if (resend) return resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    logger.warn('Email service not configured — RESEND_API_KEY missing');
    return null;
  }
  resend = new Resend(key);
  return resend;
}

async function verifyTransporter() {
  const r = getResend(EMAILS_ENABLED);
  if (!r) return false;
  // Resend has no verify() call — confirm the key exists and looks valid
  const key = process.env.RESEND_API_KEY || '';
  if (key.startsWith('re_')) {
    logger.info('Resend client ready', { from: process.env.RESEND_FROM_EMAIL });
    return true;
  }
  logger.error('RESEND_API_KEY does not look valid (should start with re_)');
  return false;
}

function buildWelcomeHtml(firstName) {
  const name = firstName ? firstName.trim() : 'Student';
  const year = new Date().getFullYear();

  const featureItems = [
    'CBT practice tests to sharpen your exam performance',
    'Video lessons to break down difficult topics',
    'Live classes to keep you engaged and accountable',
    'A simple system to track your progress and payments',
  ].map(text => `
    <tr>
      <td valign="top" style="padding:5px 0;font-size:15px;color:#374151;line-height:1.6;">
        &bull;&nbsp;&nbsp;${text}
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to NLTC Online</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#0B1D3A;padding:36px 40px;text-align:center;">
              <p style="margin:0;color:#D4A017;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">Next Level Tutorial College</p>
              <h1 style="margin:8px 0 0;color:#ffffff;font-size:28px;font-weight:900;letter-spacing:-0.5px;">Welcome to NLTC Online</h1>
            </td>
          </tr>

          <!-- Gold accent bar -->
          <tr><td style="background:linear-gradient(90deg,#D4A017,#f0be45);height:4px;"></td></tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 36px;">
              <p style="margin:0 0 20px;font-size:17px;color:#0B1D3A;font-weight:700;">Hello ${name},</p>

              <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.75;">
                Welcome to <strong>Next Level Tutorial College</strong> — where passionate teaching meets real results.
              </p>

              <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.75;">
                I'm <strong style="color:#0B1D3A;">Samuel Olusanya</strong>, the founder and director of the college, and I'm genuinely excited to have you join us.
              </p>

              <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.75;">
                This platform was built with one clear goal in mind: to give you the tools, structure, and guidance you need to succeed academically — no matter where you're starting from.
              </p>

              <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.75;font-weight:600;">
                Inside the website, you'll find everything designed to support your growth:
              </p>

              <!-- Feature list -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#f8f9fc;border-radius:10px;padding:8px 16px;">
                <tbody>${featureItems}</tbody>
              </table>

              <!-- Highlighted callout -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                <tr>
                  <td style="background:#fffbeb;border-left:4px solid #D4A017;padding:16px 20px;border-radius:0 8px 8px 0;">
                    <p style="margin:0;font-size:15px;color:#374151;line-height:1.75;font-style:italic;">
                      But here's the truth: <strong>tools only work if you use them well.</strong>
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.75;">
                So don't just sign up and disappear. <strong>Explore. Practice consistently. Revisit topics you don't understand. Push yourself a little further every day.</strong>
              </p>

              <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.75;">
                At Next Level, we believe that improvement is not magic — it's <em>daily effort, guided the right way.</em>
              </p>

              <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.75;">
                You've taken a smart first step by registering. Now let's make it count.
              </p>

              <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.75;">
                If you ever need help or guidance, we're here for you.
              </p>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 36px;">
                <tr>
                  <td style="background:#D4A017;border-radius:10px;padding:0;">
                    <a href="https://nltc.com.ng" style="display:inline-block;padding:15px 36px;color:#0B1D3A;font-weight:800;font-size:15px;text-decoration:none;letter-spacing:.3px;">Start Learning Now &rarr;</a>
                  </td>
                </tr>
              </table>

              <!-- Signature -->
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-left:3px solid #D4A017;padding-left:16px;">
                    <p style="margin:0 0 4px;font-size:15px;color:#374151;">Warm regards,</p>
                    <p style="margin:0 0 2px;font-size:17px;color:#0B1D3A;font-weight:800;">Samuel Olusanya</p>
                    <p style="margin:0 0 1px;font-size:13px;color:#6b7280;">Founder &amp; Director</p>
                    <p style="margin:0;font-size:13px;color:#6b7280;">Next Level Tutorial College</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8f9fc;padding:24px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0 0 6px;font-size:12px;color:#9ca3af;line-height:1.6;">
                You received this email because you created an account at
                <a href="https://nltc.com.ng" style="color:#D4A017;text-decoration:none;">nltc.com.ng</a>.
              </p>
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                &copy; ${year} Next Level Tutorial College &nbsp;&middot;&nbsp;
                <a href="https://nltc.com.ng/privacy-policy" style="color:#D4A017;text-decoration:none;">Privacy Policy</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Send the CEO welcome email to a newly registered student.
 * Fire-and-forget safe — never throws.
 */
async function sendWelcomeEmail({ email, firstName }) {
  if (!email) { logger.warn('sendWelcomeEmail: no email provided'); return; }

  const r = getResend(EMAILS_ENABLED);
  if (!r) { logger.warn('sendWelcomeEmail: Resend client not available — check RESEND_API_KEY'); return; }

  const fromName  = process.env.EMAIL_FROM_NAME || 'Samuel Olusanya — NLTC Online';
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'no-reply@nltc.ng';

  try {
    const { data, error } = await r.emails.send({
      from:    `${fromName} <${fromEmail}>`,
      to:      email,
      subject: `Welcome to NLTC Online, ${firstName || 'Student'}!`,
      html:    buildWelcomeHtml(firstName),
    });
    if (error) throw new Error(error.message);
    logger.info('Welcome email sent', { email, id: data?.id });
  } catch (err) {
    logger.error('Failed to send welcome email', { email, err: err.message });
  }
}

/**
 * Weekly progress report email — sent every Sunday to student (+ parent if set).
 */
async function sendWeeklyProgressEmail({ email, firstName, stats, parentEmail }) {
  const r = getResend(EMAILS_ENABLED);
  if (!r || !email) return;

  const fromName  = process.env.EMAIL_FROM_NAME  || 'NLTC Online';
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'no-reply@nltc.ng';
  const name = firstName || 'Student';

  const { cbtSessions = 0, totalCorrect = 0, totalQuestions = 0,
          xpEarned = 0, streak = 0, lessonsWatched = 0 } = stats;
  const pct = totalQuestions > 0 ? Math.round(totalCorrect / totalQuestions * 100) : 0;
  const weekRange = (() => {
    const now = new Date();
    const start = new Date(now); start.setDate(now.getDate() - 6);
    return `${start.toLocaleDateString('en-NG', { day:'numeric', month:'short' })} – ${now.toLocaleDateString('en-NG', { day:'numeric', month:'short', year:'numeric' })}`;
  })();

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>Weekly Progress Report</title></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:32px 16px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08);">
  <tr><td style="background:#0B1D3A;padding:30px 40px;text-align:center;">
    <p style="margin:0;color:#D4A017;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">NLTC Online</p>
    <h1 style="margin:8px 0 0;color:#ffffff;font-size:24px;font-weight:900;">Weekly Progress Report</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,.55);font-size:13px;">${weekRange}</p>
  </td></tr>
  <tr><td style="background:linear-gradient(90deg,#D4A017,#f0be45);height:4px;"></td></tr>
  <tr><td style="padding:36px 40px 28px;">
    <p style="margin:0 0 20px;font-size:16px;color:#0B1D3A;font-weight:700;">Hello ${name},</p>
    <p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.7;">
      Here's a summary of ${name}'s study activity on NLTC Online this week.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr style="background:#f8f9fc;">
        <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;">Metric</td>
        <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;text-align:right;">This Week</td>
      </tr>
      <tr style="border-top:1px solid #e5e7eb;">
        <td style="padding:12px 16px;font-size:14px;color:#374151;"><span style="margin-right:8px;">📝</span> CBT Sessions Completed</td>
        <td style="padding:12px 16px;font-size:14px;font-weight:700;color:#0B1D3A;text-align:right;">${cbtSessions}</td>
      </tr>
      <tr style="border-top:1px solid #e5e7eb;background:#fafafa;">
        <td style="padding:12px 16px;font-size:14px;color:#374151;"><span style="margin-right:8px;">✅</span> CBT Accuracy</td>
        <td style="padding:12px 16px;font-size:14px;font-weight:700;color:${pct >= 50 ? '#059669' : '#DC2626'};text-align:right;">${pct}% (${totalCorrect}/${totalQuestions})</td>
      </tr>
      <tr style="border-top:1px solid #e5e7eb;">
        <td style="padding:12px 16px;font-size:14px;color:#374151;"><span style="margin-right:8px;">🎬</span> Video Lessons Watched</td>
        <td style="padding:12px 16px;font-size:14px;font-weight:700;color:#0B1D3A;text-align:right;">${lessonsWatched}</td>
      </tr>
      <tr style="border-top:1px solid #e5e7eb;background:#fafafa;">
        <td style="padding:12px 16px;font-size:14px;color:#374151;"><span style="margin-right:8px;">⭐</span> XP Earned This Week</td>
        <td style="padding:12px 16px;font-size:14px;font-weight:700;color:#D4A017;text-align:right;">${xpEarned.toLocaleString()} XP</td>
      </tr>
      <tr style="border-top:1px solid #e5e7eb;">
        <td style="padding:12px 16px;font-size:14px;color:#374151;"><span style="margin-right:8px;">🔥</span> Current Study Streak</td>
        <td style="padding:12px 16px;font-size:14px;font-weight:700;color:#0B1D3A;text-align:right;">${streak} day${streak !== 1 ? 's' : ''}</td>
      </tr>
    </table>
    ${cbtSessions === 0 && lessonsWatched === 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr><td style="background:#fef3c7;border-left:4px solid #D4A017;padding:14px 18px;border-radius:0 8px 8px 0;">
        <p style="margin:0;font-size:14px;color:#92400e;line-height:1.6;">
          <strong>No activity recorded this week.</strong> Encourage ${name} to log in and practise — even 20 minutes a day makes a big difference!
        </p>
      </td></tr>
    </table>` : `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr><td style="background:#f0fdf4;border-left:4px solid #059669;padding:14px 18px;border-radius:0 8px 8px 0;">
        <p style="margin:0;font-size:14px;color:#065f46;line-height:1.6;">
          <strong>Great effort this week!</strong> Keep the momentum going — consistency is the key to exam success.
        </p>
      </td></tr>
    </table>`}
    <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr><td style="background:#D4A017;border-radius:10px;">
        <a href="https://nltc.com.ng" style="display:inline-block;padding:13px 32px;color:#0B1D3A;font-weight:800;font-size:14px;text-decoration:none;">
          Continue Studying &rarr;
        </a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;line-height:1.6;">
      This is an automated weekly report from NLTC Online. Reports are sent every Sunday.
    </p>
  </td></tr>
  <tr><td style="background:#f8f9fc;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
    <p style="margin:0;font-size:12px;color:#9ca3af;">&copy; ${new Date().getFullYear()} Next Level Tutorial College &nbsp;&middot;&nbsp;
    <a href="https://nltc.com.ng" style="color:#D4A017;text-decoration:none;">nltc.com.ng</a></p>
  </td></tr>
</table></td></tr></table></body></html>`;

  const recipients = [email];
  if (parentEmail && parentEmail !== email) recipients.push(parentEmail);

  try {
    for (const to of recipients) {
      const { error } = await r.emails.send({
        from:    `${fromName} <${fromEmail}>`,
        to,
        subject: `${name}'s Weekly Progress Report — NLTC Online`,
        html,
      });
      if (error) throw new Error(error.message);
    }
    logger.info('Weekly progress email sent', { email, parentEmail, cbtSessions, xpEarned });
  } catch (err) {
    logger.error('Failed to send weekly progress email', { email, err: err.message });
  }
}

/**
 * 3-day inactivity nudge — sent to the student.
 */
async function sendInactivityEmail({ email, firstName, daysMissed }) {
  const r = getResend(EMAILS_ENABLED);
  if (!r || !email) return;

  const fromName  = process.env.EMAIL_FROM_NAME  || 'NLTC Online';
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'no-reply@nltc.ng';
  const name = firstName || 'Student';

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>We miss you!</title></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:32px 16px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08);">
  <tr><td style="background:#0B1D3A;padding:30px 40px;text-align:center;">
    <p style="margin:0;font-size:40px;">📚</p>
    <h1 style="margin:10px 0 0;color:#ffffff;font-size:22px;font-weight:900;">You've missed ${daysMissed} study days</h1>
  </tr></tr>
  <tr><td style="background:linear-gradient(90deg,#D4A017,#f0be45);height:4px;"></td></tr>
  <tr><td style="padding:36px 40px;">
    <p style="margin:0 0 16px;font-size:16px;color:#0B1D3A;font-weight:700;">Hey ${name},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.75;">
      We noticed you haven't been on NLTC Online for <strong>${daysMissed} days</strong>. Your exam is getting closer — let's get back on track together!
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#f8f9fc;border-radius:10px;padding:4px 0;">
      ${['Complete a quick CBT session (just 10 questions!)', 'Watch one short video lesson', 'Check today\'s daily mission on your dashboard']
        .map(t => `<tr><td style="padding:10px 16px;font-size:14px;color:#374151;line-height:1.6;">✅ &nbsp;${t}</td></tr>`).join('')}
    </table>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr><td style="background:#D4A017;border-radius:10px;">
        <a href="https://nltc.com.ng" style="display:inline-block;padding:13px 32px;color:#0B1D3A;font-weight:800;font-size:14px;text-decoration:none;">
          Return to Studying &rarr;
        </a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">You got this, ${name}. Small steps every day lead to big results.</p>
  </td></tr>
  <tr><td style="background:#f8f9fc;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
    <p style="margin:0;font-size:12px;color:#9ca3af;">&copy; ${new Date().getFullYear()} NLTC Online &nbsp;&middot;&nbsp;
    <a href="https://nltc.com.ng" style="color:#D4A017;text-decoration:none;">nltc.com.ng</a></p>
  </td></tr>
</table></td></tr></table></body></html>`;

  try {
    const { error } = await r.emails.send({
      from:    `${fromName} <${fromEmail}>`,
      to:      email,
      subject: `${name}, you've missed ${daysMissed} study days — let's get back on track!`,
      html,
    });
    if (error) throw new Error(error.message);
    logger.info('Inactivity email sent', { email, daysMissed });
  } catch (err) {
    logger.error('Failed to send inactivity email', { email, err: err.message });
  }
}

/**
 * 7-day admin alert — notifies admins + center manager about an inactive student.
 */
async function sendAdminInactivityAlert({ adminEmail, studentName, studentEmail, daysMissed, centerName }) {
  const r = getResend(ADMIN_EMAILS_ENABLED);
  if (!r || !adminEmail) return;

  const fromName  = process.env.EMAIL_FROM_NAME  || 'NLTC Online';
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'no-reply@nltc.ng';

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>Student Inactivity Alert</title></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:32px 16px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08);">
  <tr><td style="background:#DC2626;padding:28px 40px;text-align:center;">
    <p style="margin:0;font-size:32px;">⚠️</p>
    <h1 style="margin:8px 0 0;color:#ffffff;font-size:20px;font-weight:900;">Student Inactivity Alert</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,.7);font-size:13px;">Action required — teacher follow-up needed</p>
  </td></tr>
  <tr><td style="padding:32px 40px;">
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.7;">
      The following student has been inactive on NLTC Online for <strong style="color:#DC2626;">${daysMissed} days</strong> and may need follow-up from their teacher.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden;">
      <tr style="background:#f8f9fc;">
        <td colspan="2" style="padding:10px 16px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;">Student Details</td>
      </tr>
      <tr style="border-top:1px solid #e5e7eb;"><td style="padding:11px 16px;font-size:13px;color:#6b7280;width:40%;">Name</td><td style="padding:11px 16px;font-size:13px;font-weight:700;color:#0B1D3A;">${studentName}</td></tr>
      <tr style="border-top:1px solid #e5e7eb;background:#fafafa;"><td style="padding:11px 16px;font-size:13px;color:#6b7280;">Email</td><td style="padding:11px 16px;font-size:13px;color:#0B1D3A;">${studentEmail}</td></tr>
      <tr style="border-top:1px solid #e5e7eb;"><td style="padding:11px 16px;font-size:13px;color:#6b7280;">Centre</td><td style="padding:11px 16px;font-size:13px;color:#0B1D3A;">${centerName || 'N/A'}</td></tr>
      <tr style="border-top:1px solid #e5e7eb;background:#fafafa;"><td style="padding:11px 16px;font-size:13px;color:#6b7280;">Days Inactive</td><td style="padding:11px 16px;font-size:13px;font-weight:700;color:#DC2626;">${daysMissed} days</td></tr>
    </table>
    <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.7;">
      Please reach out to this student directly to check in and encourage them to return to their studies.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td style="background:#0B1D3A;border-radius:8px;">
        <a href="https://nltc.com.ng/admin" style="display:inline-block;padding:12px 28px;color:#D4A017;font-weight:800;font-size:14px;text-decoration:none;">
          Open Admin Dashboard &rarr;
        </a>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#f8f9fc;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
    <p style="margin:0;font-size:12px;color:#9ca3af;">&copy; ${new Date().getFullYear()} NLTC Online &nbsp;&middot;&nbsp; Automated alert system</p>
  </td></tr>
</table></td></tr></table></body></html>`;

  try {
    const { error } = await r.emails.send({
      from:    `${fromName} <${fromEmail}>`,
      to:      adminEmail,
      subject: `[NLTC Alert] ${studentName} has been inactive for ${daysMissed} days`,
      html,
    });
    if (error) throw new Error(error.message);
    logger.info('Admin inactivity alert sent', { adminEmail, studentEmail, daysMissed });
  } catch (err) {
    logger.error('Failed to send admin alert', { adminEmail, err: err.message });
  }
}

// ─── Payment mail ───────────────────────────────────────────────────────────
//
// Payments are manual: a student transfers, uploads a receipt, and an admin
// confirms it. Nobody is watching a webhook, so these three messages are what
// keep the loop moving — the admin learns a receipt is waiting, and the student
// learns whether they are in.

const money = n => `₦${Number(n || 0).toLocaleString('en-NG')}`;

/** Escapes text that came from a user before it goes into an HTML template. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Flattens user-supplied text before it goes in a subject line.
 *
 * A student picks their own name, and it reaches the subject verbatim. Resend
 * takes JSON rather than raw SMTP so a newline cannot forge a header here, and
 * a subject is plain text so markup cannot execute in one — but neither renders
 * as anything an admin wants to read in a list of alerts. Angle brackets and
 * control characters go, and the length cap keeps a pasted essay from pushing
 * the amount out of the inbox preview.
 */
function subjectSafe(s, max = 80) {
  const flat = String(s ?? '')
    .replace(/[<>]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function mailFrom() {
  const fromName  = process.env.EMAIL_FROM_NAME   || 'NLTC Online';
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'no-reply@nltc.ng';
  return `${fromName} <${fromEmail}>`;
}

/** Shared chrome so the three payment mails read as one set. */
function paymentShell({ accent, emoji, heading, subheading, body }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:32px 16px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08);">
  <tr><td style="background:${accent};padding:28px 40px;text-align:center;">
    <p style="margin:0;font-size:32px;">${emoji}</p>
    <h1 style="margin:8px 0 0;color:#ffffff;font-size:20px;font-weight:900;">${esc(heading)}</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,.75);font-size:13px;">${esc(subheading)}</p>
  </td></tr>
  <tr><td style="padding:32px 40px;">${body}</td></tr>
  <tr><td style="background:#f8f9fc;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
    <p style="margin:0;font-size:12px;color:#9ca3af;">&copy; ${new Date().getFullYear()} NLTC Online &nbsp;&middot;&nbsp; nltcglobalservices@gmail.com</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function detailRows(rows) {
  const cells = rows.map(([label, value, strong], i) => `
      <tr style="border-top:1px solid #e5e7eb;${i % 2 ? 'background:#fafafa;' : ''}">
        <td style="padding:11px 16px;font-size:13px;color:#6b7280;width:42%;">${esc(label)}</td>
        <td style="padding:11px 16px;font-size:13px;${strong ? 'font-weight:700;' : ''}color:#0B1D3A;">${esc(value)}</td>
      </tr>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden;">
      <tr style="background:#f8f9fc;"><td colspan="2" style="padding:10px 16px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;">Payment Details</td></tr>
      ${cells}
    </table>`;
}

function button(href, label, bg = '#0B1D3A', fg = '#D4A017') {
  return `<table cellpadding="0" cellspacing="0" style="margin:0 0 8px;"><tr><td style="background:${bg};border-radius:8px;">
      <a href="${href}" style="display:inline-block;padding:12px 28px;color:${fg};font-weight:800;font-size:14px;text-decoration:none;">${label}</a>
    </td></tr></table>`;
}

/**
 * Tells an admin a receipt is waiting.
 *
 * Every one of these is a student who has paid and is locked out until somebody
 * opens the queue, which is why it carries the amount and a direct link rather
 * than just saying "you have a notification".
 */
async function sendAdminPaymentReceiptEmail({ adminEmail, studentName, studentEmail, amount, description, receiptUrl }) {
  const r = getResend(PAYMENT_EMAILS_ENABLED);
  if (!r || !adminEmail) return;

  const html = paymentShell({
    accent: '#0B1D3A', emoji: '🧾',
    heading: 'New payment receipt',
    subheading: 'A student is waiting to be activated',
    body: `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.7;">
      <strong>${esc(studentName)}</strong> has uploaded proof of a bank transfer and is locked out until it is confirmed.
    </p>
    ${detailRows([
      ['Student', studentName, true],
      ['Email', studentEmail || '—'],
      ['Amount', money(amount), true],
      ['For', description || 'Monthly fee'],
    ])}
    <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.7;">
      Check the transfer landed, then approve it — approving activates the account for 30 days straight away.
    </p>
    ${button('https://nltc.com.ng/admin', 'Open the Receipts Queue &rarr;')}
    ${receiptUrl ? `<p style="margin:12px 0 0;font-size:13px;"><a href="${esc(receiptUrl)}" style="color:#0B1D3A;">View the uploaded receipt</a></p>` : ''}`,
  });

  try {
    const { error } = await r.emails.send({
      from: mailFrom(), to: adminEmail,
      subject: `[NLTC] ${subjectSafe(studentName)} sent a receipt for ${money(amount)}`,
      html,
    });
    if (error) throw new Error(error.message);
    logger.info('Admin payment receipt email sent', { adminEmail, amount });
  } catch (err) {
    logger.error('Failed to send admin payment email', { adminEmail, err: err.message });
  }
}

/** Tells a student their payment went through and their account is open. */
async function sendPaymentConfirmedEmail({ email, firstName, amount, description, reference, expiresAt }) {
  const r = getResend(PAYMENT_EMAILS_ENABLED);
  if (!r || !email) return;

  const pretty = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  const html = paymentShell({
    accent: '#16A34A', emoji: '✅',
    heading: 'Payment confirmed',
    subheading: 'Your account is now active',
    body: `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.7;">
      Hi ${esc(firstName || 'there')}, we have confirmed your transfer. Everything is unlocked — lessons, CBT, mock exams and live classes.
    </p>
    ${detailRows([
      ['Amount paid', money(amount), true],
      ['For', description || 'Monthly fee'],
      ...(pretty ? [['Active until', pretty, true]] : []),
      ['Reference', reference || '—'],
    ])}
    ${button('https://nltc.com.ng/dashboard', 'Start Learning &rarr;')}
    <p style="margin:16px 0 0;font-size:13px;color:#6b7280;line-height:1.7;">
      Keep this email as your receipt. Quote the reference above for any query about this payment.
    </p>`,
  });

  try {
    const { error } = await r.emails.send({
      from: mailFrom(), to: email,
      subject: `Payment confirmed — your NLTC account is active`,
      html,
    });
    if (error) throw new Error(error.message);
    logger.info('Payment confirmed email sent', { email, reference });
  } catch (err) {
    logger.error('Failed to send payment confirmed email', { email, err: err.message });
  }
}

/**
 * Tells a student their receipt was not accepted, and why.
 *
 * The reason is the whole point — "your payment failed" with no cause leaves
 * them with nothing to do but guess or open a support thread.
 */
async function sendPaymentRejectedEmail({ email, firstName, amount, description, reason }) {
  const r = getResend(PAYMENT_EMAILS_ENABLED);
  if (!r || !email) return;

  const html = paymentShell({
    accent: '#DC2626', emoji: '⚠️',
    heading: 'We could not confirm your payment',
    subheading: 'Your account has not been activated yet',
    body: `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.7;">
      Hi ${esc(firstName || 'there')}, we reviewed the receipt you sent but could not confirm the transfer.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:.06em;">Reason</p>
        <p style="margin:0;font-size:14px;color:#7f1d1d;line-height:1.6;">${esc(reason)}</p>
      </td></tr>
    </table>
    ${detailRows([
      ['Amount', money(amount), true],
      ['For', description || 'Monthly fee'],
    ])}
    <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.7;">
      You have not been charged again — upload a clearer receipt and we will review it right away. If you believe this is a mistake, reply to this email and we will look into it.
    </p>
    ${button('https://nltc.com.ng/dashboard', 'Upload a New Receipt &rarr;')}`,
  });

  try {
    const { error } = await r.emails.send({
      from: mailFrom(), to: email,
      subject: 'Action needed — we could not confirm your NLTC payment',
      html,
    });
    if (error) throw new Error(error.message);
    logger.info('Payment rejected email sent', { email });
  } catch (err) {
    logger.error('Failed to send payment rejected email', { email, err: err.message });
  }
}

module.exports = {
  sendWelcomeEmail, verifyTransporter, sendWeeklyProgressEmail, sendInactivityEmail,
  sendAdminInactivityAlert,
  sendAdminPaymentReceiptEmail, sendPaymentConfirmedEmail, sendPaymentRejectedEmail,
};
