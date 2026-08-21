// Regression test for lease generation. No dependencies — run it with Node:
//
//     node lease/tools/test-lease.mjs
//
// It imports the same worker/lease.js the Worker runs and fills the same
// template that ships in dist/, so a pass means a real lease came out the other
// end. What it guards, in order of how much a mistake would cost:
//
//   - dates and money, because a wrong end date or deposit is wrong on a
//     signed contract
//   - "unanswered" staying distinct from "blank", so a setting nobody filled
//     in stops the lease instead of printing an empty line
//   - the three settings layers resolving in the right order
//   - a stored setting never being able to shadow a deal value
//   - XML escaping, so a tenant named "Smith & Jones" does not corrupt the file

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  LEASE_REGISTRY,
  dealValues,
  fieldProvenance,
  fillTemplate,
  isManagerField,
  leaseFilename,
  resolveValues,
  splitLocation
} from "../../worker/lease.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const passed = [];
const failed = [];

function check(name, condition, detail = "") {
  (condition ? passed : failed).push(name + (detail ? ` — ${detail}` : ""));
}

// ---------------------------------------------------------------- fixtures

const application = {
  id: "a", name: "Jordan Reyes and Wei Chen", email: "jordan@example.com",
  move_in: "2026-09-01", lease_term_months: 12, children_under_11: false
};
const listing = {
  id: "l", unit: "12B", location: "21-45 44th Drive, Long Island City, NY",
  price_amount: 3900, building_name: "Evergarden", title: "LIC Condo"
};
const building = {
  street: "21-45 44th Drive", city: "Long Island City",
  state: "New York", state_abbr: "NY", zip: "11101"
};
const today = { year: 2026, month: 8, day: 19 };
const deal = dealValues({ application, listing, building, today });

// ---------------------------------------------------------------- the deal

check("a listing address splits into street, city and state",
  JSON.stringify(splitLocation("47-22 11th St, Long Island City, NY")) ===
  JSON.stringify({ street: "47-22 11th St", city: "Long Island City", state_abbr: "NY" }));

check("the lease date prints long, the way the template writes it",
  deal["lease.effective_date"] === "August 19, 2026", deal["lease.effective_date"]);
check("the commencement date prints MM/DD/YYYY",
  deal["lease.commencement_date"] === "09/01/2026", deal["lease.commencement_date"]);
check("a 12-month term ends the day before its anniversary",
  deal["lease.end_date"] === "08/31/2027", deal["lease.end_date"]);
check("a term ending in a leap February lands on the 29th",
  dealValues({
    application: { ...application, move_in: "2027-03-01" }, listing, building, today
  })["lease.end_date"] === "02/29/2028");
check("rent is formatted as money",
  deal["rent.monthly"] === "$3,900.00", deal["rent.monthly"]);
check("the deposit defaults to one month's rent",
  deal["deposit.amount"] === deal["rent.monthly"]);
check("the one-line address is composed from the building's parts",
  deal["property.address_full"] === "21-45 44th Drive, Unit 12B, Long Island City, New York 11101",
  deal["property.address_full"]);
check("the window guard answer follows the application",
  deal["window_guard.mark_no_children"] === true && deal["window_guard.mark_has_children"] === false);
// The apply form stores "MM/DD/YYYY"; reading only ISO blanked every date on
// every lease generated from a real application.
const usForm = dealValues({
  application: { ...application, move_in: "10/01/2026" }, listing, building, today
});
check("a move-in date in the form's own MM/DD/YYYY is understood",
  usForm["lease.commencement_date"] === "10/01/2026", usForm["lease.commencement_date"]);
check("and its end date is still the day before the anniversary",
  usForm["lease.end_date"] === "09/30/2027", usForm["lease.end_date"]);
check("an impossible date is refused rather than rolled into the next month",
  dealValues({ application: { ...application, move_in: "02/30/2026" }, listing, building, today })["lease.commencement_date"] === "");

check("a missing move-in date leaves the dates blank rather than inventing one",
  dealValues({ application: { ...application, move_in: null }, listing, building, today })["lease.commencement_date"] === "");

// -------------------------------------------------------- unanswered ≠ blank

const sourceOf = (id) => LEASE_REGISTRY.fields.find((field) => field.id === id).source;
const nothingStored = resolveValues({ layers: { company: {}, building: {}, unit: {} }, deal });

check("settings nobody filled in are reported missing, not silently blanked",
  nothingStored.missing.length > 0, `${nothingStored.missing.length} missing`);
check("only manager settings can be missing; the deal answers its own fields",
  nothingStored.missing.every((id) => sourceOf(id) === "manager"),
  [...new Set(nothingStored.missing.map(sourceOf))].join(", "));
check("an unanswered check box renders unchecked, never as an empty space",
  nothingStored.values["bedbug.mark_none"] === "[ ]");

// ------------------------------------------------------------- the layers

const layers = {
  company: { "fee.returned_payment": "$25.00", "utility.water": "Landlord" },
  building: { "utility.water": "Tenant", "bedbug.mark_none": true },
  unit: { "utility.water": "N/A" }
};
const layered = resolveValues({ layers, deal });

