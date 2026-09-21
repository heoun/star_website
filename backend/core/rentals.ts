import { screeningIssue, reportEvidenceIssue, externalReport, NO_SCORE_HOLD } from './screening.ts';
import type { RentalDependencies, RentalGroup, RentalMemberSummary, RentalPrincipal, RentalInvitation } from '../contracts/rentals.ts';
import type { WorkspaceApplication, WorkspaceCommand, WorkspaceState, WorkspaceTerms } from '../contracts/workspace.ts';
import { canAccessCase, projectCase, makeWorkspace, WorkspaceError, TERM_FIELDS } from './workspace.ts';
const address = (v: unknown) => String(v || '').trim().toLowerCase();
const text = (v: unknown, max=2000) => String(v || '').trim().slice(0,max);
const terminal = (g: RentalGroup) => ['lease_sent','lease_signed','declined'].includes(g.root.status);
// One lease signer per bedroom, so a two-bedroom home takes the applicant and
// one roommate and a studio takes one person. An unreadable bedroom count
// allows one roommate, as the application form does.
export function householdCapacity(listing?: unknown) {
  const bedrooms=parseInt(String((listing as {bedrooms?: unknown} | null | undefined)?.bedrooms ?? '').trim(),10);
  return Number.isFinite(bedrooms) ? Math.max(1,Math.min(5,bedrooms)) : 2;
}
export function capacityMessage(listing?: unknown) {
  const n=householdCapacity(listing);
  return n===1 ? 'This home takes one applicant on its lease.' : `This home takes up to ${n} applicants on one lease.`;
}
export function rentalMembers(g: RentalGroup, allowMock=false): RentalMemberSummary[] {
  return g.members.map(m => {
    const s=m.workspace?.screening_result, issue=screeningIssue(m,allowMock);
    const employer = m.current_employer as {name?:string;employer?:string;position?:string} | undefined;
    return {id:m.id,name:text(m.name,200),annual_income:text(m.income_note,60),income_source:'Applicant reported',
      employment:text(m.employment_status === 'student' ? `Student · ${(m.student as {school_name?:string})?.school_name || ''}` : [employer?.employer || employer?.name, employer?.position].filter(Boolean).join(' · ') || m.employment_status,200),
      credit_score:!issue ? s?.credit_score ?? null : null,
      score_model:s?.model || '',report_date:s?.date || '',
      report_status:!issue ? 'Complete' : s?.status==='complete' ? 'Needs review' : 'Pending',report_issue:issue,mock:s?.mock === true};
  });
}
function reopen(w: WorkspaceState) {
  delete w.recommendation; delete w.landlord_decision; delete w.delivery; delete w.lease_draft;
  delete w.lease_preparation; delete w.tenant_signature; delete w.landlord_signature; delete w.signature_receipts;
}
// Why a group can take no part in a join, as the application joined or the
// one joining, with the reason staff read. An envelope out for signature is
// cancelled through its own void flow first, never from here. A signature on
// file, an executed lease or a closed case is never merged. Empty when the
// group may join or be joined at its present stage.
export function mergeLock(g: RentalGroup): string {
  for(const m of [g.root,...g.members.filter(m=>m.id!==g.root.id)]) {
    const w=m.workspace || {},name=text(m.name,200) || 'this application';
    const signed=!!(w.tenant_signature || w.landlord_signature || Object.keys(w.signature_receipts || {}).length);
    if(w.signing && !['voided','declined'].includes(w.signing.phase)) return `Void the DocuSign signing request for ${name} first.${signed ? ' A signature is already on that envelope.' : ''}`;
    if(m.status==='lease_signed' || w.signed_lease) return `The lease for ${name} is already executed.`;
    if(signed || m.status==='lease_sent') return `Signatures are already recorded for ${name}.`;
    if(m.status==='declined') return `The application for ${name} is closed.`;
  }
  return '';
}
export function makeRentals(d: RentalDependencies) {
  async function group(id:string) { const g=await d.store.group(id); if(!g) throw new WorkspaceError('Rental not found.',404);return g; }
  async function load(p:RentalPrincipal,id:string) { const g=await group(id); if(!canAccessCase(p,g.root)) throw new WorkspaceError('Rental not found.',404);return g; }
  // What one applicant still owes, and separately the hold a documented
  // no-score report puts on automatic sharing: that report is complete from
  // the applicant's side and the team's to review.
  function memberStatus(m:WorkspaceApplication) {
    const owed:string[]=[];
    if(m.status==='needs_info') owed.push(`${m.name}: requested information pending`);
    if(!text(m.name)) owed.push('Applicant legal name missing');
    const docs=d.missingDocuments(m); if(docs.length) owed.push(`${m.name}: ${docs.join(', ')}`);
    if(!['paid','waived'].includes(m.workspace?.checks?.fee || '') && m.workspace?.screening_result?.status!=='complete') owed.push(`${m.name}: application payment pending`);
    const reportIssue=screeningIssue(m,d.allowMockScreening);
    if(reportIssue && reportIssue!==NO_SCORE_HOLD) owed.push(`${m.name}: ${reportIssue}`);
    return {owed,hold:reportIssue===NO_SCORE_HOLD ? `${m.name}: ${reportIssue}` : ''};
  }
  function applicantComplete(m:WorkspaceApplication) {return !memberStatus(m).owed.length;}
  function readiness(g:RentalGroup) {
    const issues:string[]=[];
    for(const i of g.root.workspace?.invitations || []) if(!i.accepted) issues.push(`${i.name || i.email}: ${Date.parse(i.expires)<Date.now() ? 'invitation expired' : 'waiting for application'}`);
    for(const m of g.members) {const s=memberStatus(m);issues.push(...s.owed);if(s.hold) issues.push(s.hold);}
    const terms=g.root.workspace?.terms || {};
    for(const field of ['lease.commencement_date','lease.end_date','rent.monthly','deposit.amount'] as const) if(!terms[field]) issues.push(`Lease terms: ${field}`);
    return issues;
  }
  function view(p:RentalPrincipal,g:RentalGroup) {
    const base=projectCase(p,g.root,true) as Record<string,any>;
    const issues=readiness(g);
    if(p.role==='landlord') {
      base.progression_blocked=issues.length>0;
      if(issues.length) base.allowed_actions=[];
      base.recommendation.members=g.root.workspace?.recommendation?.members || [];
      base.next_step.label=g.root.status==='sent_to_landlord' ? 'Decide Whether to Proceed' : base.next_step.label;
      base.allowed_actions=(base.allowed_actions as string[]).filter(a=>a!=='landlord_changes');
      return base;
    }
    if(g.root.workspace?.automation_issue) issues.push(g.root.workspace.automation_issue);
    base.household={members:g.members.map(m=>projectCase(p,{...m,responsible_email:g.root.responsible_email,collaborator_emails:g.root.collaborator_emails},true)),
      invitations:g.root.workspace?.invitations || [],issues,summary:rentalMembers(g,d.allowMockScreening),join_lock:mergeLock(g)};
    base.allowed_actions=(base.allowed_actions as string[]).filter(a=>!['approve','recommend','review_and_recommend','decline','record_tenant_signature'].includes(a));
    base.allowed_actions.push('group');
    const w=g.root.workspace || {};
    if(w.signing && !['voided','declined'].includes(w.signing.phase)) {
      base.allowed_actions=base.allowed_actions.filter((a:string)=>['group','note','admin_note','assign'].includes(a));
    }
    if(!terminal(g) && !['sent_to_landlord','landlord_approved'].includes(g.root.status)) {
      const staffIssue=issues.some(i=>/Lease terms|Assign a landlord/.test(i)) || g.members.some(m=>!!screeningIssue(m,d.allowMockScreening) && ['complete','not_connected','failed'].includes(m.workspace?.screening_result?.status || ''));
      base.next_step={...base.next_step,label:issues.length ? 'Complete the Application Group' : 'Preparing the Landlord Email',bucket:staffIssue ? 'attention':'waiting',owner:staffIssue ? 'you':'applicant'};
    }
    if(p.role==='manager' && !g.root.responsible_email && !terminal(g)) base.next_step={...base.next_step,label:'Assign a Responsible Agent',bucket:'attention',owner:'you'};
    if(w.delivery?.status==='failed') base.next_step={...base.next_step,label:'Retry the Landlord Email',bucket:'attention',owner:'you'};
    if(g.root.status==='landlord_approved') base.next_step={...base.next_step,label:!w.lease_preparation || w.lease_draft?.missing.length || w.lease_draft?.error ? 'Complete the Lease Draft' : 'Review the Lease & Collect Signatures',bucket:'attention',owner:'you'};
    if(g.root.status==='lease_sent' && !w.tenant_signature) base.next_step={...base.next_step,label:'Collect the Remaining Tenant Signatures',bucket:'attention',owner:'you'};
    base.progression_blocked=issues.length>0;
    if(issues.length && ['sent_to_landlord','landlord_approved','lease_sent','lease_signed'].includes(g.root.status)) {
      base.next_step={...base.next_step,label:'Resolve Incomplete Application Evidence',bucket:'attention',owner:'you'};
      base.allowed_actions=base.allowed_actions.filter((a:string)=>!['prepare_lease','record_landlord_signature','archive_lease'].includes(a));
      if(g.root.status==='landlord_approved' && !w.tenant_signature && !Object.keys(w.signature_receipts || {}).length) base.allowed_actions.push('reopen_review');
    }
    if(w.signing && !['voided','declined'].includes(w.signing.phase)) {
      const phase=w.signing.phase;
      base.next_step={...base.next_step,label:phase==='completed'?'Lease Completed':phase==='needs_attention'?'Review the DocuSign Signing Issue':phase==='archiving'?'Saving the Signed Lease':phase==='preparing'||phase==='sending'?'Sending the Lease with DocuSign':'Waiting for DocuSign Signatures',bucket:phase==='needs_attention'?'attention':'waiting',owner:phase==='needs_attention'?'you':'signers'};
    }
    return base;
  }
  function assertReady(g:RentalGroup) {const issues=readiness(g);if(issues.length) throw new WorkspaceError(`Application group is not ready: ${issues.join(' ')}`,409);}
  async function prepare(g:RentalGroup) {
    assertReady(g);
    const w=g.root.workspace!;
    try {
      const result=await d.lease(g,w.recommendation?.terms || w.terms || {});
      w.lease_draft={...result,at:new Date().toISOString(),revision:w.recommendation!.revision};
      if(!result.missing.length) {g.root.lease_snapshot=result.values;w.lease_preparation={by:'system',at:w.lease_draft.at};}
    } catch {w.lease_draft={values:{},missing:[],error:'Lease defaults could not be loaded. Retry draft generation.',at:new Date().toISOString(),revision:w.recommendation!.revision};}
  }
  // An independent application for the same home joins this group at any
  // stage before signing starts; the destination keeps its terms and team.
  // The household changed, so both sides lose their landlord packet,
  // decision, lease draft and frozen snapshot and the group is reviewed
  // again as one. Each applicant keeps their own application, uploads, fee,
  // report, confirmation and history: nobody pays or is screened again
  // because of the join.
  async function join(g:RentalGroup,source:RentalGroup,actor:string,detail:string) {
    const root=g.root;
    if(source.root.id===root.id) throw new WorkspaceError('Choose a different application to join.');
    if(source.root.listing_id!==root.listing_id) throw new WorkspaceError('Only an application for this same unit can be joined.');
    if(source.members.length!==1) throw new WorkspaceError('The other application already has more than one applicant. Split it first.');
    if(source.root.workspace?.invitations?.some(i=>!i.accepted)) throw new WorkspaceError('Cancel the other application’s pending invitations first.');
    const lock=mergeLock(source) || mergeLock(g);
    if(lock) throw new WorkspaceError(lock,409);
    if(g.members.length>=householdCapacity(root.listings)) throw new WorkspaceError(capacityMessage(root.listings));
    if(g.members.some(m=>address(m.email)===address(source.root.email))) throw new WorkspaceError('This person is already in the group.');
    const now=new Date().toISOString(),from=source.root.status;
    root.workspace ||= {} as WorkspaceState;
    reopen(root.workspace);
    root.workspace.activity=[...(root.workspace.activity || []),{action:'merge_member',by:actor,at:now,detail}];
    (root.workspace.invitations || []).forEach(i=>{if(i.email===address(source.root.email)) i.accepted=source.root.id;});
    const w=structuredClone(source.root.workspace || {}) as WorkspaceState;
    reopen(w);delete w.terms;delete w.lease_overrides;delete w.review;delete w.automation_issue;delete w.invitations;
    if(w.test_run) w.test_run={...w.test_run,member_of:root.id};
    w.activity=[...(w.activity || []),{action:'merge_member',by:actor,at:now,detail:`Joined the application group led by ${text(root.name,200)} (${root.id}) from ${from}. Any approval, packet or lease draft this application held on its own no longer applies; the group is reviewed together.`}];
    const settled=['approved','sent_to_landlord','landlord_approved'].includes(from);
    await d.store.save(g,{[root.id]:{workspace:root.workspace,status:'review',lease_snapshot:null},[source.root.id]:{workspace:w,lease_snapshot:null,...(settled ? {status:'review'} : {})}},actor,source.root);
  }
  // Invitations wait for the lead applicant's fee. Ones the form already
  // emailed arrive marked sent; the admin's own invitations go out at once.
  async function notifyInvitations(id:string) {
    const g=await group(id),lead=g.members.find(m=>m.id===g.root.id);
    if(!['paid','waived'].includes(lead?.workspace?.checks?.fee || '')) return;
    let changed=false;
    for(const i of g.root.workspace?.invitations || []) if(!i.accepted && !['sent','preview'].includes(i.delivery || '')) {
      changed=true;
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email) || Date.parse(i.expires)<Date.now()){i.delivery='failed';continue;}
      try{i.delivery=await d.mail.invite(g.root,i);}catch{i.delivery='failed';}
    }
    if(changed) await d.store.save(g,{[g.root.id]:{workspace:g.root.workspace}},'system');
  }
  // Each applicant's own confirmation, once their payment, documents and
  // screening are complete, whatever the rest of the group is waiting on.
  // Only applications enrolled at intake qualify; older rows are never
  // backfilled. A failed send keeps its key and waits longer each retry, and
  // is still owed after the case moves past review. A declined case or member
  // owes nothing: its unsent notice is cancelled, so the scheduler stops
  // fetching a closed case for it.
  async function notifyReady(g:RentalGroup) {
    const now=Date.now(),declined=g.root.status==='declined';
    const open=(m:WorkspaceApplication)=>{const n=m.workspace?.ready_notice;return n && ['queued','failed'].includes(n.status) ? n : null;};
    const retire=g.members.filter(m=>open(m) && (declined || m.status==='declined'));
    const due=g.members.filter(m=>{
      const n=open(m);
      if(!n || declined || m.status==='declined') return false;
      if(n.status==='failed' && now-Date.parse(n.at)<Math.min(60,2**((n.attempts || 1)-1))*60000) return false;
      return applicantComplete(m);
    });
    if(!retire.length && !due.length) return g;
    const patches:Record<string,Record<string,unknown>>={};
    for(const m of retire) {
      m.workspace={...m.workspace,ready_notice:{...open(m)!,status:'cancelled',at:new Date().toISOString()}};
      patches[m.id]={workspace:m.workspace};
    }
    for(const m of due) {
      let status:'sent'|'preview'|'failed'='failed';
      try {status=await d.mail.ready(g.root,m,`ready/${m.id}`);} catch {}
      m.workspace={...m.workspace,ready_notice:{status,at:new Date().toISOString(),attempts:(m.workspace?.ready_notice?.attempts || 0)+1}};
      patches[m.id]={workspace:m.workspace};
    }
    await d.store.save(g,patches,'system');
    return group(g.root.id);
  }
  async function reconcile(id:string) {
    let g=await group(id);
    if(g.root.workspace?.rental_flow!=='automatic') return;
    // A case that has moved past review still owes a confirmation whose send failed.
    if(terminal(g) || g.root.status==='landlord_approved') {await notifyReady(g);return;}
    if((g.root.workspace?.invitations || []).some(i=>!i.accepted && !['sent','preview','failed'].includes(i.delivery || ''))) {await notifyInvitations(id);g=await group(id);}
    // Provider calls are idempotent; results are committed with the complete
    // household version set. A concurrent edit makes the whole save fail.
    const patches:Record<string,Record<string,unknown>>={};
    for(const m of g.members) if(['paid','waived'].includes(m.workspace?.checks?.fee || '') && m.workspace?.screening_result?.status!=='complete') {
      const result=await d.screening.check(m);
      if(JSON.stringify(result)!==JSON.stringify(m.workspace?.screening_result)) {
        m.workspace={...m.workspace,screening_result:result};
        if(!reportEvidenceIssue(result,m.id,d.allowMockScreening) && m.workspace.checks) m.workspace.checks={...m.workspace.checks,screening:'received',credit_score:result.credit_score};
        patches[m.id]={workspace:m.workspace};
      }
    }
    if(Object.keys(patches).length) {await d.store.save(g,patches,'system');g=await group(id);}
    g=await notifyReady(g);
    const w=g.root.workspace || {};
    if(!w.recommendation && g.root.status!=='landlord_approved' && !readiness(g).length) {
      const recipient=await d.landlord(g.root);
      if(!recipient) {
        if(w.automation_issue!=='Assign a landlord signer to this property.') {w.automation_issue='Assign a landlord signer to this property.';await d.store.save(g,{[g.root.id]:{workspace:w}},'system');}
        return;
      }
      delete w.automation_issue;
      const members=rentalMembers(g,d.allowMockScreening),now=new Date().toISOString();
      w.recommendation={revision:(g.root.workspace_version || 0)+1,sent_at:now,sent_by:g.root.responsible_email || 'Star leasing team',landlord_email:recipient,
        tenant_name:members.map(m=>m.name).join(' & '),property_title:g.root.listings?.property_name || g.root.listings?.title || '',unit:g.root.listings?.unit || '',terms:{...w.terms},members};
      w.delivery={revision:w.recommendation.revision,status:'pending',attempt_at:'',key:`rental/${g.root.id}/${w.recommendation.revision}`};
      w.activity=[...(w.activity || []),{action:'automatic_share',by:'system',at:now,detail:'All group members complete; shared the application and lease terms with the property landlord.'}];
      await d.store.save(g,{[g.root.id]:{workspace:w,status:'sent_to_landlord'}},'system');g=await group(id);
    }
    if(g.root.status==='sent_to_landlord' && g.root.workspace?.recommendation) await deliver(g);
  }
  async function deliver(g:RentalGroup) {
    assertReady(g);
    const w=g.root.workspace!, r=w.recommendation!, prior=w.delivery;
    if(['sent','preview'].includes(prior?.status || '') || (prior?.status==='sending' && Date.now()-Date.parse(prior.attempt_at)<60000)) return;
    const key=prior?.key || `rental/${g.root.id}/${r.revision}`;
    w.delivery={revision:r.revision,status:'sending',attempt_at:new Date().toISOString(),key};
    await d.store.save(g,{[g.root.id]:{workspace:w}},'system');
    g=await group(g.root.id);
    // Recheck the committed revision before sending. Links always revalidate it.
    if(g.root.workspace?.recommendation?.revision!==r.revision) return;
    assertReady(g);
    let status:'sent'|'preview'|'failed'='failed';
    try {status=await d.mail.decision(g.root,r.members || [],key);} catch {}
    const fresh=await group(g.root.id);
    if(fresh.root.workspace?.recommendation?.revision!==r.revision) return;
    fresh.root.workspace.delivery={...w.delivery,status};
    await d.store.save(fresh,{[fresh.root.id]:{workspace:fresh.root.workspace}},'system');
  }
  return {
    load,readiness,assertReady,reconcile,
    async list(p:RentalPrincipal) {return (await d.store.list(p)).filter(g=>canAccessCase(p,g.root)).map(g=>view(p,g));},
    notifyInvitations,
    // An invited roommate who applied on their own, before or without the
    // invitation link, joins the group that named their email.
    async adoptInvited(id:string) {
      let g=await group(id);
      if(g.root.workspace?.rental_flow!=='automatic' || terminal(g) || ['sent_to_landlord','landlord_approved'].includes(g.root.status)) return;
      const open=(g.root.workspace?.invitations || []).filter(i=>!i.accepted && Date.parse(i.expires)>=Date.now());
      if(!open.length || !g.root.listing_id) return;
      const candidates=(await d.store.listing(g.root.listing_id)).filter(s=>s.root.id!==g.root.id && s.members.length===1 && !s.root.workspace?.invitations?.some(i=>!i.accepted) && !terminal(s) && !['sent_to_landlord','landlord_approved'].includes(s.root.status));
      for(const invitation of open) {
        const source=candidates.find(s=>address(s.root.email)===invitation.email);
        if(!source) continue;
        try {await join(g,source,'system',`${source.root.name} applied separately and was invited to this lease; joined automatically.`);} catch {continue;}
        g=await group(id);
      }
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
      if((w.invitations || []).filter(i=>!i.accepted && i.email!==email).length+g.members.length>=householdCapacity(g.root.listings)) throw new WorkspaceError(capacityMessage(g.root.listings));
      const invitation:RentalInvitation={id:crypto.randomUUID(),email,name,expires:new Date(Date.now()+14*86400000).toISOString()};
      w.invitations=[...(w.invitations || []).filter(i=>i.email!==email),invitation];reopen(w);
      w.activity=[...(w.activity || []),{action:'invite_member',by:p.email,at:new Date().toISOString(),detail:`Invited ${name}`}];
      await d.store.save(g,{[g.root.id]:{workspace:w,status:'review',lease_snapshot:null}},p.email);
      let delivery='failed';try {delivery=await d.mail.invite(g.root,invitation);}catch{}
      return {invited:true,delivery};
    },
    // Called only after the HTTP lease adapter validates fields and permissions.
    async correctLease(p:RentalPrincipal,id:string,version:number,overrides:Record<string,unknown>) {
      const g=await load(p,id),root=g.root,w=structuredClone(root.workspace || {});
      if(!['manager','agent'].includes(p.role) || g.root.id!==id) throw new WorkspaceError('Staff access to the shared rental is required.',403);
      if(version!==(root.workspace_version || 0)) throw new WorkspaceError('This rental changed. Refresh before saving.',409);
      if(terminal(g) || (w.signing && !['voided','declined'].includes(w.signing.phase)) || w.tenant_signature || Object.keys(w.signature_receipts || {}).length) throw new WorkspaceError('Void the signing request before correcting this lease.',409);
      if(!Object.keys(overrides).length) throw new WorkspaceError('There are no corrections to save.');
      const vacancy='dhcr.mark_vacancy',renewal='dhcr.mark_renewal';
      if(vacancy in overrides || renewal in overrides){
        if((vacancy in overrides && typeof overrides[vacancy]!=='boolean') || (renewal in overrides && typeof overrides[renewal]!=='boolean') || (vacancy in overrides && renewal in overrides && overrides[vacancy]===overrides[renewal]))throw new WorkspaceError('Choose either New Lease or Renewal.',422);
        const isNew=vacancy in overrides?overrides[vacancy]:!overrides[renewal];
        overrides={...overrides,[vacancy]:isNew,[renewal]:!isNew};
      }
      w.lease_overrides={...w.lease_overrides,...overrides};
      w.terms={...w.terms,...Object.fromEntries(Object.entries(overrides).filter(([key])=>(TERM_FIELDS as readonly string[]).includes(key)))};
      reopen(w);
      w.activity=[...(w.activity || []),{action:'terms',by:p.email,at:new Date().toISOString(),detail:`Lease-only corrections saved; previous approval and signing previews invalidated. Changed: ${Object.keys(overrides).join(', ')}. New landlord approval requested.`}];
      await d.store.save(g,{[root.id]:{workspace:w,status:'review',lease_snapshot:null}},p.email);
      await reconcile(id);
      return view(p,await group(id));
    },
    async execute(p:RentalPrincipal,id:string,command:Record<string,any>) {
      const g=await load(p,id), root=g.root;
      if(root.workspace?.signing && !['voided','declined'].includes(root.workspace.signing.phase) && !['note','admin_note','assign'].includes(command.action))throw new WorkspaceError('DocuSign manages this lease. Void the envelope before changing signing information.',409);
      if(command.version!==(root.workspace_version || 0)) throw new WorkspaceError('This rental changed. Refresh before saving.',409);
      if(['prepare_lease','refresh_draft','tenant_signed','record_landlord_signature','archive_lease'].includes(command.action)) assertReady(g);
      if(command.action==='reopen_review') {
        if(p.role==='landlord' || root.status!=='landlord_approved' || !readiness(g).length || root.workspace?.tenant_signature || Object.keys(root.workspace?.signature_receipts || {}).length) throw new WorkspaceError('Only incomplete, unsigned approvals can be reopened.',403);
        const w=structuredClone(root.workspace!);
        w.activity=[...(w.activity || []),{action:'request_info',by:p.email,at:new Date().toISOString(),detail:`Reopened incomplete approval (prior decision ${w.landlord_decision?.at || 'unrecorded'}). A new landlord decision is required.`}];
        reopen(w);
        await d.store.save(g,{[root.id]:{workspace:w,status:'review',lease_snapshot:null}},p.email);
        return view(p,await group(id));
      }
      if(command.action==='retry_delivery') {if(p.role==='landlord') throw new WorkspaceError('Staff only.',403);await reconcile(id);return view(p,await group(id));}
      if(command.action==='split_member' || command.action==='remove_member') {
        const remove=command.action==='remove_member',member=g.members.find(m=>m.id===command.member_id);
        if(!['manager','agent'].includes(p.role) || (remove && p.role!=='manager'))throw new WorkspaceError('Only a manager can delete an applicant; assigned staff can split applications.',403);
        if(!member || g.members.length<2)throw new WorkspaceError('Choose a member of a combined application.',422);
        if(command.confirmed!==true || !text(command.reason) || (remove && text(command.confirm_name)!==member.name))throw new WorkspaceError('Enter a reason and confirm the selected applicant. For deletion, type their full name.',422);
        if(g.members.some(m=>['lease_sent','lease_signed','declined'].includes(m.status) || m.workspace?.signed_lease || m.workspace?.tenant_signature || m.workspace?.landlord_signature || Object.keys(m.workspace?.signature_receipts || {}).length || (m.workspace?.signing && !['voided','declined'].includes(m.workspace.signing.phase))))throw new WorkspaceError('Void any active signing request first. Signed or closed applications cannot be split or deleted.',409);
        // Retain any signing history with its application, rather than deleting
        // the audit record or moving an old envelope onto a different person.
        if(remove && member.workspace?.signing)throw new WorkspaceError('This applicant has signing history. Split the application to retain that history instead of deleting it.',409);
        const remaining=g.members.filter(m=>m.id!==member.id),nextRoot=member.id===root.id ? remaining[0] : root;
        const now=new Date().toISOString(),detail=`${remove?'Deleted':'Split'} ${member.name} (${member.id}) from this group. Reason: ${text(command.reason)}. Previous group approval and lease draft invalidated.`;
        const patches:Record<string,Record<string,unknown>>={};
        const invitations=(root.workspace?.invitations || []).filter(i=>i.accepted!==member.id && address(i.email)!==address(member.email));
        for(const m of g.members) {
          const w=structuredClone(m.workspace || {});reopen(w);delete w.lease_overrides;delete w.review;delete w.automation_issue;
          w.invitations=m.id===nextRoot.id ? invitations : [];
          if(m.id===nextRoot.id)w.terms=structuredClone(root.workspace?.terms || {});
          if(w.test_run)w.test_run={...w.test_run,member_of:m.id===member.id?m.id:nextRoot.id};
          const history=m.id===nextRoot.id && nextRoot.id!==root.id ? [...(root.workspace?.activity || []),...(w.activity || [])] : w.activity || [];
          w.activity=[...history,{action:command.action,by:p.email,at:now,detail}];
          patches[m.id]={workspace:w,status:m.status==='needs_info'?'needs_info':'review',lease_snapshot:null};
        }
        await d.store.separate(g,member.id,nextRoot.id,remove,patches,p.email);
        return {...view(p,await group(nextRoot.id)),membership_change:{action:command.action,member_id:member.id,remaining_root:nextRoot.id}};
      }
      // Joining is explicit and staff-only, at any stage before signing
      // starts. The reason a case cannot take part is named, so the team
      // knows whether to void an envelope or leave a signed lease alone.
      if(command.action==='merge') {
        if(!['manager','agent'].includes(p.role)) throw new WorkspaceError('Staff access is required to join applications.',403);
        const lock=mergeLock(g);
        if(lock) throw new WorkspaceError(lock,409);
        if(!text(command.application_id)) throw new WorkspaceError('Choose the application to join.');
        const source=await load(p,text(command.application_id));
        if(command.source_version!==source.root.workspace_version) throw new WorkspaceError('The other application changed. Review it again.',409);
        if(command.confirmed!==true) throw new WorkspaceError('Confirm these applicants intend to share one lease.');
        await join(g,source,p.email,`Joined ${source.root.name} (${source.root.id}) to this lease group from ${source.root.status}; retained this group’s terms and assignment. Any previous landlord approval and lease draft no longer apply.`);
        await reconcile(root.id);return view(p,await group(root.id));
      }
      const patches:Record<string,Record<string,unknown>>={};
      if(terminal(g) && !['note','admin_note','assign','record_landlord_signature','archive_lease',...(root.status==='lease_sent' ? ['tenant_signed'] : [])].includes(command.action)) throw new WorkspaceError('This rental is locked for signing or closed.',403);
      if(command.action==='cancel_invite') {
        if(p.role==='landlord' || ['sent_to_landlord','landlord_approved'].includes(root.status)) throw new WorkspaceError('Change pending invitations before landlord review.',403);
        const invitation=root.workspace?.invitations?.find(i=>i.id===command.invitation_id && !i.accepted);
        if(!invitation || command.confirmed!==true) throw new WorkspaceError('Confirm that this invited roommate will not join the lease.');
        root.workspace!.invitations=root.workspace!.invitations!.filter(i=>i.id!==invitation.id);reopen(root.workspace!);
        root.workspace!.activity=[...(root.workspace!.activity || []),{action:'cancel_invite',by:p.email,at:new Date().toISOString(),detail:`Cancelled the pending invitation for ${invitation.name}`}];
        await d.store.save(g,{[root.id]:{workspace:root.workspace,status:'review',lease_snapshot:null}},p.email);
        await reconcile(root.id);return view(p,await group(root.id));
      }
      if(['approve','recommend','review_and_recommend','decline','landlord_changes','record_tenant_signature'].includes(command.action)) throw new WorkspaceError('This rental uses automatic group review.',403);
      if(p.role==='landlord') {
        if(!['landlord_accept','landlord_decline'].includes(command.action)) throw new WorkspaceError('Decision unavailable.',403);
        if(command.revision!==root.workspace?.recommendation?.revision) throw new WorkspaceError('This email is out of date. Open the latest application.',409);
        assertReady(g);
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
        const report=command.action==='checks' ? externalReport(command as WorkspaceCommand,target.id,p.email) : undefined;
        if(report?.status==='complete') {const error=reportEvidenceIssue(report,target.id);if(error) throw new WorkspaceError(error);}
        const scoped={...target,status:target===root ? target.status : root.status,responsible_email:root.responsible_email,collaborator_emails:root.collaborator_emails};
        const temp=makeWorkspace({get:async()=>scoped,list:async()=>[],staff:()=>d.store.staff(),save:async(_id,_v,patch)=>{patches[target.id]=patch;Object.assign(target,patch);return {...target,responsible_email:root.responsible_email,collaborator_emails:root.collaborator_emails};}},{missingDocuments:d.missingDocuments,allowMockScreening:d.allowMockScreening});
        await temp.execute(p,target.id,{...command,version:target.workspace_version || 0} as WorkspaceCommand);
        if(command.action==='checks') {
          target.workspace!.screening_result=report;
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
