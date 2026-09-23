import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {applicantColumns} from '../site/admin/rental-applicant.js';
import {documentSummary} from '../site/admin/application-view.js';
import {STAFF_DOCUMENT_TYPES} from '../worker/portal.js';
import {rentalMembers} from '../backend/core/rentals.ts';
globalThis.location=new URL('https://dev.example.test/admin/');
const m={id:'fixture',name:'Example Applicant',status:'review',employment_status:'student',employment_history:[{employer:'Example Bakery',position:'Decorator',start:'09/2025',end:'09/2026'}],emergency_contacts:[{name:'First Contact',phone:'2125550100',email:'first@example.test'},{name:'Second Contact',phone:'2125550101',email:'a-long-emergency-contact-address@example.test'}],application_documents:[{id:'external-report',doc_type:'external_source',file_name:'credit.pdf'}],workspace:{external_credit_report:{credit_score:783,provider:'Experian',model:'Vantage Score',document_id:'external-report',status:'pending_review'}}};
const ctx={row:{...m,household:{members:[m],invitations:[]}},session:{role:'manager'},types:STAFF_DOCUMENT_TYPES,documentSummary};
const summary=rentalMembers({root:m,members:[m]})[0];
assert.equal(summary.credit_score,null);assert.notEqual(summary.report_status,'Complete');
const render=(person=m,s=summary)=>applicantColumns(person,ctx,s,v=>v??'Not stated');
const out=render();
assert(out.overview.includes('783')&&out.overview.includes('pending review'));
assert(out.overview.includes('/api/admin/documents/external-report'));
assert(out.screening.includes('Example Bakery')&&out.screening.includes('09/2026'));
assert.equal((out.screening.match(/class="rg-contact-card"/g)||[]).length,2);
assert(!render({...m,application_documents:[]}).overview.includes('783'));
assert(!render(m,{...summary,credit_score:720}).overview.includes('783'));
assert(!render({...m,workspace:{external_credit_report:{...m.workspace.external_credit_report,credit_score:999}}}).overview.includes('999'));
if(process.argv.includes('--ui')){
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage();await page.setContent(`<style>body{font-family:Arial;margin:16px}*{box-sizing:border-box}${readFileSync('site/admin/case-workspace.css','utf8')}</style><main>${out.overview}${out.screening}</main>`);
 await page.locator('[data-record-section="employment"]>summary').click();await page.locator('[data-record-section="contacts"]>summary').click();
 for(const width of [900,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.locator('.rg-contact-card').count(),2);assert(await page.getByText('Example Bakery',{exact:true}).isVisible());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`/tmp/star-applicant-display-${width}.png`,fullPage:true});}
 }finally{await browser.close();}
}
console.log('PASS applicant display: external evidence does not pass screening, verified score precedence, student work history, separate emergency contacts.');
