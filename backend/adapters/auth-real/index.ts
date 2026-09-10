// Supabase identity and business directory resolution behind the Auth port.
// The experimental landlord link path remains separate from account login.

import { fetchStaffMember } from "../../../worker/supabase.js";
import { devIdentity } from "../../../worker/env.js";
import { resolveStaff } from "../../../worker/staff.js";
import { readSession } from "../../../worker/auth.js";
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
  let refreshedCookie: string | undefined;
  return {
    decorateResponse(response) {
      if (refreshedCookie) response.headers.append("Set-Cookie", refreshedCookie);
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
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

      // All users share Supabase identity. Directory members cannot fall back
      // to applicant privileges when their workspace access is suspended.
      const session = await readSession(request, env);
      refreshedCookie = session?.setCookie;
      const identity = session || devIdentity(request, env);
      if (!identity) return null;
      const member = "development" in identity && identity.development ? true : await fetchStaffMember(env, identity.email);
      if (member || identity.email === String(env.OWNER_EMAIL || "").trim().toLowerCase()) {
        const resolved = await resolveStaff(env, identity) as { identity?: { email: string; role: string; owner?: boolean } };
        if (resolved.identity && !resolved.identity.owner && ["manager", "agent"].includes(resolved.identity.role)) {
          return { kind: "staff", id: resolved.identity.email,
            role: resolved.identity.role === "manager" ? "admin" : "agent", email: resolved.identity.email };
        }
        return null;
      }
      if (session) return { kind: "applicant", id: session.email, email: session.email };

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
