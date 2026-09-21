// The one shell every branded notification is poured into, so the landlord
// decision request and the roommate invitation cannot drift apart: the same
// sender, the same 600px card with the logo and rule on top, the same heading,
// place line, button and footer styles.
//
// Bodies are plain HTML strings the caller has already escaped with `esc`.

export const MAIL_FROM = "Star Realty <no-reply@starreusa.com>";
export const MAIL_LAYOUT_MARKER = 'data-star-mail-layout="v1"';
export const MAIL_FOOTER = "Star Real Estate · Rental applications and property services";

export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

// A public HTTPS asset, so mail clients load the logo without an attachment.
export function mailLogoUrl(env) {
  const url = new URL(env.EMAIL_LOGO_URL || "https://starreusa.com/png/email-logo-v1.png");
  if (url.protocol !== "https:") throw new Error("EMAIL_LOGO_URL must use HTTPS.");
  return url.href;
}

export const mailButton = (label, href) =>
  `<a style="display:inline-block;padding:12px 18px;margin:0 8px 12px 0;border:1px solid #111111;border-radius:4px;background:#111111;color:#ffffff;font-size:14px;font-weight:bold;line-height:20px;text-decoration:none" href="${esc(href)}">${esc(label)}</a>`;

// `test` is the run id of an internal test, which stamps the card so nobody
// mistakes synthetic mail for a live case; `stamp` says what is synthetic.
export function mailShell(env, { title, heading, place = '', test = '', stamp = "Synthetic screening", body, footer = MAIL_FOOTER }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body ${MAIL_LAYOUT_MARKER} style="margin:0;padding:0;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff"><tr><td align="center" style="padding:24px 8px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border:8px solid #f5f5f5;background:#ffffff;color:#111111;font-size:15px;line-height:1.6">
<tr><td align="center" style="padding:24px 20px"><img src="${esc(mailLogoUrl(env))}" alt="Star Real Estate" width="112" height="112" style="display:block;width:112px;height:112px;border:0;background:#ffffff"></td></tr>
<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:2px solid #111111;font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr>
<tr><td style="padding:24px">
${test ? `<p style="margin:0 0 16px;font-size:12px;color:#555555"><b>Internal Test</b> · Run ${esc(String(test).slice(0, 8))} · ${esc(stamp)}</p>` : ""}
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:#111111">${esc(heading)}</h1>
${place ? `<h2 style="margin:0 0 12px;font-size:18px;line-height:1.4;color:#111111">${esc(place)}</h2>` : ""}
${body}
${footer ? `<p style="margin:0;padding-top:16px;border-top:1px solid #dddddd;font-size:12px;line-height:1.7;color:#555555">${footer}</p>` : ""}
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}

// Every application-owned transport goes through this normalization, including
// legacy callers and the local test sink. Custom HTML cannot skip the shell.
export function prepareMail(env,message) {
  return {...message,from:MAIL_FROM,html:message.html?.includes(MAIL_LAYOUT_MARKER)
    ? message.html : textMailHtml(env,message.subject,message.text)};
}

// Older plain-text notifications get the same branded shell while retaining
// their text alternative, reply-to address and clickable HTTP(S) links.
export function textMailHtml(env, title, text) {
  const body=String(text || '').split(/\n\s*\n/).map(paragraph=>{
    const content=paragraph.split(/(https?:\/\/[^\s]+)/g).map(part=>/^https?:\/\//.test(part)
      ? `<a href="${esc(part)}" style="color:#111111;overflow-wrap:anywhere">${esc(part)}</a>` : esc(part).replaceAll('\n','<br>')).join('');
    return `<p style="margin:0 0 16px;overflow-wrap:anywhere">${content}</p>`;
  }).join('\n');
  return mailShell(env,{title,heading:title,body});
}

export function authCodeMail(env, {heading='Your verification code',intro='Enter this code on the Star Real Estate page where you requested it to finish creating your account, activating your account, or resetting your password.'}={}) {
  return mailShell(env,{title:heading,heading,
    body:`<p style="margin:0 0 16px">${esc(intro)}</p>
<p style="margin:24px 0;padding:20px;background:#f5f5f5;font-size:32px;font-weight:bold;letter-spacing:6px;text-align:center">{{ .Token }}</p>
<p style="margin:0 0 24px">Return to the browser tab where you requested this code. Use the most recent code. If it has expired, request a new one on that page.</p>`,
    footer:'Do not share this code. If you did not request it, you can ignore this email.'});
}

// The subject line, stamped the same way as the card when the mail belongs to
// an internal test run.
export function mailSubject(test, subject) {
  return `${test ? `[Internal Test ${String(test).slice(0, 8)}] ` : ""}${subject}`;
}

// The place a notification is about: building and unit, or the listing title
// when the listing has no building name yet.
export function mailPlace(listing, fallback) {
  return [listing?.property_name || fallback || listing?.title, listing?.unit].filter(Boolean).join(" · ");
}

// The roommate invitation, in text and HTML. It is sent from the form's
// roommate step, once the lead pays, and by staff from the workspace, and
// reads the same from all three.
export function invitationMail(env, { place, inviter, invitee, link, expires, test }) {
  const name = String(invitee.name || "").trim();
  const greeting = name ? `Hello ${name},` : "Hello,";
  const intro = `${inviter} has invited you to apply with them for ${place}.`;
  const together = "Each applicant completes their own application. Your application will be linked to theirs and reviewed together by the Star Real Estate leasing team.";
  const fallback = "If the button doesn’t work, copy and paste this link into your browser:";
  const account = `Sign in with ${invitee.email} to create your applicant account and complete your application.`;
  const privacy = "Your personal information and uploaded documents are only visible to the leasing team and are not shared with other applicants.";
  const expiry = expires ? ` This invitation expires ${String(expires).slice(0, 10)}.` : "";
  const text = `${test ? `INTERNAL TEST — Test application. Run ${test}\n\n` : ""}${greeting}\n\n${intro}\n\n${together}\n\nStart your application\n\n    ${link}\n\n${account}${expiry}\n\n${privacy}\n`;
  const html = mailShell(env, {
    title: "You’re invited to join a rental application",
    heading: "You’re invited to join a rental application",
    test,
    stamp: "Test application",
    body: `<p style="margin:0 0 16px">${esc(greeting)}</p>
<p style="margin:0 0 16px">${esc(intro)}</p>
<p style="margin:0 0 24px">${esc(together)}</p>
<p style="margin:0 0 12px">${mailButton("Start your application", link)}</p>
<p style="margin:0 0 24px;font-size:12px;color:#555555">${esc(fallback)}<br><a href="${esc(link)}" style="color:#111111">${esc(link)}</a></p>`,
    footer: `${esc(account)}${esc(expiry)}<br>${esc(privacy)}`
  });
  return { subject: mailSubject(test, `You’re invited to apply · ${place}`), text, html };
}
