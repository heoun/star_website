// Rich fixtures for the LOCAL demo only. The permission test fixtures deliberately
// remain sparse so they can still test missing information and blocked leases.
import { readFileSync } from "node:fs";
import { LEASE_REGISTRY } from "../worker/lease.js";
import { DOCUMENT_TYPES } from "../worker/portal.js";
import { encryptSsn } from "../worker/ssn.js";
import { readEntries, readEntryText, replaceEntry } from "../worker/zip.js";

// Deliberately public, synthetic encryption key; never used by the deployed Worker.
export const DEMO_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
// Standalone property previews have no applicant. Use a separate example,
// never another person's application or a saved unit-level tenant default.
export const MOCK_PREVIEW_TENANCY = {
  "tenant.names": "Avery Example", "tenant.email": "preview-tenant@example.test",
  "tenant.mailing_address": "10 Example Lane, Apt 3, New York, NY 10001",
  "lease.commencement_date": "2026-10-01", "lease.end_date": "2027-09-30",
  "concession.terms": "No rent concession in this mock tenancy.",
  "window_guard.mark_has_children": false, "window_guard.mark_no_children": true,
  "window_guard.mark_wants_anyway": true
};
const at = "2026-09-01T10:00:00Z";
const missing = v => v == null || v === "" || Array.isArray(v) && !v.length || typeof v === "object" && !Object.keys(v).length;

export function mockPropertyDefaults(building, landlord, index = 0, supplied = {}) {
  const address = supplied["landlord.address"] || `${900 + index} Example Plaza, Suite 200, New York, NY 10001`;
  const entity = supplied["landlord.entity_name"] || `${building.name} Example Holdings LLC`;
  const signer = supplied["landlord.print_name"] || landlord.name;
  const specific = {
    "lease.end_time": "12:00 PM", "rent.due_day": "1",
    "landlord.entity_name": entity, "landlord.print_name": signer, "landlord.address": address,
    "deposit.bank_name": "Example Deposit Bank", "deposit.bank_address": "500 Example Bank Avenue, New York, NY 10001",
    "payee.name": entity, "payee.address": address, "payee.phone": "212-555-0110",
    "manager.name": "Example Property Management", "manager.address": address, "manager.phone": "212-555-0120",
    "legal_notice.name": "Jordan Avery, Example Notice Agent", "legal_notice.address": address, "legal_notice.phone": "212-555-0130",
    "emergency.phone": "212-555-0140", "owner_rep.name": signer, "owner_rep.email": landlord.email, "owner_rep.mailing_address": address,
    "gas.provider_name": "Example Energy Service", "gas.provider_phone": "212-555-0150",
    "insurance.min_liability": "$100,000.00", "insurance.required_yes": true,
    "attorney_fees.cap_enabled": true, "attorney_fees.cap_amount": "$1,000.00",
    "guest.consecutive_days": "4", "guest.total_days": "8", "guest.window_days": "30",
    "utility.other1_label": "Common laundry service", "utility.other2_label": "Package locker service",
    "key.other_label": "Storage room key", "sprinkler.mark_option2": true, "sprinkler.last_inspection": "08/15/2026",
    "bedbug.mark_none": true, "smoking.inside_units": true, "smoking.in_unit_no": true,
    "smoking.other_areas": true, "smoking.other_areas_text": "The shared roof terrace is smoke-free in this example.",
    "good_cause.mark_yes": true, "good_cause.increase_below_threshold": true,
    "good_cause.nonrenewal_first_or_renewal": true,
    "good_cause.increase_justification": "Not applicable: this mock example has no above-threshold increase."
  };
  return Object.fromEntries(LEASE_REGISTRY.fields.filter(f => f.source === "manager").map(f => {
    if (Object.hasOwn(specific, f.id)) return [f.id, specific[f.id]];
    if (f.type === "checkbox") return [f.id, false];
    if (f.type === "choice") return [f.id, ["electricity", "internet", "cable", "other2"].some(k => f.id === `utility.${k}`) ? "Tenant" : "Landlord"];
    if (f.type === "money") return [f.id, "$50.00"];
    if (f.type === "integer") return [f.id, "2"];
    if (f.id.startsWith("fine.")) return [f.id, "$40.00 - example amount only"];
    if (f.type === "date") return [f.id, "08/15/2026"];
    throw new Error(`Add an explicit demo value for ${f.id}`);
  }));
}

