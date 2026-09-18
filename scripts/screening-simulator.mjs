// Retained test infrastructure, never imported by the deployed application.
// No bureau requests, real charges, card numbers or identity documents.
import http from 'node:http';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
export function simulatorHandler({token,read,save,now=Date.now,delay=5000}) {
  return async(req,res)=>{
    const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    const actual=Buffer.from(req.headers.authorization || ''),expected=Buffer.from(`Bearer ${token}`);
    if(!token || actual.length!==expected.length || !timingSafeEqual(actual,expected))return reply(401,{error:'Unauthorized'});
    const match=/^\/(payments|screenings)\/([0-9a-f-]{36})$/.exec(new URL(req.url,'http://localhost').pathname);
    if(!match)return reply(404,{error:'Not found'});
    const [,kind,id]=match;
    try {
      let body={},size=0,chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>16384)return reply(413,{error:'Too large'});chunks.push(chunk);}
      if(size)body=JSON.parse(Buffer.concat(chunks).toString());
      const state=read();state.payments ||= {};state.screenings ||= {};
      if(kind==='payments' && req.method==='POST') {
        if(body.outcome!==undefined && !['paid','failed'].includes(body.outcome))return reply(422,{error:'Invalid outcome'});
        const receipt=state.payments[id] ||= {id:`sim-pay-${randomUUID()}`,application_id:id,status:'pending',amount:2000,currency:'USD',simulated:true};
        if(receipt.status!=='paid' && body.outcome)receipt.status=body.outcome;
        save(state);return reply(200,receipt);
      }
      if(kind==='screenings' && req.method==='POST') {
        if(state.payments[id]?.status!=='paid')return reply(409,{error:'Payment required'});
        if(body.consent!==true || !Array.isArray(body.documents) || !body.documents.length || body.documents.length>40 || !['scored','no_score','failed'].includes(body.scenario))return reply(422,{error:'Consent and materials required'});
        const prior=state.screenings[id];
        if(prior && (prior.scenario!==body.scenario || JSON.stringify(prior.documents)!==JSON.stringify(body.documents)))return reply(409,{error:'Order inputs changed. Start a new test run.'});
        const order=state.screenings[id] ||= {id:`sim-report-${randomUUID()}`,application_id:id,status:'pending',scenario:body.scenario,documents:body.documents,ready_at:now()+delay};
        save(state);return reply(202,order);
      }
      if(kind==='screenings' && req.method==='GET') {
        const order=state.screenings[id];if(!order)return reply(404,{error:'Not found'});
        if(order.status==='pending' && now()>=order.ready_at){
          order.status=order.scenario==='failed'?'failed':'complete';order.completed_at=new Date(now()).toISOString();
          if(order.scenario==='scored'){order.outcome='scored';order.score=710+parseInt(id.replaceAll('-','').slice(-2),16)%51;}
          else if(order.scenario==='no_score'){order.outcome='no_score';order.reason='Simulated insufficient credit history';}
          else order.reason='Simulated provider processing failure';
          save(state);
        }
        return reply(200,order);
      }
      return reply(405,{error:'Method not allowed'});
    } catch {return reply(500,{error:'Simulator request failed'});}
  };
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const env=Object.fromEntries(readFileSync('.dev.vars','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));
  if(env.INTERNAL_TESTING!=='on' || !env.SCREENING_SIMULATOR_TOKEN)throw new Error('Enable internal testing and configure the simulator token in .dev.vars.');
  const url=new URL(env.SCREENING_SIMULATOR_URL);if(url.hostname!=='127.0.0.1')throw new Error('Simulator must bind to 127.0.0.1.');
  const file=resolve('.local/screening-simulator/state.json');mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const read=()=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}};
  const save=data=>{writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});renameSync(file+'.tmp',file);};
  http.createServer(simulatorHandler({token:env.SCREENING_SIMULATOR_TOKEN,read,save})).listen(Number(url.port),url.hostname,()=>console.log(`Screening API simulator: ${url.origin} (no real charges or credit checks)`));
}
