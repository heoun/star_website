import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderWorkspaceShell} from '../worker/workspace-shell.js';
const template=readFileSync('site/admin/index.html','utf8');
for(const [identity,routes] of [[{role:'agent',property_collaboration_ids:['test-property']},['applications','listings','properties']],[{role:'agent'},['applications','listings']],[{role:'manager'},['applications','onboarding','properties','listings','staff','requests']],[{role:'landlord'},['overview','properties','leases']],[{role:'manager',owner:true},['staff']]]){
 const html=renderWorkspaceShell(template,{...identity,email:'user@example.test',name:'<script>unsafe</script>',setCookie:'secret-cookie',access_token:'secret-token'});
 const nav=html.match(/<nav[^>]*id="sidebar-navigation"[^>]*>[\s\S]*?<\/nav>/)[0];
 assert.deepEqual([...nav.matchAll(/data-route="([^"]+)"/g)].map(m=>m[1]),routes);
 assert(!nav.includes(' hidden'));assert(!html.includes('secret-token'));assert(!html.includes('secret-cookie'));assert(!html.includes('<script>unsafe</script>'));
 const data=JSON.parse(html.match(/id="workspace-session" type="application\/json">([\s\S]*?)<\/script>/)[1]);assert.equal(data.role,identity.role);assert.equal(data.name,'<script>unsafe</script>');
 assert(html.includes('data-role="'+identity.role+'"'));
}
console.log('PASS server workspace shell: four roles, permitted navigation only, escaped identity and no credential exposure');
