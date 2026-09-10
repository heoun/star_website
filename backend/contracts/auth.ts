// Identity port: Supabase sessions for accounts; purpose-bound links for intake.
// Local smoke tests use auth-fake.

import type { Principal } from "./domain";

export interface AuthPort {
  resolve(request: Request): Promise<Principal | null>;
  decorateResponse?(response: Response): Response;
  // Landlord decision/intake links: single-use, expiring, bound to a contact.
  mintLandlordLink(landlordId: string, contactId: string, purpose: "decision" | "intake", ttlDays: number): Promise<string>; // returns URL
}
