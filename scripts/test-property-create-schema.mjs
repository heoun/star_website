import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 await db.exec(readFileSync('supabase/schema.sql','utf8'));
 const sql=readFileSync('supabase/property-create.sql','utf8');await db.exec(sql);await db.exec(sql);
 const [{id:oldId}]=(await db.query("insert into buildings(name) values('Existing') returning id")).rows;
 await db.query("select lease_settings_apply('building',$1,null,$2,'admin@example.test')",[oldId,{'manager.name':'Existing Manager'}]);
 const create=(token,property,defaults,actor='admin@example.test')=>db.query('select create_property_with_defaults($1,$2,$3,$4) as building',[token,property,defaults,actor]);
 const token=crypto.randomUUID(),property={name:'New property',street:'10 Example Road',city:'New York',state_abbr:'NY',zip:'10001'},defaults={'manager.name':'New Manager','insurance.required_yes':true,'insurance.required_no':false};
 const row=(await create(token,property,defaults)).rows[0].building;
 eq(row.name,'New property');assert.notEqual(row.id,oldId);checks++;
 eq((await db.query('select field_values from lease_settings where building_id=$1',[row.id])).rows[0].field_values,defaults);
 eq((await db.query('select field_values from lease_settings where building_id=$1',[oldId])).rows[0].field_values,{'manager.name':'Existing Manager'});
 eq((await create(token,property,defaults)).rows[0].building.id,row.id);
 eq((await db.query('select count(*)::int as n from buildings')).rows[0].n,2);
 // Replay cannot reset subsequent edits to the newly created property's defaults.
 await db.query("select lease_settings_apply('building',$1,null,$2,'admin@example.test')",[row.id,{'manager.name':'Edited later'}]);
 await create(token,property,defaults);
 eq((await db.query('select field_values from lease_settings where building_id=$1',[row.id])).rows[0].field_values['manager.name'],'Edited later');
 await assert.rejects(()=>create(token,{...property,name:'Changed retry'},defaults));checks++;
 await assert.rejects(()=>create(token,property,defaults,'other-admin@example.test'));checks++;
 await db.exec("create function reject_test_settings() returns trigger language plpgsql as $$ begin if new.field_values->>'manager.name'='Fail this transaction' then raise exception 'Synthetic write failure'; end if; return new; end; $$; create trigger reject_test_settings before insert on lease_settings for each row execute function reject_test_settings();");
 const failure=crypto.randomUUID();await assert.rejects(()=>create(failure,{name:'Must roll back'},{'manager.name':'Fail this transaction'}));checks++;
 eq((await db.query("select count(*)::int as n from buildings where name='Must roll back'")).rows[0].n,0);
 eq((await db.query('select count(*)::int as n from property_creation_requests where token=$1',[failure])).rows[0].n,0);
 await create(failure,{name:'Retry after failure'},{'manager.name':'Recovered'});checks++;
 await create(crypto.randomUUID(),{name:'Manual property'},{});checks++;
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);await assert.rejects(()=>create(crypto.randomUUID(),property,defaults));checks++;
  await assert.rejects(()=>db.query('select * from property_creation_requests'));checks++;await db.exec('reset role');
 }
 await db.exec('set role service_role');await create(crypto.randomUUID(),{name:'Service creation'},{});checks++;
 console.log(`PASS ${checks} property creation database checks: atomic settings, rollback, safe retries, existing property isolation and service-only access`);
}finally{await db.close();}
