import type { RentalSigningProvider, RentalSigningEnvelope, RentalSigningPackage, RentalSigningRecipientStatus } from '../../contracts/rental-signing.ts';

type Config = { environment: 'demo' | 'production'; integrationKey: string; userId: string;
  accountId: string; privateKey: string; hmacSecret: string; webhookUrl: string };
const fail = (message: string, status=503) => Object.assign(new Error(message), {status});
const bytes = (s: string) => new TextEncoder().encode(s);
const base64 = (b: Uint8Array) => {
  let s=''; for(let i=0;i<b.length;i+=8192) s+=String.fromCharCode(...b.subarray(i,i+8192));
  return btoa(s);
};
const b64url = (b: Uint8Array) => base64(b).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const decode = (s: string) => Uint8Array.from(atob(s),c=>c.charCodeAt(0));
// Wrap the PKCS#1 keys exported by DocuSign in a PKCS#8 PrivateKeyInfo.
function der(tag: number, payload: Uint8Array) {
  const n=payload.length, length=n<128 ? [n] : n<256 ? [129,n] : [130,n>>8,n&255];
  return new Uint8Array([tag,...length,...payload]);
}
function privateKey(pem: string) {
  const value=pem.replace(/\\n/g,'\n'), data=decode(value.replace(/-----[^-]+-----/g,'').replace(/\s/g,''));
  if(!value.includes('BEGIN RSA PRIVATE KEY')) return data;
  return der(48,new Uint8Array([2,1,0,48,13,6,9,42,134,72,134,247,13,1,1,1,5,0,...der(4,data)]));
}
async function json(response: Response): Promise<Record<string, any>> {
  const body=await boundedBytes(response.body,2*1024*1024);
  try{return JSON.parse(new TextDecoder().decode(body));}catch{throw fail('DocuSign returned an invalid response.');}
}
export async function boundedBytes(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if(!stream) throw fail('The document is empty.');
  const reader=stream.getReader(), chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;
    if(total>limit){await reader.cancel();throw fail('The document exceeds the supported size.',413);}chunks.push(value);
  }}finally{reader.releaseLock();}
  const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}

const tabKey={signature:'signHereTabs',initial:'initialHereTabs',date_signed:'dateSignedTabs',full_name:'fullNameTabs'};
const tabLabel=(index:number)=>`star-lease-field-${index}-v3`;
export function envelopeDefinition(pkg: RentalSigningPackage, documents: {documentId:string;bytes:Uint8Array}[], webhookUrl: string) {
  return {
    status:'created',transactionId:pkg.id,emailSubject:'Please sign your lease — Star Realty',
    documents:documents.map(d=>({documentId:d.documentId,name:pkg.documents.find(f=>f.documentId===d.documentId)?.name || 'Residential lease and riders',fileExtension:'docx',documentBase64:base64(d.bytes)})),
    recipients:{signers:pkg.signers.map(s=>{
      const tabs:Record<string,unknown[]>={signHereTabs:[],initialHereTabs:[],dateSignedTabs:[],fullNameTabs:[]};
      for(const [index,t] of pkg.tabs.entries()) {
        if(t.recipientId!==s.recipientId)continue;
        const key=tabKey[t.kind];
        // The anchor is the field's own token, so the offsets are the per-kind
        // constants that rest the tab on the line. Stored as CSS pixels
        // (96/in); physical units keep them independent of document DPI.
        tabs[key].push({documentId:t.documentId,tabLabel:tabLabel(index),anchorString:t.anchor,anchorUnits:'inches',
          anchorXOffset:String(t.xOffset/96),anchorYOffset:String(t.yOffset/96),anchorIgnoreIfNotPresent:'false',
          anchorCaseSensitive:'true',anchorMatchWholeWord:'false',...(t.kind==='signature'||t.kind==='initial'?{scaleValue:String(t.scale??.6)}:{fontSize:t.fontSize || 'Size9',font:'TimesNewRoman'})});
      }
      return {recipientId:s.recipientId,name:s.name,email:s.email,routingOrder:String(s.routingOrder),tabs};
    })},
    allowReassign:'false',
    eventNotification:{url:webhookUrl,requireAcknowledgment:'true',includeHMAC:'true',deliveryMode:'SIM',
      eventData:{version:'restv2.1',format:'json',includeData:['recipients']},
      events:['envelope-sent','envelope-delivered','envelope-completed','envelope-declined','envelope-voided','recipient-completed','recipient-declined','recipient-autoresponded']}
  };
}

