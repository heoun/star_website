// E-signature port. DocuSign and the fake fit behind it.
// Signing order is fixed by policy: tenants first, landlord last.
// Documents are docx as produced by the lease engine; the vendor converts.
// Implementations: adapters/esign-fake (a page that "signs" on click),
// adapters/esign-docusign (Ring 6).

import type { Id } from "./domain";

export interface EsignDocument {
  name: string; // "Lease", "Rent Concession Rider", ...
  docx: Uint8Array;
}

export interface EsignSigner {
  name: string;
  email: string;
  order: number; // 1..n, ascending signs first
  role: "tenant" | "landlord";
}

export interface EnvelopeCreated {
  envelopeId: string;
  // Fake exposes direct signing links so smoke can click through; real
  // vendors mostly email the signers instead and this stays empty.
  signerLinks: { email: string; url: string }[];
}

export type EsignEvent =
  | { type: "signed"; envelopeId: string; signerEmail: string }
  | { type: "completed"; envelopeId: string }
  | { type: "declined"; envelopeId: string; signerEmail: string };

export interface EsignPort {
  createEnvelope(leaseVersionId: Id, docs: EsignDocument[], signers: EsignSigner[]): Promise<EnvelopeCreated>;
  parseWebhook(body: unknown, headers: Record<string, string>): Promise<EsignEvent | null>;
  // The fully signed set, available once completed.
  downloadCompleted(envelopeId: string): Promise<Uint8Array>;
  voidEnvelope(envelopeId: string, reason: string): Promise<void>;
}
