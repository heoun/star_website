// Retained operator entry point; no application code imports this launcher.
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const vars=readFileSync('.dev.vars','utf8');
if(!/^INTERNAL_TESTING=on\s*$/m.test(vars))throw new Error('Configure internal testing in .dev.vars first. See docs/backoffice/internal-testing.md.');
const value=name=>vars.split('\n').find(line=>line.trim().startsWith(name+'='))?.trim().slice(name.length+1).trim().replace(/^["']|["']$/g,'');
if(value('DEV_REAL_EMAIL')!=='true' || !value('RESEND_API_KEY'))throw new Error('The full journey needs DEV_REAL_EMAIL=true and RESEND_API_KEY in .dev.vars to send landlord emails. Configure both before starting.');
const children=[spawn(process.execPath,['scripts/screening-simulator.mjs'],{stdio:'inherit'}),spawn(process.execPath,['scripts/dev.js','--signing-scheduler'],{stdio:'inherit'})];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');process.exitCode=code;}
children.forEach(child=>child.on('exit',code=>stop(code || 0)));
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
