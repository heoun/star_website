import type { OnboardingMail } from "../../contracts/administration.ts";
import { sendEmail } from "../../../worker/email.js";
import { isLocalRequest } from "../../../worker/env.js";
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function makeOnboardingMail(env: Record<string,unknown>, request: Request): OnboardingMail {
  return { async invite(to, name, url, note) {
    const subject = note ? "Please update your property information — Star Realty" : "Welcome to Star Realty — share your property details";
    const text = `Hello ${name},\n\n${note ? `Our team reviewed your information and requested these updates:\n${note}\n\n` : "Thank you for partnering with Star Realty.\n\n"}Please complete your landlord and property information here:\n${url}\n\nYou can save a draft and return to this private link within 14 days. Our team will review your submission before adding your properties. No account is required to fill in this form.\n\nStar Realty`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#193446;line-height:1.7"><p style="letter-spacing:3px;font-weight:bold">STAR REALTY</p><h1 style="font-size:26px">Let's get your property ready.</h1><p>Hello ${esc(name)},</p>${note ? `<p>Our team requested these updates:</p><blockquote style="white-space:pre-wrap">${esc(note)}</blockquote>` : '<p>Thank you for partnering with Star Realty.</p>'}<p>Share your landlord contact information, property addresses and utility arrangements. You can save your progress and return later.</p><p><a href="${esc(url)}" style="background:#193446;color:white;padding:14px 24px;display:inline-block;border-radius:8px;text-decoration:none">${note ? "Update property information" : "Complete property information"}</a></p><p>No account is required. This private link expires in 14 days. Your properties are added after our team reviews your submission.</p><p>If the button does not work, open this address:<br><a href="${esc(url)}">${esc(url)}</a></p></div>`;
    const ok = await sendEmail(request, env, { from: "Star Realty <no-reply@starreusa.com>", to: [to], subject, text, html });
    return !ok ? "failed" : isLocalRequest(request) && env.DEV_REAL_EMAIL !== "true" ? "preview" : "sent";
  } };
}
