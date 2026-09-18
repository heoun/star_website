// Retained operator entry point; no application code imports this launcher.
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const vars=readFileSync('.dev.vars','utf8');
if(!/^INTERNAL_TESTING=on\s*$/m.test(vars))throw new Error('Configure internal testing in .dev.vars first. See docs/backoffice/internal-testing.md.');
const children=[spawn(process.execPath,['scripts/screening-simulator.mjs'],{stdio:'inherit'}),spawn(process.execPath,['scripts/dev.js','--signing-scheduler'],{stdio:'inherit'})];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');process.exitCode=code;}
children.forEach(child=>child.on('exit',code=>stop(code || 0)));
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
