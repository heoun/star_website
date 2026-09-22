// E-signature that behaves like a vendor: an envelope with ordered signers,
// per-signer links, webhook events as each one signs, and the completed set
// available for download. Signing out of order is refused, like the real thing.

import type { EnvelopeCreated, EsignDocument, EsignEvent, EsignPort, EsignSigner } from "../../contracts/esign.ts";
import type { Id } from "../../contracts/domain.ts";

interface Envelope {
  id: string;
  leaseVersionId: Id;
  docs: EsignDocument[];
  signers: (EsignSigner & { signed: boolean })[];
}

const envelopes = new Map<string, Envelope>();

export function makeFakeEsign(): EsignPort {
  return {
    async createEnvelope(leaseVersionId, docs, signers): Promise<EnvelopeCreated> {
      const id = `env-${crypto.randomUUID()}`;
      const ordered = [...signers].sort((a, b) => a.order - b.order).map((s) => ({ ...s, signed: false }));
      envelopes.set(id, { id, leaseVersionId, docs, signers: ordered });
      return {
        envelopeId: id,
        signerLinks: ordered.map((s) => ({
          email: s.email,
          url: `/api/v2/dev/esign/${id}?email=${encodeURIComponent(s.email)}`,
        })),
      };
    },

    async parseWebhook(body, _headers) {
      const b = body as { vendor?: string; envelopeId?: string; signerEmail?: string } | null;
      if (!b || b.vendor !== "esign-fake" || !b.envelopeId || !b.signerEmail) return null;
      const envelope = envelopes.get(b.envelopeId);
      if (!envelope) return null;

      const next = envelope.signers.find((s) => !s.signed);
      if (!next) return null; // already completed
      if (next.email !== b.signerEmail) {
        // Out of order: the vendor would not offer this signer the document yet.
        return null;
      }
      next.signed = true;

      const event: EsignEvent = envelope.signers.every((s) => s.signed)
        ? { type: "completed", envelopeId: envelope.id }
        : { type: "signed", envelopeId: envelope.id, signerEmail: b.signerEmail };
      return event;
    },

    async downloadCompleted(envelopeId) {
      const envelope = envelopes.get(envelopeId);
      if (!envelope) throw new Error("Unknown envelope.");
      if (!envelope.signers.every((s) => s.signed)) throw new Error("Envelope is not completed.");
      // The signed set is the document as sent; a real vendor returns its
      // stamped copy here.
      return envelope.docs[0]!.docx;
    },

    async voidEnvelope(envelopeId, _reason) {
      envelopes.delete(envelopeId);
    },
  };
}

export function peekEnvelope(envelopeId: string) {
  const envelope = envelopes.get(envelopeId);
  if (!envelope) return null;
  return {
    signers: envelope.signers.map((s) => ({ email: s.email, order: s.order, signed: s.signed })),
  };
}
