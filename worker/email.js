// The one place that decides whether an email actually leaves the machine.
//
// Reviewing the wording of a notification is a normal thing to do while
// developing, and it must not mean mailing the real inbox from a laptop. On a
// loopback request the message is printed to the dev server's terminal
// instead — which is more useful than sending it, since the whole body is
// right there in the log.
//
// DEV_REAL_EMAIL=true in .dev.vars lifts that for a delivery rehearsal:
// local requests then send through Resend like production does (which needs
// RESEND_API_KEY set too). The flag is only ever read on a loopback request,
// so it can do nothing in production.

import { isLocalRequest } from "./env.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Returns whether the message was delivered — or, locally, shown.
export async function sendEmail(request, env, message) {
  const local = isLocalRequest(request);

  if (local && env.DEV_REAL_EMAIL !== "true") {
    // Local demo/test inbox; never used for a non-loopback request.
    if (env.LOCAL_EMAIL_SINK?.send) { await env.LOCAL_EMAIL_SINK.send(message); return true; }
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

  if (local) {
    console.log(`DEV_REAL_EMAIL is on: sending a real email to ${[].concat(message.to).join(", ")}.`);
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
