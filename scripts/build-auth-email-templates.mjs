// Run with EMAIL_LOGO_URL set to the same public asset as the Worker.
// Paste the generated HTML into Supabase; building does not change the dashboard.
import {mkdir,writeFile} from 'node:fs/promises';
import {authCodeMail,mailShell,mailButton} from '../worker/mail-layout.js';
const env={EMAIL_LOGO_URL:process.env.EMAIL_LOGO_URL};
const dir=new URL('../supabase/email-templates/',import.meta.url);
await mkdir(dir,{recursive:true});
const codes={
  'auth-code':{},
  'confirm-sign-up':{heading:'Confirm your email',intro:'Enter this code on the Star Real Estate page to confirm your email address and finish creating your account.'},
  'reset-password':{heading:'Reset your password',intro:'Enter this code on the Star Real Estate page where you requested a password reset, then choose your new password.'},
  'magic-link-or-otp':{heading:'Your verification code',intro:'Enter this code on the Star Real Estate page to verify your email and continue.'},
  reauthentication:{heading:'Verify your identity',intro:'Enter this code on the Star Real Estate page to confirm your identity before continuing.'}
};
for(const [name,options] of Object.entries(codes))await writeFile(new URL(`${name}.html`,dir),authCodeMail(env,options)+'\n');
for(const [name,heading,intro,label] of [
  ['invite-user','You’re invited to Star Real Estate','You have been invited to create an account with Star Real Estate. Use the button below to accept your invitation.','Accept invitation'],
  ['change-email-address','Confirm your new email address','Confirm the change from {{ .Email }} to {{ .NewEmail }} using the button below.','Confirm email address']
])await writeFile(new URL(`${name}.html`,dir),mailShell(env,{title:heading,heading,
  body:`<p style="margin:0 0 24px">${intro}</p><p style="margin:0 0 24px">${mailButton(label,'{{ .ConfirmationURL }}')}</p>`,
  footer:'If you did not request this, you can ignore this email.'})+'\n');
console.log('Generated seven branded Supabase email templates from worker/mail-layout.js.');
