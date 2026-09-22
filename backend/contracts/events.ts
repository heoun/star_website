// Domain events. MVP sink is a log; a later ring swaps in outbox + queues
// without touching emitters. Every state transition emits — the audit trail
// and the reminder machinery both hang off this later.

export type DomainEvent =
  | { type: "application.submitted"; applicationId: string; caseId: string }
  | { type: "screening.completed"; applicationId: string }
  | { type: "case.sent_to_landlord"; caseId: string }
  | { type: "landlord.decided"; caseId: string; approved: boolean }
  | { type: "lease.sent"; leaseVersionId: string }
  | { type: "lease.executed"; leaseVersionId: string; caseId: string }
  | { type: "listing.rented"; listingId: string; rentableId: string };

export interface EventSink {
  emit(e: DomainEvent): Promise<void>;
}
