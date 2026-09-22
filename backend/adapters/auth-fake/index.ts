// Dev/CI identity. A request says who it is with one header:
//   x-dev-principal: staff:admin | staff:agent | applicant:<id>
// Landlord links are stateless tokens carrying their own claims — same shape
// the real signed link will have, minus the signature.

import type { Principal } from "../../contracts/domain.ts";
import type { AuthPort } from "../../contracts/auth.ts";

function decodeLandlordToken(token: string): Principal | null {
  try {
    const claims = JSON.parse(atob(token));
    if (claims.kind !== "landlord_link") return null;
    return claims as Principal;
  } catch {
    return null;
  }
}

export function makeFakeAuth(baseUrl = ""): AuthPort {
  return {
    async resolve(request) {
      const url = new URL(request.url);
      const token = url.searchParams.get("llt");
      if (token) return decodeLandlordToken(token);

      const header = request.headers.get("x-dev-principal") || "";
      if (header.startsWith("staff:")) {
        const role = header.slice("staff:".length) === "admin" ? "admin" : "agent";
        return { kind: "staff", id: `dev-${role}`, role, email: `${role}@dev.local` };
      }
      if (header.startsWith("applicant:")) {
        return { kind: "applicant", id: header.slice("applicant:".length), email: "applicant@dev.local" };
      }
      return null;
    },

    async mintLandlordLink(landlordId, contactId, purpose, _ttlDays) {
      const claims: Principal = { kind: "landlord_link", landlordId, contactId, purpose };
      const token = btoa(JSON.stringify(claims));
      return `${baseUrl}/api/v2/landlord/decision?llt=${encodeURIComponent(token)}`;
    },
  };
}
