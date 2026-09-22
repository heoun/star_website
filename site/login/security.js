// No access tokens or authenticator secrets are written to browser storage.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function secureAccount(host,post,enter,{manage=false,forceVerify=false}={}) {
  let state=await post('security',{});
  if(state.provider==='gip'&&forceVerify){host.innerHTML='<h2>Verify your identity again</h2><p>Sign in with your password and authenticator to continue.</p><a href="/login/?security=1&reauth=1">Sign in again</a>';return;}
  if(state.reset_expired){host.innerHTML='<h2>Reset session expired</h2><p>Request a new email code to finish resetting your password.</p><a href="/login/?reset=1">Request a new reset code</a>';return;}
  const verifiedFactors=state.factors.filter(f=>f.status==='verified');
  const changingPassword=state.setup_password||state.reset_password;
  const verifyExisting=verifiedFactors.length>0&&(!state.verified||changingPassword&&!state.recent_mfa);
  const enrollRequired=!changingPassword&&state.mfa_required&&!state.verified;
  if(forceVerify||verifyExisting||enrollRequired) {
    let factor=verifiedFactors[0];
    if(!factor) {
      host.innerHTML='<h2>Protect your account</h2><p>Owner and Admin accounts require an authenticator. Add a time-based account in your authenticator app, then enter its six-digit code.</p><button class="primary" id="enroll">Set up authenticator</button><p role="status"></p>';
      host.querySelector('#enroll').onclick=async event=>{event.target.disabled=true;try{const setup=await post('mfa-enroll',{});factor={id:setup.factor_id};showCode(setup.secret);}catch(e){host.querySelector('[role=status]').textContent=e.message;event.target.disabled=false;}};
    } else showCode();
    function showCode(secret) {
      host.innerHTML=`<h2>${secret?'Add your authenticator':'Two-step verification'}</h2>${secret?`<p>In your authenticator app, choose “Enter setup key”, use your Star account email and select time-based codes.</p><label>Setup key<input readonly value="${esc(secret)}" autocomplete="off" spellcheck="false"></label><p>Keep access to your authenticator. If it is lost, contact the platform operator for identity-verified recovery.</p>`:'<p>Enter the current six-digit code from your authenticator app.</p>'}<form>${verifiedFactors.length>1?`<label>Authenticator<select name="factor">${verifiedFactors.map(f=>`<option value="${esc(f.id)}">${esc(f.friendly_name||'Authenticator')}</option>`).join('')}</select></label>`:''}<label>Authenticator code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label><button class="primary">Verify & continue</button><p role="status"></p></form>`;
      bind(async data=>{await post('mfa-verify',{factor_id:data.factor||factor.id,code:data.code});return secureAccount(host,post,enter,{manage});});
    }
    return;
  }
  if(state.setup_password||state.reset_password) {
    const resetting=state.reset_password;
    host.innerHTML=`<h2>${resetting?'Choose a new password':'Create your password'}</h2><p>${resetting?'Your identity has been verified. Save your new password, then sign in with it.':'Your email is verified. Choose a password for future sign-ins.'}</p><form><label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="200" required></label><label>Confirm password<input name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="200" required></label><button class="primary">Save password</button><p role="status"></p></form>`;
    bind(async data=>{
      if(data.password!==data.confirm)throw Error('Passwords do not match.');
      await post(resetting?'reset-password':'setup-password',{password:data.password});
      if(resetting){host.innerHTML='<h2>Password updated</h2><p>Your new password has been saved. Sign in with your email and new password. If you have an authenticator, you’ll be asked for its code next.</p><a href="/login/">Back to sign in</a>';return;}
      return secureAccount(host,post,enter,{manage,forceVerify});
    });return;
  }
  if(!manage){await enter(state);return;}
  host.innerHTML=`<h2>Account security</h2><p>${esc(state.email)}</p><p>Two-step verification: ${state.verified?'Verified':'Not verified'}</p>${state.owner_account?`<h3>Your workspace roles</h3><p>Owner manages account access. Admin manages business operations.</p><button data-role="owner">Open Owner workspace</button>${state.admin_enabled?'<button data-role="admin">Open Admin workspace</button>':''}<form><label>Reason for ${state.admin_enabled?'revoking':'granting'} your Admin access<input name="reason" minlength="5" maxlength="1000" required></label><button class="primary">${state.admin_enabled?'Revoke':'Grant'} my Admin role</button><p role="status"></p></form>`:''}<p><a href="/login/?reset=1">Reset password</a></p><p><a href="/admin/">Back to workspace</a></p><button id="reauth">Verify authenticator again</button><p id="security-status" role="status"></p>`;
  host.querySelector('#reauth').onclick=()=>secureAccount(host,post,enter,{manage:true,forceVerify:true});
  host.querySelectorAll('[data-role]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await post('switch-role',{role:button.dataset.role});location.replace('/admin/'+(button.dataset.role==='owner'?'#/staff':'#/overview'));}catch(e){host.querySelector('#security-status').textContent=e.message;button.disabled=false;}});
  if(state.owner_account)bind(async data=>{await post('owner-admin',{enabled:!state.admin_enabled,version:state.owner_version,reason:data.reason});return secureAccount(host,post,enter,{manage:true});});
  function bind(action) {
    host.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),status=form.querySelector('[role=status]');button.disabled=true;status.textContent='';try{await action(Object.fromEntries(new FormData(form)));}catch(e){status.textContent=e.message;button.disabled=false;}};
  }
}
