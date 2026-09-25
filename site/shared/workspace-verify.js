// Reverify in place. Credentials stay in this form and the server binds the
// challenge to the current workspace identity; this never calls login/logout.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function post(action,body={}) {
  const response=await fetch('/api/auth/workspace/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw Error(result.error||'Verification failed.');
  return result;
}
export async function verifyWorkspaceIdentity() {
  const state=await post('security');
  return new Promise((resolve,reject)=>{
    const dialog=document.createElement('dialog');
    dialog.className='workspace-verify';
    dialog.setAttribute('aria-labelledby','workspace-verify-title');
    document.body.append(dialog);
    let busy=false;
    const finish=error=>{dialog.close();dialog.remove();error?reject(error):resolve();};
    dialog.addEventListener('cancel',event=>{event.preventDefault();if(!busy)finish(Error('Verification cancelled. Your form has been kept.'));});
    function render(factors=null) {
      const password=state.provider==='gip'&&!factors;
      factors=factors||state.factors||[];
      dialog.innerHTML=`<h2 id="workspace-verify-title">Verify Your Identity</h2><p>${esc(state.email)}</p><p>${password?'Enter your current workspace password, then your authenticator code.':'Enter the current code from your authenticator.'} Your form will be kept.</p><form class="desk-form">${password?'<label>Password<input name="password" type="password" autocomplete="current-password" maxlength="200" required></label>':`<label>Authenticator<select name="factor_id">${factors.map(f=>`<option value="${esc(f.id)}">${esc(f.name||f.friendly_name||'Authenticator')}</option>`).join('')}</select></label><label>Verification Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>`}<div class="actions"><button type="submit" class="primary">${password?'Continue':'Verify & Continue'}</button><button type="button" data-cancel>Cancel</button></div><p role="status"></p></form>`;
      dialog.querySelector('[data-cancel]').onclick=()=>{if(!busy)finish(Error('Verification cancelled. Your form has been kept.'));};
      dialog.querySelector('form').onsubmit=async event=>{
        event.preventDefault();if(busy)return;busy=true;
        const form=event.currentTarget,data=Object.fromEntries(new FormData(form));
        form.querySelectorAll('button').forEach(b=>b.disabled=true);
        form.querySelector('[role=status]').textContent='';
        try {
          const result=await post(password?'reauth-start':state.provider==='gip'?'reauth-verify':'mfa-verify',data);
          form.reset();
          if(password)render(result.factors);else finish();
        }catch(error){form.querySelector('[role=status]').textContent=error.message;}
        finally{data.password='';data.code='';busy=false;form.querySelectorAll('button').forEach(b=>b.disabled=false);}
      };
      dialog.querySelector('input')?.focus();
    }
    render();dialog.showModal();dialog.querySelector('input')?.focus();
  });
}
