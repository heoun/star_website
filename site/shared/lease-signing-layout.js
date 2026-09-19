// Where each signer's fields go, and how big they are.
//
// Every field is placed by an anchor token: a tiny white string written into
// the exact paragraph or table cell where the signature belongs (see
// worker/signing-anchors.js). DocuSign finds the token in its own converted
// PDF and puts the tab on top of it, so the position comes from Word's layout
// of the signed document itself, never from coordinates measured elsewhere.
// A longer name, an extra tenant or a rider pushed onto the next page moves
// the token and the tab together.
//
// What remains here is structure: which table, row and cell a slot occupies,
// or which paragraph carries the line. Geometry is the small TAB_GEOMETRY
// table below, shared by every document and signer.
export const SIGNING_TEMPLATE_VERSION='star-lease-2026-09-19-anchor-v11';
export const SIGNING_LAYOUT_REVIEW_REQUIRED=false;

// PDF points. The tab control includes transparent padding; `ink` describes
// the visible signature stamp. Use the latter for preview/collision checks.
// Anchor resolution uses fixed 33pt / 38.4pt reference heights even when
// scaleValue changes the rendered stamp. Compensate that difference before
// applying the desired distance from the line. Verified against Sandbox tabs.
// Signature lines retain their original font metrics when anchors are added.
export const TAB_GEOMETRY={
 signature:{scale:.75,width:112.5,height:41.25,anchorHeight:33,below:12.5,ink:{height:24.25,lift:11.25}},
 initial:{scale:.8,width:48,height:51.2,anchorHeight:38.4,below:20.5,ink:{height:15.33,lift:20}},
 full_name:{fontSize:'Size11',width:106,height:13,below:-1.5,ink:{height:13,lift:0}},
 date_signed:{fontSize:'Size11',width:50,height:13,below:-2,ink:{height:13,lift:0}}
};
const PX=96/72;

// The eight-slot signature tables every rider shares: row 0 says "Tenant:",
// rows 1–4 alternate Signature / Print Name with four slots each, and the
// landlord table has Signature and Print Name rows with one cell. `tables`
// are indices within the standalone document.
const standardCell=(role,slot,kind)=>role==='landlord'
 ?{table:'landlord',row:kind==='full_name'?1:0,cell:1}
 :{table:'tenant',row:1+(slot>=4?2:0)+(kind==='full_name'?1:0),cell:1+slot%4};

export const SIGNING_DOCUMENTS=[
 {id:'lease',document:'lease',name:'New York Residential Lease Agreement',tables:{tenant:2,landlord:3},place:standardCell,
  initials:[{section:'38',paragraph:{starts:'Tenant(s)’ initials',nth:0}},{section:'39',paragraph:{starts:'Tenant(s)’ initials',nth:1}}]},
 {id:'utilities',document:'utilities',name:'Utilities – Simple Form',tables:{tenant:1,landlord:2},place:standardCell},
 {id:'packages',document:'packages',name:'Packages Rider',tables:{tenant:0,landlord:1},place:standardCell},
 {id:'keys',document:'keys',name:'Key Rider',tables:{tenant:1,landlord:2},place:standardCell},
 {id:'insurance',document:'insurance',name:'New York Renters Insurance Rider',tables:{tenant:0,landlord:1},place:standardCell},
 {id:'rules',document:'rules',name:'Community Rules Rider',tables:{tenant:0,landlord:1},place:standardCell},
 {id:'fines',document:'rules',name:'Fine Schedule',tables:{tenant:1,landlord:2},place:standardCell},
 // DocuSign resolves Date Signed 4pt to the right of Sign Here at the same
 // anchor x. Compensate so their visible left edges align on these two lines.
 {id:'window_guards',document:'window_guards',name:'Window Guards Required Lease Notice to Tenant',individual:true,tenantOnly:true,
  kinds:['signature','date_signed'],place:(role,slot,kind)=>kind==='signature'?{paragraph:{is:'Tenant’s Signature:'},nextLine:true,xInset:100}:{paragraph:{is:'Date:'},nextLine:true,xInset:96}},
 {id:'bedbug',document:'bedbug',name:'Bedbug Infestation History Disclosure',individual:true,kinds:['signature','date_signed'],
  place:(role,slot,kind)=>({paragraph:{contains:role==='tenant'?'Signature of Tenant(s):':'Signature of Owner/Agent:'},beforeUnderlined:kind==='signature'?0:1,xInset:kind==='signature'?6:4})},
 {id:'sprinkler',document:'sprinkler',name:'Sprinkler System Notice',tables:{tenant:1,landlord:2},place:standardCell},
 {id:'allergen',document:'allergen',name:'Indoor Allergen Hazards Notice',landlordOnly:true,kinds:['signature','full_name','date_signed'],
  tables:{landlord:0},place:(role,slot,kind)=>({table:'landlord',row:{signature:0,full_name:1,date_signed:2}[kind],cell:1})},
 {id:'alarms',document:'alarms',name:'Gas Leak, Carbon Monoxide and Smoke Alarm Rider',tables:{tenant:1,landlord:2},place:standardCell},
 {id:'smoking',document:'smoking',name:'Smoking Policy Rider',tables:{tenant:2,landlord:3},place:standardCell},
 {id:'concession',document:'concession',name:'Rent Concession Rider',conditional:true,tables:{tenant:0,landlord:1},place:standardCell},
 {id:'dhcr',document:'dhcr',name:'DHCR Electronic Lease Consent',individual:true,kinds:['signature','date_signed'],tables:{tenant:3,landlord:1},
  place:(role,slot,kind)=>({table:role,row:0,cell:kind==='signature'?1:0,lineWidth:kind==='signature'?311.6:235.4,align:'center'})},
 {id:'good_cause',document:'good_cause',name:'Good Cause Eviction Notice',tables:{tenant:0,landlord:1},place:standardCell}
];
export const signingFieldLabel=kind=>({signature:'Signature',initial:'Initials',full_name:'Print Name',date_signed:'Date Signed'})[kind];
export function hasConcession(values={}){
 const text=String(values['concession.terms'] || '').trim();
 return !!text && !/^(?:none|n\/a|not applicable|no(?: rent)? concession(?:s)?(?:\b.*)?|mock test only.*)[.!]?$/i.test(text);
}
const CODES={lease:'LEASE',utilities:'UTIL',packages:'PKG',keys:'KEYS',insurance:'INS',rules:'RULES',fines:'FINES',window_guards:'WG',bedbug:'BEDBUG',sprinkler:'SPRK',allergen:'ALRG',alarms:'ALARM',smoking:'SMOKE',concession:'CONC',dhcr:'DHCR',good_cause:'GCE'};
const KIND_CODES={signature:'SIG',full_name:'NAME',date_signed:'DATE',initial:'INIT'};
// Unique across the envelope: one recipient signs each layout once, so the
// pair identifies the field even where a layout appears in several copies.
export const anchorToken=(layoutId,recipientId,kind,section='')=>`\\${CODES[layoutId]}-R${recipientId}-${KIND_CODES[kind]}${section}\\`;