export function makeDocusign(config: Config, http: typeof fetch=fetch): RentalSigningProvider {
  const authHost=config.environment==='demo'?'account-d.docusign.com':'account.docusign.com';
  // This closure is request-scoped, never shared across Worker requests.
  let session:Promise<{token:string;base:string}> | undefined;
  async function authenticate() {
    const now=Math.floor(Date.now()/1000),key=await crypto.subtle.importKey('pkcs8',privateKey(config.privateKey),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
    const unsigned=[b64url(bytes(JSON.stringify({alg:'RS256',typ:'JWT'}))),b64url(bytes(JSON.stringify({iss:config.integrationKey,sub:config.userId,aud:authHost,iat:now-30,exp:now+3600,scope:'signature impersonation'})))].join('.');
    const assertion=unsigned+'.'+b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,bytes(unsigned))));
    const response=await http(`https://${authHost}/oauth/token`,{method:'POST',signal:AbortSignal.timeout(20000),body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
    const token=await json(response);
    if(!response.ok || typeof token.access_token!=='string') throw fail(token.error==='consent_required'?'DocuSign consent is required for the configured sender.':'DocuSign authentication failed. Check the sender and RSA key.');
    const userResponse=await http(`https://${authHost}/oauth/userinfo`,{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(20000)});
    const user=await json(userResponse),account=Array.isArray(user.accounts)?user.accounts.find((a:{account_id:string})=>a.account_id===config.accountId):null;
    if(!userResponse.ok || !account) throw fail('The configured DocuSign account is unavailable to this sender.');
    const url=new URL(account.base_uri);
    if(url.protocol!=='https:' || !/^(?:[a-z0-9-]+\.)*docusign\.net$/.test(url.hostname) || url.username || url.password) throw fail('Invalid DocuSign account API address.');
    return {token:token.access_token as string,base:`${url.origin}/restapi/v2.1/accounts/${encodeURIComponent(config.accountId)}`};
  }
  async function api(path:string,method='GET',body?:unknown) {
    const auth=await (session ||= authenticate());
    // Creating the draft converts every DOCX and locates its anchor tabs.
    // Keep ordinary API calls bounded to 30s; allow this conversion up to 2m.
    const creating=path==='/envelopes' && method==='POST';
    let r:Response;
    try {
      r=await http(auth.base+path,{method,headers:{Authorization:`Bearer ${auth.token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(creating?120000:30000)});
    } catch(error) {
      if(error instanceof Error && error.name==='TimeoutError')throw fail(creating?'DocuSign document preparation timed out. The existing request is retained for recovery; do not send a replacement.':'DocuSign did not respond in time. The existing request is retained for recovery.');
      throw error;
    }
    if(!r.ok){const detail=await json(r).catch(()=>({errorCode:''}));throw fail(detail.errorCode==='TAB_OUT_OF_BOUNDS' || detail.errorCode==='ANCHOR_TAB_STRING_NOT_FOUND'?'A lease signing position could not be located. Review the signing template.':`DocuSign request failed (${r.status}). The existing signing request is retained.`,r.status===429?429:503);}
    return r;
  }
  const path=(id:string)=>`/envelopes/${encodeURIComponent(id)}`;
  async function read(id:string):Promise<RentalSigningEnvelope> {
    const e=await json(await api(path(id))), r=await json(await api(path(id)+'/recipients'));
    if(!['created','sent','delivered','completed','declined','voided'].includes(e.status) || !Array.isArray(r.signers)) throw fail('Unrecognized DocuSign envelope state.');
    return {accountId:config.accountId,envelopeId:id,status:e.status,statusChangedAt:e.statusChangedDateTime || new Date().toISOString(),
      recipients:r.signers.map((s:Record<string,string>):RentalSigningRecipientStatus=>{
        const status=s.status==='created'?'pending':s.status==='autoresponded'?'delivery_failed':s.status;
        if(!['pending','sent','delivered','completed','declined','delivery_failed'].includes(status))throw fail('Unrecognized DocuSign recipient state.');
        return {recipientId:s.recipientId,status:status as RentalSigningRecipientStatus['status'],signedAt:s.signedDateTime,
          ...(status==='delivery_failed'?{deliveryIssue:String(s.autoRespondedReason || 'The receiving mail server rejected the invitation.').replace(/[\u0000-\u001f]/g,' ').slice(0,300)}:{})};
      })};
  }
  return {
    async createDraft({package:pkg,documents}) {
      const e=await json(await api('/envelopes','POST',envelopeDefinition(pkg,documents,config.webhookUrl)));
      if(typeof e.envelopeId!=='string')throw fail('DocuSign creation response is incomplete. Recover the existing transaction.');
      return {accountId:config.accountId,envelopeId:e.envelopeId,status:'created',recipients:pkg.signers.map(s=>({recipientId:s.recipientId,status:'pending'})),statusChangedAt:new Date().toISOString()};
    },
    async findByTransactionId(id) {
      const found=await json(await api(`/envelopes/status?transaction_ids=${encodeURIComponent(id)}`,'PUT',{envelopeIds:[]}));
      const rows=found.envelopes || [];if(rows.length>1)throw fail('More than one DocuSign envelope matches this request. Contact an administrator.');
      return rows.length?read(rows[0].envelopeId):null;
    },
    async send(id,pkg){
      if(/^star-lease-2026-09-19-anchor-v[5-7]$/.test(pkg.templateVersion))throw fail('This draft uses an outdated signing layout. Cancel this request and prepare a new signing package.');
      const placed:{label:string;field:string;documentId:string;page:number;x:number;y:number;w:number;h:number}[]=[];
      // Anchor scope is account-dependent and commonly envelope-wide, even
      // with documentId. Remove cross-document matches from the DRAFT only,
      // then verify exactly one field in its intended document before sending.
      for(const signer of pkg.signers){
        const expected=pkg.tabs.map((t,i)=>({...t,label:tabLabel(i)})).filter(t=>t.recipientId===signer.recipientId);
        if(!expected.length)continue;
        const endpoint=path(id)+`/recipients/${encodeURIComponent(signer.recipientId)}/tabs`;
        const load=async()=>json(await api(endpoint+'?include_anchor_tab_locations=true'));
        let actual=await load();const remove:Record<string,{tabId:string}[]>={};
        for(const [kind,list] of Object.entries(actual)){
          if(!Array.isArray(list))continue;
          for(const tab of list){
            const target=expected.find(t=>t.label===tab.tabLabel && tabKey[t.kind]===kind);
            if(!target || !tab.tabId)throw fail('The DocuSign draft contains an unexpected signing field. Review it before sending.');
            if(String(tab.documentId)!==target.documentId)(remove[kind] ||= []).push({tabId:tab.tabId});
          }
        }
        if(Object.keys(remove).length){await api(endpoint,'DELETE',remove);actual=await load();}
        // Every field landed exactly once, on its own document and page, and
        // no two of this signer's fields cover the same spot.
        for(const target of expected){
          const matches=(actual[tabKey[target.kind]] || []).filter((t:Record<string,string>)=>t.tabLabel===target.label);
          const m=matches[0],page=Number(m?.pageNumber),x=Number(m?.xPosition),y=Number(m?.yPosition);
          if(matches.length!==1 || String(m.documentId)!==target.documentId || !(page>0) || !Number.isFinite(x) || !Number.isFinite(y))throw fail('The DocuSign draft does not match the reviewed signing fields. No invitation was sent.');
          // DocuSign's signature controls include transparent bottom padding.
          // Test the visible stamp, not that padding, against adjacent name rows.
          const w=Number(m.width)>0?Number(m.width):(target.width??0)*72/96;
          const h=Number(m.height)>0?Number(m.height):(target.height??0)*72/96;
          const inkH=target.inkHeight===undefined?h:target.inkHeight*72/96;
          const lift=(target.inkLift??0)*72/96;
          if(!(w>0 && h>0 && inkH>0 && inkH<=h+1 && lift>=0 && inkH+lift<=h+1))throw fail('The signing field dimensions are invalid. No invitation was sent.');
          placed.push({label:target.label,field:`${target.kind} for recipient ${target.recipientId}`,documentId:target.documentId,page,x,y:y+h-lift-inkH,w,h:inkH});
        }
      }
      for(const a of placed)for(const b of placed){
          if(a===b || a.documentId!==b.documentId || a.page!==b.page)continue;
          // Allow only PDF coordinate rounding, never a real ink intersection.
          const slack=2;
          if(a.x+slack<b.x+b.w && b.x+slack<a.x+a.w && a.y+slack<b.y+b.h && b.y+slack<a.y+a.h)throw fail(`Two signing fields overlap in the converted lease (${a.field} and ${b.field}, document ${a.documentId} page ${a.page}). No invitation was sent.`);
      }
      await api(path(id),'PUT',{status:'sent'});
    },read,
    async verifyNotice(raw,headers) {
      if(!config.hmacSecret)return null;
      const key=await crypto.subtle.importKey('raw',bytes(config.hmacSecret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
      let valid=false;
      for(const [name,value] of Object.entries(headers))if(/^x-docusign-signature-\d+$/i.test(name)) {
        try{if(await crypto.subtle.verify('HMAC',key,decode(value),new Uint8Array(raw)))valid=true;}catch{}
      }
      if(!valid)return null;
      try{const b=JSON.parse(new TextDecoder().decode(raw));
        if(String(b.data?.accountId)!==config.accountId || !/^[\da-f-]{36}$/i.test(b.data?.envelopeId || '') || typeof b.event!=='string')return null;
        return {accountId:config.accountId,envelopeId:b.data.envelopeId,event:b.event,generatedAt:b.generatedDateTime || ''};
      }catch{return null;}
    },
    async download(id,kind){const r=await api(path(id)+`/documents/${kind==='certificate'?'certificate':'combined'}`);if(!r.body)throw fail('DocuSign document is empty.');return r.body;},
    async void(id,reason){await api(path(id),'PUT',{status:'voided',voidedReason:reason.slice(0,200)});}
  };
}
