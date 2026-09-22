// No access tokens or authenticator secrets are written to browser storage.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function secureAccount(host,post,enter,{manage=false,forceVerify=false}={}) {
  let state=await post('security',{});
  if(state.setup_password) {
    host.innerHTML='<h2>Create your password</h2><p>Your email is verified. Choose a password for future sign-ins.</p><form><label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="200" required></label><label>Confirm password<input name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="200" required></label><button class="primary">Save password</button><p role="status"></p></form>';
    bind(async data=>{if(data.password!==data.confirm)throw Error('Passwords do not match.');await post('setup-password',{password:data.password});return secureAccount(host,post,enter,{manage,forceVerify});});return;
  }
  const verifiedFactors=state.factors.filter(f=>f.status==='verified');
  if(forceVerify || state.mfa_required&&!state.verified) {
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
  if(!manage){await enter(state);return;}
  host.innerHTML=`<h2>Account security</h2><p>${esc(state.email)}</p><p>Two-step verification: ${state.verified?'Verified':'Not verified'}</p>${state.owner_account?`<h3>Your workspace roles</h3><p>Owner manages account access. Admin manages business operations.</p><button data-role="owner">Open Owner workspace</button>${state.admin_enabled?'<button data-role="admin">Open Admin workspace</button>':''}<form><label>Reason for ${state.admin_enabled?'revoking':'granting'} your Admin access<input name="reason" minlength="5" maxlength="1000" required></label><button class="primary">${state.admin_enabled?'Revoke':'Grant'} my Admin role</button><p role="status"></p></form>`:''}<p><a href="/admin/">Back to workspace</a></p><button id="reauth">Verify authenticator again</button><p id="security-status" role="status"></p>`;
  host.querySelector('#reauth').onclick=()=>secureAccount(host,post,enter,{manage:true,forceVerify:true});
  host.querySelectorAll('[data-role]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await post('switch-role',{role:button.dataset.role});location.replace('/admin/'+(button.dataset.role==='owner'?'#/staff':'#/overview'));}catch(e){host.querySelector('#security-status').textContent=e.message;button.disabled=false;}});
  if(state.owner_account)bind(async data=>{await post('owner-admin',{enabled:!state.admin_enabled,version:state.owner_version,reason:data.reason});return secureAccount(host,post,enter,{manage:true});});
  function bind(action) {
    host.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),status=form.querySelector('[role=status]');button.disabled=true;status.textContent='';try{await action(Object.fromEntries(new FormData(form)));}catch(e){status.textContent=e.message;button.disabled=false;}};
  }
}
