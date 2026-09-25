import { isListingPage, serveListingPage } from "./listing-pages.js";
import { accountSecurityEnabled } from "./account-security.js";
import { handleWorkspaceSecurity } from "./workspace-security.js";
import { handleAuthRequest } from "./auth.js";
import { handleWorkspaceAuth } from "./workspace-auth.js";
import { handlePublicOnboarding } from "./administration.js";
import { guardAdminPage, handleAdminRequest } from "./admin.js";
import { handleApplication, handleRoommateInvites } from "./apply.js";
import { handleInquiry, renderPage } from "./contact.js";
import { serveListingsFeed, servePropertyDetail } from "./listings.js";
import { serveMedia } from "./media.js";
import { handlePortalRequest } from "./portal.js";
import { handleBackendRequest } from "../backend/app/index.ts";
import { rentalMode, rentalApplyOptions, reconcileRentals } from "./rentals.js";
import { handleDocusignWebhook, reconcileSigning } from './signing.js';
import { readSession } from './auth.js';
import { internalTesting,internalTestParticipant,internalTestListing } from '../backend/app/internal-testing.ts';
import { handleLandlordDecision } from './landlord-decision.js';
import { invitedTestContext } from './internal-testing.js';
import {deploymentError,deploymentResponse} from './deployment.js';
import {handleGipAuth} from './gip-flow.js';

