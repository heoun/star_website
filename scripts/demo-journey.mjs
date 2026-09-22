// Explicit local-demo scenario pack. No production imports or external services.
import {completeDemoState} from './demo-data.mjs';
import {normalizeDemoNames} from './demo-names.mjs';
import {rentalWorkflow} from '../worker/rentals.js';
import {readFileSync} from 'node:fs';
const id=n=>`dede0000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const JOURNEY_SCENARIOS=[
 {key:'unassigned',property:'A',unit:'2A',title:'未指定 Agent',note:'已付款，信用报告处理中；申请时没有选择 sales person，等待 Admin 分配。'},
 {key:'documents',property:'A',unit:'2A',title:'等待补齐材料',note:'已付款并收到信用报告；原银行流水需要替换，已记录补件要求，不能发给房东。'},
 {key:'group-report',property:'B',unit:'4B',members:2,title:'整组已提交，一人报告未完成',note:'两名申请人都已提交并付款；必须等第二人的信用报告完成。'},
 {key:'no-score',property:'C',unit:'1A',title:'报告没有信用分数',note:'服务商返回 no score，保留原因，需要人工处理，不能自动推进。'},
 {key:'landlord',property:'C',unit:'1A',title:'等待房东决定',note:'单人申请资料、付款和报告齐全，已发送本地房东邮件。'},
 {key:'declined',property:'C',unit:'1A',title:'房东不同意推进',note:'房东已明确拒绝；保留决定记录，不生成租约。'},
 {key:'draft',property:'C',unit:'2A',title:'房东同意，租约可下载',note:'租约内容已自动生成并保存，可查看和下载 Word，尚未签署。'},
 {key:'missing-default',property:'C',unit:'3A',title:'房东同意，租约仍缺信息',note:'这个 Unit 的押金银行地址为空；补齐默认设置后刷新草稿。'},
 {key:'partial-signatures',property:'D',unit:'2A',members:2,title:'部分租客已签署',note:'两名租客中只有一人签署，尚不能记录房东签署。'},
 {key:'landlord-signature',property:'D',unit:'3A',members:2,title:'所有租客已签，等待房东签署',note:'整组租客回执齐全，现在可以记录房东签署。'},
 {key:'archive',property:'D',unit:'4A',title:'双方已签，等待归档',note:'租客和房东签署回执齐全，尚未上传签署后的 PDF。'},
 {key:'completed',property:'D',unit:'5A',title:'已完成并归档',note:'签署顺序完整，已归档带有醒目标记的合成 PDF。'},
];
export async function seedJourney(state,env,request) {
 if(state.demo_journey?.version===1)return;
 normalizeDemoNames(state);
 for(const letter of ['C','D'])if(!state.buildings.some(b=>b.name===`Property ${letter}`))state.buildings.push({id:id(letter==='C'?1:2),name:`Property ${letter}`});
 await completeDemoState(state);normalizeDemoNames(state);
 const properties=Object.fromEntries(['A','B','C','D'].map(l=>[l,state.buildings.find(b=>b.name===`Property ${l}`)]));
 for(const letter of ['C','D'])for(const l of state.listings.filter(l=>l.building_id===properties[letter].id))l.published=true;
 const agentA=state.staff.find(s=>s.email==='agent-a@example.test'),agentB=state.staff.find(s=>s.email==='agent-b@example.test');
 for(const [agent,letter]of [[agentA,'C'],[agentB,'D']])agent.property_ids=[...new Set([...agent.property_ids,properties[letter].id])];
 const sample=state.applications.find(a=>a.name==='Applicant A');
 const created=[];
 for(const [i,scenario]of JOURNEY_SCENARIOS.entries()){
  const property=properties[scenario.property];let listing=state.listings.find(l=>l.building_id===property.id && l.unit===scenario.unit);
  if(!listing){const source=state.listings.find(l=>l.building_id===property.id);listing={...structuredClone(source),id:id(100+i),unit:scenario.unit,published:true,listing_media:[],video_url:null};state.listings.push(listing);}
  listing.published=true;
  state.demo_seed.listings[`${listing.id}:application`]=true;
  const groupId=id(1000+i*10),memberIds=[];
  for(let j=0;j<(scenario.members || 1);j++){
   const appId=id(1000+i*10+j);memberIds.push(appId);
   const a={...structuredClone(sample),id:appId,rental_group_id:groupId,listing_id:listing.id,listings:structuredClone(listing),name:`Scenario ${i+1} Member ${j+1}`,first_name:'Scenario',last_name:`${i+1}-${j+1}`,email:`journey-${i+1}-${j+1}@example.test`,responsible_email:scenario.property==='B'||scenario.property==='D'?agentB.email:agentA.email,collaborator_emails:[],status:'review',roommates:[],notes:'',submitted:{},lease_snapshot:null,workspace_version:0,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),workspace:{rental_flow:'automatic',terms:{...sample.workspace.terms,'rent.monthly':String(listing.price_amount),'deposit.amount':String(listing.price_amount)},checks:{fee:'paid',screening:'pending',documents:'verified',reference:`Mock payment receipt ${appId}`,by:'system',at:new Date().toISOString()},invitations:[],activity:[{action:'note',by:'demo',at:new Date().toISOString(),detail:`Mock scenario: ${scenario.title}. ${scenario.note}`}]}};
   delete a.application_documents;
   if(scenario.key==='unassigned'){a.responsible_email=null;a.workspace.demo_screening_status='pending';}
   if(scenario.key==='group-report' && j===1)a.workspace.demo_screening_status='pending';
   if(scenario.key==='no-score')a.workspace.demo_screening_status='no_score';
   state.applications.push(a);
  }
  created.push({...scenario,id:groupId,listingId:listing.id,memberIds});
 }
 // C/D's original listings should not also receive an unrelated auto-created row.
 for(const l of state.listings.filter(l=>['C','D'].some(x=>properties[x].id===l.building_id)))state.demo_seed.listings[`${l.id}:application`]=true;
 await completeDemoState(state);normalizeDemoNames(state);
 const flow=rentalWorkflow(env,request),admin={role:'manager',email:'admin@example.test'};
 for(const scenario of created){
  const raw=()=>state.applications.find(a=>a.id===scenario.id);
  if(scenario.key==='documents'){
   const removed=state.documents.filter(d=>d.application_id===scenario.id && d.doc_type==='bank_statement');
   for(const d of removed)delete state.files[d.path];
   state.documents=state.documents.filter(d=>!removed.includes(d));
   raw().workspace.checks.documents='pending';
  }
  if(scenario.key==='missing-default'){
   state.unit_settings ||= {};state.unit_settings[scenario.listingId]={'deposit.bank_address':''};
  }
  await flow.reconcile(scenario.id);
  if(scenario.key==='documents')await flow.execute(admin,scenario.id,{action:'request_info',version:raw().workspace_version,reason:'Mock document review: replace the unreadable bank statements with two clear statements.'});
  if(['unassigned','documents','group-report','no-score','landlord'].includes(scenario.key))continue;
  const landlordEmail=raw().workspace.recommendation?.landlord_email;
  if(!landlordEmail)throw new Error(`Scenario not ready: ${scenario.key}`);
  const owner={role:'landlord',email:landlordEmail,property_ids:state.staff.find(s=>s.email===landlordEmail).property_ids};
  await flow.execute(owner,scenario.id,{action:scenario.key==='declined'?'landlord_decline':'landlord_accept',version:raw().workspace_version,revision:raw().workspace.recommendation.revision,reason:scenario.key==='declined'?'Mock landlord decision: not proceeding with this application.':''});
  if(['declined','draft','missing-default'].includes(scenario.key))continue;
  const count=scenario.key==='partial-signatures'?1:scenario.memberIds.length;
  for(const memberId of scenario.memberIds.slice(0,count))await flow.execute(admin,scenario.id,{action:'tenant_signed',version:raw().workspace_version,member_id:memberId,reason:`MOCK tenant signing receipt ${memberId}`});
  if(['partial-signatures','landlord-signature'].includes(scenario.key))continue;
  await flow.execute(admin,scenario.id,{action:'record_landlord_signature',version:raw().workspace_version,reason:`MOCK landlord signing receipt ${scenario.id}`});
  if(scenario.key==='completed'){
   const path=`${scenario.id}/executed/mock-signed-lease.pdf`;
   const bytes=[...readFileSync(new URL('./demo-assets/executed-lease-mock.pdf',import.meta.url))];state.files[path]=bytes;
   await flow.execute(admin,scenario.id,{action:'archive_lease',version:raw().workspace_version,file:{path,name:'MOCK executed lease archive.pdf',size:bytes.length,uploaded_at:new Date().toISOString()}});
  }
 }
 state.demo_journey={version:1,created_at:new Date().toISOString(),scenarios:created};
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function journeyPage(state){
 const cards=(state.demo_journey?.scenarios || []).map(s=>{const a=state.applications.find(a=>a.id===s.id),l=state.listings.find(l=>l.id===s.listingId);return `<article><h2>${esc(s.title)}</h2><p>${esc(s.note)}</p><p><b>${esc(l?.property_name)} · Unit ${esc(l?.unit)}</b><br>${esc(s.memberIds.map(id=>state.applications.find(a=>a.id===id)?.name).join(' & '))}</p><p>Current status: ${esc(a?.status)}</p><a href="/admin/#/applications/${esc(s.id)}">查看申请 / Open Case</a></article>`;}).join('');
 return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Rental Journey · Mock Scenarios</title><style>body{font:16px/1.6 system-ui;background:#f6f7f9;color:#183c50;max-width:1180px;margin:auto;padding:28px}nav{display:flex;gap:24px}a{color:#205570}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}article{padding:22px;border:1px solid #dce5eb;background:white;border-radius:12px}h2{font-size:18px}p{color:#607382}</style><nav><a href="/__demo">Demo Roles</a><a href="/admin/#/applications">Rentals</a><a href="/__demo/inbox">Local Inbox</a></nav><h1>租赁全流程 · Mock 场景目录</h1><p>这些是独立的合成案例，覆盖当前已实现的主要流程与阻塞分支。未接入的支付、信用服务商故障和电子签约回调不属于已实现功能。未提交的申请草稿不伪装成已提交 case。所有付款、信用报告与签署回执均为 mock，没有发送真实邮件。</p><p>已有 Applicant A–E 的申请保持原样；下面新增案例可以直接操作。操作后的状态会保存，重启不会重置。请先通过 Demo Roles 选择 Admin 查看全部场景。</p><div class="grid">${cards}</div></html>`;
}
