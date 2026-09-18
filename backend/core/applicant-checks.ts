import type { ApplicantChecksProvider, ScreeningScenario } from '../contracts/applicant-checks.ts';
import type { RentalStore } from '../contracts/rentals.ts';
import { WorkspaceError } from './workspace.ts';
export function makeApplicantChecks(store:RentalStore,provider:ApplicantChecksProvider,missingDocuments:(row:any)=>string[]) {
  return {async execute(id:string,actor:{email:string;subject:string},action:string,body:Record<string,unknown>) {
    const group=await store.group(id),row=group?.members.find(m=>m.id===id);
    if(!group || !row || row.email!==actor.email || row.workspace?.test_run?.account_id!==actor.subject)throw new WorkspaceError('Test application not found.',404);
    if(['sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined'].includes(group.root.status) || group.root.workspace?.signing)throw new WorkspaceError('This application has already progressed. Start a new test run.',409);
    const w=structuredClone(row.workspace!);
    if(action==='payment') {
      if(body.outcome!==undefined && !['paid','failed'].includes(String(body.outcome)))throw new WorkspaceError('Choose a test payment outcome.',422);
      const receipt=await provider.payment(id,body.outcome as 'paid'|'failed'|undefined);
      w.test_payment=receipt;
      w.checks={...w.checks,fee:receipt.status==='paid'?'paid':'pending',screening:w.checks?.screening || 'pending',documents:w.checks?.documents || 'pending',reference:receipt.id,by:'screening-simulator',at:new Date().toISOString()};
    } else if(action==='screening') {
      if(w.test_payment?.status!=='paid' || w.checks?.fee!=='paid')throw new WorkspaceError('Complete the test payment first.',409);
      if(missingDocuments(row).length)throw new WorkspaceError('Upload all required supporting documents first.',409);
      if(body.consent!==true)throw new WorkspaceError('Confirm consent to the simulated screening.',422);
      if(!['scored','no_score','failed'].includes(String(body.scenario)))throw new WorkspaceError('Choose a screening test scenario.',422);
      const documents=(row.application_documents as {id:string;doc_type:string}[] || []).map(d=>({id:d.id,type:d.doc_type})).sort((a,b)=>a.id.localeCompare(b.id));
      const order=await provider.order(id,{consent:true,documents,scenario:body.scenario as ScreeningScenario});
      w.test_screening={order_id:order.id,consent_at:w.test_screening?.consent_at || new Date().toISOString(),scenario:body.scenario as ScreeningScenario};
    } else throw new WorkspaceError('Unknown test action.',404);
    await store.save(group,{[id]:{workspace:w}},actor.email);
    return {payment:w.test_payment,screening:w.test_screening};
  }};
}