const application = {
  async scheduled(_event,env,ctx) {
    ctx.waitUntil(reconcileRentals(env,new Request(env.SITE_ORIGIN || 'https://starreusa.com/')));
    ctx.waitUntil(reconcileSigning(env,new Request(env.SITE_ORIGIN || 'https://starreusa.com/')));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if(pathname==='/api/webhooks/docusign')return handleDocusignWebhook(request,env,ctx);
    if(pathname==='/api/landlord-decision')return handleLandlordDecision(request,env);
    if(pathname==='/api/apply/options' && request.method==='GET') {
      try {
        const session=internalTesting(env,request)?await readSession(request,env):null;
        const invitation=rentalMode(env) ? await invitedTestContext(env,request,session,url.searchParams.get('id'),url.searchParams.get('invite') || '',url.searchParams.get('group') || '') : null;
        const response=Response.json({automatic:rentalMode(env),internal_testing:internalTestParticipant(env,request,session) && internalTestListing(env,url.searchParams.get('id')),internal_test_group:invitation?.run?.member_of || invitation?.pendingGroup || null,internal_test_pending:!!invitation?.pendingGroup,agents:rentalMode(env) ? await rentalApplyOptions(env,url.searchParams.get('id')) : []},{headers:{'Cache-Control':'no-store'}});
        if(session?.setCookie)response.headers.append('Set-Cookie',session.setCookie);return response;
      }
      catch {return Response.json({error:'Application options are unavailable.'},{status:503});}
    }

    if ((request.method === "GET" || request.method === "HEAD") && isListingPage(pathname)) {
      return serveListingPage(request, env, ctx);
    }

    // The listing pages fetch this path; the Worker answers it from Supabase.
    // wrangler.jsonc routes it here instead of to the bundled asset, which is
    // still used as the offline fallback.
    if (pathname === "/data/listings.json") {
      return serveListingsFeed(request, env, ctx);
    }

    // One listing with its full copy and media, for the property page.
    if (pathname === "/data/property.json") {
      return servePropertyDetail(request, env, ctx);
    }

    // Listing photos, floor plans, and videos stored in R2.
    if (pathname.startsWith("/media/")) {
      return serveMedia(request, env, pathname, ctx);
    }

    // The rebuilt backend, one ring at a time. Off unless BACKEND_V2=on, so
    // deploying this code changes nothing until the switch is thrown.
    if (pathname === "/api/v2" || pathname.startsWith("/api/v2/")) {
      if (env.BACKEND_V2 !== "on") {
        return new Response(JSON.stringify({ error: "Not found." }), {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
      return handleBackendRequest(request, env);
    }

    if (pathname.startsWith("/api/auth/")) {
      const resource = pathname.slice(pathname.startsWith('/api/auth/workspace/') ? '/api/auth/workspace/'.length : '/api/auth/'.length);
      if(env.AUTH_PROVIDER==='gip')return handleGipAuth(request,env,resource,pathname.startsWith('/api/auth/workspace/')||resource.startsWith('workspace-')?'workspace':'applicant');
      if(pathname==='/api/auth/options')return Response.json({provider:'supabase'},{headers:{'Cache-Control':'no-store'}});
      if(pathname==='/api/auth/workspace/options')return new Response(JSON.stringify({secure:accountSecurityEnabled(env)}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
      if(pathname.startsWith('/api/auth/workspace/') && accountSecurityEnabled(env) && ['security','reset-password','setup-password','mfa-enroll','mfa-verify','switch-role','owner-admin'].includes(resource))return handleWorkspaceSecurity(request,env,resource);
      if (["workspace-code", "workspace-activate", "workspace-invitation", "workspace-accept"].includes(resource)) return handleWorkspaceAuth(request, env, resource);
      return handleAuthRequest(request, env, ctx, resource);
    }

    if (pathname === "/api/landlord-onboarding") return handlePublicOnboarding(request, env);

    if (pathname === "/api/admin" || pathname.startsWith("/api/admin/")) {
      return handleAdminRequest(request, env, ctx, pathname);
    }

    // The applicant portal: sign-in codes, application status, and document
    // uploads for people who have already applied.
    if (pathname === "/api/portal" || pathname.startsWith("/api/portal/")) {
      return handlePortalRequest(request, env, ctx, pathname);
    }

    // Roommate invitations, sent from the apply page's roommate step.
    if (pathname === "/api/apply/invite") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed." }), {
          status: 405,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
      return handleRoommateInvites(request, env);
    }

    // Rental applications submitted from the apply page.
    if (pathname === "/api/apply") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed." }), {
          status: 405,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
      return handleApplication(request, env, ctx);
    }

    // Resolve the Supabase session and business role before serving workspace assets.
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return guardAdminPage(request, env);
    }

    // /contact-us/submit-inquiry.php is kept as an alias so cached pages that
    // still post to the legacy endpoint keep working.
    if (pathname === "/api/contact" || pathname === "/contact-us/submit-inquiry.php") {
      if (request.method !== "POST") {
        return renderPage("Form unavailable", "Please submit the inquiry form from the Contact Us page.", 405);
      }
      return handleInquiry(request, env);
    }

    // PHP files are excluded from the static assets upload.
    if (pathname.endsWith(".php")) {
      return Response.redirect(new URL("/contact-us/", url).toString(), 302);
    }

    return env.ASSETS.fetch(request);
  }
};

export default {
  async fetch(request,env,ctx) {
    if(deploymentError(env))return Response.json({error:'Environment configuration is incomplete.'},{status:503});
    if(new URL(request.url).pathname==='/api/health' && request.method==='GET') {
      try {
        const result=await fetch(env.SUPABASE_URL+'/rest/v1/star_schema_release?select=revision&limit=1',{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`},signal:AbortSignal.timeout(5000)});
        if(!result.ok)throw new Error('Database unavailable');
        const schema=(await result.json())[0]?.revision;if(!schema)throw new Error('Schema not initialized');
        let simulatorMigrations;
        if(env.APP_ENV==='staging') {const simulator=await env.SCREENING_SIMULATOR.fetch('https://screening.internal/health');if(!simulator.ok)throw new Error('Simulator unavailable');simulatorMigrations=(await simulator.json()).migrations;}
        return Response.json({ok:true,environment:env.APP_ENV || 'production',schema,simulatorMigrations},{headers:{'Cache-Control':'no-store'}});
      }catch{return Response.json({ok:false},{status:503,headers:{'Cache-Control':'no-store'}});}
    }
    if(new URL(request.url).pathname==='/api/release' && request.method==='GET')return Response.json({environment:env.APP_ENV || 'production',revision:env.RELEASE_SHA || 'local'},{headers:{'Cache-Control':'no-store'}});
    // Operator-controlled cutover window: never allow new writes while business
    // identities are being rebound. Webhooks receive 503 so senders can retry.
    if(env.AUTH_MIGRATION==='maintenance')return Response.json({error:'Account migration is in progress. Please try again shortly.'},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'60'}});
    return deploymentResponse(await application.fetch(request,env,ctx),env,request);
  },
  async scheduled(event,env,ctx) {
    if(deploymentError(env))throw new Error('Background jobs blocked: environment configuration is invalid.');
    if(env.AUTH_MIGRATION==='maintenance')return;
    return application.scheduled(event,env,ctx);
  }
};
