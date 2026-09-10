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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

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
      return serveMedia(request, env, pathname);
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
      const resource = pathname.slice("/api/auth/".length);
      if (["workspace-code", "workspace-activate"].includes(resource)) return handleWorkspaceAuth(request, env, resource);
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
      const denied = await guardAdminPage(request, env);
      if (denied) return denied;
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set("Cache-Control", "no-store");
      return response;
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
