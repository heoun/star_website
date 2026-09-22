export function deploymentError(env) {
  if(env.APP_ENV==='staging') {
    if(env.SITE_ORIGIN!=='https://dev.starreusa.com' || env.SUPABASE_URL!=='https://shlodyxlnepxnafthvod.supabase.co'
      || env.INTERNAL_TEST_DATABASE_HOST!=='shlodyxlnepxnafthvod.supabase.co' || env.DOCUSIGN_ENVIRONMENT!=='demo'
      || env.INTERNAL_TESTING!=='on' || !env.SCREENING_SIMULATOR?.fetch)return 'Invalid staging environment';
  }
  if(env.APP_ENV==='production' && (env.INTERNAL_TESTING==='on' || env.RENTAL_SCREENING==='simulator'
    || env.RENTAL_SCREENING==='mock' || env.SUPABASE_URL?.includes('shlodyxlnepxnafthvod')))return 'Invalid production environment';
  return '';
}
export function deploymentResponse(response,env) {
  if(env.APP_ENV!=='staging')return response;
  const result=new Response(response.body,response);
  result.headers.set('X-Robots-Tag','noindex, nofollow, noarchive');
  result.headers.set('X-Star-Environment','staging');
  if(result.headers.get('Content-Type')?.includes('text/html') && typeof HTMLRewriter!=='undefined') {
    return new HTMLRewriter().on('body',{element(e){e.append('<aside style="position:fixed;bottom:0;left:0;z-index:2147483647;background:#fff3cd;color:#513c06;padding:5px 12px;font:12px system-ui;pointer-events:none">Star Dev · Test environment</aside>',{html:true});}}).transform(result);
  }
  return result;
}
