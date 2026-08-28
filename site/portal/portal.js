(function () {
  const container = document.getElementById("portal");
  if (!container) return;

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  // Applicant-facing names for the pipeline statuses the office tracks.
  // "Sent to landlord" is the office's vocabulary, not the applicant's.
  const STATUS_LABELS = {
    new: "Received",
    contacted: "In progress",
    fee_pending: "Application fee pending",
    screening: "Screening in progress",
    review: "Under review",
    sent_to_landlord: "With the landlord",
    needs_info: "More information needed",
    approved: "Approved",
    declined: "Not approved",
    lease_sent: "Lease sent for signing",
    lease_signed: "Lease signed"
  };

  // Where to go after signing in. The apply page sends people here with
  // ?next=/apply/?id=…; only a same-origin path is ever followed, so the
  // parameter cannot bounce anyone to another site.
  const rawNext = new URLSearchParams(window.location.search).get("next") || "";
  const nextPath = /^\/(?!\/)/.test(rawNext) ? rawNext : "";

  const state = {
    email: "",      // carried between the auth steps
    data: null      // the signed-in payload: email, document_types, applications
  };

  // One reusable file input for every Upload button; which slot it feeds is
  // remembered while the picker is open.
  let pendingUpload = null;
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif";
  fileInput.hidden = true;
  document.body.appendChild(fileInput);

  async function api(path, options = {}) {
    const response = await fetch(`/api/portal${path}`, { credentials: "same-origin", ...options });
    const isJson = (response.headers.get("Content-Type") || "").includes("application/json");
    const payload = isJson ? await response.json().catch(() => null) : null;

    if (!response.ok) {
      const error = new Error(payload?.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  const postJson = (path, body) => api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const setError = (message) => {
    const el = container.querySelector(".form-error");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  };

  const arrived = () => {
    if (nextPath) window.location.replace(nextPath);
    else load();
  };

  const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

  // Wires one auth <form>: disables the button, runs `submit`, restores on
  // failure. Every view below is this pattern.
  function wireForm(formId, labelWhileBusy, submit) {
    const form = document.getElementById(formId);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setError("");
      const button = form.querySelector(".submit");
      const label = button.textContent;
      button.disabled = true;
      button.textContent = labelWhileBusy;
      try {
        await submit(form);
      } catch (error) {
        setError(error.message);
        button.disabled = false;
        button.textContent = label;
      }
    });
    return form;
  }

  // ---- signing in ---------------------------------------------------------

  function renderSignIn() {
    container.innerHTML = `
      <h1>Applicant Portal</h1>
      <p class="lede">${nextPath.startsWith("/apply/")
        ? "Sign in, or create your account, to continue your application. Your account is where you follow its progress and upload your documents afterwards."
        : "Follow your rental application and upload your supporting documents. Sign in with your applicant account."}</p>
      <form class="portal-login" id="signin-form" novalidate>
        <label for="login-email">Email</label>
        <input id="login-email" type="email" maxlength="180" autocomplete="email" required
               value="${escapeHtml(state.email)}">
        <label for="login-password">Password</label>
        <input id="login-password" type="password" maxlength="200" autocomplete="current-password" required>
        <button type="submit" class="submit">Sign in</button>
        <p class="form-error" hidden></p>
      </form>
      <p class="portal-note">
        <a href="#" id="to-register">Create an account</a> ·
        <a href="#" id="to-reset">Forgot your password?</a>
      </p>
      <p class="portal-note">Haven’t applied yet? <a href="../rental/">Browse the rentals</a>
        and apply from any property page.</p>
    `;

    document.getElementById("to-register").addEventListener("click", (event) => {
      event.preventDefault();
      renderRegister();
    });
    document.getElementById("to-reset").addEventListener("click", (event) => {
      event.preventDefault();
      renderResetRequest();
    });

    wireForm("signin-form", "Signing in…", async () => {
      const email = document.getElementById("login-email").value.trim();
      const password = document.getElementById("login-password").value;
      if (!validEmail(email)) throw new Error("Please enter a valid email address.");
      if (!password) throw new Error("Please enter your password.");

      state.email = email.toLowerCase();
      await postJson("/login", { email, password });
      arrived();
    });
  }

  // ---- creating an account ------------------------------------------------

  function renderRegister() {
    container.innerHTML = `
      <h1>Create your account</h1>
      <p class="lede">Use the email address you want your application filed under.
        We will send a code to confirm it is yours.</p>
      <form class="portal-login" id="register-form" novalidate>
        <label for="reg-email">Email</label>
        <input id="reg-email" type="email" maxlength="180" autocomplete="email" required
               value="${escapeHtml(state.email)}">
        <label for="reg-password">Password <span class="hint">(at least 8 characters)</span></label>
        <input id="reg-password" type="password" maxlength="200" autocomplete="new-password" required>
        <label for="reg-confirm">Password, again</label>
        <input id="reg-confirm" type="password" maxlength="200" autocomplete="new-password" required>
        <div class="field-website" aria-hidden="true">
          <label for="website">Website</label>
          <input id="website" tabindex="-1" autocomplete="off">
        </div>
        <button type="submit" class="submit">Send confirmation code</button>
        <p class="form-error" hidden></p>
      </form>
      <p class="portal-note">Already have an account? <a href="#" id="to-signin">Sign in</a></p>
    `;

    document.getElementById("to-signin").addEventListener("click", (event) => {
      event.preventDefault();
      renderSignIn();
    });

    wireForm("register-form", "Sending…", async () => {
      const email = document.getElementById("reg-email").value.trim();
      const password = document.getElementById("reg-password").value;
      const confirm = document.getElementById("reg-confirm").value;

      if (!validEmail(email)) throw new Error("Please enter a valid email address.");
      if (password.length < 8) throw new Error("Please choose a password of at least 8 characters.");
      if (password !== confirm) throw new Error("The two passwords do not match.");

      const result = await postJson("/register", {
        email,
        password,
        website: document.getElementById("website").value
      });
      state.email = email.toLowerCase();

      // A project with email confirmation turned off signs the account in on
      // the spot; otherwise the code is on its way.
      if (result && result.confirm) renderRegisterCode();
      else arrived();
    });
  }

  function renderRegisterCode() {
    container.innerHTML = `
      <h1>Check your email</h1>
      <p class="lede">We sent a 6-digit code to <b>${escapeHtml(state.email)}</b>.
        It is good for about an hour. If it is not in your inbox, check spam.</p>
      <form class="portal-login" id="code-form" novalidate>
        <label for="login-code">Code</label>
        <input id="login-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
               placeholder="••••••" required>
        <button type="submit" class="submit">Create account</button>
        <p class="form-error" hidden></p>
      </form>
      <p class="portal-note">
        <a href="#" id="resend">Send a new code</a> ·
        <a href="#" id="back">Start over</a>
      </p>
    `;
    document.getElementById("login-code").focus();

    document.getElementById("back").addEventListener("click", (event) => {
      event.preventDefault();
      renderRegister();
    });
    document.getElementById("resend").addEventListener("click", async (event) => {
      event.preventDefault();
      setError("");
      try {
        await postJson("/resend", { email: state.email });
        setError("A new code is on its way.");
      } catch (error) {
        setError(error.message);
      }
    });

    wireForm("code-form", "Creating…", async () => {
      const code = document.getElementById("login-code").value.replace(/\D/g, "");
      if (code.length !== 6) throw new Error("Please enter the 6-digit code from the email.");

      await postJson("/verify-register", { email: state.email, code });
      arrived();
    });
  }

  // ---- forgotten passwords ------------------------------------------------

  function renderResetRequest() {
    container.innerHTML = `
      <h1>Reset your password</h1>
      <p class="lede">Enter your account email. If it has an account, a 6-digit code
        is on its way to it.</p>
      <form class="portal-login" id="reset-form" novalidate>
        <label for="reset-email">Email</label>
        <input id="reset-email" type="email" maxlength="180" autocomplete="email" required
               value="${escapeHtml(state.email)}">
        <button type="submit" class="submit">Email me a code</button>
        <p class="form-error" hidden></p>
      </form>
      <p class="portal-note"><a href="#" id="to-signin">Back to sign in</a></p>
    `;

    document.getElementById("to-signin").addEventListener("click", (event) => {
      event.preventDefault();
      renderSignIn();
    });

    wireForm("reset-form", "Sending…", async () => {
      const email = document.getElementById("reset-email").value.trim();
      if (!validEmail(email)) throw new Error("Please enter a valid email address.");

      await postJson("/request-reset", { email });
      state.email = email.toLowerCase();
      renderResetCode();
    });
  }

  function renderResetCode() {
    container.innerHTML = `
      <h1>Check your email</h1>
      <p class="lede">If <b>${escapeHtml(state.email)}</b> has an account, a 6-digit code
        was sent to it. Enter the code and choose a new password.</p>
      <form class="portal-login" id="reset-code-form" novalidate>
        <label for="login-code">Code</label>
        <input id="login-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
               placeholder="••••••" required>
        <label for="new-password">New password <span class="hint">(at least 8 characters)</span></label>
        <input id="new-password" type="password" maxlength="200" autocomplete="new-password" required>
        <label for="new-confirm">New password, again</label>
        <input id="new-confirm" type="password" maxlength="200" autocomplete="new-password" required>
        <button type="submit" class="submit">Set password</button>
        <p class="form-error" hidden></p>
      </form>
      <p class="portal-note">
        <a href="#" id="resend">Send a new code</a> ·
        <a href="#" id="to-signin">Back to sign in</a>
      </p>
    `;
    document.getElementById("login-code").focus();

    document.getElementById("to-signin").addEventListener("click", (event) => {
      event.preventDefault();
      renderSignIn();
    });
    document.getElementById("resend").addEventListener("click", async (event) => {
      event.preventDefault();
      setError("");
      try {
        await postJson("/request-reset", { email: state.email });
        setError("A new code is on its way.");
      } catch (error) {
        setError(error.message);
      }
    });

    wireForm("reset-code-form", "Saving…", async () => {
      const code = document.getElementById("login-code").value.replace(/\D/g, "");
      const password = document.getElementById("new-password").value;
      const confirm = document.getElementById("new-confirm").value;

      if (code.length !== 6) throw new Error("Please enter the 6-digit code from the email.");
      if (password.length < 8) throw new Error("Please choose a password of at least 8 characters.");
      if (password !== confirm) throw new Error("The two passwords do not match.");

      await postJson("/verify-reset", { email: state.email, code, password });
      arrived();
    });
  }

  // ---- the dashboard ------------------------------------------------------

  function listingLabel(app) {
    const listing = app.listing;
    if (!listing) return "Property no longer listed";
    const home = [listing.property_name, listing.unit].filter(Boolean).join(" ");
    return home ? `${listing.title} · ${home}` : (listing.title || "Property");
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  // The checklist this application is asked for. `when` limits a type to one
  // work-or-school answer; applications from before the question all had an
  // employer on the form, so a missing answer reads as employed. The Worker
  // filters uploads by the same rule, so the buttons here and the uploads it
  // accepts are one list.
  function applicableTypes(app) {
    const status = app.employment_status === "student" ? "student" : "employed";
    return (state.data.document_types || []).filter((type) => !type.when || type.when === status);
  }

  // Types sharing an `either` value are alternatives — a job offer letter
  // proves income the same way two paystubs do — so a satisfied sibling
  // satisfies the group.
  function typeSatisfied(app, type, types) {
    const enough = (entry) =>
      app.documents.filter((doc) => doc.doc_type === entry.id).length >= entry.required;
    if (!type.either) return enough(type);
    return types.some((other) => other.either === type.either && enough(other));
  }

  function requiredProgress(app) {
    const types = applicableTypes(app);
    // An either-group is one requirement, not two: counting the offer letter
    // and the paystubs separately would tell an applicant who finished that
    // they are still one short.
    const counted = new Set();
    let total = 0;
    let met = 0;
    for (const type of types) {
      if (type.required === 0) continue;
      const unit = type.either || type.id;
      if (counted.has(unit)) continue;
      counted.add(unit);
      total += 1;
      if (typeSatisfied(app, type, types)) met += 1;
    }
    return { met, total };
  }

  // `orphan` marks a type this application is no longer asked for but has
  // files under — uploaded before an agent corrected the work-or-school
  // answer. The files stay visible and removable; only new uploads stop,
  // because the Worker refuses them too.
  function docTypeRow(app, type, types, { orphan = false } = {}) {
    const files = app.documents.filter((doc) => doc.doc_type === type.id);
    const ownSatisfied = type.required > 0 && files.length >= type.required;
    const groupSatisfied = type.required > 0 && typeSatisfied(app, type, types);
    const badge = orphan
      ? '<span class="doc-req">No longer requested</span>'
      : type.required === 0
        ? '<span class="doc-req">Optional</span>'
        : ownSatisfied
          ? '<span class="doc-req is-done">Received</span>'
          : groupSatisfied
            ? '<span class="doc-req is-done">Covered</span>'
            : `<span class="doc-req is-missing">Required${type.required > 1 ? ` · ${files.length}/${type.required}` : ""}</span>`;

    const list = files.map((doc) => `
      <li class="doc-file">
        <a href="/api/portal/documents/${escapeHtml(doc.id)}" target="_blank" rel="noopener">${escapeHtml(doc.file_name || "document")}</a>
        <span class="doc-size num">${formatSize(doc.size_bytes)}</span>
        <button type="button" class="doc-remove" data-remove="${escapeHtml(doc.id)}">Remove</button>
      </li>`).join("");

    return `
      <div class="doc-type">
        <div class="doc-type-head">
          <span class="doc-label">${escapeHtml(type.label)} ${badge}</span>
          ${orphan ? "" : `<button type="button" class="doc-add" data-upload="${escapeHtml(type.id)}"
                  data-app="${escapeHtml(app.id)}"${files.length >= type.max ? " disabled" : ""}>
            ${files.length > 0 ? "Add another" : "Upload"}
          </button>`}
        </div>
        ${orphan || !type.hint ? "" : `<p class="doc-hint">${escapeHtml(type.hint)}</p>`}
        ${list ? `<ul class="doc-files">${list}</ul>` : ""}
      </div>`;
  }

  // Files under types the checklist no longer asks this application for.
  function orphanRows(app, types) {
    return (state.data.document_types || [])
      .filter((type) => !types.includes(type)
        && app.documents.some((doc) => doc.doc_type === type.id))
      .map((type) => docTypeRow(app, type, types, { orphan: true }))
      .join("");
  }

  function renderDashboard() {
    const data = state.data;
    const apps = data.applications || [];

    const cards = apps.map((app) => {
      const submitted = new Date(app.created_at).toLocaleDateString("en-US", {
        month: "long", day: "numeric", year: "numeric"
      });
      const types = applicableTypes(app);
      const progress = requiredProgress(app);
      const facts = [
        `Submitted ${submitted}`,
        app.move_in ? `Move-in ${app.move_in}` : "",
        app.lease_term_months ? `${app.lease_term_months}-month term` : ""
      ].filter(Boolean).join(" · ");

      return `
        <section class="section portal-app" data-app-card="${escapeHtml(app.id)}">
          <div class="portal-app-head">
            <h2>${escapeHtml(listingLabel(app))}</h2>
            <span class="portal-chip is-${escapeHtml(app.status)}">${escapeHtml(STATUS_LABELS[app.status] || app.status)}</span>
          </div>
          <p class="portal-facts">${escapeHtml(facts)}</p>
          <p class="portal-progress${progress.met === progress.total ? " is-done" : ""}">
            ${progress.met === progress.total
              ? "All required documents received. Thank you"
              : `Required documents · ${progress.met} of ${progress.total} complete`}
          </p>
          <div class="doc-list">
            ${types.map((type) => docTypeRow(app, type, types)).join("")}${orphanRows(app, types)}
          </div>
        </section>`;
    }).join("");

    container.innerHTML = `
      <div class="portal-bar">
        <span>Signed in as <b>${escapeHtml(data.email)}</b></span>
        <button type="button" id="sign-out">Sign out</button>
      </div>
      <h1>Your application${apps.length === 1 ? "" : "s"}</h1>
      ${apps.length === 0
        ? `<p class="lede">There is no application under ${escapeHtml(data.email)} yet.
             <a href="../rental/">Browse the rentals</a> and apply from any property page.
             Your application will appear here.</p>`
        : `<p class="lede">Upload each document below as a PDF or a photo (JPEG, PNG, HEIC),
             up to 10&nbsp;MB per file. We are notified automatically once everything
             required is in.</p>`}
      <p class="form-error" hidden></p>
      ${cards}
    `;

    document.getElementById("sign-out").addEventListener("click", async () => {
      try {
        await api("/sign-out", { method: "POST" });
      } catch {
        // The cookie is gone either way.
      }
      state.data = null;
      renderSignIn();
    });
  }

  // Upload and remove clicks, delegated so re-renders cannot orphan handlers.
  container.addEventListener("click", async (event) => {
    const uploadButton = event.target.closest("[data-upload]");
    if (uploadButton) {
      pendingUpload = { applicationId: uploadButton.dataset.app, typeId: uploadButton.dataset.upload };
      fileInput.value = "";
      fileInput.click();
      return;
    }

    const removeButton = event.target.closest("[data-remove]");
    if (removeButton) {
      if (!window.confirm("Remove this file?")) return;
      removeButton.disabled = true;
      try {
        await api(`/documents/${encodeURIComponent(removeButton.dataset.remove)}`, { method: "DELETE" });
        await load();
      } catch (error) {
        removeButton.disabled = false;
        setError(error.message);
      }
    }
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    const target = pendingUpload;
    pendingUpload = null;
    if (!file || !target) return;

    setError("");
    if (file.size > 10 * 1024 * 1024) {
      setError("Files must be 10 MB or smaller.");
      return;
    }

    const button = container.querySelector(
      `[data-upload="${CSS.escape(target.typeId)}"][data-app="${CSS.escape(target.applicationId)}"]`
    );
    if (button) {
      button.disabled = true;
      button.textContent = "Uploading…";
    }

    let failure = "";
    try {
      const body = new FormData();
      body.append("doc_type", target.typeId);
      body.append("file", file);
      await api(`/applications/${encodeURIComponent(target.applicationId)}/documents`, {
        method: "POST",
        body
      });
    } catch (error) {
      failure = error.message;
    }

    await load();
    if (failure) setError(failure);
  });

  async function load() {
    try {
      state.data = await api("/applications");
      // Someone who arrived here mid-application and is already signed in
      // goes straight back to the form.
      if (nextPath) {
        window.location.replace(nextPath);
        return;
      }
      renderDashboard();
    } catch (error) {
      if (error.status === 401) {
        renderSignIn();
      } else {
        container.innerHTML = `<p class="state">${escapeHtml(error.message)}</p>`;
      }
    }
  }

  load();
})();
