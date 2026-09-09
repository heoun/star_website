// Outbound mail port. Templates are named here so the catalog is greppable;
// bodies live with the adapter or in core, not in this file.
// Implementations: adapters/email-log (prints, incl. any action links, so dev
// flows are clickable from the console), adapters/email-resend (Ring 4).

export type EmailTemplate =
  | "application_received"
  | "screening_invite"
  | "decision_package"      // to landlord; recipients chosen by Admin per send
  | "decision_recorded"     // to staff
  | "lease_sent"
  | "lease_executed";

export interface EmailSend {
  to: string[];
  template: EmailTemplate;
  data: Record<string, string>;
  replyTo?: string;
}

export interface EmailPort {
  send(msg: EmailSend): Promise<{ messageId: string }>;
}
