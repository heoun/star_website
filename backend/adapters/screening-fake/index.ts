// Screening that behaves like a vendor: start() hands back a consent URL,
// and a webhook later delivers the result. The webhook body is whatever the
// consent page posts — in dev, the smoke test or a person clicking the link.

import type { Id, ScreeningResult } from "../../contracts/domain.ts";
import type { ScreeningPort } from "../../contracts/screening.ts";

const pending = new Map<Id, { applicationId: Id }>(); // by screeningId

export function makeFakeScreening(): ScreeningPort {
  return {
    async start(input) {
      const screeningId = `scr-${crypto.randomUUID()}`;
      pending.set(screeningId, { applicationId: input.applicationId });
      return {
        screeningId,
        applicantUrl: `/api/v2/dev/screening/${screeningId}`,
      };
    },

    async fetchResult(screeningId) {
      // The fake is webhook-driven; nothing to poll.
      return pending.has(screeningId) ? null : null;
    },

    async parseWebhook(body, _headers) {
      const b = body as { vendor?: string; screeningId?: string } | null;
      if (!b || b.vendor !== "screening-fake" || !b.screeningId) return null;
      const entry = pending.get(b.screeningId);
      if (!entry) return null;
      pending.delete(b.screeningId);
      const result: ScreeningResult = {
        screeningId: b.screeningId,
        applicationId: entry.applicationId,
        status: "complete",
        creditScore: 640 + Math.floor(Math.random() * 160),
        reportRef: `fake-report/${b.screeningId}`,
      };
      return result;
    },
  };
}
