import type { RentalMail } from '../../contracts/rentals.ts';
import { sendEmail } from '../../../worker/email.js';
import { isLocalRequest } from '../../../worker/env.js';
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function makeRentalMail(env:Record<string,any>,request:Request):RentalMail {
  async function send(to:string,subject:string,text:string,html:string,key:string) {
    const ok=await sendEmail(request,env,{from:'Star Realty <no-reply@starreusa.com>',to:[to],subject,text,html},{idempotencyKey:key});
    return !ok ? 'failed' as const : isLocalRequest(request) && env.DEV_REAL_EMAIL!=='true' ? 'preview' as const : 'sent' as const;
  }
  return {
    async decision(root,members,key) {
      const r=root.workspace!.recommendation!,terms=r.terms;
      const url=new URL('/landlord-decision/',request.url);
      const link=(choice:string)=>`${url}#${new URLSearchParams({id:root.id,revision:String(r.revision),choice})}`;
      const place=[root.listings?.property_name || r.property_title,root.listings?.unit].filter(Boolean).join(' · ');
      const facts=`Monthly rent: $${terms['rent.monthly']} · Deposit: $${terms['deposit.amount']}\nLease: ${terms['lease.commencement_date']} to ${terms['lease.end_date']}`;
      const lines=members.map(m=>`${m.name}: credit score ${m.credit_score ?? 'No score returned'} (${m.score_model}; ${m.report_date.slice(0,10)})${m.mock ? ' (mock)' : ''}; annual income ${m.annual_income || 'Not stated'} (${m.income_source}); ${m.employment}`);
      const text=`${root.workspace?.test_run?'INTERNAL TEST — Synthetic screening. Run '+root.id+'\n\n':''}Application ready for your decision\n${place}\n\n${facts}\n\n${lines.join('\n')}\n\nView details: ${link('details')}\nAgree to proceed: ${link('accept')}\nDo not proceed: ${link('decline')}\n\nSign in with your landlord account to confirm. Agreeing approves this application group and the displayed terms for lease preparation; it does not sign the lease.`;
      const button=(label:string,choice:string)=>`<a style="display:inline-block;padding:12px 18px;margin:8px 8px 8px 0;border-radius:8px;background:#205570;color:white;text-decoration:none" href="${esc(link(choice))}">${label}</a>`;
      const html=`<div style="font:16px Arial,sans-serif;color:#193446;max-width:680px;margin:auto;line-height:1.6"><p>STAR REAL ESTATE</p>${root.workspace?.test_run?`<p><b>Internal Test</b> · Run ${esc(root.id.slice(0,8))} · Synthetic screening</p>`:''}<h1 style="font-size:24px">Application ready for your decision</h1><h2>${esc(place)}</h2><p style="white-space:pre-line">${esc(facts)}</p><table style="width:100%;border-collapse:collapse"><thead><tr><th align="left">Applicant</th><th align="left">Credit score</th><th align="left">Annual income</th></tr></thead><tbody>${members.map(m=>`<tr><td style="padding:16px 8px;border-bottom:1px solid #dde5ea">${esc(m.name)}<br><small>${esc(m.employment)}</small></td><td style="padding:16px 8px;border-bottom:1px solid #dde5ea"><b>${esc(m.credit_score ?? 'No score returned')}${m.mock?' (mock)':''}</b><br><small>${esc(m.score_model)}<br>${esc(m.report_date.slice(0,10))}</small></td><td style="padding:16px 8px;border-bottom:1px solid #dde5ea">${esc(m.annual_income || 'Not stated')}<br><small>${esc(m.income_source)}</small></td></tr>`).join('')}</tbody></table><p>${button('View details','details')}</p><p>${button('Agree to proceed','accept')}${button('Do not proceed','decline')}</p><p>Confirm with your landlord account. Your decision covers this whole application group and these terms. Agreeing starts lease preparation; it does not sign the lease.</p></div>`;
      return send(r.landlord_email,`${root.workspace?.test_run?'[Internal Test '+root.id.slice(0,8)+'] ':''}Application ready · ${place}`,text,html,key);
    },
    async invite(root,i) {
      const link=new URL('/apply/',request.url);link.searchParams.set('id',String(root.listing_id));link.searchParams.set('invite',`${root.id}.${i.id}`);
      const text=`Hello ${i.name},\n\nYou are invited to apply together for ${root.listings?.property_name || root.listings?.title || 'this home'} · ${root.listings?.unit || ''}.\n\nComplete your own application using this link, signed in as ${i.email}:\n${link}\n\nSubmitting accepts this invitation to join one lease application group. Your private documents are visible to the leasing team, not other applicants. This invitation expires ${i.expires.slice(0,10)}.`;
      return send(i.email,'Your shared rental application invitation',text,`<div style="font:16px Arial;line-height:1.7"><p style="white-space:pre-line">${esc(text)}</p><a href="${esc(link)}">Complete your application</a></div>`,`roommate/${i.id}`);
    }
  };
}
