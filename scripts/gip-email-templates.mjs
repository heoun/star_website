// Google-managed security notifications lock their content. Application-owned
// verification/reset emails already use worker/mail-layout.js via Resend.
export function gipEmailTemplates(){
  const sender={senderDisplayName:'Star Real Estate',senderLocalPart:'no-reply',replyTo:'info@starreusa.com'};
  return Object.fromEntries(['revertSecondFactorAdditionTemplate','verifyEmailTemplate','changeEmailTemplate','resetPasswordTemplate'].map(name=>[name,{...sender}]));
}
