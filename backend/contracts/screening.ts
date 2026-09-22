// Screening vendor port. Vendor-neutral: RentSpree, Experian Connect and the
// fake all fit behind it. The applicant pays the vendor directly (RPL 238-a:
// $20 or actual cost, whichever is lower, per person) — no payment port here.
// Implementations: adapters/screening-fake (random score, short delay),
// adapters/screening-<vendor> (Ring 7).

import type { Id, PersonRef, ScreeningResult } from "./domain";

export interface ScreeningStart {
  applicationId: Id;
  caseId: Id;
  applicant: PersonRef;
}

export interface ScreeningStarted {
  screeningId: Id;
  // Where the applicant goes to consent and pay, when the vendor hosts that.
  applicantUrl: string | null;
}

// Vendor pushes (webhook) or we poll; both normalize to a ScreeningResult.
export interface ScreeningPort {
  start(input: ScreeningStart): Promise<ScreeningStarted>;
  // Poll fallback for vendors without webhooks and for the fake.
  fetchResult(screeningId: Id): Promise<ScreeningResult | null>;
  // Returns null when the request is not this vendor's webhook.
  parseWebhook(body: unknown, headers: Record<string, string>): Promise<ScreeningResult | null>;
}
