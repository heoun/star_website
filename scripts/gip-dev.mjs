// Dev-only provisioning. gcloud credentials stay in an ignored local directory.
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {writeFileSync,mkdirSync} from 'node:fs';
const project='starreusa-dev-auth';
const tenants={applicant:'Applicant-sw0j9',workspace:'Workspace-7ppgr'};
const command=process.argv[2]||'inspect';
if(!['inspect','configure','save-config','domains'].includes(command))throw new Error('Use inspect, configure, save-config, or domains. This tool cannot target production.');
const token=execFileSync(resolve('.local/gip-tools/google-cloud-sdk/bin/gcloud'),['auth','print-access-token','info@starreusa.com','--project='+project],{env:{...process.env,CLOUDSDK_CONFIG:resolve('.local/gip-tools/config')},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function api(path,method='GET',body){
  const prefix=path.includes('/tenants/')?'v2/':'admin/v2/';
  const r=await fetch('https://identitytoolkit.googleapis.com/'+prefix+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','x-goog-user-project':project},...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json();
  if(!r.ok)throw new Error(`Google configuration request failed (${r.status}): ${data.error?.message || 'unknown error'}`);
  return data;
}
const config=await api(`projects/${project}/config`);
if(![`projects/${project}/config`,'projects/54640971372/config'].includes(config.name))throw new Error('Unexpected target project');
const safeTenant=({name,displayName,allowPasswordSignup,enableEmailLinkSignin,enableAnonymousUser,mfaConfig,client,emailPrivacyConfig,passwordPolicyConfig,smsRegionConfig})=>({name,displayName,allowPasswordSignup,enableEmailLinkSignin,enableAnonymousUser,mfaConfig,client,emailPrivacyConfig,passwordPolicyConfig,smsRegionConfig});
if(command==='domains'){
  const authorizedDomains=[...new Set([...(config.authorizedDomains||[]),'dev.starreusa.com','localhost','127.0.0.1'])];
  await api(`projects/${project}/config?updateMask=authorizedDomains`,'PATCH',{authorizedDomains});
  config.authorizedDomains=(await api(`projects/${project}/config`)).authorizedDomains;
}
if(command==='configure'){
  for(const [scope,id] of Object.entries(tenants)){
    const body={allowPasswordSignup:true,enableEmailLinkSignin:false,enableAnonymousUser:false,
      client:{permissions:{disabledUserSignup:scope==='workspace',disabledUserDeletion:true}},
      emailPrivacyConfig:{enableImprovedEmailPrivacy:true},
      passwordPolicyConfig:{passwordPolicyEnforcementState:'ENFORCE',passwordPolicyVersions:[{customStrengthOptions:{minPasswordLength:8}}]},
      mfaConfig:{state:'ENABLED',providerConfigs:[{state:'ENABLED',totpProviderConfig:{adjacentIntervals:1}}]},
      smsRegionConfig:{allowlistOnly:{allowedRegions:[]}}};
    await api(`projects/${project}/tenants/${id}?updateMask=${Object.keys(body).join(',')}`,'PATCH',body);
  }
}
if(command==='save-config'){
  if(!config.client?.apiKey)throw new Error('No project API key was returned.');
  mkdirSync('.local/gip',{recursive:true,mode:0o700});
  writeFileSync('.local/gip/dev-config.json',JSON.stringify({GIP_PROJECT_ID:project,GIP_API_KEY:config.client.apiKey,GIP_APPLICANT_TENANT_ID:tenants.applicant,GIP_WORKSPACE_TENANT_ID:tenants.workspace},null,2)+'\n',{mode:0o600});
  console.log('Dev configuration saved to ignored .local/gip/dev-config.json; no live application settings changed.');
}
console.log(JSON.stringify({project:config.name,multiTenant:config.multiTenant,authorizedDomains:config.authorizedDomains,hasApiKey:!!config.client?.apiKey,tenants:await Promise.all(Object.values(tenants).map(async id=>safeTenant(await api(`projects/${project}/tenants/${id}`))))},null,2));
