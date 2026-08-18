const CONTACT_EMAIL = "info@starreusa.com";
const FROM_ADDRESS = "Star Real Estate Website <no-reply@starreusa.com>";
const RESEND_ENDPOINT = "https://api.resend.com/emails";

const ALLOWED_PROPERTY_TYPES = ["Residential", "Commercial"];
const ALLOWED_TRANSACTION_TYPES = ["Lease", "Purchase"];

export async function handleInquiry(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return renderPage("Missing information", "The form data could not be read. Please go back and try again.", 400);
  }

  const value = (key) => String(form.get(key) ?? "");

  // Honeypot: bots that fill the hidden field get a fake success page.
  if (value("website").trim() !== "") {
    return renderPage("Inquiry received", "Thank you. The Star Real Estate team will review your message shortly.");
  }

  const name = cleanLine(value("name"), 100);
  const email = cleanLine(value("email"), 180);
  const phone = cleanLine(value("phone"), 60);
  const propertyType = cleanLine(value("property_type"), 40);
  const transactionType = cleanLine(value("transaction_type"), 40);
  const propertyDetails = cleanMessage(value("property_details"), 2000);

  const errors = [];

  if (name === "") {
    errors.push("name");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("contact email");
  }

  if (phone === "") {
    errors.push("phone number");
  }

  if (!ALLOWED_PROPERTY_TYPES.includes(propertyType)) {
    errors.push("property type");
  }

  if (!ALLOWED_TRANSACTION_TYPES.includes(transactionType)) {
    errors.push("lease or purchase");
  }

  if (errors.length > 0) {
    return renderPage(
      "Missing information",
      `Please go back and complete the required fields: ${errors.join(", ")}.`,
      422
    );
  }

  const submittedAt = `${new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false })} ET`;
  const remoteAddress = request.headers.get("CF-Connecting-IP") || "Unavailable";
  const body = `New property inquiry from starreusa.com

Name: ${name}
Contact Email: ${email}
Phone Number: ${phone}
Property Type: ${propertyType}
Lease or Purchase: ${transactionType}

Property Details:
${propertyDetails}

Submitted: ${submittedAt}
IP Address: ${remoteAddress}
`;

  let sent = false;
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [CONTACT_EMAIL],
        reply_to: email,
        subject: "Property Inquiry",
        text: body
      })
    });

    sent = response.ok;
    if (!sent) {
      console.error("Resend API error", response.status, await response.text());
    }
  } catch (error) {
    console.error("Resend request failed", error);
  }

  if (!sent) {
    return renderPage(
      "Message not sent",
      `The form could not send right now. Please email ${CONTACT_EMAIL} directly with your property details.`,
      500
    );
  }

  return renderPage("Inquiry received", "Thank you. The Star Real Estate team will review your message shortly.");
}

function cleanLine(value, maxLength) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanMessage(value, maxLength) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

export function renderPage(title, message, statusCode = 200) {
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | Star Real Estate</title>
  <style>
    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: "Inter", system-ui, -apple-system, sans-serif;
      background: #f6f4ef;
      color: #141834;
      padding: 24px;
    }

    main {
      width: min(560px, 100%);
      border: 1px solid #dcd8cd;
      background: #ffffff;
      padding: 34px;
    }

    h1 {
      margin: 0 0 10px;
      font-family: "Inter Tight", "Inter", sans-serif;
      color: #141834;
      font-size: 28px;
      line-height: 1.12;
      letter-spacing: -0.02em;
    }

    p {
      margin: 0 0 18px;
      color: #666d8a;
      line-height: 1.7;
      font-size: 14px;
    }

    a {
      display: inline-flex;
      background: #3E3EE5;
      color: #ffffff;
      padding: 12px 22px;
      text-decoration: none;
      font-family: "IBM Plex Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    a:hover { background: #141834; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/contact-us/">Back to Contact Us</a>
  </main>
</body>
</html>
`;

  return new Response(body, {
    status: statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
