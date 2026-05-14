const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    logger.warn('Email service not configured — EMAIL_USER / EMAIL_PASS missing');
    return null;
  }

  // Explicit Gmail SMTP settings (more reliable than service:'gmail' shorthand)
  transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   587,
    secure: false,        // STARTTLS on port 587
    auth:   { user, pass },
    tls:    { rejectUnauthorized: false },
  });

  return transporter;
}

async function verifyTransporter() {
  const t = getTransporter();
  if (!t) return false;
  try {
    await t.verify();
    logger.info('Email transporter verified OK', { user: process.env.EMAIL_USER });
    return true;
  } catch (err) {
    logger.error('Email transporter verify FAILED', { err: err.message });
    transporter = null; // reset so next call retries
    return false;
  }
}

function buildWelcomeHtml(firstName) {
  const name = firstName ? firstName.trim() : 'Student';
  const year = new Date().getFullYear();

  const featureRows = [
    ['📝', 'CBT practice tests to sharpen your exam performance'],
    ['🎬', 'Video lessons to break down difficult topics'],
    ['📡', 'Live classes to keep you engaged and accountable'],
    ['📊', 'A simple system to track your progress and payments'],
  ].map(([icon, text]) => `
    <tr>
      <td width="32" valign="top" style="padding:6px 0;font-size:18px;">${icon}</td>
      <td style="padding:6px 0 6px 8px;font-size:15px;color:#374151;line-height:1.6;">${text}</td>
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
                <tbody>${featureRows}</tbody>
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

  const t = getTransporter();
  if (!t) { logger.warn('sendWelcomeEmail: transporter not available — check EMAIL_USER/EMAIL_PASS'); return; }

  const fromName  = process.env.EMAIL_FROM_NAME || 'Samuel Olusanya — NLTC Online';
  const fromEmail = process.env.EMAIL_USER;

  try {
    const info = await t.sendMail({
      from:    `"${fromName}" <${fromEmail}>`,
      to:      email,
      subject: `Welcome to NLTC Online, ${firstName || 'Student'}! 🎓`,
      html:    buildWelcomeHtml(firstName),
    });
    logger.info('Welcome email sent', { email, messageId: info.messageId });
  } catch (err) {
    logger.error('Failed to send welcome email', { email, err: err.message, code: err.code });
    // Reset transporter so next request retries with fresh connection
    transporter = null;
  }
}

module.exports = { sendWelcomeEmail, verifyTransporter };
