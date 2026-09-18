// Individually reviewed document layouts. Preserve the source DOCX; tabs use existing unique text.
// Geometry (points) is measured against the retained template's original lines.
export const SIGNING_TEMPLATE_VERSION='star-lease-2026-09-18-all-v4';
export const SIGNING_LAYOUT_REVIEW_REQUIRED=true;
export const MAIN_SIGNING_ANCHORS={
 jury:'JURY TRIAL WAIVER.',class:'CLASS ACTION WAIVER.',
 execution:'This Lease is entered into between Landlord and Tenant as of the Effective Date set forth above.'
};
export function mainAgreementFields(signers){
 const tenants=signers.filter(s=>s.role==='tenant'),landlords=signers.filter(s=>s.role==='landlord');
 if(!tenants.length || tenants.length>8 || landlords.length!==1)throw new Error('The original agreement has space for one to eight tenants and one landlord.');
 const fields=[];
 const add=(s,section,kind,slot,x,y,anchorX,anchorY,width)=>fields.push({
   id:`main-${section}-${s.recipientId}-${kind}`,recipientId:s.recipientId,documentId:'1',document:'lease',layout:'lease',section,kind,slot,
   anchor:MAIN_SIGNING_ANCHORS[section==='38'?'jury':section==='39'?'class':'execution'],
   xOffset:+((x-anchorX)*4/3).toFixed(2),yOffset:+((y-anchorY)*4/3-(kind==='full_name'?12:18)).toFixed(2),
   units:'pixels',scale:.5,width:+(width*4/3).toFixed(2),height:kind==='full_name'?12:18,
   role:s.role,name:s.name,email:s.email
 });
 tenants.forEach((s,i)=>{
   const x=[179.1,228.6,278.1,327.6,377.1,426.6,476.1,526.3][i];
   add(s,'38','initial',i,x,449.7,68.5,376.526,35.7);
   add(s,'39','initial',i,x,551.4,68.5,465.576,35.7);
   const sx=[119.7,235.5,347.2,462.4][i%4],second=i>=4;
   add(s,'47','signature',i,sx,second?176.9:135.2,86.5,83.676,92.45);
   add(s,'47','full_name',i,sx,second?190:148.7,86.5,83.676,92.45);
 });
 add(landlords[0],'47','signature',0,114.3,233.8,86.5,83.676,226.55);
 add(landlords[0],'47','full_name',0,114.3,247.2,86.5,83.676,226.55);
 return fields;
}

