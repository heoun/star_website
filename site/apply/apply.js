import { endDateFor } from "../shared/lease-dates.js";

(function () {
  // Turnstile site key (public identifier, safe to ship to browsers).
  // Leave empty to run without the widget; the Worker only enforces
  // verification once its TURNSTILE_SECRET_KEY secret is configured.
  const TURNSTILE_SITE_KEY = "";

  const TOTAL_STEPS = 7;
  const REFERENCES_REQUIRED = 2;

  const container = document.getElementById("apply");
  const template = document.getElementById("form-template");
  const backLink = document.getElementById("back-link");
  const headerStep = document.getElementById("header-step");
  const headerProperty = document.getElementById("header-property");
  const progress = document.getElementById("progress");
  const progressFill = document.getElementById("progress-fill");
  const liveRegion = document.getElementById("live-region");
  const helpDialog = document.getElementById("help-dialog");
  if (!container || !template) return;

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const announce = (message) => { if (liveRegion) liveRegion.textContent = message; };

  const id = new URLSearchParams(window.location.search).get("id") || "";

  // ------------------------------------------------------------- validators

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
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
  };

  const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

  // The date input reports yyyy-mm-dd; store the familiar US format.
  // The fallback keeps raw text from browsers without a date control.
  const toUsDate = (raw) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    return match ? `${match[2]}/${match[3]}/${match[1]}` : raw;
  };

  const isAdult = (usDate) => {
    const [month, day, year] = usDate.split("/").map(Number);
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 18);
    return new Date(year, month - 1, day) <= cutoff;
  };

  // --------------------------------------------------------------- the page

  // The property is what the whole page is about, so a failure to load one is
  // not a line of grey text — it says what happened and offers the way back to
  // the homes that do exist.
  const showFailure = (message) => {
    container.innerHTML = `
      <div class="app-failure">
        <h1>This application could not be opened</h1>
        <p>${escapeHtml(message)}</p>
        <p><a class="app-help" href="../rental/">Browse homes for rent</a></p>
      </div>`;
  };

  // Applying requires an applicant account: the Worker takes the
  // application's email from the signed-in session, so the form has to have
  // one. Whoever arrives without it goes to the portal and comes back here.
  const portalSignIn = () => {
    window.location.replace(
      `../portal/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
    );
  };

  if (!id) {
    showFailure("No property was requested, so there is nothing to apply for.");
    return;
  }

  backLink.href = `../property/?id=${encodeURIComponent(id)}`;

  // --------------------------------------------------------- repeated records
  //
  // Each record is a <fieldset> with its own numbered <legend>, and every
  // control inside it is stamped with an id, a name and a label of its own —
  // "landlord phone" alone says nothing about which of three homes it belongs
  // to. The id carries a key that is never reused; the legend carries the
  // position, which is renamed whenever a record is added or removed, so
  // the titles a reader sees always run in order while the ids stay stable.
  //
  // `legendFor` names a record by its position — the rental list calls its
  // first record "Current landlord" and every later one "Previous landlord" —
  // and falls back to "<legend> <n>".

  const makeRepeater = ({ listId, templateId, addId, name, legend, legendFor,
                         min = 0, max = 10, initial = 0,
                         required = [], requiredScope = "all", onChange }) => {
    const list = document.getElementById(listId);
    const tpl = document.getElementById(templateId);
    const addButton = addId ? document.getElementById(addId) : null;
    let nextKey = 0;

    const cards = () => Array.from(list.querySelectorAll(":scope > .repeat-card"));

    const stamp = (card, key) => {
      card.dataset.key = String(key);
      card.querySelector("legend").id = `${name}-legend-${key}`;
      card.querySelectorAll("[data-field]").forEach((control) => {
        const field = control.dataset.field;
        control.id = `${name}-${field}-${key}`;
        control.name = `${name}_${field}_${key}`;
        const label = control.closest(".field")?.querySelector("[data-label]");
        if (label) label.htmlFor = control.id;
      });
      // A help line one rule shares between fields — the rental card's "a
      // phone or an email is enough" — is stamped like the controls and
      // attached to each field it names, so a screen reader hears the rule
      // on the very inputs it loosens.
      card.querySelectorAll("[data-card-help]").forEach((note, index) => {
        note.id = `${name}-cardhelp-${key}-${index}`;
        String(note.dataset.cardHelp).split(/\s+/).forEach((fieldName) => {
          card.querySelector(`[data-field="${fieldName}"]`)?.setAttribute("aria-describedby", note.id);
        });
      });
    };

    const renumber = () => {
      const items = cards();
      items.forEach((card, index) => {
        const title = legendFor ? legendFor(index) : `${legend} ${index + 1}`;
        card.querySelector("legend").textContent = title;

        // The validators require these, so the markup has to say so: without it
        // a screen reader is told nothing is required inside a record, next to
        // sibling fields that carry a visible "Optional" chip — which reads as
        // the opposite of the truth.
        for (const field of required) {
          const control = card.querySelector(`[data-field="${field}"]`);
          if (control) control.toggleAttribute("required", requiredScope === "all" || index === 0);
        }

        const head = card.querySelector(".repeat-head");
        head.innerHTML = "";
        if (items.length > min) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "repeat-remove";
          button.textContent = "Remove";
          // The visible word is inside the spoken name, which is what a voice
          // user says to press it — and the title is what tells three
          // identical buttons apart.
          button.setAttribute("aria-label", `Remove ${title.toLowerCase()}`);
          head.appendChild(button);
        }
      });
      if (addButton) addButton.hidden = items.length >= max;
      if (onChange) onChange();
    };

    const add = ({ focus = false } = {}) => {
      if (cards().length >= max) return null;
      const key = nextKey;
      nextKey += 1;
      const fragment = tpl.content.cloneNode(true);
      const card = fragment.querySelector(".repeat-card");
      stamp(card, key);
      list.appendChild(fragment);
      renumber();
      if (focus) {
        const heading = card.querySelector("legend");
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "instant" : "smooth" });
        announce(`${card.querySelector("legend").textContent} added.`);
      }
      return card;
    };

    list.addEventListener("click", (event) => {
      const button = event.target.closest(".repeat-remove");
      if (!button) return;
      const card = button.closest(".repeat-card");
      const title = card.querySelector("legend").textContent;

      // Nothing typed is nothing to lose; a filled record is asked about,
      // because there is no undo and no draft to fall back on.
      const hasValue = Array.from(card.querySelectorAll("[data-field]"))
        .some((control) => control.tagName !== "SELECT" && control.value.trim() !== "");
      if (hasValue && !window.confirm(`Remove ${title.toLowerCase()}? What you typed in it will be lost.`)) return;

      const previous = card.previousElementSibling;
      card.remove();
      renumber();
      const landing = previous?.querySelector("legend") || addButton;
      landing?.focus({ preventScroll: true });
      announce(`${title} removed.`);
    });

    addButton?.addEventListener("click", () => add({ focus: true }));
    for (let i = 0; i < initial; i += 1) add();
    renumber();

    return {
      count: () => cards().length,
      add,
      entries() {
        return cards().map((card) => {
          const values = {};
          let filled = false;
          card.querySelectorAll("[data-field]").forEach((control) => {
            const value = control.value.trim();
            values[control.dataset.field] = value;
            if (value !== "" && control.tagName !== "SELECT") filled = true;
          });
          return { card, values, filled, control: (field) => card.querySelector(`[data-field="${field}"]`) };
        });
      }
    };
  };

  // -------------------------------------------------------------- rendering

  const renderForm = (property, accountEmail) => {
    container.innerHTML = "";
    container.appendChild(template.content.cloneNode(true));

    const title = property.title || "This property";
    headerProperty.textContent = title;
    document.getElementById("help-property").textContent = title;
    document.title = `Apply for ${title} | Star Real Estate`;

    document.getElementById("summary-price").textContent = property.price || "";
    document.getElementById("property-heading").textContent = title;
    // The unit is what tells two applications in the same building apart, and
    // this card exists to confirm which home is being applied for.
    const unit = String(property.unit ?? "").trim();
    document.getElementById("summary-address").textContent =
      [property.location, unit ? `Unit ${unit}` : ""]
        .filter(Boolean).join(" · ");
    // "0 bedrooms" is what a studio would read as, while the property page the
    // applicant just came from says "Studio" — and this card exists to confirm
    // they are applying for the home they were looking at.
    const count = (value, word) => {
      const text = String(value ?? "").trim();
      if (text === "" || text === "0") return "";
      return `${text} ${word}${text === "1" ? "" : "s"}`;
    };
    document.getElementById("summary-facts").textContent = [
      property.property_type,
      String(property.bedrooms ?? "").trim() === "0" ? "Studio" : count(property.bedrooms, "bedroom"),
      count(property.bathroom, "bathroom")
    ].filter(Boolean).join(" · ");
    // Masked, because the sidebar sits on screen for the whole application:
    // enough to recognise your own account, not enough to read over a shoulder.
    const maskedAccount = (() => {
      const at = accountEmail.indexOf("@");
      if (at < 2) return accountEmail;
      return `${accountEmail[0]}•••••${accountEmail.slice(at)}`;
    })();
    document.getElementById("summary-account").textContent = maskedAccount;

    // Shown, not sent: the Worker files the application under the session's
    // email whatever the form says, so the form says the same thing.
    const emailInput = document.getElementById("email");
    emailInput.value = accountEmail;
    emailInput.readOnly = true;

    wireForm(property);
  };

  const wireForm = (property) => {
    const form = document.getElementById("apply-form");
    const panels = Array.from(form.querySelectorAll(".form-step"));
    const stepLinks = Array.from(document.querySelectorAll(".step-link"));
    const backButton = document.getElementById("step-back");
    const nextButton = document.getElementById("step-next");
    const actionNote = document.getElementById("action-note");
    const reviewList = document.getElementById("review-list");
    const referenceCount = document.getElementById("reference-count");

    const state = { step: 1, visited: new Set([1]), dirty: false, submitting: false, done: false };
    let widgetId = null;
    let turnstileMounted = false;

    const field = (name) => form.elements[name];
    const value = (name) => String(field(name)?.value ?? "").trim();

    // ------------------------------------------------- the work-or-school branch
    //
    // Step 3 opens on a question: are you working, or a student? The answer
    // decides which half of the step is on screen, which fields are required,
    // and which documents the portal will ask for. The branch not chosen is
    // hidden rather than emptied, so changing the answer brings back whatever
    // was typed there.

    const employmentStatus = () => String(form.elements.employment_status?.value ?? "");

    const EMPLOYED_REQUIRED = ["employer", "employer_position", "employer_start", "income_note",
      "supervisor_name", "supervisor_phone", "supervisor_email"];
    const STUDENT_REQUIRED = ["school_name", "major", "country", "entry_year", "graduation_year"];

    const stepName = (step) => ["Roommates", "About You", "Income", "Rental History",
      "References", "Additional Information", "Review & Submit"][step - 1];

    const applyBranch = () => {
      const status = employmentStatus();
      document.getElementById("branch-employed").hidden = status !== "employed";
      document.getElementById("branch-student").hidden = status !== "student";
      EMPLOYED_REQUIRED.forEach((name) => field(name)?.toggleAttribute("required", status === "employed"));
      STUDENT_REQUIRED.forEach((name) => field(name)?.toggleAttribute("required", status === "student"));
    };

    // ------------------------------------------------------- the identity field
    //
    // One input holds an SSN or a passport number; the radio above it decides
    // which, and the input's own label, hint and keyboard follow the choice.

    const idType = () => String(form.elements.id_type?.value ?? "ssn") || "ssn";

    const idNumber = () => {
      const raw = value("id_number");
      return idType() === "passport"
        ? raw.replace(/\s+/g, "").toUpperCase()
        : raw.replace(/\D/g, "");
    };

    const isValidIdNumber = () => {
      const cleaned = idNumber();
      if (idType() === "passport") return /^[A-Z0-9]{5,20}$/.test(cleaned);
      return /^\d{9}$/.test(cleaned) && !/^(\d)\1{8}$/.test(cleaned);
    };

    const applyIdType = () => {
      const passport = idType() === "passport";
      const input = field("id_number");
      document.getElementById("id-number-label").textContent =
        passport ? "Passport number" : "Social Security Number";
      input.placeholder = passport ? "Passport number" : "###-##-####";
      input.inputMode = passport ? "text" : "numeric";
      input.maxLength = passport ? 20 : 11;
      document.getElementById("id-number-help").textContent = passport
        ? "Letters and digits only, as printed on your passport."
        : "If you do not have an SSN yet, you can use your passport number instead.";
    };

    // ---------------------------------------------------------- the lease dates
    //
    // The end date is arithmetic, not a question: start plus term, minus a
    // day. Asking for it would invite three answers that disagree — and the
    // arithmetic is imported from the same module the lease document uses,
    // so the date shown here is the date the lease will carry.

    const leaseEndText = () => {
      const months = Number(value("lease_term_months"));
      if (!Number.isInteger(months) || months < 1 || months > 60) return "";
      return endDateFor(value("move_in"), months);
    };

    const paintLeaseEnd = () => { field("lease_end").value = leaseEndText(); };

    // ------------------------------------------------------ repeated records
    //
    // The counter is declared before the repeaters because a repeater paints it
    // while it is still being built -- so it reads the records off the page
    // rather than through a binding that does not exist yet.

    const referenceCards = () =>
      Array.from(document.querySelectorAll("#rep-references > .repeat-card"));

    const completeReferences = () => referenceCards().filter((card) => {
      const value = (name) => card.querySelector(`[data-field="${name}"]`).value.trim();
      return value("name") !== "" && value("relationship") !== ""
        && isValidPhone(value("phone")) && isValidEmail(value("email"));
    }).length;

    function paintReferenceCount() {
      if (!referenceCount) return;
      const done = completeReferences();
      referenceCount.textContent =
        `${done} of ${REFERENCES_REQUIRED} references completed.`
        + (done < REFERENCES_REQUIRED ? " Each one needs a name, a relationship, a phone number, and an email." : "");
      referenceCount.classList.toggle("is-done", done >= REFERENCES_REQUIRED);
    }

    const employment = makeRepeater({
      listId: "rep-employment", templateId: "tpl-employment", addId: "add-employment",
      name: "employment", legend: "Previous Employment", max: 5
    });
    const rental = makeRepeater({
      listId: "rep-rental", templateId: "tpl-rental", addId: "add-rental",
      name: "rental", legend: "Previous Landlord",
      legendFor: (index) => (index === 0 ? "Current Landlord" : `Previous Landlord ${index}`),
      min: 1, max: 6, initial: 1,
      required: ["landlord_name", "contact", "address", "start", "monthly_rent"],
      requiredScope: "all"
    });
    const references = makeRepeater({
      listId: "rep-references", templateId: "tpl-reference", addId: "add-reference",
      name: "reference", legend: "Reference", min: REFERENCES_REQUIRED, max: 4,
      initial: REFERENCES_REQUIRED,
      required: ["name", "relationship", "phone", "email"], requiredScope: "all",
      onChange: () => paintReferenceCount()
    });
    // One lease signer per bedroom: a two-bedroom home takes the applicant
    // plus one roommate, a three-bedroom two. A listing whose bedroom count
    // cannot be read falls back to allowing one.
    const bedroomCount = parseInt(String(property.bedrooms ?? "").trim(), 10);
    const roommateCap = Number.isFinite(bedroomCount)
      ? Math.max(0, Math.min(4, bedroomCount - 1))
      : 1;

    const roommates = makeRepeater({
      listId: "rep-roommates", templateId: "tpl-roommate", addId: "add-roommate",
      name: "roommate", legend: "Roommate", max: Math.max(roommateCap, 1),
      required: ["first_name", "last_name", "phone", "email"], requiredScope: "all"
    });
    const emergency = makeRepeater({
      listId: "rep-emergency", templateId: "tpl-emergency", addId: "add-emergency",
      name: "emergency", legend: "Emergency Contact", min: 1, max: 4, initial: 1,
      required: ["name", "relationship", "phone", "email"], requiredScope: "all"
    });
    const pets = makeRepeater({
      listId: "rep-pets", templateId: "tpl-pet", addId: "add-pet", name: "pet", legend: "Pet", max: 10,
      required: ["species", "weight"], requiredScope: "all"
    });

    const hasRoommates = () => String(form.elements.has_roommates?.value ?? "");
    const hasPets = () => String(form.elements.has_pets?.value ?? "");

    // The two yes-or-no gates work like the work-or-school branch: the hidden
    // half keeps whatever was typed, and saying yes to an empty list starts it
    // off with one card to fill.
    const applyRoommates = () => {
      document.getElementById("branch-roommates").hidden = hasRoommates() !== "yes";
      if (hasRoommates() === "yes" && roommates.count() === 0) roommates.add();
    };
    const applyPets = () => {
      document.getElementById("branch-pets").hidden = hasPets() !== "yes";
      if (hasPets() === "yes" && pets.count() === 0) pets.add();
    };

    // A studio or one-bedroom home has no lease line for a roommate, so the
    // question is answered by the listing rather than asked.
    if (roommateCap === 0) {
      form.querySelector('[data-group="has_roommates"]')?.closest("fieldset")?.setAttribute("hidden", "");
      form.querySelectorAll('input[name="has_roommates"]').forEach((radio) => radio.removeAttribute("required"));
      const solo = document.getElementById("roommates-solo");
      solo.hidden = false;
      solo.textContent = `This home is listed as a ${bedroomCount === 0 ? "studio" : "one bedroom home"}, `
        + "so the lease covers a single applicant and there is no roommate to add.";
    } else {
      const capNote = document.getElementById("roommate-cap-note");
      capNote.hidden = false;
      capNote.textContent = Number.isFinite(bedroomCount)
        ? `With ${bedroomCount} bedrooms, this home takes you and up to ${roommateCap} `
          + `${roommateCap === 1 ? "roommate" : "roommates"}.`
        : `You can add up to ${roommateCap} ${roommateCap === 1 ? "roommate" : "roommates"} for this home.`;
    }

    // ----------------------------------------------------------- validation
    //
    // The rules are the ones the Worker enforces; what changed is when they
    // run. Continue checks the step in front of you. Submit checks all seven,
    // because the Worker will.

    const problem = (el, message) => ({ focus: el, mark: [el], message });
    // A button is not a control that can hold a wrong value, so it is flagged
    // rather than marked aria-invalid -- which would say something untrue about
    // it to a screen reader.
    const pointer = (el, message) => ({ focus: el, mark: [], flag: el, message });
    const groupProblem = (group, message) => ({
      focus: group.querySelector("input"),
      mark: Array.from(group.querySelectorAll("input")),
      group,
      message
    });

    // `label` carries its own determiner ("your supervisor's", "this
    // landlord's") so the sentences read naturally at every call site.
    const requiredPhone = (el, label, problems) => {
      if (!el) return;
      if (el.value.trim() === "") {
        problems.push(problem(el, `Enter ${label} phone number.`));
      } else if (!isValidPhone(el.value)) {
        problems.push(problem(el, `Check ${label} phone number. It needs ten digits, like (718) 555-0123.`));
      }
    };
    const requiredEmail = (el, label, problems) => {
      if (!el) return;
      if (el.value.trim() === "") {
        problems.push(problem(el, `Enter ${label} email address.`));
      } else if (!isValidEmail(el.value.trim())) {
        problems.push(problem(el, `Check ${label} email address.`));
      }
    };

    const required = (name, message, problems) => {
      const el = field(name);
      if (el && el.value.trim() === "") problems.push(problem(el, message));
      return el && el.value.trim() !== "";
    };

    const VALIDATORS = {
      1() {
        const problems = [];
        if (roommateCap === 0) return problems;

        if (hasRoommates() === "") {
          const group = form.querySelector('[data-group="has_roommates"]');
          problems.push(groupProblem(group, "Say whether any roommates are moving in with you."));
          return problems;
        }
        if (hasRoommates() !== "yes") return problems;

        const entries = roommates.entries();
        if (entries.filter(({ filled }) => filled).length === 0) {
          problems.push(pointer(document.getElementById("add-roommate"),
            "Add at least one roommate, or answer No."));
          return problems;
        }
        for (const entry of entries) {
          if (!entry.values.first_name) {
            problems.push(problem(entry.control("first_name"), "Enter this roommate's first name."));
          }
          if (!entry.values.last_name) {
            problems.push(problem(entry.control("last_name"), "Enter this roommate's last name."));
          }
          requiredPhone(entry.control("phone"), "this roommate's", problems);
          requiredEmail(entry.control("email"), "this roommate's", problems);
        }
        return problems;
      },

      2() {
        const problems = [];
        required("first_name", "Enter your first name.", problems);
        required("last_name", "Enter your last name.", problems);

        if (required("phone", "Enter a phone number we can reach you on.", problems)
            && !isValidPhone(value("phone"))) {
          problems.push(problem(field("phone"), "Enter a valid phone number, like (718) 555-0123."));
        }

        const dob = toUsDate(value("dob"));
        if (!isRealDate(dob)) problems.push(problem(field("dob"), "Pick your date of birth."));
        else if (!isAdult(dob)) problems.push(problem(field("dob"), "Applicants must be at least 18 years old."));

        if (value("id_number") === "") {
          problems.push(problem(field("id_number"), idType() === "passport"
            ? "Enter your passport number."
            : "Enter your nine-digit Social Security Number."));
        } else if (!isValidIdNumber()) {
          problems.push(problem(field("id_number"), idType() === "passport"
            ? "Check the passport number. It should be 5 to 20 letters and digits."
            : "That is not a valid Social Security Number. Enter the nine digits as printed on your card."));
        }

        required("address_street", "Enter your street address.", problems);
        required("address_unit", "Enter your apartment or unit.", problems);
        required("address_city", "Enter your city.", problems);
        required("address_state", "Enter your state.", problems);
        if (!/^\d{5}(-\d{4})?$/.test(value("address_zip"))) {
          problems.push(problem(field("address_zip"), "Enter a five-digit ZIP code."));
        }

        const moveIn = toUsDate(value("move_in"));
        if (!isRealDate(moveIn)) problems.push(problem(field("move_in"), "Pick the date you would like your lease to start."));

        const term = Number(value("lease_term_months"));
        if (!Number.isInteger(term) || term < 1 || term > 60) {
          problems.push(problem(field("lease_term_months"), "Enter a lease term between 1 and 60 months."));
        }
        return problems;
      },

      3() {
        const problems = [];
        const status = employmentStatus();

        if (status === "") {
          const group = form.querySelector('[data-group="employment_status"]');
          problems.push(groupProblem(group, "Say whether you are working or a student. The rest of this step depends on it."));
          return problems;
        }

        if (status === "employed") {
          required("employer", "Enter who you work for now.", problems);
          required("employer_position", "Enter your position.", problems);
          required("employer_start", "Enter when you started this job.", problems);
          required("income_note", "Enter your annual income.", problems);
          required("supervisor_name", "Enter your supervisor's name.", problems);
          requiredPhone(field("supervisor_phone"), "your supervisor's", problems);
          requiredEmail(field("supervisor_email"), "your supervisor's", problems);

          for (const entry of employment.entries()) {
            if (!entry.filled) continue;
            for (const [key, message] of [
              ["employer", "Enter the employer's name, or remove this record."],
              ["position", "Enter the position you held there."],
              ["start", "Enter when this job began."],
              ["income", "Enter the annual income for this job."],
              ["supervisor_name", "Enter your supervisor's name at this job."]
            ]) {
              if (!entry.values[key]) problems.push(problem(entry.control(key), message));
            }
            requiredPhone(entry.control("supervisor_phone"), "this supervisor's", problems);
            requiredEmail(entry.control("supervisor_email"), "this supervisor's", problems);
          }
          return problems;
        }

        required("school_name", "Enter your school's name.", problems);
        required("major", "Enter your major.", problems);
        required("country", "Enter your country of citizenship.", problems);

        const year = (name, label) => {
          if (!/^\d{4}$/.test(value(name))) {
            problems.push(problem(field(name), `Enter your ${label} as a four-digit year, like 2024.`));
            return null;
          }
          return Number(value(name));
        };
        const entry = year("entry_year", "school entry year");
        const graduation = year("graduation_year", "graduation year");
        if (entry !== null && graduation !== null && graduation < entry) {
          problems.push(problem(field("graduation_year"), "The graduation year cannot be before the entry year."));
        }
        return problems;
      },

      4() {
        const problems = [];
        rental.entries().forEach((entry, index) => {
          // The first record is where the applicant lives now; any later one
          // was added on purpose. Both are complete records the leasing team
          // can call, so both are held to the same fields.
          const who = index === 0 ? "your current landlord's" : "this landlord's";
          if (!entry.values.landlord_name) {
            problems.push(problem(entry.control("landlord_name"), `Enter ${who} name.`));
          }
          if (!entry.values.address) {
            problems.push(problem(entry.control("address"), index === 0
              ? "Enter the address you live at now."
              : "Enter the address, or remove this record."));
          }
          if (!entry.values.contact) {
            problems.push(problem(entry.control("contact"),
              `Enter a contact person for ${index === 0 ? "your current home" : "this home"}.`));
          }
          // A phone or an email is enough to reach a landlord; whichever is
          // given still has to be a real one.
          if (!entry.values.landlord_phone && !entry.values.landlord_email) {
            // Both boxes are the problem, so both wear the mark.
            problems.push({
              focus: entry.control("landlord_phone"),
              mark: [entry.control("landlord_phone"), entry.control("landlord_email")],
              message: `Enter ${who} phone number or email address. One of the two is enough.`
            });
          } else {
            if (entry.values.landlord_phone && !isValidPhone(entry.values.landlord_phone)) {
              problems.push(problem(entry.control("landlord_phone"),
                `Check ${who} phone number. It needs ten digits, like (718) 555-0123.`));
            }
            if (entry.values.landlord_email && !isValidEmail(entry.values.landlord_email)) {
              problems.push(problem(entry.control("landlord_email"), `Check ${who} email address.`));
            }
          }
          if (!entry.values.start) {
            problems.push(problem(entry.control("start"), "Enter when you moved in."));
          }
          if (!entry.values.monthly_rent) {
            problems.push(problem(entry.control("monthly_rent"), "Enter the monthly rent there."));
          }
        });
        return problems;
      },

      5() {
        const problems = [];
        for (const entry of references.entries()) {
          if (!entry.values.name) {
            problems.push(problem(entry.control("name"), "Enter this reference's name."));
          }
          if (!entry.values.relationship) {
            problems.push(problem(entry.control("relationship"), "Say how you know this reference."));
          }
          requiredPhone(entry.control("phone"), "this reference's", problems);
          requiredEmail(entry.control("email"), "this reference's", problems);
        }
        return problems;
      },

      6() {
        const problems = [];
        const children = form.querySelector('[data-group="children_under_11"]');
        if (!form.querySelector('input[name="children_under_11"]:checked')) {
          problems.push(groupProblem(children, "Say whether any children aged 10 or younger will live here."));
        }

        if (hasPets() === "") {
          const group = form.querySelector('[data-group="has_pets"]');
          problems.push(groupProblem(group, "Say whether you have pets."));
        } else if (hasPets() === "yes") {
          if (pets.count() === 0) {
            problems.push(pointer(document.getElementById("add-pet"), "Add your pet, or answer No."));
          }
          for (const entry of pets.entries()) {
            if (!entry.values.species) {
              problems.push(problem(entry.control("species"), "Enter this pet's breed or species."));
            }
            if (!entry.values.weight) {
              problems.push(problem(entry.control("weight"), "Enter this pet's weight in pounds."));
            }
          }
        }

        for (const entry of emergency.entries()) {
          if (!entry.values.name) {
            problems.push(problem(entry.control("name"), "Enter this contact's name."));
          }
          if (!entry.values.relationship) {
            problems.push(problem(entry.control("relationship"), "Say how you know this contact."));
          }
          requiredPhone(entry.control("phone"), "this contact's", problems);
          requiredEmail(entry.control("email"), "this contact's", problems);
        }
        return problems;
      },

      7() {
        const problems = [];
        if (!field("consent").checked) {
          problems.push(problem(field("consent"), "Confirm the information is accurate before submitting."));
        }
        return problems;
      }
    };

    const validate = (step) => VALIDATORS[step]();
    const isComplete = (step) => validate(step).length === 0;

    // ------------------------------------------------------- showing errors

    // One place decides what an error message's id looks like, and one place
    // recognises it again. They were written twice and drifted, which left every
    // control still pointing at the message it had been told about first: a
    // corrected field kept describing somebody else's error.
    const ERROR_PREFIX = "error-";
    const errorId = (step, index) => `${ERROR_PREFIX}${step}-${index}`;

    const describe = (el, id) => {
      const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
      if (!ids.includes(id)) ids.push(id);
      el.setAttribute("aria-describedby", ids.join(" "));
    };
    const undescribe = (el) => {
      const ids = (el.getAttribute("aria-describedby") || "")
        .split(/\s+/).filter((token) => token && !token.startsWith(ERROR_PREFIX));
      if (ids.length > 0) el.setAttribute("aria-describedby", ids.join(" "));
      else el.removeAttribute("aria-describedby");
    };

    const clearErrors = (step) => {
      const panel = panels[step - 1];
      panel.querySelectorAll(".field-error").forEach((node) => node.remove());
      panel.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
      // Not `[aria-invalid]`: typing in a field clears that flag, and the
      // description would then be swept by nothing.
      panel.querySelectorAll("[aria-describedby]").forEach(undescribe);
      panel.querySelectorAll("[data-invalid]").forEach((el) => el.removeAttribute("data-invalid"));
      const summary = document.getElementById(`errors-${step}`);
      if (summary) summary.innerHTML = "";
    };

    const showErrors = (step, problems) => {
      clearErrors(step);
      const links = [];

      problems.forEach((entry, index) => {
        const id = errorId(step, index);
        const anchor = entry.group || entry.focus;
        const holder = anchor.closest(".field") || anchor.parentElement;

        const note = document.createElement("p");
        note.className = "field-error";
        note.id = id;
        note.textContent = entry.message;
        holder.appendChild(note);

        entry.mark.forEach((el) => {
          el.setAttribute("aria-invalid", "true");
          describe(el, id);
        });
        const flagged = entry.group || entry.flag;
        if (flagged) flagged.setAttribute("data-invalid", "true");

        const target = entry.focus.id || `focus-${step}-${index}`;
        if (!entry.focus.id) entry.focus.id = target;
        links.push(`<li><a href="#${escapeHtml(target)}">${escapeHtml(entry.message)}</a></li>`);
      });

      const summary = document.getElementById(`errors-${step}`);
      const heading = problems.length === 1
        ? "One thing needs your attention on this step"
        : `${problems.length} things need your attention on this step`;
      summary.innerHTML = `<h2>${heading}</h2><ul>${links.join("")}</ul>`;

      // The summary announces itself (role="alert"); the focus goes where the
      // work is, which is the first control that needs fixing.
      problems[0].focus.focus({ preventScroll: true });
      problems[0].focus.scrollIntoView({ block: "center", behavior: reducedMotion ? "instant" : "smooth" });
    };

    // A field stops being wrong the moment it is touched: leaving a red
    // message under a box somebody is retyping is just noise. The message ids
    // are read off aria-describedby before it is swept, so the paragraph goes
    // with the border.
    form.addEventListener("input", (event) => {
      state.dirty = true;
      const el = event.target;
      if (el.getAttribute("aria-invalid") === "true") {
        const stale = (el.getAttribute("aria-describedby") || "")
          .split(/\s+/).filter((token) => token.startsWith(ERROR_PREFIX));
        el.removeAttribute("aria-invalid");
        undescribe(el);
        stale.forEach((errId) => document.getElementById(errId)?.remove());
      }
      if (el.type === "radio") {
        // The whole group was marked together, so the whole group is cleared
        // together — including each sibling's aria-describedby, which would
        // otherwise point at the removed message.
        const group = el.closest("[data-group]");
        group?.removeAttribute("data-invalid");
        group?.querySelectorAll("input").forEach((radio) => {
          radio.removeAttribute("aria-invalid");
          const staleIds = (radio.getAttribute("aria-describedby") || "")
            .split(/\s+/).filter((token) => token.startsWith(ERROR_PREFIX));
          undescribe(radio);
          staleIds.forEach((errId) => document.getElementById(errId)?.remove());
        });
      }
      if (el.name === "move_in" || el.name === "lease_term_months") paintLeaseEnd();
    });
    form.addEventListener("change", (event) => {
      state.dirty = true;
      if (event.target.name === "employment_status") {
        // The errors on this step belong to the branch that was chosen when
        // Continue was pressed; after a switch they point into a hidden half.
        clearErrors(3);
        applyBranch();
      }
      if (event.target.name === "id_type") applyIdType();
      if (event.target.name === "has_roommates") {
        clearErrors(1);
        applyRoommates();
      }
      if (event.target.name === "has_pets") {
        clearErrors(6);
        applyPets();
      }
      if (event.target.name === "move_in" || event.target.name === "lease_term_months") paintLeaseEnd();
      paintReferenceCount();
      paintSteps();
    });

    // ------------------------------------------------------------ the steps

    const paintSteps = () => {
      stepLinks.forEach((link) => {
        const step = Number(link.dataset.step);
        const done = state.visited.has(step) && isComplete(step);
        link.classList.toggle("is-done", done);
        if (step === state.step) link.setAttribute("aria-current", "step");
        else link.removeAttribute("aria-current");
      });
    };

    const paintReview = () => {
      const status = employmentStatus();
      const refs = completeReferences();
      const homes = rental.entries().filter(({ filled }) => filled).length;
      const roommateCount = roommates.entries().filter(({ filled }) => filled).length;
      const petCount = pets.count();

      const idLabel = idType() === "passport" ? "passport number given" : "SSN given";
      const workParts = status === "student"
        ? [value("school_name"), value("major"),
          value("graduation_year") ? `graduating ${value("graduation_year")}` : "", value("country")]
        : status === "employed"
          ? [value("employer"), value("employer_position"), value("income_note")]
          : ["Not answered yet"];

      const childrenAnswer = form.querySelector('input[name="children_under_11"]:checked')
        ? (form.elements.children_under_11.value === "yes"
          ? "children 10 or younger living here" : "no children 10 or younger")
        : "";

      const roommateLine = roommateCap === 0 || hasRoommates() === "no"
        ? "No roommates"
        : hasRoommates() === "yes"
          ? `${roommateCount} ${roommateCount === 1 ? "roommate" : "roommates"}`
          : "Not answered yet";
      const petsLine = hasPets() === "yes"
        ? `${petCount} ${petCount === 1 ? "pet" : "pets"}`
        : hasPets() === "no" ? "no pets" : "";

      const lines = [
        [1, [roommateLine,
          hasRoommates() === "yes" && invitedEmails.size > 0
            ? `${invitedEmails.size} ${invitedEmails.size === 1 ? "invitation" : "invitations"} sent` : "",
          hasRoommates() === "yes" && failedInvites.size > 0 ? "some invitations not sent yet" : ""]],
        [2, [`${value("first_name")} ${value("last_name")}`.trim(), value("phone"),
          value("id_number") ? idLabel : "",
          value("move_in") ? `lease starting ${toUsDate(value("move_in"))}` : "",
          value("lease_term_months") ? `${value("lease_term_months")}-month term` : "",
          leaseEndText() ? `ending ${leaseEndText()}` : ""]],
        [3, workParts],
        [4, [homes > 0 ? `${homes} ${homes === 1 ? "address" : "addresses"}` : "No addresses given"]],
        [5, [`${refs} of ${REFERENCES_REQUIRED} references`]],
        [6, [childrenAnswer,
          field("window_guards")?.checked ? "window guards requested" : "",
          petsLine,
          `${emergency.count()} emergency ${emergency.count() === 1 ? "contact" : "contacts"}`]]
      ];

      reviewList.innerHTML = lines.map(([step, parts]) => {
        const short = !isComplete(step);
        const summary = short
          ? "Something on this step still needs your attention"
          : parts.filter(Boolean).join(" · ");
        return `
          <li class="review-item">
            <span class="review-copy">
              <strong>Step ${step} · ${escapeHtml(stepName(step))}</strong>
              <span class="${short ? "is-short" : ""}">${escapeHtml(summary)}</span>
            </span>
            <button class="review-edit" type="button" data-goto="${step}"
                    aria-label="Edit step ${step}, ${escapeHtml(stepName(step))}">Edit</button>
          </li>`;
      }).join("");
    };

    // The documents that will be asked for in the portal, shown on the
    // confirmation page so nobody leaves it expecting to be done. The list
    // follows the work-or-school answer, which is the whole reason the
    // question is asked — and by submit time that answer always exists.
    const docsChecklist = (status) => {
      const items = ["Government ID (front and back)"];
      if (status === "student") items.push("School Offer Letter", "Student Visa / I-20");
      else if (status === "employed") items.push("Job Offer Letter or Last Two Paystubs");
      items.push("Last Two Bank Statements");

      const rows = items.map((item) => `<li>${escapeHtml(item)}</li>`);
      rows.push('<li class="is-soft">Last Two Tax Returns and a Rental Payment Record are optional, but they help.</li>');
      return rows.join("");
    };

    // Turnstile is mounted the first time the last step is on screen: a widget
    // rendered into a hidden panel is a widget that may never draw.
    const mountTurnstile = () => {
      if (!TURNSTILE_SITE_KEY || turnstileMounted) return;
      turnstileMounted = true;
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__mountTurnstile";
      script.async = true;
      window.__mountTurnstile = () => {
        const box = document.getElementById("turnstile-box");
        if (box && window.turnstile) widgetId = window.turnstile.render(box, { sitekey: TURNSTILE_SITE_KEY });
      };
      document.head.appendChild(script);
    };

    const showStep = (requested, { focus = true, push = true } = {}) => {
      const step = Math.max(1, Math.min(TOTAL_STEPS, requested));
      state.step = step;
      state.visited.add(step);

      panels.forEach((panel) => {
        const active = Number(panel.dataset.step) === step;
        panel.classList.toggle("is-active", active);
        panel.hidden = !active;
      });

      headerStep.textContent = `Rental Application · Step ${step} of ${TOTAL_STEPS}`;
      progress.setAttribute("aria-valuenow", String(step));
      progress.setAttribute("aria-valuetext", `Step ${step} of ${TOTAL_STEPS}, ${stepName(step)}`);
      progressFill.style.width = `${(step / TOTAL_STEPS) * 100}%`;

      backButton.hidden = step === 1;
      nextButton.textContent = step === TOTAL_STEPS ? "Submit Application" : "Continue →";
      actionNote.textContent = step === TOTAL_STEPS
        ? "Your application is sent when you press Submit Application."
        : `Step ${step} of ${TOTAL_STEPS} · your application is sent only from the last step`;

      if (step === TOTAL_STEPS) { paintReview(); mountTurnstile(); }
      paintSteps();

      const link = stepLinks[step - 1];
      const list = link.closest(".app-steps");
      if (list && list.scrollWidth > list.clientWidth) {
        link.scrollIntoView({ block: "nearest", inline: "center", behavior: reducedMotion ? "instant" : "smooth" });
      }

      if (push) {
        const url = step === 1
          ? window.location.pathname + window.location.search
          : `#step-${step}`;
        window.history.pushState({ step }, "", url);
      }

      if (focus) {
        const heading = panels[step - 1].querySelector("h1");
        heading.focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: reducedMotion ? "instant" : "smooth" });
      }
    };

    const goTo = (step, options) => {
      // Any way off a valid roommate step counts as continuing, so the step
      // list and the review screen's Edit buttons send the invitations the
      // Continue button would have.
      if (state.step === 1 && step > 1 && validate(1).length === 0) maybeSendInvites();
      clearErrors(state.step);
      showStep(step, options);
    };

    const advance = () => {
      const problems = validate(state.step);
      if (problems.length > 0) { showErrors(state.step, problems); return; }
      clearErrors(state.step);
      goTo(state.step + 1);
    };

    // ------------------------------------------------- roommate invitations
    //
    // Sent whenever the applicant moves on from a valid roommate step with
    // the invitation box ticked — the Continue button, the step list, or the
    // final submit all count, so asking for the invitations means they go
    // out. The Worker answers per address; only confirmed deliveries enter
    // `invitedEmails`, addresses that failed wait in `failedInvites` for the
    // next pass, and the status line is redrawn from these sets, so however
    // many requests are in flight it always states the whole truth.
    const invitedEmails = new Set();
    const failedInvites = new Set();
    const invitesInFlight = new Set();

    const paintInviteStatus = () => {
      const status = document.getElementById("invite-status");
      if (!status) return;
      const parts = [];
      if (invitesInFlight.size > 0) parts.push("Sending the invitations…");
      if (invitedEmails.size > 0) parts.push(`Invitations sent to ${[...invitedEmails].join(", ")}.`);
      if (failedInvites.size > 0) {
        parts.push(`The ${failedInvites.size === 1 ? "invitation" : "invitations"} to `
          + `${[...failedInvites].join(", ")} could not be sent. Your application is not `
          + "affected, and moving on from this step tries again.");
      }
      status.textContent = parts.join(" ");
    };

    const maybeSendInvites = () => {
      if (hasRoommates() !== "yes" || field("invite_roommates")?.checked !== true) return;
      const pending = roommates.entries().filter(({ filled }) => filled)
        .map(({ values }) => ({
          first_name: values.first_name, last_name: values.last_name, email: values.email
        }))
        .filter((mate) => {
          const address = mate.email.toLowerCase();
          return mate.email && !invitedEmails.has(address) && !invitesInFlight.has(address);
        });
      if (pending.length === 0) return;

      pending.forEach((mate) => {
        invitesInFlight.add(mate.email.toLowerCase());
        failedInvites.delete(mate.email.toLowerCase());
      });
      paintInviteStatus();

      const settle = (sent, failed) => {
        pending.forEach((mate) => invitesInFlight.delete(mate.email.toLowerCase()));
        sent.forEach((email) => invitedEmails.add(String(email).toLowerCase()));
        failed.forEach((email) => failedInvites.add(String(email).toLowerCase()));
        paintInviteStatus();
        if (state.step === TOTAL_STEPS) paintReview();
        announce(failed.length === 0
          ? "Roommate invitations sent."
          : "Some roommate invitations could not be sent. The Roommates step says which, and moving on from it tries again.");
      };

      fetch("/api/apply/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listing_id: id, roommates: pending })
      }).then(async (response) => {
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        if (data && (Array.isArray(data.sent) || Array.isArray(data.failed))) {
          settle(data.sent ?? [], data.failed ?? []);
        } else if (response.ok) {
          settle(pending.map((mate) => mate.email), []);
        } else {
          settle([], pending.map((mate) => mate.email));
        }
      }).catch(() => settle([], pending.map((mate) => mate.email)));
    };

    // ------------------------------------------------------------- submitting

    const collectPayload = () => {
      const status = employmentStatus();

      const payload = {
        listing_id: id,
        first_name: value("first_name"),
        last_name: value("last_name"),
        dob: toUsDate(value("dob")),
        id_type: idType(),
        id_number: idNumber(),
        phone: value("phone"),
        // The four address parts travel as the one line everything downstream
        // reads, the way an applicant would write it on an envelope.
        current_address: [value("address_street"), value("address_unit"), value("address_city"),
          [value("address_state"), value("address_zip")].filter(Boolean).join(" ")]
          .filter(Boolean).join(", "),
        move_in: toUsDate(value("move_in")),
        lease_term_months: Number(value("lease_term_months")),
        children_under_11: form.elements.children_under_11.value === "yes",
        wants_window_guards: field("window_guards")?.checked === true,
        employment_status: status,
        rental_history: rental.entries().filter(({ filled }) => filled).map(({ values }) => values),
        reference_contacts: references.entries().map(({ values }) => values),
        emergency_contacts: emergency.entries().map(({ values }) => values),
        roommates: hasRoommates() === "yes"
          ? roommates.entries().filter(({ filled }) => filled).map(({ values }) => values)
          : [],
        pets: hasPets() === "yes"
          ? pets.entries().filter(({ values, filled }) => filled || values.type).map(({ values }) => values)
          : [],
        message: value("message"),
        website: value("website"),
        turnstile_token: widgetId !== null && window.turnstile
          ? window.turnstile.getResponse(widgetId) || ""
          : ""
      };

      if (status === "student") {
        payload.student = {
          school_name: value("school_name"),
          major: value("major"),
          entry_year: value("entry_year"),
          graduation_year: value("graduation_year"),
          country: value("country")
        };
      } else {
        payload.income_note = value("income_note");
        payload.current_employer = {
          employer: value("employer"),
          position: value("employer_position"),
          start: value("employer_start"),
          supervisor_name: value("supervisor_name"),
          supervisor_phone: value("supervisor_phone"),
          supervisor_email: value("supervisor_email")
        };
        payload.employment_history =
          employment.entries().filter(({ filled }) => filled).map(({ values }) => values);
      }

      return payload;
    };

    const showSubmitError = (message) => {
      const summary = document.getElementById(`errors-${TOTAL_STEPS}`);
      summary.innerHTML = `<h2>Your application was not submitted</h2><ul><li>${escapeHtml(message)}</li></ul>`;
      summary.focus({ preventScroll: true });
      summary.scrollIntoView({ block: "center", behavior: reducedMotion ? "instant" : "smooth" });
    };

    const submit = async () => {
      if (state.submitting) return;
      state.submitting = true;
      nextButton.disabled = true;
      nextButton.textContent = "Submitting…";

      try {
        const response = await fetch("/api/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(collectPayload())
        });

        const payload = await response.json().catch(() => null);
        if (response.status === 401) {
          // The session expired while the form was open; signing back in
          // returns here with everything to retype, which is still better
          // than an application filed under nobody.
          state.dirty = false;
          portalSignIn();
          return;
        }
        if (!response.ok) {
          throw new Error(payload?.error || "The application could not be submitted. Please try again.");
        }

        state.done = true;
        state.dirty = false;
        progressFill.style.width = "100%";
        headerStep.textContent = "Rental Application · Submitted";
        container.innerHTML = `
          <div class="success">
            <h2>Thank You for Applying</h2>
            <p>Your application for ${escapeHtml(property.title || "this property")} has
               been received. We appreciate your interest. The Star Real Estate team will
               review your application and contact you within 24 to 48 hours.</p>
            <div class="success-docs">
              <h3>After Your Application Is Reviewed</h3>
              <p>No documents are needed right now. Once the team has looked at your
                 application, you will upload the following in your applicant portal.</p>
              <ul class="docs-note">${docsChecklist(employmentStatus())}</ul>
            </div>
            <p class="success-links">
              <a href="../portal/">Open the applicant portal</a>
              <a href="../property/?id=${encodeURIComponent(id)}">Back to the property</a>
            </p>
          </div>`;
        announce("Application received. The team will review it and contact you within 24 to 48 hours.");
      } catch (error) {
        showSubmitError(error.message);
        state.submitting = false;
        nextButton.disabled = false;
        nextButton.textContent = "Submit Application";
        if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
      }
    };

    const submitAll = () => {
      // Every step, because the Worker checks every step. The first one that
      // is short is the one to open, so the fix is in front of the reader
      // rather than behind a Back button.
      for (let step = 1; step <= TOTAL_STEPS; step += 1) {
        const problems = validate(step);
        if (problems.length === 0) { clearErrors(step); continue; }
        if (step !== state.step) showStep(step);
        showErrors(step, problems);
        return;
      }
      // The safety net for an applicant who reached the end without ever
      // leaving step 1 forwards: asked-for invitations go out with the
      // application itself.
      maybeSendInvites();
      submit();
    };

    // ------------------------------------------------------------- wiring up

    form.addEventListener("submit", (event) => {
      // Continue on the first six steps, submit on the last. Pressing Enter in
      // a text box lands here too, which is why step six cannot file an
      // application by accident.
      event.preventDefault();
      if (state.step < TOTAL_STEPS) advance();
      else submitAll();
    });

    nextButton.addEventListener("click", (event) => {
      // The button is type=submit so that Enter works and so that a page with
      // broken JavaScript still POSTs; the handler above does the real work.
      if (state.step < TOTAL_STEPS) { event.preventDefault(); advance(); }
    });

    backButton.addEventListener("click", () => goTo(state.step - 1));

    stepLinks.forEach((link) => link.addEventListener("click", () => goTo(Number(link.dataset.step))));

    form.addEventListener("click", (event) => {
      const edit = event.target.closest("[data-goto]");
      if (edit) goTo(Number(edit.dataset.goto));
    });

    document.querySelectorAll(".app-error-summary").forEach((summary) => {
      summary.addEventListener("click", (event) => {
        const link = event.target.closest("a[href^='#']");
        if (!link) return;
        event.preventDefault();
        const target = document.getElementById(link.getAttribute("href").slice(1));
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: "center", behavior: reducedMotion ? "instant" : "smooth" });
      });
    });

    // The CSS hides the empty date input's locale format hint; this class
    // brings the value back into view as soon as one is set.
    form.querySelectorAll('input[type="date"]').forEach((input) => {
      const syncClass = () => input.classList.toggle("has-value", input.value !== "");
      input.addEventListener("input", syncClass);
      input.addEventListener("change", syncClass);
    });

    const idInput = document.getElementById("id_number");
    const ssnToggle = document.getElementById("ssn-toggle");
    ssnToggle.addEventListener("click", () => {
      const reveal = idInput.type === "password";
      idInput.type = reveal ? "text" : "password";
      ssnToggle.textContent = reveal ? "Hide" : "Show";
      ssnToggle.setAttribute("aria-label",
        reveal ? "Hide identity number" : "Show identity number");
    });

    // Steps live in the URL fragment and nothing else does: no answer is ever
    // written to the address bar. Back moves a step; Back from the first step
    // leaves the page, which is where the unsaved-work prompt takes over.
    window.addEventListener("popstate", (event) => {
      // After a successful submit the form is gone from the page; the step
      // entries left in history have nothing to show any more.
      if (state.done) return;
      const fromHash = /^#step-([1-7])$/.exec(window.location.hash);
      const step = event.state?.step || (fromHash ? Number(fromHash[1]) : 1);
      goTo(step, { push: false });
    });

    // There is no draft and no autosave, so nothing here claims there is: the
    // one honest protection is to ask before the page goes away.
    window.addEventListener("beforeunload", (event) => {
      if (!state.dirty || state.done) return;
      event.preventDefault();
      event.returnValue = "";
    });

    paintReferenceCount();
    applyRoommates();
    applyPets();
    applyBranch();
    applyIdType();
    paintLeaseEnd();
    // A fragment left over from a previous visit would open a step nobody has
    // filled in; the application always starts at the beginning.
    window.history.replaceState({ step: 1 }, "", window.location.pathname + window.location.search);
    showStep(1, { focus: false, push: false });
  };

  // ------------------------------------------------------------ help dialog

  if (helpDialog) {
    const openHelp = document.getElementById("open-help");
    const closeHelp = document.getElementById("close-help");
    let opener = null;

    openHelp.addEventListener("click", () => {
      opener = document.activeElement;
      helpDialog.showModal();
      closeHelp.focus();
    });
    closeHelp.addEventListener("click", () => helpDialog.close());
    // <dialog> handles Escape and the focus trap; returning focus is ours.
    helpDialog.addEventListener("close", () => opener?.focus());
    helpDialog.addEventListener("click", (event) => {
      if (event.target === helpDialog) helpDialog.close();
    });
  }

  // ---------------------------------------------------------------- loading

  Promise.all([
    fetch(`../data/property.json?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || "This property could not be loaded.");
        return payload;
      }),
    fetch("/api/portal/me", { credentials: "same-origin" })
      .then(async (response) => {
        if (response.status === 401) return null;
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || "The application form could not be loaded. Please try again.");
        return payload;
      })
  ])
    .then(([property, me]) => {
      if (!me) {
        portalSignIn();
        return;
      }
      renderForm(property, me.email);
    })
    .catch((error) => showFailure(error.message));
})();
