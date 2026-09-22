import {secureAccount} from './security.js';
const host = document.querySelector("#login-content");
let email = "";
const options=await fetch('/api/auth/workspace/options').then(r=>r.json()).catch(()=>({}));
if(options.provider==='gip'){
  const {mountGipAuth}=await import('../shared/gip-auth-ui.js');
  const gipPost=async(resource,body)=>{
    const response=await fetch('/api/auth/workspace/'+resource,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'Account access is unavailable.'),{code:result.code});return result;
  };
  await mountGipAuth(host,{scope:'workspace',post:gipPost,enter:()=>secureAccount(host,gipPost,finishWorkspace,{manage:new URLSearchParams(location.search).has('security')})});
}else{
  await legacyLogin();
}
async function legacyLogin(){
const secure=options.secure===true;
let invitation=new URLSearchParams(location.hash.slice(1)).get('invite')||'';
// Reusing an open login tab for another invitation must not retain the previous account.
window.addEventListener('hashchange',()=>{
  const next=new URLSearchParams(location.hash.slice(1)).get('invite')||'';
  if(next!==invitation)location.reload();
});

const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
async function post(resource, body) {
  const response = await fetch(`/api/auth/workspace/${resource}`, { method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body:JSON.stringify({...body,...(invitation?{invite:invitation}:{})}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The request could not be completed. Please try again.");
  return result;
}
async function enterWorkspace() {
  if(secure)return secureAccount(host,post,finishWorkspace,{manage:new URLSearchParams(location.search).has('security')});
  return finishWorkspace();
}

function render(mode = "login", notice = "") {
  const verify = mode === "activate" || mode === "reset-confirm";
  const passwordStep=verify && !secure;
  const title = {login:"Welcome back",code:"Activate your account",activate:secure?"Verify your email":"Set up your sign in",reset:"Reset your password","reset-confirm":secure?"Verify your reset code":"Choose a new password"}[mode];
  const intro = {login:"Sign in with the email your team invited.",code:"Enter your invited email. We’ll send a code to activate your workspace access.",activate:secure?"Enter your email code to accept your invitation. Existing accounts keep their current password.":"Enter your email code and choose a password. Your access is set by your administrator.",reset:"We’ll email a code so you can choose a new password.","reset-confirm":secure?"Enter the code from your reset email. We’ll verify your authenticator next if one is linked, then you can choose a new password.":"Enter the code from your reset email and choose a new password."}[mode];
  host.innerHTML = `<h2>${title}</h2><p class="intro">${intro}</p><form>
    <label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" ${invitation?'readonly':''} maxlength="180" value="${esc(email)}" required>
    ${verify ? '<label for="code">Email code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" minlength="6" maxlength="8" required>' : ""}
    ${mode === "login" || passwordStep ? `<label for="password">${verify ? "New password" : "Password"}</label><input id="password" name="password" type="password" autocomplete="${verify ? "new-password" : "current-password"}" ${verify ? 'minlength="8"' : ''} maxlength="200" required>` : ""}
    ${passwordStep ? '<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="200" required>' : ""}
    <button class="primary">${mode === "login" ? "Sign in" : verify ? (passwordStep?"Save password & sign in":"Verify & continue") : "Send email code"}</button><p class="status" role="status" aria-live="polite">${esc(notice)}</p>
    </form><div class="links">${mode === "login" ? '<button type="button" data-mode="code">Activate an invited account</button><button type="button" data-mode="reset">Forgot password?</button>' : '<button type="button" data-mode="login">Back to sign in</button>'}${verify ? `<button type="button" data-mode="${mode === "activate" ? "code" : "reset"}">Request another code</button>` : ""}</div>`;
  host.querySelectorAll("[data-mode]").forEach(button => button.onclick = () => { email = host.querySelector("#email").value.trim(); render(button.dataset.mode); });
  host.querySelector("form").onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector("button"), status = form.querySelector(".status"), data = Object.fromEntries(new FormData(form));
    email = data.email.trim().toLowerCase(); button.disabled = true; status.textContent = "";
    try {
      if (passwordStep && data.password !== data.confirm) throw new Error("The passwords do not match.");
      if (mode === "code") { await post("workspace-code", {email}); render("activate", "If this email has workspace access, a code is on its way."); }
      else if (mode === "reset") { await post("request-reset", {email}); render("reset-confirm", "If this email has an account, a reset code is on its way."); }
      else {
        await post(mode === "login" ? "login" : mode === "activate" ? "workspace-activate" : "verify-reset", {email, password:data.password, code:data.code});
        if(secure && invitation && (mode==='login'||mode==='reset-confirm'))await post('workspace-accept',{email});
        invitation='';
        history.replaceState(null,'',location.pathname+location.search);
        await enterWorkspace();
      }
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  };
}
render(new URLSearchParams(location.search).has('reset')?'reset':'login', new URLSearchParams(location.search).get('error') === 'workspace-access' ? 'This account does not have workspace access. Sign in with an invited staff or landlord account. ' : '');

if(secure && invitation){
  try{const inv=await post('workspace-invitation',{});email=inv.email;render('code','Verify your invited email to accept. If you already have an account, your existing password stays the same. Use Forgot password if you need to change it.');}
  catch(e){host.innerHTML=`<h2>Invitation unavailable</h2><p>${esc(e.message)}</p><a href="/login/">Sign in</a>`;}
} else if(secure && new URLSearchParams(location.search).has('security')){
  try{await enterWorkspace();}catch(e){render('login',e.message);}
}
}

async function finishWorkspace(security) {
  const intended=new URLSearchParams(location.search).get('return');
  if(options.secure && /^\/landlord-onboarding\/#([a-f0-9]{64})$/.test(intended||'')){location.replace(intended);return;}
  if(security?.onboarding_pending){host.innerHTML='<h2>Landlord onboarding</h2><p>Your account is ready. Open your latest property-information invitation to complete onboarding. Business access becomes available after your submission is approved.</p><a href="/login/?security=1">Account security</a>';return;}

  const response = await fetch("/api/admin/me", { credentials:"same-origin" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Your account does not have workspace access. Contact your administrator.");
  const returnTo=new URLSearchParams(location.search).get('return');
  if(!result.owner && returnTo?.startsWith('/landlord-decision/#')){location.replace(returnTo);return;}
  const route = result.owner ? "#/staff" : location.hash.startsWith("#/") ? location.hash : "#/overview";
  location.replace(`/admin/${route}`);
}
