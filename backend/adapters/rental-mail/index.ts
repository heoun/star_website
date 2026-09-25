import type { RentalMail } from '../../contracts/rentals.ts';
import { sendEmail } from '../../../worker/email.js';
import { isLocalRequest } from '../../../worker/env.js';
import { createLandlordDecisionToken } from '../../../worker/landlord-decision-token.js';
import { MAIL_FROM, esc, mailShell, mailButton, mailSubject, mailPlace, invitationMail, readyMail } from '../../../worker/mail-layout.js';
export function makeRentalMail(env:Record<string,any>,request:Request):RentalMail {
  async function send(to:string,subject:string,text:string,html:string,key:string) {
    const ok=await sendEmail(request,env,{from:MAIL_FROM,to:[to],subject,text,html},{idempotencyKey:key});
    return !ok ? 'failed' as const : isLocalRequest(request) && env.DEV_REAL_EMAIL!=='true' ? 'preview' as const : 'sent' as const;
  }
  return {
    async decision(root,members,key) {
      const r=root.workspace!.recommendation!,terms=r.terms,test=root.workspace?.test_run ? root.id : '';
      // Separate intentional notifications in Gmail; retries keep the same subject
      // and payload so the provider's idempotency key continues to deduplicate them.
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
      const notice=Array.from(new Uint8Array(digest)).slice(0,6).map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
      const url=new URL('/landlord-decision/',env.SITE_ORIGIN || request.url);
      const token=await createLandlordDecisionToken(env,url.origin,root.id,r);
      const link=(choice:string)=>`${url}#${new URLSearchParams({id:root.id,revision:String(r.revision),choice,...(token&&choice!=='details'?{token}:{})})}`;
      const confirmation=token?'Open your secure email link and confirm once. No sign-in is required to confirm your decision. View Details requires your landlord account. Keep this link private.':'Sign in with your landlord account to confirm.';
      const place=mailPlace(root.listings,r.property_title);
      const facts=`Monthly Rent: $${terms['rent.monthly']} · Deposit: $${terms['deposit.amount']}\nLease: ${terms['lease.commencement_date']} to ${terms['lease.end_date']}`;
      const lines=members.map(m=>`${m.name}: credit score ${m.credit_score ?? 'No score returned'} (${m.score_model}; ${m.report_date.slice(0,10)})${m.mock ? ' (mock)' : ''}; annual income ${m.annual_income || 'Not stated'} (${m.income_source}); ${m.employment}`);
      const text=`${test?'INTERNAL TEST — Synthetic screening. Run '+root.id+'\n\n':''}Application Ready for Your Decision\n${place}\n\n${facts}\n\n${lines.join('\n')}\n\nView Details: ${link('details')}\nAgree to Proceed: ${link('accept')}\nDo Not Proceed: ${link('decline')}\n\n${confirmation} Agreeing approves this application group and the displayed terms for lease preparation; it does not sign the lease.`;
      const html=mailShell(env,{title:'Application Ready for Your Decision',heading:'Application Ready for Your Decision',place,test,
        body:`<p style="margin:0 0 24px;white-space:pre-line">${esc(facts)}</p>
${members.map(m=>`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:20px;border-top:1px solid #dddddd;border-bottom:1px solid #dddddd">
<tr><td colspan="2" style="padding:16px 0 12px"><span style="font-size:12px;color:#555555">Applicant</span><br><b>${esc(m.name)}</b><br><span style="font-size:13px;color:#555555">${esc(m.employment)}</span></td></tr>
<tr><td width="50%" valign="top" style="padding:0 12px 16px 0"><span style="font-size:12px;color:#555555">Credit Score</span><br><b>${esc(m.credit_score ?? 'No score returned')}${m.mock?' (mock)':''}</b><br><span style="font-size:12px;color:#555555">${esc(m.score_model)}<br>${esc(m.report_date.slice(0,10))}</span></td>
<td width="50%" valign="top" style="padding:0 0 16px 12px"><span style="font-size:12px;color:#555555">Annual Income</span><br><b>${esc(m.annual_income || 'Not stated')}</b><br><span style="font-size:12px;color:#555555">${esc(m.income_source)}</span></td></tr></table>`).join('')}
<p style="margin:0 0 12px;font-size:12px;color:#555555">Decision Request · Reference ${notice}</p>
<p style="margin:0 0 8px">${mailButton('View Details',link('details'))}</p>
<p style="margin:0 0 12px">${mailButton('Agree to Proceed',link('accept'))}${mailButton('Do Not Proceed',link('decline'))}</p>`,
        footer:`${esc(confirmation)} Your decision covers this whole application group and these terms. Agreeing starts lease preparation; it does not sign the lease.`});
      return send(r.landlord_email,mailSubject(test,`Application ready · ${place} · Ref ${notice}`),`${text}\n\nNotification reference: ${notice}`,html,key);
    },
    async invite(root,i) {
      const link=new URL('/apply/',env.SITE_ORIGIN || request.url);link.searchParams.set('id',String(root.listing_id));link.searchParams.set('invite',`${root.id}.${i.id}`);link.searchParams.set('invited',i.email);
      const mail=invitationMail(env,{place:mailPlace(root.listings,'this home'),inviter:root.email,invitee:{name:i.name,email:i.email},link:link.toString(),expires:i.expires,test:root.workspace?.test_run ? root.id : ''});
      return send(i.email,mail.subject,mail.text,mail.html,`roommate/${i.id}`);
    },
    async ready(root,member,key) {
      // The portal opens on this application once the applicant signs in.
      const link=new URL('/portal/',env.SITE_ORIGIN || request.url);link.searchParams.set('application',member.id);
      const mail=readyMail(env,{place:mailPlace(root.listings,'this home'),link:link.toString(),test:root.workspace?.test_run ? root.id : ''});
      return send(String(member.email || ''),mail.subject,mail.text,mail.html,key);
    }
  };
}
