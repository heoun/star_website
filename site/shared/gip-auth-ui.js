// Auth links live only in this page's memory. No passwords, tokens, codes or
// authenticator secrets are written to localStorage/sessionStorage.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Opening another email link in the same tab must use that link's identity and
// action rather than the form that was previously mounted.
window.addEventListener('hashchange',()=>{
  const next=new URLSearchParams(location.hash.slice(1));
  if(next.has('oob')||next.has('invite'))location.reload();
});
export async function mountGipAuth(host,{scope,post,enter,email:initialEmail='',mode:initialMode='login'}){
  const workspace=scope==='workspace',fragment=new URLSearchParams(location.hash.slice(1));
  let email=initialEmail,invite=workspace?fragment.get('invite')||'':'',code=fragment.get('oob')||'',action=fragment.get('action')||'';
  if(code||invite)history.replaceState(null,'',location.pathname+location.search);
  const send=(resource,body={})=>post(resource,{...body,...(invite?{invite}:{})});
  function bind(task){host.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type=submit]'),status=form.querySelector('[role=status]');button.disabled=true;status.textContent='';try{await task(Object.fromEntries(new FormData(form)));}catch(error){status.textContent=error.message;button.disabled=false;}};}
  async function entered(){if(workspace&&invite){await send('workspace-accept',{});invite='';}await enter();}
  function render(mode='login',notice=''){
    const password=['login','register','reset-confirm','activate-confirm'].includes(mode),confirm=password&&mode!=='login';
    const titles={login:workspace?'Welcome back':'Applicant Portal',register:'Create your applicant account',activate:'Activate your account',reset:'Reset your password',resend:'Confirm your email','reset-confirm':'Choose a new password','activate-confirm':'Activate your account','verify-confirm':'Confirm your email'};
    const intros={login:workspace?'Sign in with the email your team invited.':'Sign in to manage your rental applications.',register:'Your applicant account and password are separate from the team workspace.',activate:'Enter your invited email to receive an activation link.',reset:`We’ll send a link to reset only your ${workspace?'workspace':'applicant'} password.`,resend:'We’ll send a new email confirmation link.','reset-confirm':'Choose a new password. You will sign in afterwards and verify your authenticator if one is enrolled.','activate-confirm':'Choose a password for your workspace account.','verify-confirm':'Confirm that this is your email address, then sign in with your password.'};
    const fixed=!!code||!!invite;
    host.innerHTML=`<h2>${titles[mode]}</h2><p class="intro">${intros[mode]}</p><form class="portal-login">
      <label>Email address<input name="email" type="email" autocomplete="username" maxlength="180" value="${esc(email)}" ${fixed?'readonly':''} required></label>
      ${password?`<label>${confirm?'New password':'Password'}<input name="password" type="password" autocomplete="${confirm?'new-password':'current-password'}" ${confirm?'minlength="8"':''} maxlength="200" required></label>`:''}
      ${confirm?'<label>Confirm password<input name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="200" required></label>':''}
      <button type="submit" class="primary submit">${mode==='login'?'Sign in':mode==='register'?'Create account':mode==='verify-confirm'?'Confirm email':confirm?'Save password':'Send email link'}</button><p class="status form-error" role="status">${esc(notice)}</p></form>
      <div class="links gip-auth-links">${mode==='login'?`${workspace?'<button type="button" data-mode="activate">Activate an invited account</button>':'<button type="button" data-mode="register">Create an account</button><button type="button" data-mode="resend">Resend confirmation</button>'}<button type="button" data-mode="reset">Forgot password?</button>`:'<button type="button" data-mode="login">Back to sign in</button>'}</div>`;
    host.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{email=host.querySelector('[name=email]').value.trim();code='';render(button.dataset.mode);});
    bind(async data=>{
      email=data.email.trim().toLowerCase();
      if(confirm&&data.password!==data.confirm)throw Error('The passwords do not match.');
      if(mode==='login'){
        const result=await send('login',{email,password:data.password});
        if(result.mfa_required){renderMfa(result.factors);return;}await entered();
      }else if(mode==='register'){
        await send('register',{email,password:data.password});render('login','Check your email and open the confirmation link before signing in.');
      }else if(mode==='verify-confirm'){
        await send('verify-register',{code});code='';render('login','Email confirmed. Sign in with your password.');
      }else if(mode==='reset-confirm'||mode==='activate-confirm'){
        await send('verify-reset',{code,password:data.password,activation:mode==='activate-confirm'});code='';render('login','Password saved. Sign in with your new password.');
      }else{
        const result=await send(mode==='activate'?'workspace-code':mode==='reset'?'request-reset':'resend',{email});
        render('login',result.existing_account?'Your account is already activated. Sign in with your current password.':'If this email is eligible, a link is on its way. Open it to continue.');
      }
    });
  }
  function renderMfa(factors){
    host.innerHTML=`<h2>Two-step verification</h2><p>Enter the current code from your authenticator.</p><form class="portal-login"><label>Authenticator<select name="factor_id">${factors.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select></label><label>Verification code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button type="submit" class="primary submit">Verify & sign in</button><p role="status"></p></form><div class="links gip-auth-links"><button type="button" id="gip-back">Back to sign in</button></div>`;
    host.querySelector('#gip-back').onclick=()=>render('login');
    bind(async data=>{await send('mfa-login',data);await entered();});
  }
  try{
    if(code){
      const checked=await send('check-action',{code});email=checked.email;
      if(action==='verify'&&checked.requestType==='VERIFY_EMAIL')render('verify-confirm');
      else if(['reset','activate'].includes(action)&&checked.requestType==='PASSWORD_RESET'&&(action!=='activate'||workspace))render(action==='activate'?'activate-confirm':'reset-confirm');
      else throw Error('This link does not match the requested action. Request a new one.');
    }else if(invite){const inv=await send('workspace-invitation');email=inv.email;render('activate');}
    else if(workspace&&new URLSearchParams(location.search).has('security')&&!new URLSearchParams(location.search).has('reauth'))await enter();
    else render(new URLSearchParams(location.search).has('reset')?'reset':initialMode);
  }catch(error){code='';invite='';render('login',error.message);}
}
