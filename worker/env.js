// Local role simulation needs both a loopback request and DEV_ADMIN_EMAIL.
// Production identities use Supabase Auth. These local overrides never apply
// to a deployed hostname, even if accidentally configured there.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalRequest(request) {
  try {
    return LOOPBACK_HOSTS.has(new URL(request.url).hostname);
  } catch {
    return false;
  }
}

// The identity a local request acts as, or null. Shaped like the one
// the Supabase adapter returns so callers cannot tell them apart, except that it
// states its own role: a laptop should not need rows in the staff table before
// the admin console will open.
//
// DEV_ADMIN_ROLE=agent is how the agent half of the console gets exercised
// locally. It is passed through unvalidated on purpose — worker/staff.js owns
// the list of roles, and a typo there should say so rather than quietly hand
// out the wider of the two.
export function devIdentity(request, env) {
  const email = (env.DEV_ADMIN_EMAIL || "").trim();
  if (!email || !isLocalRequest(request)) return null;
  return {
    email,
    subject: "local-development",
    development: true,
    role: (env.DEV_ADMIN_ROLE || "manager").trim().toLowerCase()
  };
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
    //
    // Local only. The banner that shows it is local-only too, but the value was
    // being sent to every production browser regardless and sat in the network
    // tab — naming the production project to anyone who opened dev tools. It is
    // only ever useful for catching a local Worker pointed at the wrong
    // database, so it is answered only when there is a local Worker.
    database: local ? (host ? host.split(".")[0] : "not configured") : "",
    database_label: local ? (env.DEV_SUPABASE_LABEL || "").trim() : ""
  };
}
