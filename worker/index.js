import { guardAdminPage, handleAdminRequest } from "./admin.js";
import { handleInquiry, renderPage } from "./contact.js";
import { serveListingsFeed } from "./listings.js";
import { serveMedia } from "./media.js";

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

    // Listing photos, floor plans, and videos stored in R2.
    if (pathname.startsWith("/media/")) {
      return serveMedia(request, env, pathname);
    }

    if (pathname === "/api/admin" || pathname.startsWith("/api/admin/")) {
      return handleAdminRequest(request, env, ctx, pathname);
    }

    // Cloudflare Access already gates these routes; this is a second check so
    // the admin page is never served if that policy is missing.
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      const denied = await guardAdminPage(request, env);
      if (denied) return denied;
      return env.ASSETS.fetch(request);
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
