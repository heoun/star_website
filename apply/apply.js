(function () {
  // Turnstile site key (public identifier, safe to ship to browsers).
  // Leave empty to run without the widget; the Worker only enforces
  // verification once its TURNSTILE_SECRET_KEY secret is configured.
  const TURNSTILE_SITE_KEY = "";

  const container = document.getElementById("apply");
  const template = document.getElementById("form-template");
  const backLink = document.getElementById("back-link");
  if (!container || !template) return;

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const showState = (message) => {
    container.innerHTML = `<p class="state">${escapeHtml(message)}</p>`;
  };

  const id = new URLSearchParams(window.location.search).get("id") || "";

  if (!id) {
    showState("No property was requested. Browse the listings to pick one.");
    return;
  }

  backLink.href = `../property/?id=${encodeURIComponent(id)}`;

  let widgetId = null;

  const mountTurnstile = () => {
    if (!TURNSTILE_SITE_KEY) return;

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__mountTurnstile";
    script.async = true;
    window.__mountTurnstile = () => {
      const box = document.getElementById("turnstile-box");
      if (box && window.turnstile) {
        widgetId = window.turnstile.render(box, { sitekey: TURNSTILE_SITE_KEY });
      }
    };
    document.head.appendChild(script);
  };

  const renderForm = (property) => {
    container.innerHTML = "";
    container.appendChild(template.content.cloneNode(true));

    const summary = document.getElementById("listing-summary");
    document.getElementById("summary-price").textContent = property.price || "";
    document.getElementById("summary-title").textContent = property.title || "Property";
    document.getElementById("summary-address").textContent =
      [property.neighborhood, property.location].filter(Boolean).join(" · ");
    summary.hidden = false;

    document.title = `Apply: ${property.title || "Property"} | Star Real Estate`;

    mountTurnstile();
    wireForm(property);
  };

  const wireForm = (property) => {
    const form = document.getElementById("apply-form");
    const submitButton = document.getElementById("submit-button");
    const errorEl = document.getElementById("form-error");

    const showError = (message) => {
      errorEl.textContent = message;
      errorEl.hidden = false;
    };

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorEl.hidden = true;

      if (!form.reportValidity()) return;

      submitButton.disabled = true;
      submitButton.textContent = "Submitting…";

      const field = (name) => form.elements[name].value;

      // The date input reports yyyy-mm-dd; store the familiar US format.
      const moveIn = (() => {
        const raw = field("move_in");
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
        return match ? `${match[2]}/${match[3]}/${match[1]}` : raw;
      })();

      try {
        const response = await fetch("/api/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            listing_id: id,
            name: field("name"),
            email: field("email"),
            phone: field("phone"),
            move_in: moveIn,
            household_size: field("household_size"),
            income_note: field("income_note"),
            message: field("message"),
            website: field("website"),
            turnstile_token: widgetId !== null && window.turnstile
              ? window.turnstile.getResponse(widgetId) || ""
              : ""
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error || "The application could not be submitted. Please try again.");
        }

        container.innerHTML = `
          <div class="success">
            <h2>Application received</h2>
            <p>Thank you — the Star Real Estate team will review your application for
               ${escapeHtml(property.title || "this property")} and follow up shortly.</p>
            <a href="../property/?id=${encodeURIComponent(id)}">Back to the property</a>
          </div>
        `;
      } catch (error) {
        showError(error.message);
        submitButton.disabled = false;
        submitButton.textContent = "Submit application";
        if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
      }
    });
  };

  fetch(`../data/property.json?id=${encodeURIComponent(id)}`, { cache: "no-store" })
    .then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "This property could not be loaded.");
      return payload;
    })
    .then(renderForm)
    .catch((error) => showState(error.message));
})();
