import type { ApplicantChecksProvider, PaymentReceipt, ScreeningOrder } from '../../contracts/applicant-checks.ts';
export function makeScreeningSimulator(origin:string,token:string,http:typeof fetch=fetch):ApplicantChecksProvider {
  const url=new URL(origin);
  if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !token)throw new Error('Internal screening simulator is not configured.');
  async function call(path:string,body?:unknown) {
    let response:Response;
    try {response=await http(new URL(path,url),{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});}
    catch {throw Object.assign(new Error('The screening test provider is unavailable. Retry this step; your application is retained.'),{status:503});}
    if(response.status===404)return null;
    if(!response.ok)throw Object.assign(new Error('The screening test provider is unavailable. Retry this step; your application is retained.'),{status:503});
    return response.json();
  }
  return {
    async payment(id,outcome){const r=await call(`/payments/${encodeURIComponent(id)}`,{outcome});if(!r || r.application_id!==id || r.simulated!==true || !['paid','pending','failed'].includes(r.status) || r.amount!==2000 || r.currency!=='USD')throw new Error('Invalid test payment receipt.');return r as PaymentReceipt;},
    async order(id,materials){const r=await call(`/screenings/${encodeURIComponent(id)}`,materials);if(!r || r.application_id!==id)throw new Error('Invalid screening order.');return r as ScreeningOrder;},
    async result(id){const r=await call(`/screenings/${encodeURIComponent(id)}`);if(r && (r.application_id!==id || !['pending','complete','failed'].includes(r.status)))throw new Error('Invalid screening response.');return r as ScreeningOrder|null;}
  };
}
