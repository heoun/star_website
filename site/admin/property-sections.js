// What a manager is actually setting, as opposed to where it prints.
//
// The registry groups the 125 landlord values by the part of the document they
// land on — contacts, fees, utilities, keys, fines, disclosures, good cause.
// That is the right shape for building the template and the wrong shape for
// setting one up: it puts the landlord's legal name and the rent-payable
// address in the same bucket, and it puts thirty-three statutory exemption
// marks on the same footing as the one field without which no lease can be
// sent at all.
//
// So this is a second reading of the same registry, by what the value is for.
// Nothing here is stored: every field still lives at the scope the registry
// gives it, and is written through the same settings layer. Change the
// registry and these sections follow; the only thing written down twice is
// which section a field belongs to, and `assign()` refuses to lose one.

// Fields are claimed by explicit id first, then by registry group. First
// section to claim a field keeps it.
const SECTIONS = [
  {
    id: "signing",
    label: "Landlord & signing",
    note: "Who appears as Landlord on the lease, and who signs it.",
    groups: ["parties"]
  },
  {
    id: "management",
    label: "Management & notices",
    note: "The contacts printed on the lease and on the notices that go with it.",
    ids: [
      "manager.name", "manager.address", "manager.phone",
      "legal_notice.name", "legal_notice.address", "legal_notice.phone",
      "owner_rep.name", "owner_rep.email", "owner_rep.mailing_address",
      "emergency.phone", "gas.provider_name", "gas.provider_phone"
    ]
  },
  {
    id: "payments",
    label: "Payments & standing fees",
    note: "Where rent goes, where the deposit is held, and the fees the lease "
      + "charges whatever the tenancy.",
    ids: [
      "payee.name", "payee.address", "payee.phone",
      "deposit.bank_name", "deposit.bank_address",
      "rent.due_day", "lease.end_time"
    ],
    groups: ["fees", "fines"]
  },
  {
    id: "utilities",
    label: "Utilities & services",
    note: "Who pays for each service. Every lease for this building says so.",
    groups: ["utilities"]
  },
  {
    id: "optional",
    label: "Optional & uncommon terms",
    note: "Blank here does not stop a lease. Key deposits, the building's "
      + "disclosure history, and the Good Cause exemptions that do not apply.",
    optional: true,
    groups: ["keys", "building_disclosures", "good_cause"]
  }
];

export function sectionsFor(fields) {
  const claimed = new Map();
  for (const section of SECTIONS) {
    for (const field of fields) {
      if (claimed.has(field.id)) continue;
      const byId = (section.ids || []).includes(field.id);
      const byGroup = (section.groups || []).includes(field.group);
      if (byId || byGroup) claimed.set(field.id, section.id);
    }
  }

  // A field nobody claimed is a field nobody would ever see. It is not worth
  // silently dropping to keep a screen tidy, so it lands in whichever bucket
  // tells the truth about it: required values stay in view.
  const orphans = fields.filter((field) => !claimed.has(field.id));
  for (const field of orphans) claimed.set(field.id, field.required ? "payments" : "optional");

  return SECTIONS
    .map((section) => ({
      ...section,
      fields: fields.filter((field) => claimed.get(field.id) === section.id)
    }))
    .filter((section) => section.fields.length > 0);
}

// A section that only holds optional fields is collapsed whatever its id says:
// the rule is about what blocking means, not about which bucket a value is in.
export function isOptionalSection(section) {
  return section.optional === true || section.fields.every((field) => !field.required);
}

// ------------------------------------------------------------- readiness

// The checks a manager can actually act on. Each one is a named group of
// required fields, so "1 required item" always points at something specific
// rather than at a count of 27 blanks with no priority between them.
//
// `answered` is supplied by the caller, because whether a value is answered
// depends on the layers being read, which is the screen's business, not this
// file's.
const CHECKS = [
  { id: "entity", label: "Landlord entity", ids: ["landlord.entity_name"],
    blocking: "A lease has no Landlord to name." },
  { id: "signer", label: "Landlord signer", ids: ["landlord.print_name"], signer: true,
    blocking: "Landlord signer must be set before agents can send leases." },
  { id: "notices", label: "Management & notices", section: "management",
    blocking: "The notices that go out with the lease have no contact on them." },
  { id: "payments", label: "Payment profile", section: "payments",
    blocking: "The lease cannot say where rent goes or where the deposit is held." },
  { id: "utilities", label: "Utilities", section: "utilities",
    blocking: "The lease cannot say who pays for each service." }
];

// One property's state, in the terms the screens report it.
//
//   ready            nothing required is missing
//   one required     exactly one check is short — name it
//   setup incomplete more than one
export function readiness({ fields, answered, hasSigner = true, signerApplies = true }) {
  const sections = sectionsFor(fields);
  const inSection = new Map();
  for (const section of sections) {
    for (const field of section.fields) inSection.set(field.id, section.id);
  }

  const checks = [];
  for (const check of CHECKS) {
    if (check.signer && !signerApplies) continue;

    const own = check.ids
      ? fields.filter((field) => check.ids.includes(field.id))
      : fields.filter((field) => inSection.get(field.id) === check.section && field.required);
    if (own.length === 0) continue;

    const missing = own.filter((field) => field.required && !answered(field));
    // The signer is the one check with a second half the document never
    // prints: an address to send the signature request to.
    const needsEmail = Boolean(check.signer) && missing.length === 0 && !hasSigner;

    checks.push({
      id: check.id,
      label: check.label,
      blocking: check.blocking,
      missing: missing.length + (needsEmail ? 1 : 0),
      needsEmail,
      complete: missing.length === 0 && !needsEmail
    });
  }

  const short = checks.filter((check) => !check.complete);
  return {
    checks,
    short,
    // Every required value that is not answered, for the places that count.
    missing: short.reduce((total, check) => total + check.missing, 0),
    state: short.length === 0 ? "ready" : short.length === 1 ? "one" : "incomplete",
    label: short.length === 0 ? "Ready"
      : short.length === 1 ? "1 required item"
        : "Setup incomplete",
    // What to say under the headline. One short check names itself; several
    // are counted, because listing five would be the wall of text this screen
    // exists to remove.
    detail: short.length === 0
      ? "Agents can generate and send leases for this property."
      : short.length === 1 ? short[0].blocking
        : `${short.length} groups still need values before agents can send leases.`
  };
}
