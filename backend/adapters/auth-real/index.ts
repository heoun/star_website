// The real identities, behind the same contract the fake implements.
//
//   staff      Cloudflare Access JWT (verified again in the Worker), or the
//              two-lock local dev identity — then the staff table decides the
//              role. All reused from worker/, unchanged; legacy "manager"
//              surfaces as v2 "admin".
//   applicant  the portal's HttpOnly Supabase session cookie.
//   landlord   an HMAC-signed, expiring link token. Single-use enforcement
//              arrives with the landlord tables ring; until then the token is
//              stateless, like every other part of this ring.

import { verifyAccessRequest } from "../../../worker/access.js";
import { devIdentity } from "../../../worker/env.js";
import { resolveStaff } from "../../../worker/staff.js";
import { readSession } from "../../../worker/portal.js";
import type { Principal } from "../../contracts/domain.ts";
import type { AuthPort } from "../../contracts/auth.ts";

export interface AuthEnv {
  AUTH_LINK_SECRET?: string;
  [key: string]: unknown;
}

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

interface LinkClaims {
  landlordId: string;
  contactId: string;
  purpose: "decision" | "intake";
  exp: number; // epoch seconds
}

async function signLink(secret: string, claims: LinkClaims): Promise<string> {
  const payload = encoder.encode(JSON.stringify(claims));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), payload));
  return `${b64url(payload)}.${b64url(signature)}`;
}

async function verifyLink(secret: string, token: string): Promise<LinkClaims | null> {
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return null;
  const payload = fromB64url(payloadPart);
  const signature = fromB64url(signaturePart);
  if (!payload || !signature) return null;

  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature.slice() as unknown as BufferSource, payload.slice() as unknown as BufferSource);
  if (!valid) return null;

  let claims: LinkClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) return null;
  if (claims.purpose !== "decision" && claims.purpose !== "intake") return null;
  return claims;
}

export function makeRealAuth(env: AuthEnv, baseUrl = ""): AuthPort {
  return {
    async resolve(request): Promise<Principal | null> {
      // 1. A landlord link names its own bearer.
      const url = new URL(request.url);
      const token = url.searchParams.get("llt");
      if (token) {
        const secret = String(env.AUTH_LINK_SECRET || "");
        if (!secret) return null;
        const claims = await verifyLink(secret, token);
        if (!claims) return null;
        return { kind: "landlord_link", landlordId: claims.landlordId, contactId: claims.contactId, purpose: claims.purpose };
      }

      // 2. Staff: Access first, then the two-lock dev identity; either way the
      //    staff table (or the dev role) decides what they are.
      const identity = (await verifyAccessRequest(request, env)) || devIdentity(request, env);
      if (identity) {
        const resolved = await resolveStaff(env, identity) as { identity?: { email: string; role: string; owner?: boolean } };
        if (resolved.identity && !resolved.identity.owner && ["manager", "agent"].includes(resolved.identity.role)) {
          return {
            kind: "staff",
            id: resolved.identity.email,
            role: resolved.identity.role === "manager" ? "admin" : "agent",
            email: resolved.identity.email,
          };
        }
        return null; // authenticated at the edge but not staff: refused, not demoted
      }

      // 3. An applicant's portal session.
      const session = await readSession(request, env) as { email: string } | null;
      if (session?.email) {
        return { kind: "applicant", id: session.email, email: session.email };
      }

      return null;
    },

    async mintLandlordLink(landlordId, contactId, purpose, ttlDays) {
      const secret = String(env.AUTH_LINK_SECRET || "");
      if (!secret) {
        throw new Error("AUTH_LINK_SECRET is not set; landlord links cannot be minted.");
      }
      const claims: LinkClaims = {
        landlordId,
        contactId,
        purpose,
        exp: Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60,
      };
      const token = await signLink(secret, claims);
      return `${baseUrl}/api/v2/landlord/decision?llt=${encodeURIComponent(token)}`;
    },
  };
}