function mockApplication(listing, index) {
  const student = index % 2 === 1;
  return {
    first_name: "Avery", last_name: "Example", name: "Avery Example", email: `applicant-${index + 1}@example.test`,
    phone: "212-555-0161", current_address: `${10 + index} Example Lane, Apt 3, New York, NY 10001`,
    dob: "01/15/1994", id_type: "ssn", ssn_last4: "1234", move_in: "10/01/2026", lease_term_months: 12,
    employment_status: student ? "student" : "employed", income_note: "120000", children_under_11: false, wants_window_guards: true,
    concession_terms: "No rent concession in this mock tenancy.", message: "Mock applicant: flexible viewing schedule; planning an October move.",
    current_employer: { employer: "Example Design Studio", position: "Product Designer", start: "06/01/2023", supervisor_name: "Riley Example", supervisor_phone: "212-555-0162", supervisor_email: "supervisor@example.test" },
    student: { school_name: "Example Graduate Institute", major: "Urban Design", entry_year: "2025", graduation_year: "2027", country: "United States" },
    employment_history: [{ employer: "Example Research Group", position: "Research Associate", start: "07/01/2020", end: "05/31/2023", income: "85000", supervisor_name: "Taylor Example", supervisor_phone: "212-555-0163", supervisor_email: "previous-supervisor@example.test" }],
    rental_history: [{ landlord_name: "Example Former Landlord LLC", address: `${10 + index} Example Lane, Apt 3, New York, NY 10001`, contact: "Morgan Example", landlord_phone: "212-555-0164", landlord_email: "previous-landlord@example.test", start: "07/01/2023", end: "09/30/2026", monthly_rent: "2400" }],
    reference_contacts: [{ name: "Jordan Example", relationship: "Former colleague", phone: "212-555-0165", email: "reference-one@example.test" }, { name: "Casey Example", relationship: "Professional reference", phone: "212-555-0166", email: "reference-two@example.test" }],
    emergency_contacts: [{ name: "Alex Example", relationship: "Sibling", phone: "212-555-0167", email: "emergency-contact@example.test" }],
    roommates: [{ first_name: "Morgan", last_name: "Example", phone: "212-555-0168", email: `roommate-${index + 1}@example.test` }],
    pets: [{ type: "cat", species: "Domestic shorthair", weight: "9" }],
    listing_id: listing.id, status: "new", responsible_email: null, collaborator_emails: [], created_at: at, updated_at: at,
    workspace_version: 0, workspace: { terms: { "lease.commencement_date": "2026-10-01", "lease.end_date": "2027-09-30", "rent.monthly": String(listing.price_amount), "deposit.amount": String(listing.price_amount), "rent.due_day": "1", "concession.terms": "No rent concession in this mock tenancy." }, activity: [] }
  };
}

