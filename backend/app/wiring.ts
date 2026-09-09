// The composition root. The ONLY file that may import adapters. Swapping an
// implementation is one line here — that is the whole point of the fence.

import type { Deps } from "../core/deps.ts";
import { makePolicy } from "../core/policy.ts";
import { makeMemoryRepos } from "../adapters/db-memory/index.ts";
import { makeSupabaseRepos } from "../adapters/db-supabase/index.ts";
import { makeFakeAuth } from "../adapters/auth-fake/index.ts";
import { makeRealAuth } from "../adapters/auth-real/index.ts";
import { makeLogEmail } from "../adapters/email-log/index.ts";
import { makeResendEmail } from "../adapters/email-resend/index.ts";
import { makeLogEvents } from "../adapters/events-log/index.ts";
import { makeMemoryStorage } from "../adapters/storage-memory/index.ts";
import { makeR2Storage } from "../adapters/storage-r2/index.ts";
import { makeFakeScreening } from "../adapters/screening-fake/index.ts";
import { makeFakeEsign } from "../adapters/esign-fake/index.ts";
import { makeRealLeaseGen } from "../adapters/leasegen-real/index.ts";

interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MEDIA?: unknown;
  APPLICANT_DOCS?: unknown;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  [key: string]: unknown;
}

// Ring 3: real identities whenever a way to verify them exists — Cloudflare
// Access in production, the two-lock dev identity locally. CI has neither and
// keeps the fake.
export function authKind(env: WorkerEnv): "real" | "fake" {
  const access = String(env.CF_ACCESS_TEAM_DOMAIN || "") && String(env.CF_ACCESS_AUD || "");
  const dev = String(env.DEV_ADMIN_EMAIL || "");
  return access || dev ? "real" : "fake";
}

// Ring 4: real mail rides the legacy sender, which never lets a loopback
// request email anyone unless DEV_REAL_EMAIL=true. The log adapter records
// every message regardless, so /api/v2/dev/emails and the smoke assertions
// see the same truth in every mode.
export function emailKind(env: WorkerEnv): "resend" | "log" {
  return String(env.RESEND_API_KEY || "") ? "resend" : "log";
}

// Ring 5: the R2 bindings exist wherever the Worker runs (wrangler dev
// simulates them), so the real adapter is the default; memory remains for a
// bare environment without bindings.
export function storageKind(env: WorkerEnv): "r2" | "memory" {
  return env.MEDIA && env.APPLICANT_DOCS ? "r2" : "memory";
}

// Ring 2: with database credentials the real store is used; without them the
// memory store keeps dev and CI runnable with zero secrets.
export function dbKind(env: WorkerEnv): "supabase" | "memory" {
  const url = String(env.SUPABASE_URL || "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  return url.startsWith("http") && key.length > 0 ? "supabase" : "memory";
}

export function buildDeps(env: WorkerEnv, request: Request): Deps {
  const origin = new URL(request.url).origin;
  const log = makeLogEmail();
  const email = emailKind(env) === "resend"
    ? {
        send: async (msg: Parameters<Deps["email"]["send"]>[0]) => {
          await log.send(msg);
          return makeResendEmail(env, request).send(msg);
        },
      }
    : log;
  const repos = dbKind(env) === "supabase"
    ? makeSupabaseRepos({ url: String(env.SUPABASE_URL), serviceRoleKey: String(env.SUPABASE_SERVICE_ROLE_KEY) })
    : makeMemoryRepos();
  return {
    repos,
    screening: makeFakeScreening(),
    esign: makeFakeEsign(),
    email,
    storage: storageKind(env) === "r2"
      ? makeR2Storage(env as unknown as Parameters<typeof makeR2Storage>[0])
      : makeMemoryStorage(),
    leasegen: makeRealLeaseGen(repos, env, request),
    auth: authKind(env) === "real" ? makeRealAuth(env, origin) : makeFakeAuth(origin),
    events: makeLogEvents(),
    policy: makePolicy(),
  };
}
