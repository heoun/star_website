// Real outbound mail through the legacy sender, which already owns the safety
// rule this repo lives by: on a loopback request nothing leaves the machine
// unless DEV_REAL_EMAIL=true, and production always sends. Templates render
// here, next to the transport, so wording changes never touch core.

import { sendEmail } from "../../../worker/email.js";
import type { EmailPort, EmailSend, EmailTemplate } from "../../contracts/email.ts";

const FROM_ADDRESS = "Star Real Estate Website <no-reply@starreusa.com>";

interface Rendered {
  subject: string;
  text: string;
}

function render(template: EmailTemplate, data: Record<string, string>): Rendered {
  switch (template) {
    case "application_received":
      return {
        subject: "We received your application",
        text: [
          `Hi ${data.name || "there"},`,
          "",
          "Your rental application has been received. The next step is the",
          "screening invitation, which arrives in a separate email.",
          "",
          "Star Real Estate",
        ].join("\n"),
      };
    case "screening_invite":
      return {
        subject: "Your screening invitation",
        text: [
          `Hi ${data.name || "there"},`,
          "",
          "Please complete your screening here:",
          data.screeningUrl || "",
          "",
          "Star Real Estate",
        ].join("\n"),
      };
    case "decision_package":
      return {
        subject: "An application package for your review",
        text: [
          "Hello,",
          "",
          "An application package for your unit is ready for your decision.",
          "Open the link below to review the summary and approve or decline:",
          "",
          data.decisionUrl || "",
          "",
          "The link is personal to you and expires. If you have questions,",
          "reply to this email and our office will follow up.",
          "",
          "Star Real Estate",
        ].join("\n"),
      };
    case "decision_recorded":
      return {
        subject: `Landlord decision recorded: ${data.approved === "true" ? "approved" : "declined"}`,
        text: [
          `Case ${data.caseId || ""}.`,
          "",
          `The landlord has ${data.approved === "true" ? "approved" : "declined"} the application package.`,
        ].join("\n"),
      };
    case "lease_sent":
      return {
        subject: "Your lease is ready to sign",
        text: [
          "Hello,",
          "",
          "The lease has been prepared and sent for signature. Please check",
          "your inbox for the signing request and complete your signature.",
          "",
          "Star Real Estate",
        ].join("\n"),
      };
    case "lease_executed":
      return {
        subject: "Your lease is fully signed",
        text: [
          "Hello,",
          "",
          "Everyone has signed. A copy of the executed lease is kept on file",
          "and available through your portal.",
          "",
          "Star Real Estate",
        ].join("\n"),
      };
  }
}

export function makeResendEmail(env: Record<string, unknown>, request: Request): EmailPort {
  let counter = 0;
  return {
    async send(msg: EmailSend) {
      const rendered = render(msg.template, msg.data);
      const delivered = await sendEmail(request, env, {
        from: FROM_ADDRESS,
        to: msg.to,
        subject: rendered.subject,
        text: rendered.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      });
      counter += 1;
      // Delivery failure is logged by the sender; the flow is not aborted over
      // a notification. The outbox ring will add retries.
      return { messageId: delivered ? `resend-${counter}` : "unsent" };
    },
  };
}