check("the unit layer beats the building layer beats the company layer",
  layered.values["utility.water"] === "N/A", layered.values["utility.water"]);
check("a company value survives where no later layer answers",
  layered.values["fee.returned_payment"] === "$25.00");
check("a checked box renders its checked mark",
  layered.values["bedbug.mark_none"] === "[X]");
check("provenance names the layer that answered",
  fieldProvenance(layers)["utility.water"] === "unit");

// resolveValues is a pure function and honours any override it is handed; the
// admin API is what limits an agent to deal and agent fields, so that a manager
// setting can only change where the change is audited.
const overridden = resolveValues({
  layers, deal, overrides: { "tenant.names": "Someone Else", "utility.water": "Landlord" }
});
check("what the agent confirms on the generate form beats the deal value",
  overridden.values["tenant.names"] === "Someone Else");
check("an override is honoured over a settings layer when one is supplied",
  overridden.values["utility.water"] === "Landlord");

// A lease that writes the same day two ways is one somebody has to explain.
const retyped = resolveValues({
  layers, deal,
  overrides: {
    "lease.commencement_date": "2026-10-01",
    "lease.vacancy_lease_date": "2026-11-01"
  }
});
check("a date typed as ISO is printed the way the rest of the lease writes dates",
  retyped.values["lease.commencement_date"] === "10/01/2026",
  retyped.values["lease.commencement_date"]);
check("and so is one the application never supplied",
  retyped.values["lease.vacancy_lease_date"] === "11/01/2026",
  retyped.values["lease.vacancy_lease_date"]);
check("a date written out in words is left alone",
  retyped.values["lease.effective_date"] === "August 19, 2026",
  retyped.values["lease.effective_date"]);

// Correcting one part of the address has to move the one-line version too, or
// the lease names the same apartment two different ways.
const corrected = resolveValues({
  layers, deal, overrides: { "property.city": "Kew Gardens", "property.zip": "11415" }
});
check("correcting a part of the address recomposes the one-line address",
  corrected.values["property.address_full"] === "21-45 44th Drive, Unit 12B, Kew Gardens, New York 11415",
  corrected.values["property.address_full"]);
check("an address typed in whole still wins over the parts",
  resolveValues({ layers, deal, overrides: { "property.address_full": "One Typed Address" } })
    .values["property.address_full"] === "One Typed Address");

check("a settings layer may not carry deal fields",
  !isManagerField("rent.monthly") && !isManagerField("tenant.names") && !isManagerField("lease.end_date"));
check("a settings layer may carry manager fields",
  isManagerField("utility.water") && isManagerField("fine.dog_waste"));

check("the filename identifies the lease without opening it",
  leaseFilename({ application, listing }) === "Evergarden-12B-Jordan-Reyes-and-Wei-Chen.docx",
  leaseFilename({ application, listing }));

// -------------------------------------------------------- the real document

const templateBytes = readFileSync(join(repo, "lease", "template", "lease-template.docx"));
const env = { ASSETS: { fetch: async () => new Response(templateBytes) } };
const request = { url: "https://example.com/api/admin/lease/document/a" };

const complete = {};
for (const field of LEASE_REGISTRY.fields) {
  complete[field.id] = field.type === "checkbox"
    ? (field.default ? field.marks.checked : field.marks.unchecked)
    : (deal[field.id] ?? field.default ?? "VALUE");
}

const docx = await fillTemplate(env, request, complete);
check("filling the template produces a document", docx instanceof Uint8Array && docx.length > 100_000,
  `${docx.length} bytes`);

const xml = await readDocumentXml(docx);
check("no placeholder survives into the finished lease", !xml.includes("{{"));
check("the tenant's name reaches the document", xml.includes(application.name));

// A name with XML metacharacters must not be able to close the run it sits in.
const risky = await fillTemplate(env, request, { ...complete, "tenant.names": 'Smith & Jones <Co>' });
const riskyXml = await readDocumentXml(risky);
check("an ampersand and angle brackets are escaped, not injected",
  riskyXml.includes("Smith &amp; Jones &lt;Co&gt;") && !riskyXml.includes("Smith & Jones <Co>"));

// The registry and the template must still agree, or a lease prints "{{...}}".
const placeholders = new Set([...xml.matchAll(/\{\{([a-z0-9_.]+)\}\}/g)].map((m) => m[1]));
check("the template asks for nothing the registry has not defined", placeholders.size === 0);

// ---------------------------------------------------------------- reporting

console.log(`PASS ${passed.length}`);
for (const name of passed) console.log(`  ok   ${name}`);
if (failed.length > 0) {
  console.log(`\nFAIL ${failed.length}`);
  for (const name of failed) console.log(`  FAIL ${name}`);
  process.exit(1);
}

async function readDocumentXml(bytes) {
  const { readEntries, readEntryText } = await import("../../worker/zip.js");
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return readEntryText(readEntries(buffer), "word/document.xml");
}
