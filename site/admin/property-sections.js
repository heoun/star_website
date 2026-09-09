// The property editor follows the order in which the lease package is filled.
// This is a presentation map: field IDs, permissions and storage scopes stay fixed.
export const PROPERTY_SECTIONS = [
  { id: "property", label: "Properties", note: "Start with the property's address.", ids: [], always: true },
  { id: "signing", label: "Landlord & signing", note: "Identify the landlord and the person who signs the lease.", ids: ["landlord.print_name", "landlord.entity_name", "landlord.address"], groups: ["parties"] },
  { id: "management", label: "Management & notices", note: "Set management, notice recipients and the housing emergency contact.", ids: ["manager.name", "manager.address", "manager.phone", "legal_notice.name", "legal_notice.address", "legal_notice.phone", "emergency.phone"] },
  { id: "payments", label: "Lease terms, payments & policies", note: "Work through lease timing, payments, deposits and standing policies.", ids: ["lease.end_time", "rent.due_day", "fee.returned_payment", "payee.name", "payee.address", "payee.phone", "deposit.bank_name", "deposit.bank_address", "guest.consecutive_days", "guest.total_days", "guest.window_days", "fee.lock_change_admin", "fee.animal_liability_cap", "insurance.required_yes", "insurance.required_no", "fee.lptli_monthly", "attorney_fees.cap_enabled", "attorney_fees.cap_amount", "smoking.in_unit_yes", "smoking.in_unit_no"] },
  { id: "utilities", label: "Utility", note: "Choose who pays for each service and name any additional utilities.", groups: ["utilities"] },
  { id: "keys", label: "Key rider", note: "For each key or remote, record the quantity and replacement charge.", groups: ["keys"] },
  { id: "insurance", label: "New York renters insurance rider", note: "Set required liability coverage and insurance-related monthly charges.", ids: ["insurance.min_liability", "fee.renters_insurance_waiver_monthly", "fee.lptli_admin_monthly"] },
  { id: "fines", label: "Fine schedule", note: "Review the amount or description printed for each violation.", groups: ["fines"] },
  { id: "bedbug", label: "Bedbug", note: "Review the infestation history used in the disclosure.", prefixes: ["bedbug."] },
  { id: "sprinkler", label: "Sprinkler system notice", note: "Record the system's status and the actual inspection date.", prefixes: ["sprinkler."] },
  { id: "gas", label: "NYC gas leak, carbon monoxide and smoke alarm rider", note: "Provide the gas supplier and its emergency telephone number.", ids: ["gas.provider_name", "gas.provider_phone"] },
  { id: "smoking", label: "New York smoking policy rider", note: "Specify restricted areas, exceptions and the complaint contact.", prefixes: ["smoking."] },
  { id: "concession", label: "Rent concession rider", note: "Offer details are confirmed for each rental when preparing its lease.", ids: [], always: true },
  { id: "dhcr", label: "DHCR electronic lease consent", note: "Review the owner's consent contact. Lease type is confirmed for each rental.", ids: ["owner_rep.name", "owner_rep.email", "owner_rep.mailing_address"] },
  { id: "good_cause", label: "Good Cause Eviction notice", note: "Work through applicability, exemptions, rent increases and nonrenewal reasons.", groups: ["good_cause"] }
];

export function sectionsFor(fields) {
  const claimed = new Set();
  const sections = PROPERTY_SECTIONS.map(section => {
    const ordered = [...(section.ids || []).map(id => fields.find(field => field.id === id)).filter(Boolean),
      ...fields.filter(field => (section.groups || []).includes(field.group) || (section.prefixes || []).some(prefix => field.id.startsWith(prefix)))];
    const own = ordered.filter(field => {
      if (claimed.has(field.id)) return false;
      claimed.add(field.id); return true;
    });
    return {...section, fields: own};
  }).filter(section => section.always || section.fields.length);
  const extra = fields.filter(field => !claimed.has(field.id));
  if (extra.length) sections.push({id:"additional", label:"Additional property fields", note:"Additional fields in this lease package.", fields:extra});
  return sections;
}

export function isOptionalSection(section) {
  return section.fields.length > 0 && section.fields.every(field => !field.required);
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
export function readiness({ fields, answered, hasSigner = true }) {
  const sections = sectionsFor(fields);
  const inSection = new Map();
  for (const section of sections) {
    for (const field of section.fields) inSection.set(field.id, section.id);
  }

  const checks = [];
  for (const check of CHECKS) {
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

  const covered = new Set(CHECKS.flatMap(check => check.ids || fields.filter(field => inSection.get(field.id) === check.section && field.required).map(field => field.id)));
  for (const section of sections) {
    const remaining = section.fields.filter(field => field.required && !covered.has(field.id));
    if (!remaining.length) continue;
    const missing = remaining.filter(field => !answered(field)).length;
    checks.push({id:section.id, label:section.label, blocking:`${section.label} still needs required values.`, missing, needsEmail:false, complete:missing === 0});
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
