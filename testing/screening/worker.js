// Private staging provider: reachable only by a Worker service binding.
// D1 persists synthetic receipts across deployments; no card/SSN data is accepted.
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export default {
  async fetch(request,env) {
    if(env.APP_ENV!=='staging')return json({error:'Unavailable'},503);
    const path=new URL(request.url).pathname;
    if(path==='/health' && request.method==='GET') {
      await env.DB.prepare('SELECT 1 FROM simulations LIMIT 1').all();
      const migrations=await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY name').all();
      return json({ok:true,migrations:migrations.results.map(row=>row.name)});
    }
    const match=/^\/(payments|screenings)\/([0-9a-f-]{36})$/.exec(path);
    if(!match)return json({error:'Not found'},404);
    if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed'},405);
    const [,kind,id]=match,db=env.DB;
    const read=async type=>{const row=await db.prepare('SELECT record FROM simulations WHERE application_id=? AND kind=?').bind(id,type).first();return row?JSON.parse(row.record):null;};
    let body={};
    if(request.method==='POST') {
      const reader=request.body?.getReader();let size=0;const chunks=[];
      if(reader)while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();return json({error:'Too large'},413);}chunks.push(value);}
      try {body=JSON.parse(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()));}catch{return json({error:'Invalid JSON'},400);}
      if(!body || typeof body!=='object' || Array.isArray(body))return json({error:'Invalid input'},422);
    }
    if(kind==='payments' && request.method==='POST') {
      if(body.outcome!==undefined && !['paid','failed'].includes(body.outcome))return json({error:'Invalid outcome'},422);
      const receipt={id:`sim-pay-${crypto.randomUUID()}`,application_id:id,status:body.outcome || 'pending',amount:2000,currency:'USD',simulated:true};
      await db.prepare(`INSERT INTO simulations VALUES (?,'payment',?) ON CONFLICT(application_id,kind) DO UPDATE SET record=json_set(simulations.record,'$.status',json_extract(excluded.record,'$.status')) WHERE json_extract(simulations.record,'$.status')!='paid' AND json_extract(excluded.record,'$.status')!='pending'`).bind(id,JSON.stringify(receipt)).run();
      return json(await read('payment'));
    }
    if(kind==='screenings' && request.method==='POST') {
      if((await read('payment'))?.status!=='paid')return json({error:'Payment required'},409);
      if(body.consent!==true || !['scored','no_score','failed'].includes(body.scenario) || !Array.isArray(body.documents) || !body.documents.length || body.documents.length>40 || body.documents.some(x=>!x || typeof x.id!=='string' || !/^[0-9a-f-]{36}$/i.test(x.id) || typeof x.type!=='string' || !/^[a-z_]{1,50}$/.test(x.type) || Object.keys(x).some(k=>!['id','type'].includes(k))))return json({error:'Consent and document IDs required'},422);
      const order={id:`sim-report-${crypto.randomUUID()}`,application_id:id,status:'pending',scenario:body.scenario,documents:body.documents,ready_at:Date.now()+5000};
      await db.prepare("INSERT INTO simulations VALUES (?,'screening',?) ON CONFLICT DO NOTHING").bind(id,JSON.stringify(order)).run();
      const saved=await read('screening');
      if(saved.scenario!==body.scenario || JSON.stringify(saved.documents)!==JSON.stringify(body.documents))return json({error:'Order inputs changed. Start a new test run.'},409);
      return json(saved,202);
    }
    if(kind==='screenings' && request.method==='GET') {
      const order=await read('screening');if(!order)return json({error:'Not found'},404);
      if(order.status==='pending' && Date.now()>=order.ready_at) {
        order.status=order.scenario==='failed'?'failed':'complete';order.completed_at=new Date().toISOString();
        if(order.scenario==='scored'){order.outcome='scored';order.score=710+parseInt(id.replaceAll('-','').slice(-2),16)%51;}
        else if(order.scenario==='no_score'){order.outcome='no_score';order.reason='Simulated insufficient credit history';}
        else order.reason='Simulated provider processing failure';
        await db.prepare("UPDATE simulations SET record=? WHERE application_id=? AND kind='screening' AND json_extract(record,'$.status')='pending'").bind(JSON.stringify(order),id).run();
      }
      return json(await read('screening'));
    }
    return json({error:'Method not allowed'},405);
  }
};
