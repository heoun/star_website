import type { OnboardingMail } from "../../contracts/administration.ts";
import { sendEmail } from "../../../worker/email.js";
import { isLocalRequest } from "../../../worker/env.js";
import { MAIL_FROM, esc, mailShell, mailButton } from '../../../worker/mail-layout.js';
export function makeOnboardingMail(env: Record<string,unknown>, request: Request): OnboardingMail {
  return { async invite(to, name, url, note) {
    const subject = note ? "Please update your property information — Star Realty" : "Welcome to Star Realty — share your property details";
    const text = `Hello ${name},\n\n${note ? `Our team reviewed your information and requested these updates:\n${note}\n\n` : "Thank you for partnering with Star Realty.\n\n"}Please complete your landlord and property information here:\n${url}\n\nYou can save a draft and return to this private link within 14 days. Our team will review your submission before adding your properties. No account is required to fill in this form.\n\nStar Realty`;
    const html = mailShell(env,{title:subject,heading:"Let's get your property ready.",
      body:`<p style="margin:0 0 16px">Hello ${esc(name)},</p>${note ? `<p style="margin:0 0 16px">Our team requested these updates:</p><blockquote style="white-space:pre-wrap">${esc(note)}</blockquote>` : '<p style="margin:0 0 16px">Thank you for partnering with Star Realty.</p>'}<p style="margin:0 0 24px">Share your landlord contact information, property addresses and utility arrangements. You can save your progress and return later.</p><p style="margin:0 0 12px">${mailButton(note ? 'Update property information' : 'Complete property information',url)}</p><p style="margin:0 0 24px;font-size:12px;color:#555555">If the button does not work, open this address:<br><a href="${esc(url)}" style="color:#111111">${esc(url)}</a></p>`,
      footer:'No account is required. This private link expires in 14 days. Your properties are added after our team reviews your submission.'});
    const ok = await sendEmail(request, env, { from: MAIL_FROM, to: [to], subject, text, html });
    return !ok ? "failed" : isLocalRequest(request) && env.DEV_REAL_EMAIL !== "true" ? "preview" : "sent";
  } };
}
