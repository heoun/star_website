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

  const isRealDate = (value) => {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    if (!match) return false;
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  };

  const isValidPhone = (value) => {
    const digits = value.replace(/\D/g, "");
    return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
  };

  const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

  // The date input reports yyyy-mm-dd; store the familiar US format.
  // The fallback keeps raw text from browsers without a date control.
  const toUsDate = (raw) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    return match ? `${match[2]}/${match[3]}/${match[1]}` : raw;
  };

  // ---- Repeatable sections ------------------------------------------------
  // Each repeater owns a .rep-items container and stamps entries out of a
  // <template>. Entries serialize to plain objects keyed by data-field.

  const makeRepeater = ({ itemsId, templateId, addId, min = 0, max = 10, initial = 0 }) => {
    const itemsEl = document.getElementById(itemsId);
    const tpl = document.getElementById(templateId);
    const addButton = addId ? document.getElementById(addId) : null;

    const sync = () => {
      const items = itemsEl.querySelectorAll(".rep-item");
      itemsEl.querySelectorAll(".remove-entry").forEach((button) => {
        button.hidden = items.length <= min;
      });
      if (addButton) addButton.hidden = items.length >= max;
    };

    const add = () => {
      if (itemsEl.querySelectorAll(".rep-item").length >= max) return;
      itemsEl.appendChild(tpl.content.cloneNode(true));
      sync();
    };

    itemsEl.addEventListener("click", (event) => {
      const button = event.target.closest(".remove-entry");
      if (!button) return;
      button.closest(".rep-item")?.remove();
      sync();
    });

    addButton?.addEventListener("click", add);
    for (let i = 0; i < initial; i += 1) add();
    sync();

    return {
      entries() {
        return Array.from(itemsEl.querySelectorAll(".rep-item")).map((item) => {
          const entry = {};
          let filled = false;
          item.querySelectorAll("[data-field]").forEach((input) => {
            const value = input.value.trim();
            entry[input.dataset.field] = value;
            if (value !== "" && input.tagName !== "SELECT") filled = true;
          });
          return { entry, filled, item };
        });
      }
    };
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
      errorEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    // The CSS hides the empty date input's locale format hint; this class
    // brings the value back into view as soon as one is set.
    form.querySelectorAll('input[type="date"]').forEach((input) => {
      const syncClass = () => input.classList.toggle("has-value", input.value !== "");
      input.addEventListener("input", syncClass);
      input.addEventListener("change", syncClass);
    });

    const ssnInput = document.getElementById("ssn");
    const ssnToggle = document.getElementById("ssn-toggle");
    ssnToggle.addEventListener("click", () => {
      const show = ssnInput.type === "password";
      ssnInput.type = show ? "text" : "password";
      ssnToggle.textContent = show ? "Hide" : "Show";
      ssnToggle.setAttribute("aria-label", show ? "Hide SSN" : "Show SSN");
    });

    const employment = makeRepeater({ itemsId: "rep-employment", templateId: "tpl-employment", addId: "add-employment" });
    const rental = makeRepeater({ itemsId: "rep-rental", templateId: "tpl-rental", addId: "add-rental", initial: 1 });
    const references = makeRepeater({ itemsId: "rep-references", templateId: "tpl-reference", min: 3, max: 3, initial: 3 });
    const emergency = makeRepeater({ itemsId: "rep-emergency", templateId: "tpl-emergency", addId: "add-emergency", min: 1, max: 3, initial: 1 });
    const pets = makeRepeater({ itemsId: "rep-pets", templateId: "tpl-pet", addId: "add-pet" });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorEl.hidden = true;

      if (!form.reportValidity()) return;

      const field = (name) => form.elements[name].value;

      const moveIn = toUsDate(field("move_in"));
      const dob = toUsDate(field("dob"));
      const ssnDigits = field("ssn").replace(/\D/g, "");

      const problems = [];

      if (!isValidEmail(field("email").trim())) {
        problems.push("Please enter a valid email address.");
      }
      if (!isValidPhone(field("phone"))) {
        problems.push("Please enter a valid phone number, e.g. (718) 555-0123.");
      }
      if (!isRealDate(dob)) {
        problems.push("Please pick your date of birth.");
      } else {
        const [month, day, year] = dob.split("/").map(Number);
        const cutoff = new Date();
        cutoff.setFullYear(cutoff.getFullYear() - 18);
        if (new Date(year, month - 1, day) > cutoff) {
          problems.push("Applicants must be at least 18 years old.");
        }
      }
      if (ssnDigits.length !== 9) {
        problems.push("Please enter your 9-digit Social Security Number.");
      }
      if (!isRealDate(moveIn)) {
        problems.push("Please pick a move-in date.");
      }
      const household = Number(field("household_size"));
      if (!Number.isInteger(household) || household < 1 || household > 20) {
        problems.push("Please enter the number of occupants (1-20).");
      }
      const leaseTerm = Number(field("lease_term_months"));
      if (!Number.isInteger(leaseTerm) || leaseTerm < 1 || leaseTerm > 60) {
        problems.push("Please enter a lease term between 1 and 60 months.");
      }

      const optionalPhone = (value, label) => {
        if (value.trim() !== "" && !isValidPhone(value)) problems.push(`Please check the ${label} phone number.`);
      };
      const optionalEmail = (value, label) => {
        if (value.trim() !== "" && !isValidEmail(value.trim())) problems.push(`Please check the ${label} email address.`);
      };

      optionalPhone(field("supervisor_phone"), "supervisor");
      optionalEmail(field("supervisor_email"), "supervisor");

      const employmentEntries = [];
      for (const { entry, filled } of employment.entries()) {
        if (!filled) continue;
        if (!entry.employer) {
          problems.push("Each previous employment needs at least the employer name.");
          break;
        }
        optionalPhone(entry.supervisor_phone, "previous employment supervisor");
        optionalEmail(entry.supervisor_email, "previous employment supervisor");
        employmentEntries.push(entry);
      }

      const rentalEntries = [];
      for (const { entry, filled } of rental.entries()) {
        if (!filled) continue;
        if (!entry.address) {
          problems.push("Each rental history entry needs at least the address.");
          break;
        }
        optionalPhone(entry.landlord_phone, "landlord");
        optionalEmail(entry.landlord_email, "landlord");
        rentalEntries.push(entry);
      }

      const referenceEntries = references.entries().map(({ entry }) => entry);
      for (const entry of referenceEntries) {
        if (!isValidPhone(entry.phone)) {
          problems.push("Each reference needs a valid phone number.");
          break;
        }
        optionalEmail(entry.email, "reference");
      }

      const emergencyEntries = [];
      for (const { entry, filled } of emergency.entries()) {
        if (!filled) continue;
        if (!entry.name || !isValidPhone(entry.phone)) {
          problems.push("Each emergency contact needs a name and a valid phone number.");
          break;
        }
        emergencyEntries.push(entry);
      }
      if (emergencyEntries.length === 0) {
        problems.push("Please add at least one emergency contact.");
      }

      const petEntries = pets.entries()
        .filter(({ entry, filled }) => filled || entry.type)
        .map(({ entry }) => entry);

      if (problems.length > 0) {
        showError(problems.join(" "));
        return;
      }

      submitButton.disabled = true;
      submitButton.textContent = "Submitting…";

      try {
        const response = await fetch("/api/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            listing_id: id,
            first_name: field("first_name"),
            last_name: field("last_name"),
            dob,
            ssn: ssnDigits,
            phone: field("phone"),
            email: field("email"),
            current_address: field("current_address"),
            move_in: moveIn,
            lease_term_months: leaseTerm,
            household_size: household,
            children_under_11: form.elements.children_under_11.value === "yes",
            income_note: field("income_note"),
            current_employer: {
              employer: field("employer"),
              position: field("employer_position"),
              start: field("employer_start"),
              supervisor_name: field("supervisor_name"),
              supervisor_phone: field("supervisor_phone"),
              supervisor_email: field("supervisor_email")
            },
            employment_history: employmentEntries,
            rental_history: rentalEntries,
            reference_contacts: referenceEntries,
            emergency_contacts: emergencyEntries,
            pets: petEntries,
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
