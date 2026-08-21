// The one place that decides whether an email actually leaves the machine.
//
// Reviewing the wording of a notification is a normal thing to do while
// developing, and it must not mean mailing the real inbox from a laptop. On a
// loopback request the message is printed to the dev server's terminal
// instead — which is more useful than sending it, since the whole body is
// right there in the log.

import { isLocalRequest } from "./env.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Returns whether the message was delivered — or, locally, shown.
export async function sendEmail(request, env, message) {
  if (isLocalRequest(request)) {
    console.log(
      [
        "",
        "──── email (not sent: local development) ────",
        `To:      ${[].concat(message.to).join(", ")}`,
        message.reply_to ? `Reply-to: ${message.reply_to}` : null,
        `Subject: ${message.subject}`,
        "",
        message.text,
        "────────────────────────────────────────────"
      ].filter((line) => line !== null).join("\n")
    );
    return true;
  }

  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not configured; the message was not sent.");
    return false;
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message)
    });

    if (!response.ok) {
      console.error("Resend API error", response.status, await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.error("Resend request failed", error);
    return false;
  }
}
