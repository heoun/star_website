// What an authenticated person may do in the admin console.
//
// Two systems, two questions, deliberately kept apart:
//
//   Cloudflare Access   may this request reach the Worker at all?
//   this module         now that it has, is it a manager or an agent?
//
// Access is the better answer to the first question because it refuses at the
// edge, before any of our code runs, and because removing somebody from an
// Access group ends every session they have at once. It is the wrong place for
// the second: its application token carries an email and a subject but no group
// membership — reading that needs a second call to /cdn-cgi/access/get-identity
// on every request — and a role is business data a manager wants to read and
// change in the console rather than in someone else's dashboard.
//
// So the role lives in public.staff, keyed by the email Access proved.
//
// Three rules this file exists to keep:
//
//   1. No default role. An email not in the table is refused, not demoted to
//      agent. Somebody added to the Access group by mistake must gain nothing.
//   2. The owner is not in the table. OWNER_EMAIL is always a manager, checked
//      before any query, because a fresh database has no rows and somebody has
//      to be able to add the first one.
//   3. A missing table is reported as a missing table. It means the Worker was
//      deployed ahead of its migration, and answering "not authorized" would
//      send a person looking for a permissions problem that is not there.

import { fetchStaffMember, isMissingTable } from "./supabase.js";
import { agentMayWriteField } from "../site/shared/lease-permissions.js";

export const MANAGER = "manager";
export const AGENT = "agent";
export const LANDLORD = "landlord";

const ROLES = new Set([MANAGER, AGENT, LANDLORD]);

export function normalizeRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  return ROLES.has(role) ? role : "";
}

function ownerEmail(env) {
  return String(env.OWNER_EMAIL ?? "").trim().toLowerCase();
}

export function isManager(identity) {
  return identity?.role === MANAGER;
}

// Resolves the role for an already-authenticated identity.
//
// Returns { identity } when the request may proceed, or { error, status } when
// it may not. Never returns a partly-filled identity: a caller that forgets to
// check would otherwise get an object with no role and treat it as valid.
export async function resolveStaff(env, identity) {
  if (!identity) return { error: "Not authorized.", status: 403 };

  const email = String(identity.email ?? "").trim().toLowerCase();
  if (!email) return { error: "Not authorized.", status: 403 };

  // A local identity states its own role, so a laptop does not need the staff
  // table to exist. Keyed on where the identity came from, not on whether it
  // happens to carry a `role` property: a shape test would let any future
  // token claim named "role" assert itself and skip the table entirely.
  if (identity.development === true) {
    const role = normalizeRole(identity.role);
    if (!role) {
      return {
        error: `DEV_ADMIN_ROLE is "${identity.role}". Use "manager", "agent" or "landlord".`,
        status: 403
      };
    }
    // Landlord assignments always come from the database, including locally.
    const member = [LANDLORD, AGENT].includes(role) ? await fetchStaffMember(env, email) : null;
    return { identity: { ...identity, email, role, owner: role === MANAGER && email === ownerEmail(env), property_ids: member?.active ? member.property_ids || [] : [] } };
  }

  const owner = ownerEmail(env);
  if (owner && email === owner) {
    return { identity: { ...identity, email, role: MANAGER, owner: true } };
  }

  let member;
  try {
    member = await fetchStaffMember(env, email);
  } catch (error) {
    if (isMissingTable(error)) {
      return {
        error: "The admin account list does not exist on this database yet. "
          + "Run supabase/schema.sql on it, then try again.",
        status: 503
      };
    }
    throw error;
  }

  // Truthiness, not `=== false`. A row whose active is null — which is what an
  // older row or a hand-written insert leaves — would otherwise resolve as an
  // active account.
  if (!member || !member.active) {
    return {
      error: `${email} is not set up to use the admin console. `
        + "An Admin can add the account under Accounts & access.",
      status: 403
    };
  }

  const role = normalizeRole(member.role);
  if (!role) {
    return { error: `${email} has an unrecognised role. A manager can correct it.`, status: 403 };
  }

  return { identity: { ...identity, email, role, owner: false, name: member.name || "", property_ids: member.property_ids || [] } };
}

// The values an agent may not write, decided by the whitelist in
// site/shared/lease-permissions.js: an agent settles the terms of one tenancy
// — the dates, the rent, the due day, the deposit, the concession — and every
// other lease value, the tenant's identity and the statutory marks included,
// is a manager's. One list, shared with the browser, so the screen never
// draws an input whose Save this refuses.
export function isManagerControlled(fieldId) {
  return !agentMayWriteField(fieldId);
}

// The application columns an agent may correct: the same tenancy terms the
// lease whitelist allows, on the row they start from. Everything else on an
// application — identity, screening answers — is a manager's to touch.
export const AGENT_APPLICATION_COLUMNS = new Set([
  "move_in", "lease_term_months", "concession_terms"
]);
