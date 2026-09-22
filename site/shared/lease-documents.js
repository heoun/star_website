// The documents inside the lease package.
//
// The template is one .docx containing the lease and every notice and rider
// attached to it. Word divides it with section breaks, and docx-preview renders
// each one as a `section.docx` element — 46 of them — so a "document" here is a
// named run of consecutive sections.
//
// The runs are found by their opening words rather than by index. An index
// would be silently wrong the first time somebody adds a page to the template;
// a marker that stops matching is caught by verifyDocuments() and said out
// loud, which is the rule the rest of this screen follows.
//
// `why` is what the Documents list shows about each one:
//
//   required  — law or the template attaches it to every lease
//   property  — it is here because of how the property is configured
//   condition — it is about the terms of this particular tenancy
//
// `conditionalOn` names the lease value that decides whether the document has
// anything to say. It does NOT decide whether the document is produced: see
// worker/lease.js, where fillTemplate substitutes placeholders across the whole
// of word/document.xml and cannot omit a section. Every document below is in
// every .docx this system generates. The list says which ones are answered.

export const DOCUMENTS = [
  {
    id: "lease",
    name: "New York Residential Lease Agreement",
    starts: "THIS IS A BINDING CONTRACT",
    why: "required",
    note: "The agreement itself."
  },
  {
    id: "utilities",
    name: "Utilities Rider",
    starts: "Utilities – Simple Form",
    why: "property",
    note: "Who pays for each utility at this property."
  },
  {
    id: "packages",
    name: "Packages Rider",
    starts: "Packages Rider",
    why: "property",
    note: "Authority to accept deliveries."
  },
  {
    id: "keys",
    name: "Key Rider",
    starts: "Key Rider",
    why: "property",
    note: "Keys issued and what a replacement costs."
  },
  {
    id: "insurance",
    name: "Renters Insurance Rider",
    starts: "New York Renters Insurance Rider",
    why: "property",
    note: "Whether cover is required, and for how much."
  },
  {
    id: "rules",
    name: "Community Rules Rider",
    starts: "Community Rules Rider",
    why: "property",
    note: "House rules and the fine schedule."
  },
  {
    id: "window_guards",
    name: "Window Guard Notice",
    starts: "APPENDIX A",
    why: "required",
    note: "New York City requires this of every lease.",
    conditionalOn: "window_guard.mark_has_children"
  },
  {
    id: "bedbug",
    name: "Bedbug Infestation History Disclosure",
    starts: "NOTICE TO TENANTDISCLOSURE OF BEDBUG",
    why: "required",
    note: "NYC Housing Maintenance Code."
  },
  {
    id: "sprinkler",
    name: "Sprinkler System Notice",
    starts: "Sprinkler System Notice",
    why: "required",
    note: "Real Property Law § 231-a."
  },
  {
    id: "allergen",
    name: "Indoor Allergen Hazards Notice",
    starts: "LEASE/COMMENCEMENT OF OCCUPANCY NOTICE",
    why: "required",
    note: "Local Law 55."
  },
  {
    id: "alarms",
    name: "Gas Leak, Carbon Monoxide and Smoke Alarm Rider",
    starts: "NYC Gas Leak",
    why: "required",
    note: "How to react to an alarm."
  },
  {
    id: "smoking",
    name: "Smoking Policy Rider",
    starts: "New York Smoking Policy Rider",
    why: "property",
    note: "Where smoking is not allowed at this property."
  },
  {
    id: "concession",
    name: "Rent Concession Rider",
    starts: "Rent Concession Rider",
    why: "condition",
    note: "The terms of a concession, when one is agreed.",
    conditionalOn: "concession.terms"
  },
  {
    id: "dhcr",
    name: "DHCR Electronic Lease Consent",
    starts: "DIVISION OF HOUSING AND COMMUNITY RENEWAL",
    why: "required",
    note: "Consent to receive the lease electronically."
  },
  {
    id: "good_cause",
    name: "Good Cause Eviction Notice",
    starts: "NOTICE TO TENANT OF APPLICABILITY",
    why: "required",
    note: "Whether Article 6-A applies to this unit."
  }
];

const norm = (text) => String(text || "").replace(/\s+/g, " ").trim();

// Walks the rendered sections once and gives each document the run of sections
// between its own opening words and the next document's.
//
// `sectionTexts` is the text of every rendered section, in order.
export function mapDocuments(sectionTexts) {
  const starts = new Map();

  for (const doc of DOCUMENTS) {
    const marker = norm(doc.starts);
    const found = sectionTexts.findIndex((text) => norm(text).startsWith(marker));
    if (found !== -1 && !starts.has(found)) starts.set(found, doc);
  }

  const ordered = [...starts.entries()].sort((a, b) => a[0] - b[0]);

  return ordered.map(([from, doc], index) => ({
    ...doc,
    from,
    // Up to the next document's first section, or the end.
    to: index + 1 < ordered.length ? ordered[index + 1][0] - 1 : sectionTexts.length - 1
  }));
}

// Every marker has to match exactly one section, and the runs have to cover the
// document with no section left out. A page added to the template that nothing
// claims would otherwise be invisible on this screen while still printing in
// the .docx somebody signs.
export function verifyDocuments(mapped, sectionCount) {
  const problems = [];

  const missing = DOCUMENTS.filter((doc) => !mapped.some((row) => row.id === doc.id));
  for (const doc of missing) {
    problems.push(`"${doc.name}" was not found in the template — it opened with "${doc.starts}".`);
  }

  if (mapped.length > 0) {
    if (mapped[0].from !== 0) {
      problems.push(`${mapped[0].from} section(s) at the start of the template belong to no document.`);
    }
    const last = mapped[mapped.length - 1];
    if (last.to !== sectionCount - 1) {
      problems.push(`${sectionCount - 1 - last.to} section(s) at the end of the template belong to no document.`);
    }
  }

  return problems;
}
