const host = document.querySelector("#login-content");
let email = "";
const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
async function post(resource, body) {
  const response = await fetch(`/api/auth/${resource}`, { method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The request could not be completed. Please try again.");
  return result;
}
async function enterWorkspace() {
  const response = await fetch("/api/admin/me", { credentials:"same-origin" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Your account does not have workspace access. Contact your administrator.");
  const route = result.owner ? "#/staff" : location.hash.startsWith("#/") ? location.hash : "#/overview";
  location.replace(`/admin/${route}`);
}
function render(mode = "login", notice = "") {
  const verify = mode === "activate" || mode === "reset-confirm";
  const title = {login:"Welcome back",code:"Activate your account",activate:"Set up your sign in",reset:"Reset your password","reset-confirm":"Choose a new password"}[mode];
  const intro = {login:"Sign in with the email your team invited.",code:"Enter your invited email. We’ll send a code to activate your workspace access.",activate:"Enter your email code and choose a password. Your access is set by your administrator.",reset:"We’ll email a code so you can choose a new password.","reset-confirm":"Enter the code from your reset email and choose a new password."}[mode];
  host.innerHTML = `<h2>${title}</h2><p class="intro">${intro}</p><form>
    <label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" maxlength="180" value="${esc(email)}" required>
    ${verify ? '<label for="code">Email code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" minlength="6" maxlength="8" required>' : ""}
    ${mode === "login" || verify ? `<label for="password">${verify ? "New password" : "Password"}</label><input id="password" name="password" type="password" autocomplete="${verify ? "new-password" : "current-password"}" ${verify ? 'minlength="8"' : ''} maxlength="200" required>` : ""}
    ${verify ? '<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="200" required>' : ""}
    <button class="primary">${mode === "login" ? "Sign in" : verify ? "Save password & sign in" : "Send email code"}</button><p class="status" role="status" aria-live="polite">${esc(notice)}</p>
    </form><div class="links">${mode === "login" ? '<button type="button" data-mode="code">Activate an invited account</button><button type="button" data-mode="reset">Forgot password?</button>' : '<button type="button" data-mode="login">Back to sign in</button>'}${verify ? `<button type="button" data-mode="${mode === "activate" ? "code" : "reset"}">Request another code</button>` : ""}</div>`;
  host.querySelectorAll("[data-mode]").forEach(button => button.onclick = () => { email = host.querySelector("#email").value.trim(); render(button.dataset.mode); });
  host.querySelector("form").onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector("button"), status = form.querySelector(".status"), data = Object.fromEntries(new FormData(form));
    email = data.email.trim().toLowerCase(); button.disabled = true; status.textContent = "";
    try {
      if (verify && data.password !== data.confirm) throw new Error("The passwords do not match.");
      if (mode === "code") { await post("workspace-code", {email}); render("activate", "If this email has workspace access, a code is on its way."); }
      else if (mode === "reset") { await post("request-reset", {email}); render("reset-confirm", "If this email has an account, a reset code is on its way."); }
      else {
        await post(mode === "login" ? "login" : mode === "activate" ? "workspace-activate" : "verify-reset", {email, password:data.password, code:data.code});
        await enterWorkspace();
      }
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  };
}
render();
