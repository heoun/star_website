// Dev-only Workload Identity Federation; does not alter organization key policies.
import {generateKeyPair,exportJWK,exportPKCS8} from 'jose';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const project='starreusa-dev-auth',number='54640971372',pool='star-dev-auth',provider='cloudflare-worker';
const serviceAccount=`star-dev-auth-runtime@${project}.iam.gserviceaccount.com`;
const command=process.argv[2];
if(!['prepare','create','grant','grant-tenants'].includes(command))throw new Error('Use prepare, create, grant, or grant-tenants.');
const dir='.local/gip';mkdirSync(dir,{recursive:true,mode:0o700});
const path=dir+'/workload.json';
if(!existsSync(path)){
  if(command!=='prepare')throw new Error('Run prepare first; never replace a missing workload key during IAM changes.');
  const {privateKey,publicKey}=await generateKeyPair('RS256',{extractable:true});
  const kid=crypto.randomUUID();
  writeFileSync(path,JSON.stringify({privateKey:await exportPKCS8(privateKey),kid,
    issuer:'https://dev.starreusa.com/workload-identity',subject:'star-website-staging',
    audience:`//iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`,serviceAccount},null,2)+'\n',{mode:0o600});
  writeFileSync(dir+'/workload-public-jwks.json',JSON.stringify({keys:[{...await exportJWK(publicKey),kid,alg:'RS256',use:'sig'}]},null,2)+'\n',{mode:0o600});
}
const credential=JSON.parse(readFileSync(path,'utf8'));
if(credential.serviceAccount!==serviceAccount||credential.subject!=='star-website-staging'||
  credential.issuer!=='https://dev.starreusa.com/workload-identity'||
  credential.audience!==`//iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`)throw new Error('Unexpected credential target');
console.log('Prepared Dev workload identity. The private signing key stays local; only its public verification key goes to Google.');
const run=args=>execFileSync(resolve('.local/gip-tools/google-cloud-sdk/bin/gcloud'),[...args,'--project='+project,'--quiet'],{env:{...process.env,CLOUDSDK_CONFIG:resolve('.local/gip-tools/config')},stdio:['ignore','pipe','pipe'],encoding:'utf8'});
if(command==='create'){
  run(['services','enable','iam.googleapis.com','iamcredentials.googleapis.com','sts.googleapis.com']);
  const existing=JSON.parse(run(['iam','workload-identity-pools','list','--location=global','--format=json']));
  if(!existing.some(p=>p.name.endsWith('/'+pool)))run(['iam','workload-identity-pools','create',pool,'--location=global','--display-name=Star Dev authentication']);
  const providers=JSON.parse(run(['iam','workload-identity-pools','providers','list','--workload-identity-pool='+pool,'--location=global','--format=json']));
  if(!providers.some(p=>p.name.endsWith('/'+provider)))run(['iam','workload-identity-pools','providers','create-oidc',provider,'--location=global','--workload-identity-pool='+pool,
    '--display-name=Star staging Worker','--issuer-uri='+credential.issuer,'--attribute-mapping=google.subject=assertion.sub',
    "--attribute-condition=assertion.sub == 'star-website-staging'",'--jwk-json-path='+dir+'/workload-public-jwks.json']);
  console.log('Created the Dev workload pool and provider; no service-account impersonation has been granted yet.');
} else if(command==='grant'){
  run(['iam','service-accounts','add-iam-policy-binding',serviceAccount,
    '--role=roles/iam.workloadIdentityUser',`--member=principal://iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/subject/star-website-staging`,'--format=value(version)']);
  console.log('Only the pinned star-website-staging workload can obtain short-lived credentials for the approved Dev runtime account.');
} else if(command==='grant-tenants'){
  const token=run(['auth','print-access-token','info@starreusa.com']).trim();
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json','x-goog-user-project':project};
  const role=`projects/${project}/roles/starAuthRuntime`,member=`serviceAccount:${serviceAccount}`;
  for(const tenant of ['Applicant-sw0j9','Workspace-7ppgr']){
    const base=`https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/tenants/${tenant}`;
    async function policyRequest(method,body){
      const r=await fetch(base+':'+method,{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(15000),body:JSON.stringify(body)});
      if(!r.ok)throw new Error(`Dev tenant IAM ${method} failed (${r.status}); no broader role was attempted.`);
      return r.json();
    }
    const policy=await policyRequest('getIamPolicy',{});policy.bindings??=[];
    let binding=policy.bindings.find(b=>b.role===role&&!b.condition);
    if(!binding){binding={role,members:[]};policy.bindings.push(binding);}
    if(!binding.members.includes(member)){
      binding.members.push(member);
      await policyRequest('setIamPolicy',{policy});
    }
    console.log(`${tenant}: approved custom role bound, other policy entries preserved.`);
  }
}