function field(layout,signer,slot,kind,placement,section='') {
 // Every signature line in the shared tables has room for the full-size
 // stamp above it (lease/tools/space-signature-tables.py), so one geometry
 // serves every slot, tenant or landlord, first row or second.
 let g=TAB_GEOMETRY[kind];
 if(kind==='signature' && layout.id==='bedbug')g={...g,below:g.below-1};
 const x=placement.align==='center'?(placement.lineWidth-g.width)/2:(placement.xInset || 0);
 return {id:`${layout.id}-${section?section+'-':''}${signer.recipientId}-${kind}`,recipientId:signer.recipientId,documentId:'1',document:layout.document,layout:layout.id,
  ...(section?{section}:{}),kind,slot,role:signer.role,name:signer.name,email:signer.email,
  anchor:anchorToken(layout.id,signer.recipientId,kind,section),placement:{...placement,table:placement.table?layout.tables[placement.table]:undefined},
  units:'pixels',xOffset:+(x*PX).toFixed(2),yOffset:+((g.below-g.height+(g.anchorHeight??g.height))*PX).toFixed(2),anchorHeight:+((g.anchorHeight??g.height)*PX).toFixed(2),width:+(g.width*PX).toFixed(2),height:+(g.height*PX).toFixed(2),inkHeight:+(g.ink.height*PX).toFixed(2),inkLift:+(g.ink.lift*PX).toFixed(2),...(g.scale?{scale:g.scale}:{fontSize:g.fontSize})};
}

export function mainAgreementFields(signers){
 const tenants=signers.filter(s=>s.role==='tenant'),landlords=signers.filter(s=>s.role==='landlord');
 if(!tenants.length || tenants.length>8 || landlords.length!==1)throw new Error('The original agreement has space for one to eight tenants and one landlord.');
 const layout=SIGNING_DOCUMENTS[0],fields=[];
 tenants.forEach((s,i)=>{
  for(const initials of layout.initials)fields.push(field(layout,s,i,'initial',{paragraph:initials.paragraph,beforeUnderlined:i},initials.section));
  for(const kind of ['signature','full_name'])fields.push(field(layout,s,i,kind,layout.place('tenant',i,kind)));
 });
 for(const kind of ['signature','full_name'])fields.push(field(layout,landlords[0],0,kind,layout.place('landlord',0,kind)));
 return fields;
}

export function signingFields(signers,layoutId,values={}){
 const main=mainAgreementFields(signers);
 if(layoutId==='lease')return main;
 const layouts=SIGNING_DOCUMENTS.filter(d=>d.id!=='lease' && (!layoutId || d.id===layoutId));
 if(layoutId && !layouts.length)throw new Error('Signing positions have not been configured for this document.');
 const fields=layoutId?[]:main;
 for(const layout of layouts){
  if(layout.conditional && !hasConcession(values))continue;
  let tenantSlot=0;
  for(const signer of signers){
   const tenant=signer.role==='tenant';
   if((tenant && layout.landlordOnly) || (!tenant && layout.tenantOnly))continue;
   const slot=tenant?tenantSlot++:0;
   if(slot>=8)throw new Error('The original riders have space for eight tenants.');
   for(const kind of layout.kinds || ['signature','full_name'])fields.push(field(layout,signer,slot,kind,layout.place(signer.role,slot,kind)));
  }
 }
 return fields;
}
