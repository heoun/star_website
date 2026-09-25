// Dev-only operator tool. No mail is sent and authentication settings are untouched.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {gipEmailTemplates} from './gip-email-templates.mjs';
const project='starreusa-dev-auth',tenants=['Applicant-sw0j9','Workspace-7ppgr'];
const mode=process.argv[2]||'plan';
if(!['plan','apply','verify'].includes(mode))throw Error('Use plan, apply, or verify. Only Dev is supported.');
const templates=gipEmailTemplates();
const smtp={host:'smtp.resend.com',port:465,username:'resend',securityMode:'SSL',senderEmail:'no-reply@starreusa.com'};
if(mode==='plan'){
  console.log(JSON.stringify({project,tenants,smtp,credentialSource:'Existing RESEND_API_KEY in .dev.vars (never printed or written to a new file)',templates:Object.fromEntries(Object.entries(templates).map(([k,v])=>[k,{senderDisplayName:v.senderDisplayName,preserveGoogleContent:true}])),callback:'Preserve Google tenant-bound security action handler',sendsEmail:false},null,2));
  process.exit(0);
}
const token=execFileSync(resolve('.local/gip-tools/google-cloud-sdk/bin/gcloud'),['auth','print-access-token','info@starreusa.com','--project='+project],{env:{...process.env,CLOUDSDK_CONFIG:resolve('.local/gip-tools/config')},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function api(path,method='GET',body){
  const r=await fetch('https://identitytoolkit.googleapis.com/'+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'x-goog-user-project':project,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json();
  if(!r.ok){const code=String(data.error?.message||'').split(' : ')[0];throw Error(`Google mail configuration: ${r.status} ${/^[A-Z_]+$/.test(code)?code:'request_failed'}`);}
  return data;
}
const configPath=`admin/v2/projects/${project}/config`;
const before=await api(configPath);
assert.equal(before.name,'projects/54640971372/config');
const originalCallback=before.notification.sendEmail.callbackUri;
if(mode==='apply'){
  const {RESEND_API_KEY}=parseEnv(readFileSync('.dev.vars','utf8'));
  assert.ok(RESEND_API_KEY?.startsWith('re_'),'Missing configured Resend credential');
  // Whitelist backup fields: never persist returned SMTP credentials.
  const prior=before.notification.sendEmail;
  mkdirSync('.local/gip',{recursive:true,mode:0o700});
  writeFileSync('.local/gip/email-config-before-redacted.json',JSON.stringify({method:prior.method,callbackUri:prior.callbackUri,templates:Object.fromEntries(Object.keys(templates).map(k=>[k,prior[k]])),smtp:prior.smtp?{host:prior.smtp.host,port:prior.smtp.port,senderEmail:prior.smtp.senderEmail,securityMode:prior.smtp.securityMode}:null},null,2),{mode:0o600});
  // Keep delivery and template settings separate; do not replace unrelated
  // notification settings or try to overwrite Google's locked safety text.
  await api(configPath+'?updateMask=notification.sendEmail.method,notification.sendEmail.smtp','PATCH',{notification:{sendEmail:{method:'CUSTOM_SMTP',smtp:{...smtp,password:RESEND_API_KEY}}}});
  const templateMask=Object.entries(templates).flatMap(([name,t])=>Object.keys(t).map(key=>`notification.sendEmail.${name}.${key}`)).join(',');
  await api(configPath+'?updateMask='+templateMask,'PATCH',{notification:{sendEmail:templates}});
  for(const tenant of tenants)await api(`v2/projects/${project}/tenants/${tenant}?updateMask=inheritance.emailSendingConfig`,'PATCH',{inheritance:{emailSendingConfig:true}});
}
const after=await api(configPath),email=after.notification.sendEmail;
assert.equal(email.method,'CUSTOM_SMTP');
for(const key of ['host','port','senderEmail','securityMode'])assert.equal(email.smtp[key],smtp[key]);
assert.equal(email.callbackUri,originalCallback,'Do not redirect unsupported security actions to the application login page');
for(const [name,t] of Object.entries(templates))for(const key of Object.keys(t))assert.equal(email[name][key],t[key],`${name}.${key}`);
for(const name of Object.keys(templates))for(const key of ['body','subject'])assert.equal(email[name][key],before.notification.sendEmail[name][key],'Preserve Google-managed security notice content');
for(const tenant of tenants){const t=await api(`v2/projects/${project}/tenants/${tenant}`);assert.equal(t.inheritance?.emailSendingConfig,true);}
console.log('Verified Dev: four Star Real Estate sender settings, Resend SMTP, both tenant inheritance settings, and preserved Google security bodies/action handler. No email sent.');
