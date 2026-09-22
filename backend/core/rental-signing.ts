import type { RentalSigningStore, RentalSigningFiles, RentalSigningProvider, RentalSigningRecord } from '../contracts/rental-signing.ts';
const nextPoll=()=>new Date(Date.now()+31*60*1000).toISOString();
export function makeRentalSigning(store:RentalSigningStore,provider:RentalSigningProvider,files:RentalSigningFiles) {
  async function process(record:RentalSigningRecord,token:string) {
    const id=record.package.id;
    async function save(){const v=record.version;record.updatedAt=new Date().toISOString();await store.save(record,v,token);record.version=v+1;}
    // Fencing before each vendor mutation reduces stale work after staff commands.
    async function current(){const fresh=await store.get(id);if(!fresh || fresh.version!==record.version)throw new Error('Signing changed while processing.');}
    try {
      if(['completed','voided','declined'].includes(record.phase))return null;
      let fetched=false;
      if(record.envelope) {
        // Connect is authenticated push, not polling. Apply only complete
        // snapshots for this immutable envelope and its exact recipient IDs.
        const notices=(await store.notices(record.envelope)).sort((a,b)=>Date.parse(a.generatedAt)-Date.parse(b.generatedAt));
        for(const notice of notices) {
          const latest=notice.envelope,before=record.envelope,at=Date.parse(notice.generatedAt);
          if(!latest || !Number.isFinite(at) || at>Date.now()+300000 || at<=Date.parse(record.lastNoticeAt || '1970-01-01') || latest.accountId!==before.accountId || latest.envelopeId!==before.envelopeId)continue;
          if(latest.recipients.length!==record.package.signers.length || new Set(latest.recipients.map(r=>r.recipientId)).size!==latest.recipients.length || record.package.signers.some(s=>!latest.recipients.some(r=>r.recipientId===s.recipientId)))continue;
          if(before.status==='completed')break;
          if(['sent','delivered'].includes(before.status) && latest.status==='created')continue;
          if(before.status==='delivered' && latest.status==='sent')latest.status=before.status;
          const rank={pending:0,sent:1,delivered:2,delivery_failed:3,declined:4,completed:5};
          for(const r of latest.recipients){const previous=before.recipients.find(p=>p.recipientId===r.recipientId);if(previous && rank[previous.status]>rank[r.status])Object.assign(r,previous);}
          record.envelope=latest;record.lastNoticeAt=notice.generatedAt;fetched=true;
          if(['completed','declined','voided'].includes(latest.status))break;
        }
      }
      if(!fetched && record.envelope?.status!=='completed' && record.nextReadAt && Date.parse(record.nextReadAt)>Date.now())return record.nextReadAt;
      if(!record.envelope) {
        if(record.voidReason && !record.creationAttemptedAt){record.phase='voided';delete record.issue;await save();return null;}
        if(Date.now()-Date.parse(record.package.createdAt)>6*86400000) {
          record.phase='needs_attention';record.issue='The envelope creation recovery window has expired. An administrator must locate the original transaction in DocuSign before any replacement is sent.';await save();return null;
        }
        if(record.creationAttemptedAt){
          record.nextReadAt=new Date(Date.now()+16*60*1000).toISOString();await save();
          record.envelope=await provider.findByTransactionId(id);fetched=!!record.envelope;
        }
        if(!record.envelope) {
          if(record.voidReason){record.phase='needs_attention';record.issue='Cancellation requested before an envelope could be located. Resolve the transaction in DocuSign; no new envelope will be created.';await save();return null;}
          const documents=[];
          for(const d of record.package.documents) {
            const reader=(await files.read(d.file)).getReader(),chunks:Uint8Array[]=[];let n=0;
            try{for(;;){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>10*1024*1024){await reader.cancel();throw new Error('Lease source is too large.');}chunks.push(r.value);}}finally{reader.releaseLock();}
            const data=new Uint8Array(n);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
            const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),x=>x.toString(16).padStart(2,'0')).join('');
            if(hash!==d.file.sha256)throw new Error('The stored lease source does not match the reviewed file.');
            documents.push({documentId:d.documentId,bytes:data});
          }
          record.creationAttemptedAt ||= new Date().toISOString();await save();
          await current();record.envelope=await provider.createDraft({package:record.package,documents});fetched=true;
        }
        record.phase='sending';delete record.issue;await save();
      }
      if(!fetched && record.envelope.status!=='completed'){
        record.nextReadAt=new Date(Date.now()+16*60*1000).toISOString();await save();
        const before=record.envelope,latest=await provider.read(record.envelope.envelopeId);
        if(latest.envelopeId!==before.envelopeId || latest.accountId!==before.accountId)throw new Error('The provider returned a different envelope.');
        if(before.status==='delivered' && ['created','sent'].includes(latest.status))latest.status=before.status;
        for(const recipient of latest.recipients){const previous=before.recipients.find(r=>r.recipientId===recipient.recipientId);if(previous?.status==='completed')Object.assign(recipient,previous);}
        record.envelope=latest;
      }
      if(record.voidReason && !['completed','declined','voided'].includes(record.envelope.status)) {
        await current();await provider.void(record.envelope.envelopeId,record.voidReason);
        record.envelope={...record.envelope,status:'voided',statusChangedAt:new Date().toISOString()};
      } else if(record.envelope.status==='created' && !record.voidReason) {
        await current();await provider.send(record.envelope.envelopeId,record.package);
        const firstOrder=Math.min(...record.package.signers.map(s=>s.routingOrder));
        record.envelope={...record.envelope,status:'sent',statusChangedAt:new Date().toISOString(),recipients:record.envelope.recipients.map(r=>
          r.status==='pending' && record.package.signers.some(s=>s.recipientId===r.recipientId && s.routingOrder===firstOrder)?{...r,status:'sent'}:r)};
      }
      const e=record.envelope;
      if(e.status==='completed') {
        const expected=record.package.signers;
        if(e.recipients.length!==expected.length || expected.some(s=>!e.recipients.some(r=>r.recipientId===s.recipientId && r.status==='completed' && r.signedAt)))throw new Error('DocuSign completion does not match all expected lease signers.');
        record.phase='archiving';delete record.issue;await save();
        const archived=await Promise.allSettled([
          record.signedPdf?null:provider.download(e.envelopeId,'signed_pdf').then(stream=>files.put(id,'signed_pdf',stream)).then(file=>{record.signedPdf=file;}),
          record.certificate?null:provider.download(e.envelopeId,'certificate').then(stream=>files.put(id,'certificate',stream)).then(file=>{record.certificate=file;})
        ]);
        const failed=archived.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
        record.phase='completed';delete record.issue;await save();return null;
      }
      record.phase=e.status==='declined'?'declined':e.status==='voided'?'voided':e.status==='created'?'sending':'in_progress';
      delete record.issue;
      if(record.phase==='in_progress' && e.recipients.some(r=>r.status==='delivery_failed')){
        record.phase='needs_attention';record.issue='DocuSign reported an invitation delivery failure. Check the affected recipient’s email and delivery details.';
      }
      await save();
      return ['declined','voided'].includes(record.phase)?null:nextPoll();
    } catch(error) {
      // Never expose provider payloads, private keys or tokens.
      record.issue=error instanceof Error && !/fetch|network|JSON|crypto/i.test(error.message)?error.message.slice(0,300):'DocuSign processing needs a retry. The existing signing request is retained.';
      if(record.phase!=='archiving')record.phase='needs_attention';
      try{await save();}catch{/* Another claim/version owns the retry. */}
      return record.phase==='archiving'?new Date(Date.now()+15000).toISOString():nextPoll();
    }
  }
  return {async run(){await Promise.allSettled((await store.claimDue(3,new Date().toISOString())).map(async claim=>{
    let retry:string|null=nextPoll();
    try{const record=await store.get(claim.packageId);retry=record?await process(record,claim.claimToken):null;}
    finally{await store.release(claim.packageId,claim.claimToken,retry);}
  }));}};
}