// Each rider is measured separately against its own retained signature lines.
// Fine Schedule is a separately selectable attachment inside the rules document.
export const SIGNING_DOCUMENTS=[
 {id:'lease',document:'lease',name:'New York Residential Lease Agreement',tenantTable:2,landlordTable:3},
 {id:'utilities',document:'utilities',name:'Utilities – Simple Form',tenantTable:5,landlordTable:6,anchor:'This Form is entered into between',origin:[86.5,223.226],lines:[274.7,288.2,316.4,329.5,373.4,386.8]},
 {id:'packages',document:'packages',name:'Packages Rider',tenantTable:7,landlordTable:8,tenantParagraphOffset:3,anchor:'this Addendum have',origin:[446.759,325.226],lines:[415.1,428.6,456.8,469.9,513.8,527.2]},
 {id:'keys',document:'keys',name:'Key Rider',tenantTable:10,landlordTable:11,anchor:'Tenant shall immediately report',origin:[137.5835,426.268],columns:[119.7,236.3,347.9,462.8],tenantWidth:92.25,landlordWidth:226.45,lines:[548.6,561.7,585.8,597.9,635.5,648.2]},
 {id:'insurance',document:'insurance',name:'New York Renters Insurance Rider',tenantTable:12,landlordTable:13,anchor:'The cost of LPTLI coverage',origin:[86.5,121.626],lines:[249.5,263,291.2,304.3,348.1,361.5]},
 {id:'rules',document:'rules',name:'Community Rules Rider',tenantTable:14,landlordTable:15,anchor:'A violation of the above rules',origin:[79.9,159.576],lines:[236.8,250.3,278.5,291.6,335.5,348.9]},
 {id:'fines',document:'rules',name:'Fine Schedule',tenantTable:17,landlordTable:18,anchor:'I hereby acknowledge the fine schedule',origin:[50.45,313.526],columns:[119.7,235.5,347.2,462.5],lines:[432.3,445.8,474,487.1,530.9,544.2]},
 {id:'window_guards',document:'window_guards',name:'Window Guards Required Lease Notice to Tenant',individual:true,special:true},
 {id:'bedbug',document:'bedbug',name:'Bedbug Infestation History Disclosure',individual:true,special:true},
 {id:'sprinkler',document:'sprinkler',name:'Sprinkler System Notice',tenantTable:21,landlordTable:22,tenantParagraphOffset:-1,anchor:'Sprinkler System Notice provided',origin:[50.5,235.84],columns:[119.7,233.6,346.1,461.4],tenantWidth:92.7,landlordWidth:226.75,lines:[277.3,308.3,338.7,354.8,404.1,418.6]},
 {id:'allergen',document:'allergen',name:'Indoor Allergen Hazards Notice',special:true},
 {id:'alarms',document:'alarms',name:'Gas Leak, Carbon Monoxide and Smoke Alarm Rider',tenantTable:25,landlordTable:26,anchor:'This Rider is entered into between',origin:[86.5,45.726],lines:[97.7,111.2,139.4,152.5,196.3,209.7]},
 {id:'smoking',document:'smoking',name:'Smoking Policy Rider',tenantTable:29,landlordTable:30,anchor:'This Rider is entered into between',origin:[86.5,45.726],lines:[97.2,110.7,138.9,152,195.9,209.3]},
 {id:'concession',document:'concession',name:'Rent Concession Rider',conditional:true,tenantTable:31,landlordTable:32,anchor:'Tenant:',origin:[55.9,132.08],lines:[157.8,171.3,199.5,212.6,256.4,269.7]},
 {id:'dhcr',document:'dhcr',name:'DHCR Electronic Lease Consent',individual:true,special:true},
 {id:'good_cause',document:'good_cause',name:'Good Cause Eviction Notice',tenantTable:37,landlordTable:38,anchor:'Tenant:',origin:[55.9,451.48],lines:[477.2,490.7,518.9,532,575.9,589.3]}

];
export const LOCAL_TABLE_BASE={lease:0,utilities:4,packages:7,keys:9,insurance:12,rules:14,fines:16,window_guards:19,bedbug:19,sprinkler:20,allergen:23,alarms:24,smoking:27,concession:31,dhcr:33,good_cause:37};
export const signingFieldLabel=kind=>({signature:'Signature',initial:'Initials',full_name:'Print Name',date_signed:'Date Signed'})[kind];
export function hasConcession(values={}){
 const text=String(values['concession.terms'] || '').trim();
 return !!text && !/^(?:none|n\/a|not applicable|no(?: rent)? concession(?:s)?(?:\b.*)?|mock test only.*)[.!]?$/i.test(text);
}
export function signingFields(signers,layoutId,values={}){
 const main=mainAgreementFields(signers);
 if(layoutId==='lease')return main;
 const layouts=SIGNING_DOCUMENTS.filter(d=>d.id!=='lease' && (!layoutId || d.id===layoutId));
 if(layoutId && !layouts.length)throw new Error('Signing positions have not been configured for this document.');
 const fields=layoutId?[]:main;
 for(const layout of layouts){
  if(layout.conditional && !hasConcession(values))continue;
  if(layout.special){fields.push(...noticeFields(signers,layout));continue;}
  let tenantSlot=0;
  for(const signer of signers){
   const tenant=signer.role==='tenant',slot=tenant?tenantSlot++:0;
   for(const kind of ['signature','full_name']){
    const line=tenant?(slot>=4?2:0)+(kind==='full_name'?1:0):4+(kind==='full_name'?1:0);
    const x=tenant?(layout.columns || [119.7,235.5,347.2,462.4])[slot%4]:114.3;
    const height=kind==='full_name'?12:18;
    fields.push({id:`${layout.id}-${signer.recipientId}-${kind}`,recipientId:signer.recipientId,documentId:'1',document:layout.document,layout:layout.id,kind,slot,
     anchor:layout.anchor,xOffset:+((x-layout.origin[0])*4/3).toFixed(2),yOffset:+((layout.lines[line]-layout.origin[1])*4/3-height).toFixed(2),
     units:'pixels',scale:.5,width:+((tenant?(layout.tenantWidth || 92.45):(layout.landlordWidth || 226.55))*4/3).toFixed(2),height,
     role:signer.role,name:signer.name,email:signer.email});
   }
  }
 }
 return fields;
}

function noticeFields(signers,layout){
 const result=[];
 function add(s,kind,anchor,origin,x,lineY,width,target){
  const height=kind==='signature'?18:12;
  result.push({id:`${layout.id}-${s.recipientId}-${kind}`,recipientId:s.recipientId,documentId:'1',document:layout.document,layout:layout.id,kind,slot:0,anchor,units:'pixels',scale:.5,
   xOffset:+((x-origin[0])*4/3).toFixed(2),yOffset:+((lineY-origin[1])*4/3-height).toFixed(2),width:width*4/3,height,role:s.role,name:s.name,email:s.email,target});
 }
 for(const s of signers){
  const tenant=s.role==='tenant';
  if(layout.id==='window_guards' && tenant){
   add(s,'signature','Tenant’s Signature:',[36.1,536.05],36,561.5,334.95,{paragraph:'Tenant’s Signature:',next:true});
   add(s,'date_signed','Tenant’s Signature:',[36.1,536.05],36,593.3,334.95,{paragraph:'Date:',next:true});
  }
  if(layout.id==='bedbug'){
   const anchor=tenant?'Signature of Tenant(s):':'Signature of Owner/Agent:',origin=tenant?[42.7,617.19]:[42.7,674.89];
   add(s,'signature',anchor,origin,tenant?153.85:173.2,tenant?628:685.7,tenant?238.1:219.1,{table:0,p:tenant?31:35,tab:0});
   add(s,'date_signed',anchor,origin,tenant?429.9:430.3,tenant?628:685.7,102.1,{table:0,p:tenant?31:35,tab:1});
  }
  if(layout.id==='allergen' && !tenant){
   for(const [i,kind] of ['signature','full_name','date_signed'].entries())add(s,kind,'Signed:',[50.5,330.03],114.3,[341.9,355.3,368.7][i],153.35,{table:0,p:1+i*2});
  }
  if(layout.id==='dhcr'){
   const anchor=tenant?'Tenant Signature(s) (Ink or Electronic)':'Owner/Owner Representative Signature(s)',origin=tenant?[351.45,719.36]:[343.95,356.41],y=tenant?717.9:355;
   add(s,'signature',anchor,origin,279.4,y,311.55,{table:tenant?3:1,p:1});
   add(s,'date_signed',anchor,origin,36,y,235.35,{table:tenant?3:1,p:0});
  }
 }
 return result;
}
