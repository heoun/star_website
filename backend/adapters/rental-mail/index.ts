import type { RentalMail } from '../../contracts/rentals.ts';
import { sendEmail } from '../../../worker/email.js';
import { isLocalRequest } from '../../../worker/env.js';
import { createLandlordDecisionToken } from '../../../worker/landlord-decision-token.js';
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function makeRentalMail(env:Record<string,any>,request:Request):RentalMail {
  async function send(to:string,subject:string,text:string,html:string,key:string) {
    const ok=await sendEmail(request,env,{from:'Star Realty <no-reply@starreusa.com>',to:[to],subject,text,html},{idempotencyKey:key});
    return !ok ? 'failed' as const : isLocalRequest(request) && env.DEV_REAL_EMAIL!=='true' ? 'preview' as const : 'sent' as const;
  }
  return {
    async decision(root,members,key) {
      const r=root.workspace!.recommendation!,terms=r.terms;
      // Separate intentional notifications in Gmail; retries keep the same subject
      // and payload so the provider's idempotency key continues to deduplicate them.
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
      const notice=Array.from(new Uint8Array(digest)).slice(0,6).map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
      const url=new URL('/landlord-decision/',env.SITE_ORIGIN || request.url);
      const token=await createLandlordDecisionToken(env,url.origin,root.id,r);
      const link=(choice:string)=>`${url}#${new URLSearchParams({id:root.id,revision:String(r.revision),choice,...(token?{token}:{})})}`;
      const confirmation=token?'Open your secure email link and confirm once. No sign-in is required. Keep this link private.':'Sign in with your landlord account to confirm.';
      const place=[root.listings?.property_name || r.property_title,root.listings?.unit].filter(Boolean).join(' · ');
      const facts=`Monthly rent: $${terms['rent.monthly']} · Deposit: $${terms['deposit.amount']}\nLease: ${terms['lease.commencement_date']} to ${terms['lease.end_date']}`;
      const lines=members.map(m=>`${m.name}: credit score ${m.credit_score ?? 'No score returned'} (${m.score_model}; ${m.report_date.slice(0,10)})${m.mock ? ' (mock)' : ''}; annual income ${m.annual_income || 'Not stated'} (${m.income_source}); ${m.employment}`);
      const text=`${root.workspace?.test_run?'INTERNAL TEST — Synthetic screening. Run '+root.id+'\n\n':''}Application ready for your decision\n${place}\n\n${facts}\n\n${lines.join('\n')}\n\nView details: ${link('details')}\nAgree to proceed: ${link('accept')}\nDo not proceed: ${link('decline')}\n\n${confirmation} Agreeing approves this application group and the displayed terms for lease preparation; it does not sign the lease.`;
      // Use a public HTTPS asset so mail clients can load the logo without attachments.
      const logoUrl=new URL(env.EMAIL_LOGO_URL || 'https://starreusa.com/png/email-logo-v1.png');
      if(logoUrl.protocol!=='https:') throw new Error('EMAIL_LOGO_URL must use HTTPS.');
      const button=(label:string,choice:string)=>`<a style="display:inline-block;padding:12px 18px;margin:0 8px 12px 0;border:1px solid #111111;border-radius:4px;background:#111111;color:#ffffff;font-size:14px;font-weight:bold;line-height:20px;text-decoration:none" href="${esc(link(choice))}">${label}</a>`;
      const html=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Application ready for your decision</title></head>
<body style="margin:0;padding:0;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff"><tr><td align="center" style="padding:24px 8px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border:8px solid #f5f5f5;background:#ffffff;color:#111111;font-size:15px;line-height:1.6">
<tr><td align="center" style="padding:24px 20px"><img src="${esc(logoUrl.href)}" alt="Star Real Estate" width="112" height="112" style="display:block;width:112px;height:112px;border:0;background:#ffffff"></td></tr>
<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:2px solid #111111;font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr>
<tr><td style="padding:24px">
${root.workspace?.test_run?`<p style="margin:0 0 16px;font-size:12px;color:#555555"><b>Internal Test</b> · Run ${esc(root.id.slice(0,8))} · Synthetic screening</p>`:''}
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:#111111">Application ready for your decision</h1>
<h2 style="margin:0 0 12px;font-size:18px;line-height:1.4;color:#111111">${esc(place)}</h2>
<p style="margin:0 0 24px;white-space:pre-line">${esc(facts)}</p>
${members.map(m=>`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:20px;border-top:1px solid #dddddd;border-bottom:1px solid #dddddd">
<tr><td colspan="2" style="padding:16px 0 12px"><span style="font-size:12px;color:#555555">Applicant</span><br><b>${esc(m.name)}</b><br><span style="font-size:13px;color:#555555">${esc(m.employment)}</span></td></tr>
<tr><td width="50%" valign="top" style="padding:0 12px 16px 0"><span style="font-size:12px;color:#555555">Credit score</span><br><b>${esc(m.credit_score ?? 'No score returned')}${m.mock?' (mock)':''}</b><br><span style="font-size:12px;color:#555555">${esc(m.score_model)}<br>${esc(m.report_date.slice(0,10))}</span></td>
<td width="50%" valign="top" style="padding:0 0 16px 12px"><span style="font-size:12px;color:#555555">Annual income</span><br><b>${esc(m.annual_income || 'Not stated')}</b><br><span style="font-size:12px;color:#555555">${esc(m.income_source)}</span></td></tr></table>`).join('')}
<p style="margin:0 0 12px;font-size:12px;color:#555555">Decision request · Reference ${notice}</p>
<p style="margin:0 0 8px">${button('View details','details')}</p>
<p style="margin:0 0 12px">${button('Agree to proceed','accept')}${button('Do not proceed','decline')}</p>
<p style="margin:0;padding-top:16px;border-top:1px solid #dddddd;font-size:12px;line-height:1.7;color:#555555">${confirmation} Your decision covers this whole application group and these terms. Agreeing starts lease preparation; it does not sign the lease.</p>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
      return send(r.landlord_email,`${root.workspace?.test_run?'[Internal Test '+root.id.slice(0,8)+'] ':''}Application ready · ${place} · Ref ${notice}`,`${text}\n\nNotification reference: ${notice}`,html,key);
    },
    async invite(root,i) {
      const link=new URL('/apply/',request.url);link.searchParams.set('id',String(root.listing_id));link.searchParams.set('invite',`${root.id}.${i.id}`);
      const text=`Hello ${i.name},\n\nYou are invited to apply together for ${root.listings?.property_name || root.listings?.title || 'this home'} · ${root.listings?.unit || ''}.\n\nComplete your own application using this link, signed in as ${i.email}:\n${link}\n\nSubmitting accepts this invitation to join one lease application group. Your private documents are visible to the leasing team, not other applicants. This invitation expires ${i.expires.slice(0,10)}.`;
      return send(i.email,'Your shared rental application invitation',text,`<div style="font:16px Arial;line-height:1.7"><p style="white-space:pre-line">${esc(text)}</p><a href="${esc(link)}">Complete your application</a></div>`,`roommate/${i.id}`);
    }
  };
}
