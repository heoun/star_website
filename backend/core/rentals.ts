import type { RentalDependencies, RentalGroup, RentalMemberSummary, RentalPrincipal, RentalInvitation } from '../contracts/rentals.ts';
import type { WorkspaceApplication, WorkspaceCommand, WorkspaceState, WorkspaceTerms } from '../contracts/workspace.ts';
import { canAccessCase, projectCase, makeWorkspace, WorkspaceError } from './workspace.ts';
const address = (v: unknown) => String(v || '').trim().toLowerCase();
const text = (v: unknown, max=2000) => String(v || '').trim().slice(0,max);
const terminal = (g: RentalGroup) => ['lease_sent','lease_signed','declined'].includes(g.root.status);
export function rentalMembers(g: RentalGroup): RentalMemberSummary[] {
  return g.members.map(m => {
    const s=m.workspace?.screening_result, c=m.workspace?.checks;
    const employer = m.current_employer as {name?:string;employer?:string;position?:string} | undefined;
    return {id:m.id,name:text(m.name,200),annual_income:text(m.income_note,60),income_source:'Applicant reported',
      employment:text(m.employment_status === 'student' ? `Student · ${(m.student as {school_name?:string})?.school_name || ''}` : [employer?.employer || employer?.name, employer?.position].filter(Boolean).join(' · ') || m.employment_status,200),
      credit_score:s?.status === 'complete' ? s.credit_score ?? null : c?.credit_score ?? null,
      score_model:s?.model || 'Model not recorded',report_date:s?.date || c?.at || '',
      report_status:s?.status === 'complete' || c?.screening === 'received' ? 'Complete' : 'Pending',mock:s?.mock === true};
  });
}
function reopen(w: WorkspaceState) {
  delete w.recommendation; delete w.landlord_decision; delete w.delivery; delete w.lease_draft;
  delete w.lease_preparation; delete w.tenant_signature; delete w.landlord_signature; delete w.signature_receipts;
}
export function makeRentals(d: RentalDependencies) {
  async function group(id:string) { const g=await d.store.group(id); if(!g) throw new WorkspaceError('Rental not found.',404);return g; }
  async function load(p:RentalPrincipal,id:string) { const g=await group(id); if(!canAccessCase(p,g.root)) throw new WorkspaceError('Rental not found.',404);return g; }
  function readiness(g:RentalGroup) {
    const issues:string[]=[];
    for(const i of g.root.workspace?.invitations || []) if(!i.accepted) issues.push(`${i.name || i.email}: ${Date.parse(i.expires)<Date.now() ? 'invitation expired' : 'waiting for application'}`);
    for(const m of g.members) {
      if(m.status==='needs_info') issues.push(`${m.name}: requested information pending`);
      if(!text(m.name)) issues.push('Applicant legal name missing');
      const docs=d.missingDocuments(m); if(docs.length) issues.push(`${m.name}: ${docs.join(', ')}`);
      if(!['paid','waived'].includes(m.workspace?.checks?.fee || '')) issues.push(`${m.name}: payment or waiver pending`);
      if(m.workspace?.screening_result?.status !== 'complete' && m.workspace?.checks?.screening !== 'received') issues.push(`${m.name}: credit report pending`);
    }
    const terms=g.root.workspace?.terms || {};
    for(const field of ['lease.commencement_date','lease.end_date','rent.monthly','deposit.amount'] as const) if(!terms[field]) issues.push(`Lease terms: ${field}`);
    return issues;
  }
  function view(p:RentalPrincipal,g:RentalGroup) {
    const base=projectCase(p,g.root,true) as Record<string,any>;
    if(p.role==='landlord') {
      base.recommendation.members=g.root.workspace?.recommendation?.members || [];
      base.next_step.label=g.root.status==='sent_to_landlord' ? 'Decide Whether to Proceed' : base.next_step.label;
      base.allowed_actions=(base.allowed_actions as string[]).filter(a=>a!=='landlord_changes');
      return base;
    }
    const issues=readiness(g);
    if(g.root.workspace?.automation_issue) issues.push(g.root.workspace.automation_issue);
    base.household={members:g.members.map(m=>projectCase(p,{...m,responsible_email:g.root.responsible_email,collaborator_emails:g.root.collaborator_emails},true)),
      invitations:g.root.workspace?.invitations || [],issues,summary:rentalMembers(g)};
    base.allowed_actions=(base.allowed_actions as string[]).filter(a=>!['approve','recommend','review_and_recommend','decline','record_tenant_signature'].includes(a));
    base.allowed_actions.push('group');
    const w=g.root.workspace || {};
    if(!terminal(g) && !['sent_to_landlord','landlord_approved'].includes(g.root.status)) {
      const staffIssue=issues.some(i=>/Lease terms|waiver|Assign a landlord/.test(i)) || w.screening_result?.status==='not_connected';
      base.next_step={...base.next_step,label:issues.length ? 'Complete the Application Group' : 'Preparing the Landlord Email',bucket:staffIssue ? 'attention':'waiting',owner:staffIssue ? 'you':'applicant'};
    }
    if(p.role==='manager' && !g.root.responsible_email && !terminal(g)) base.next_step={...base.next_step,label:'Assign a Responsible Agent',bucket:'attention',owner:'you'};
    if(w.delivery?.status==='failed') base.next_step={...base.next_step,label:'Retry the Landlord Email',bucket:'attention',owner:'you'};
    if(g.root.status==='landlord_approved') base.next_step={...base.next_step,label:w.lease_draft?.missing.length || w.lease_draft?.error ? 'Complete the Lease Draft' : 'Review the Lease & Collect Signatures',bucket:'attention',owner:'you'};
    if(g.root.status==='lease_sent' && !w.tenant_signature) base.next_step={...base.next_step,label:'Collect the Remaining Tenant Signatures',bucket:'attention',owner:'you'};
    return base;
  }
  async function prepare(g:RentalGroup) {
    const w=g.root.workspace!;
    try {
      const result=await d.lease(g,w.recommendation?.terms || w.terms || {});
      w.lease_draft={...result,at:new Date().toISOString(),revision:w.recommendation!.revision};
      if(!result.missing.length) {g.root.lease_snapshot=result.values;w.lease_preparation={by:'system',at:w.lease_draft.at};}
    } catch {w.lease_draft={values:{},missing:[],error:'Lease defaults could not be loaded. Retry draft generation.',at:new Date().toISOString(),revision:w.recommendation!.revision};}
  }
  async function reconcile(id:string) {
    let g=await group(id);
    if(terminal(g) || g.root.workspace?.rental_flow!=='automatic') return;
    // Provider calls are idempotent; results are committed with the complete
    // household version set. A concurrent edit makes the whole save fail.
    const patches:Record<string,Record<string,unknown>>={};
    for(const m of g.members) if(m.workspace?.screening_result?.status!=='complete' && m.workspace?.checks?.screening!=='received') {
      const result=await d.screening.check(m);
      if(JSON.stringify(result)!==JSON.stringify(m.workspace?.screening_result)) {
        m.workspace={...m.workspace,screening_result:result};patches[m.id]={workspace:m.workspace};
      }
    }
    if(Object.keys(patches).length) {await d.store.save(g,patches,'system');g=await group(id);}
    const w=g.root.workspace || {};
    if(!w.recommendation && g.root.status!=='landlord_approved' && !readiness(g).length) {
      const recipient=await d.landlord(g.root);
      if(!recipient) {
        if(w.automation_issue!=='Assign a landlord signer to this property.') {w.automation_issue='Assign a landlord signer to this property.';await d.store.save(g,{[g.root.id]:{workspace:w}},'system');}
        return;
      }
      delete w.automation_issue;
      const members=rentalMembers(g),now=new Date().toISOString();
      w.recommendation={revision:(g.root.workspace_version || 0)+1,sent_at:now,sent_by:g.root.responsible_email || 'Star leasing team',landlord_email:recipient,
        tenant_name:members.map(m=>m.name).join(' & '),property_title:g.root.listings?.property_name || g.root.listings?.title || '',unit:g.root.listings?.unit || '',terms:{...w.terms},members};
      w.delivery={revision:w.recommendation.revision,status:'pending',attempt_at:'',key:`rental/${g.root.id}/${w.recommendation.revision}`};
      w.activity=[...(w.activity || []),{action:'automatic_share',by:'system',at:now,detail:'All group members complete; shared the application and lease terms with the property landlord.'}];
      await d.store.save(g,{[g.root.id]:{workspace:w,status:'sent_to_landlord'}},'system');g=await group(id);
    }
    if(g.root.status==='sent_to_landlord' && g.root.workspace?.recommendation) await deliver(g);
  }
  async function deliver(g:RentalGroup) {
    const w=g.root.workspace!, r=w.recommendation!, prior=w.delivery;
    if(['sent','preview'].includes(prior?.status || '') || (prior?.status==='sending' && Date.now()-Date.parse(prior.attempt_at)<60000)) return;
    const key=prior?.key || `rental/${g.root.id}/${r.revision}`;
    w.delivery={revision:r.revision,status:'sending',attempt_at:new Date().toISOString(),key};
    await d.store.save(g,{[g.root.id]:{workspace:w}},'system');
    g=await group(g.root.id);
    // Recheck the committed revision before sending. Links always revalidate it.
    if(g.root.workspace?.recommendation?.revision!==r.revision) return;
    let status:'sent'|'preview'|'failed'='failed';
    try {status=await d.mail.decision(g.root,r.members || [],key);} catch {}
    const fresh=await group(g.root.id);
    if(fresh.root.workspace?.recommendation?.revision!==r.revision) return;
    fresh.root.workspace.delivery={...w.delivery,status};
    await d.store.save(fresh,{[fresh.root.id]:{workspace:fresh.root.workspace}},'system');
  }
  return {
    load,readiness,reconcile,
    async list(p:RentalPrincipal) {return (await d.store.list(p)).filter(g=>canAccessCase(p,g.root)).map(g=>view(p,g));},
    async notifyInvitations(id:string) {
      const g=await group(id);
      for(const i of g.root.workspace?.invitations || []) if(!i.accepted && !['sent','preview'].includes(i.delivery || '')) {
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email) || Date.parse(i.expires)<Date.now()){i.delivery='failed';continue;}
        try{i.delivery=await d.mail.invite(g.root,i);}catch{i.delivery='failed';}
      }
      await d.store.save(g,{[g.root.id]:{workspace:g.root.workspace}},'system');
    },
    async get(p:RentalPrincipal,id:string) {return view(p,await load(p,id));},
    async invite(p:RentalPrincipal,id:string,command:Record<string,any>) {
      const g=await load(p,id);
      if(p.role==='landlord' || terminal(g) || g.root.status==='landlord_approved') throw new WorkspaceError('Invitations are unavailable at this stage.',403);
      if(command.version!==g.root.workspace_version) throw new WorkspaceError('This rental changed. Refresh first.',409);
      const email=address(command.email),name=text(command.name,160);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) throw new WorkspaceError('Enter the roommate name and email.');
      if(g.members.some(m=>address(m.email)===email)) throw new WorkspaceError('This applicant is already in the group.');
      const w=g.root.workspace!;
      if((w.invitations || []).filter(i=>!i.accepted && i.email!==email).length+g.members.length>=10) throw new WorkspaceError('A group supports up to 10 applicants.');
      const invitation:RentalInvitation={id:crypto.randomUUID(),email,name,expires:new Date(Date.now()+14*86400000).toISOString()};
      w.invitations=[...(w.invitations || []).filter(i=>i.email!==email),invitation];reopen(w);
      w.activity=[...(w.activity || []),{action:'invite_member',by:p.email,at:new Date().toISOString(),detail:`Invited ${name}`}];
      await d.store.save(g,{[g.root.id]:{workspace:w,status:'review',lease_snapshot:null}},p.email);
      let delivery='failed';try {delivery=await d.mail.invite(g.root,invitation);}catch{}
      return {invited:true,delivery};
    },
    async execute(p:RentalPrincipal,id:string,command:Record<string,any>) {
      const g=await load(p,id), root=g.root;
      if(command.version!==(root.workspace_version || 0)) throw new WorkspaceError('This rental changed. Refresh before saving.',409);
      if(command.action==='retry_delivery') {if(p.role==='landlord') throw new WorkspaceError('Staff only.',403);await reconcile(id);return view(p,await group(id));}
      const patches:Record<string,Record<string,unknown>>={};
      if(terminal(g) && !['note','admin_note','assign','record_landlord_signature',...(root.status==='lease_sent' ? ['tenant_signed'] : [])].includes(command.action)) throw new WorkspaceError('This rental is locked for signing or closed.',403);
      if(command.action==='cancel_invite') {
        if(p.role==='landlord' || ['sent_to_landlord','landlord_approved'].includes(root.status)) throw new WorkspaceError('Change pending invitations before landlord review.',403);
        const invitation=root.workspace?.invitations?.find(i=>i.id===command.invitation_id && !i.accepted);
        if(!invitation || command.confirmed!==true) throw new WorkspaceError('Confirm that this invited roommate will not join the lease.');
        root.workspace!.invitations=root.workspace!.invitations!.filter(i=>i.id!==invitation.id);reopen(root.workspace!);
        root.workspace!.activity=[...(root.workspace!.activity || []),{action:'cancel_invite',by:p.email,at:new Date().toISOString(),detail:`Cancelled the pending invitation for ${invitation.name}`}];
        await d.store.save(g,{[root.id]:{workspace:root.workspace,status:'review',lease_snapshot:null}},p.email);
        await reconcile(root.id);return view(p,await group(root.id));
      }
      if(command.action==='merge') {
        if(p.role==='landlord' || terminal(g) || ['sent_to_landlord','landlord_approved'].includes(root.status)) throw new WorkspaceError('Change group membership before landlord review.',409);
        const source=await load(p,text(command.application_id));
        if(source.root.id===root.id || source.members.length!==1 || source.root.listing_id!==root.listing_id || terminal(source) || ['sent_to_landlord','landlord_approved'].includes(source.root.status) || source.root.workspace?.invitations?.some(i=>!i.accepted)) throw new WorkspaceError('Choose an independent application for this same unit, before landlord review.');
        if(command.source_version!==source.root.workspace_version) throw new WorkspaceError('The other application changed. Review it again.',409);
        if(g.members.length>=10) throw new WorkspaceError('A group supports up to 10 applicants.');
        if(g.members.some(m=>address(m.email)===address(source.root.email))) throw new WorkspaceError('This person is already in the group.');
        if(command.confirmed!==true) throw new WorkspaceError('Confirm these applicants intend to share one lease.');
        reopen(root.workspace!);
        root.workspace!.activity=[...(root.workspace!.activity || []),{action:'merge_member',by:p.email,at:new Date().toISOString(),detail:`Joined ${source.root.name} to this lease group; retained the destination group’s terms and assignment.`}];
        const invitations=root.workspace?.invitations || [];invitations.forEach(i=>{if(i.email===address(source.root.email)) i.accepted=source.root.id;});
        await d.store.save(g,{[root.id]:{workspace:root.workspace,status:'review',lease_snapshot:null}},p.email,source.root);
        await reconcile(root.id);return view(p,await group(root.id));
      }
      if(['approve','recommend','review_and_recommend','decline','landlord_changes','record_tenant_signature'].includes(command.action)) throw new WorkspaceError('This rental uses automatic group review.',403);
      if(p.role==='landlord') {
        if(!['landlord_accept','landlord_decline'].includes(command.action)) throw new WorkspaceError('Decision unavailable.',403);
        if(command.revision!==root.workspace?.recommendation?.revision) throw new WorkspaceError('This email is out of date. Open the latest application.',409);
        if(readiness(g).length) throw new WorkspaceError('This application group has changed and is not ready.',409);
      }
      if(command.action==='tenant_signed') {
        if(p.role==='landlord' || !['landlord_approved','lease_sent'].includes(root.status) || !root.lease_snapshot || !root.workspace?.lease_preparation) throw new WorkspaceError('A complete approved lease is required.',409);
        if(!g.members.some(m=>m.id===command.member_id) || !text(command.reason)) throw new WorkspaceError('Choose a lease signer and enter the signing receipt.');
        if(root.workspace.signature_receipts?.[command.member_id]) throw new WorkspaceError('This signer already has a recorded receipt.',409);
        const w=root.workspace;w.signature_receipts={...w.signature_receipts,[command.member_id]:{reference:text(command.reason),by:p.email,at:new Date().toISOString()}};
        root.status='lease_sent';
        w.activity=[...(w.activity || []),{action:'tenant_signed',by:p.email,at:new Date().toISOString(),detail:`Signature receipt recorded for ${g.members.find(m=>m.id===command.member_id)?.name}`}];
        if(g.members.every(m=>w.signature_receipts?.[m.id])) {w.tenant_signature={reference:'Individual receipts recorded for every lease signer',by:p.email,at:new Date().toISOString()};root.status='lease_sent';}
        patches[root.id]={workspace:w,status:root.status};
      } else if(command.action==='refresh_draft') {
        if(p.role==='landlord' || root.status!=='landlord_approved' || root.workspace?.lease_preparation) throw new WorkspaceError('Only incomplete approved drafts may be refreshed.',403);
        await prepare(g);patches[root.id]={workspace:root.workspace,lease_snapshot:root.lease_snapshot || null};
        root.workspace!.activity=[...(root.workspace!.activity || []),{action:'refresh_draft',by:p.email,at:new Date().toISOString(),detail:'Refreshed incomplete lease draft from current property defaults.'}];
      } else {
        const target=command.member_id ? g.members.find(m=>m.id===command.member_id) : root;
        if(!target || (target!==root && !['checks','request_info'].includes(command.action))) throw new WorkspaceError('Choose a valid member action.');
        const scoped={...target,status:target===root ? target.status : root.status,responsible_email:root.responsible_email,collaborator_emails:root.collaborator_emails};
        const temp=makeWorkspace({get:async()=>scoped,list:async()=>[],staff:()=>d.store.staff(),save:async(_id,_v,patch)=>{patches[target.id]=patch;Object.assign(target,patch);return {...target,responsible_email:root.responsible_email,collaborator_emails:root.collaborator_emails};}});
        await temp.execute(p,target.id,{...command,version:target.workspace_version || 0} as WorkspaceCommand);
        if(command.action==='checks') {
          const c=target.workspace!.checks!;
          target.workspace!.screening_result=c.screening==='received' ? {status:'complete',credit_score:c.credit_score,reference:c.reference,model:text(command.score_model,80)||'Model not recorded',date:c.at,mock:false} : {status:'pending'};
        }
        if(['checks','terms','request_info'].includes(command.action)) {reopen(root.workspace!);patches[root.id]={...patches[root.id],workspace:root.workspace,status:'review',lease_snapshot:null};}
        if(command.action==='landlord_accept') {await prepare(g);patches[root.id]={...patches[root.id],workspace:root.workspace,lease_snapshot:root.lease_snapshot || null};}
      }
      await d.store.save(g,patches,p.email);
      if(p.role!=='landlord') await reconcile(root.id);
      const fresh=await group(root.id);
      return canAccessCase(p,fresh.root) ? view(p,fresh) : {id:root.id,recorded:true};
    }
  };
}
