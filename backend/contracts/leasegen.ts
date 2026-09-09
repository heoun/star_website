// Lease document generation. Wraps the existing engine under lease/ — the
// registry, the settings resolution and the docx fill stay exactly where they
// are; this port hides them so callers never touch them directly. Real from
// Ring 1. Later property-settings work swaps internals, not this surface.

import type { Id } from "./domain";

export interface GeneratedLease {
  documents: { name: string; docx: Uint8Array }[];
  // Registry ids still unanswered. Empty is required for mode "final";
  // in mode "draft" they print as [ TO BE COMPLETED ].
  missing: string[];
  values: Record<string, string>; // the frozen snapshot for LeaseVersion.values
}

export interface LeaseGenPort {
  build(caseId: Id, mode: "draft" | "final"): Promise<GeneratedLease>;
}
