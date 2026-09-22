// A tab chooses an applicant session; authentication tokens remain exclusively
// in separate HttpOnly cookies. No password or Supabase token is stored here.
const KEY='star-applicant-context';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createApplicantSession(email='') {
  let context;
  try {context=JSON.parse(sessionStorage.getItem(KEY) || 'null');}catch{}
  if(!UUID.test(context?.id || ''))context={id:crypto.randomUUID(),email:''};
  const save=()=>sessionStorage.setItem(KEY,JSON.stringify(context));
  function selectEmail(value) {
    const address=String(value || '').trim().toLowerCase();
    if(!address)return;
    // Invitation links can open in a duplicated tab whose sessionStorage was
    // copied from the inviter. Selecting the invitee must allocate a new slot.
    if(context.email && context.email!==address)context={id:crypto.randomUUID(),email:address};
    else context.email=address;
    save();
  }
  selectEmail(email);save();
  return {
    selectEmail,
    async fetch(input,options={}) {
      const url=new URL(input,location.href);
      if(url.origin!==location.origin)throw new Error('Applicant requests must stay on this website.');
      const headers=new Headers(options.headers);headers.set('X-Applicant-Session',context.id);
      return fetch(input,{...options,credentials:'same-origin',headers});
    },
    documentUrl(path) {
      const url=new URL(path,location.href);
      if(url.origin!==location.origin || !url.pathname.startsWith('/api/portal/documents/'))throw new Error('Invalid document URL.');
      url.searchParams.set('applicant_session',context.id);
      return url.pathname+url.search;
    }
  };
}
