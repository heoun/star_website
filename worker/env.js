// Tells a developer's machine apart from production.
//
// Two different questions live here, and they deliberately have two different
// answers, because getting either one wrong in production costs something
// different.
//
//   isLocalRequest  — "is this a loopback address?"  Governs side effects that
//                     must not escape a laptop: notification email, reading
//                     media from the live site.  A deployed Worker only ever
//                     receives requests routed to its own hostname, so this is
//                     false in production without any configuration to forget.
//
//   devIdentity     — "may this request act as an administrator without
//                     Cloudflare Access?"  This grants the whole admin API, so
//                     it needs more than a hostname.
//
// Cloudflare Access protects /admin in production and fails closed: with no
// CF_ACCESS_* configuration verifyAccessRequest returns null and every admin
// route answers 403. That is correct, and it is also why a local Worker needs a
// deliberate way in. This is that way, behind two independent locks:
//
//   1. DEV_ADMIN_EMAIL has a value. It can only reach the Worker through
//      .dev.vars, which is gitignored, is never uploaded by `wrangler deploy`,
//      and does not exist in the GitHub Actions environment.
//   2. The request arrived on a loopback hostname.
//
// Either lock on its own keeps this shut in production. Both would have to fail
// at once — someone deliberately running `wrangler secret put DEV_ADMIN_EMAIL`
// *and* production traffic somehow arriving as localhost.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

export function isLocalRequest(request) {
  try {
    return LOOPBACK_HOSTS.has(new URL(request.url).hostname);
  } catch {
    return false;
  }
}

// The identity a local request acts as, or null. Shaped like the one
// verifyAccessRequest returns so callers cannot tell them apart.
export function devIdentity(request, env) {
  const email = (env.DEV_ADMIN_EMAIL || "").trim();
  if (!email || !isLocalRequest(request)) return null;
  return { email, subject: "local-development", development: true };
}

// What the admin page shows in its banner. The Supabase project is named, not
// just the environment, because the mistake worth catching is a local Worker
// pointed at the production database — that looks exactly like development
// until something is deleted.
//
// A project's display name is not reachable from here: it lives only in the
// Supabase dashboard, and neither the URL nor the service role key carries it —
// both identify the project by its ref. So DEV_SUPABASE_LABEL lets a person
// write the familiar name down, and the ref is shown beside it. The label is
// typed by hand and can be stale; the ref is read from the URL actually in use
// and cannot be, which is why both appear.
export function describeEnvironment(request, env) {
  const local = isLocalRequest(request);
  const host = (() => {
    try {
      return new URL(env.SUPABASE_URL || "").hostname;
    } catch {
      return "";
    }
  })();

  return {
    environment: local ? "development" : "production",
    // "shlodyxlnepxnafthvod.supabase.co" -> "shlodyxlnepxnafthvod"
    database: host ? host.split(".")[0] : "not configured",
    database_label: local ? (env.DEV_SUPABASE_LABEL || "").trim() : ""
  };
}
