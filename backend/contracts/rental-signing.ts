// Flow and contract approved by Ocean on 2026-09-16.
// The production rental workflow uses application groups, not the isolated
// /api/v2 LeaseVersion model. Keep that demo's EsignPort unchanged.
import type { LeaseFile, WorkspacePrincipal } from './workspace.ts';

export type RentalSigningPhase =
  | 'preparing' | 'sending' | 'in_progress' | 'archiving' | 'completed'
  | 'declined' | 'voided' | 'needs_attention';

export interface RentalSigner {
  // Stable provider recipient ID; never identify a signature by email alone.
  recipientId: string;
  memberId: string | null; // application ID for tenants; null for landlord
  role: 'tenant' | 'landlord';
  name: string;
  email: string;
  routingOrder: 1 | 2; // every tenant = 1; landlord = 2
}

export interface RentalSigningTab {
  recipientId: string;
  documentId: string;
  kind: 'signature' | 'initial' | 'date_signed' | 'full_name';
  scale?: number;
  fontSize?: string;
  anchorHeight?: number;
  inkHeight?: number;
  inkLift?: number;
  // The field's own anchor token, written invisibly where the field goes.
  // Missing or repeated anchors block preparation.
  anchor: string;
  xOffset: number;
  yOffset: number;
  width?: number;
  height?: number;
  units: 'pixels';
}

export interface RentalSigningFile extends LeaseFile {
  sha256: string;
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'application/pdf';
}

export interface RentalSigningPackage {
  id: string; // durable UUID used as the provider transaction ID
  rentalId: string;
  approvalRevision: number;
  templateVersion: string;
  values: Record<string, unknown>;
  reviewFile?: RentalSigningFile;
  documents: { documentId: string; file: RentalSigningFile; name?: string; layout?: string; tenantRecipientId?: string | null }[];
  signers: RentalSigner[];
  tabs: RentalSigningTab[];
  createdAt: string;
  createdBy: string;
}

export interface RentalSigningRecipientStatus {
  recipientId: string;
  status: 'pending' | 'sent' | 'delivered' | 'completed' | 'declined' | 'delivery_failed';
  deliveryIssue?: string;
  signedAt?: string;
}

export interface RentalSigningEnvelope {
  accountId: string;
  envelopeId: string;
  status: 'created' | 'sent' | 'delivered' | 'completed' | 'declined' | 'voided';
  recipients: RentalSigningRecipientStatus[];
  statusChangedAt: string;
}

export interface RentalSigningRecord {
  package: RentalSigningPackage;
  version: number;
  phase: RentalSigningPhase;
  envelope: RentalSigningEnvelope | null;
  // Sanitized operational messages only; no tokens or raw provider responses.
  issue?: string;
  voidReason?: string;
  creationAttemptedAt?: string;
  nextReadAt?: string; // persisted budget for fallback API polling only
  lastNoticeAt?: string;
  signedPdf?: RentalSigningFile;
  certificate?: RentalSigningFile;
  updatedAt: string;
}

export interface RentalSigningNotice {
  // HMAC is verified over the original bytes before JSON parsing.
  // Only the HMAC-verified, normalized snapshot is retained, never URLs or files.
  accountId: string;
  envelopeId: string;
  event: string;
  generatedAt: string;
  envelope?: RentalSigningEnvelope;
}

export interface RentalSigningProvider {
  // Create a DRAFT; persist its envelope ID before requesting delivery.
  // Recovery searches by transaction ID before attempting another creation.
  createDraft(input: {
    package: RentalSigningPackage;
    documents: { documentId: string; bytes: Uint8Array }[];
  }): Promise<RentalSigningEnvelope>;
  findByTransactionId(transactionId: string): Promise<RentalSigningEnvelope | null>;
  send(envelopeId: string, pkg: RentalSigningPackage): Promise<void>;
  read(envelopeId: string): Promise<RentalSigningEnvelope>;
  verifyNotice(rawBody: Uint8Array, headers: Record<string, string>): Promise<RentalSigningNotice | null>;
  // Bounded streams; storage validates PDF type/size and records a hash.
  download(envelopeId: string, kind: 'signed_pdf' | 'certificate'): Promise<ReadableStream<Uint8Array>>;
  void(envelopeId: string, reason: string): Promise<void>;
}

export interface RentalSigningStore {
  get(packageId: string): Promise<RentalSigningRecord | null>;
  current(rentalId: string): Promise<RentalSigningRecord | null>;
  // Transaction: recheck staff access, ALL member versions and approval;
  // insert package + pending job; lock signing-sensitive application changes.
  // Unique active package per rental. Source documents already exist privately.
  reserve(input: {
    package: RentalSigningPackage;
    principal: WorkspacePrincipal;
    expectedMemberVersions: Record<string, number>;
  }): Promise<RentalSigningRecord>;
  // Atomic CAS: signing record, provider-derived receipts and rental status.
  // Marks lease_signed only when all signers completed AND both PDFs exist.
  save(record: RentalSigningRecord, expectedVersion: number, claimToken: string): Promise<void>;
  // Durable inbox, deduplication, and work scheduling committed before HTTP 2xx.
  // An unknown envelope is retained for correlation with an in-flight creation.
  enqueueNotice(notice: RentalSigningNotice, payloadSha256: string): Promise<void>;
  notices(envelope: RentalSigningEnvelope): Promise<RentalSigningNotice[]>;
  // Claim has a lease expiry and fencing token; an expired worker cannot commit.
  claimDue(limit: number, now: string): Promise<{
    packageId: string; claimToken: string; expiresAt: string;
  }[]>;
  release(packageId: string, claimToken: string, retryAt: string | null): Promise<void>;
}

export interface RentalSigningFiles {
  // Immutable private keys scoped to package ID and artifact kind.
  put(packageId: string, kind: 'source_docx' | 'signed_pdf' | 'certificate',
    bytes: ReadableStream<Uint8Array>): Promise<RentalSigningFile>;
  read(file: RentalSigningFile): Promise<ReadableStream<Uint8Array>>;
}

export interface SendRentalLeaseCommand {
  // Server resolves recipients/documents; callers cannot substitute a file,
  // email address, signing order, approval revision or template version.
  rentalId: string;
  expectedWorkspaceVersion: number;
  reviewedPackageId: string;
}