export async function completeDemoState(state) {
  const seeded = state.demo_seed ||= { properties: {}, applications: {}, listings: {}, documents: {} };
  const fillOnce = (kind, id, target, values) => {
    const keys = new Set(seeded[kind][id] || []);
    for (const [key, value] of Object.entries(values)) {
      if (!keys.has(key) && missing(target[key])) target[key] = structuredClone(value);
      keys.add(key);
    }
    seeded[kind][id] = [...keys];
  };
  for (const [i, b] of state.buildings.entries()) {
    const firstSeed = !seeded.properties[b.id];
    let landlord = state.staff.find(s => s.role === "landlord" && s.active && s.property_ids?.includes(b.id));
    if (!landlord && firstSeed) {
      landlord = { email: `property-${b.id}@example.test`, name: `Example Landlord ${i + 1}`, role: "landlord", active: true, property_ids: [b.id], account_version: 0 };
      state.staff.push(landlord);
    }
    landlord ||= { email: b.landlord_signer_email || "landlord@example.test", name: "Example Landlord" };
    const defaultValues = mockPropertyDefaults(b, landlord, i, state.settings[b.id]);
    state.settings[b.id] ||= {};
    fillOnce("properties", b.id, b, { street: `${100 + i * 100} Example Avenue`, city: "New York", state_abbr: "NY", zip: "10001", state: ({NY:"New York",NJ:"New Jersey",CT:"Connecticut"})[b.state_abbr] || b.state_abbr || "New York", landlord_signer_email: landlord.email, declared_units: 6 });
    fillOnce("properties", `${b.id}:lease`, state.settings[b.id], defaultValues);
    // A representative unit makes every sample property usable in lease preview.
    if (firstSeed && !state.listings.some(l => l.building_id === b.id)) state.listings.push({ id: crypto.randomUUID(), building_id: b.id, unit: "1A", price_amount: 2800 + i * 100, created_at: at, published: false });
  }
  for (const row of [...state.listings, ...state.applications.map(a => a.listings).filter(Boolean)]) {
    for (const key of ["price_display", "neighborhood", "kind_label", "position"]) delete row[key];
  }
  for (const [i, l] of state.listings.entries()) {
    const b = state.buildings.find(b => b.id === l.building_id); if (!b) continue;
    fillOnce("listings", l.id, l, { title: `${b.name} · ${l.unit || "1A"}`, property_name: b.name, unit: "1A", price_amount: 3000, category: "residential", transaction_type: "rental", property_type: "Apartment", use_type: "Residential", bedrooms: 2, bathrooms: 1, size: "900 sq ft", location: [b.street,b.city,b.state_abbr,b.zip].join(", "), description: "Mock two-bedroom apartment with an open living area, elevator access, shared laundry and a package room.", details: "Elevator · Shared laundry · Package room", term_label: "12 months", created_at: at, listing_media: [] });
    if (!state.applications.some(a => a.listing_id === l.id) && !seeded.listings[`${l.id}:application`]) {
      state.applications.push({ id: crypto.randomUUID(), ...mockApplication(l, i) });
    }
    seeded.listings[`${l.id}:application`] = true;
  }
  const samplePdf = [...readFileSync(new URL("./demo-assets/supporting-document-mock.pdf", import.meta.url))];
  for (const [i, a] of state.applications.entries()) {
    const listing = state.listings.find(l => l.id === a.listing_id); if (!listing) continue;
    fillOnce("applications", a.id, a, mockApplication(listing, i));
    // Only replace the old invalid placeholder; never rewrite a later edit.
    if (!a.ssn_encrypted || a.ssn_encrypted === "TEST-ONLY-SECRET") a.ssn_encrypted = await encryptSsn({ APP_ENCRYPTION_KEY: DEMO_ENCRYPTION_KEY }, "000001234");
    if (seeded.documents[a.id] === 2) continue;
    for (const type of DOCUMENT_TYPES.filter(t => !t.when || t.when === a.employment_status)) {
      const required = Math.max(type.required, type.id === "tax_return" ? 2 : 1);
      const existing = state.documents.filter(d => d.application_id === a.id && d.doc_type === type.id);
      while (existing.length < required) {
        const doc = { id: crypto.randomUUID(), application_id: a.id, path: `${a.id}/mock/${type.id}-${existing.length + 1}.pdf`, file_name: `${type.id}-${existing.length + 1} (mock).pdf`, doc_type: type.id, content_type: "application/pdf", size_bytes: samplePdf.length, created_at: a.created_at || at };
        state.documents.push(doc); existing.push(doc); state.files[doc.path] = samplePdf;
      }
      for (const doc of existing) if (!state.files[doc.path] || state.files[doc.path].length < 100) { state.files[doc.path] = samplePdf; doc.size_bytes = samplePdf.length; doc.file_name = `${type.id} (mock).pdf`; }
    }
    seeded.documents[a.id] = 2;
  }
  return state;
}

export async function annotateDemoTemplate(bytes) {
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const entries = readEntries(buffer);
  const xml = await readEntryText(entries, "word/document.xml");
  const marked = xml.replace(/(\{\{[a-z0-9_.]+\}\})/g, "$1 (mock)")
    // Keep the opening contract table first: the document navigator identifies
    // each document by its opening words. Put the visible mock notice after it.
    .replace(/<\/w:tbl>/, '</w:tbl><w:p><w:r><w:rPr><w:b/><w:color w:val="A04020"/></w:rPr><w:t>MOCK LEASE - DEMONSTRATION ONLY. All people, property facts and field values below are mock.</w:t></w:r></w:p>');
  return replaceEntry(entries, "word/document.xml", marked);
}
