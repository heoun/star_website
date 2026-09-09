// Principal resolution. All three verifiers already exist in worker/ (Access
// JWT for staff, Supabase cookie for applicants, signed single-use links for
// landlords); Ring 3 moves them behind this port. Ring 1 uses auth-fake, which
// mints any principal from a header so smoke can play all roles.

import type { Principal } from "./domain";

export interface AuthPort {
  resolve(request: Request): Promise<Principal | null>;
  // Landlord decision/intake links: single-use, expiring, bound to a contact.
  mintLandlordLink(landlordId: string, contactId: string, purpose: "decision" | "intake", ttlDays: number): Promise<string>; // returns URL
}
