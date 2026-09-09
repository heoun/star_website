const LISTING_COLUMNS = [
  "id",
  "category",
  "transaction_type",
  "title",
  "property_name",
  "unit",
  "description",
  "price_amount",
  "price_display",
  "property_type",
  "use_type",
  "size",
  "term_label",
  "location",
  "neighborhood",
  "bedrooms",
  "bathrooms",
  "video_url",
  "details_url",
  "kind_label",
  "published",
  "position",
  "building_id",
  "created_at"
].join(",");

const MEDIA_COLUMNS = "id,listing_id,kind,path,caption,position";

export function requireConfig(env) {
  const url = (env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) {
    throw new Error("Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return { url, key };
}

async function restRequest(env, path, init = {}) {
  const { url, key } = requireConfig(env);
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...init.headers
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase ${init.method || "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }

  return response;
}

export async function fetchListings(env, { publishedOnly = true, propertyIds } = {}) {
  if (propertyIds && !propertyIds.length) return [];
  const filters = [
    `select=${LISTING_COLUMNS},listing_media(${MEDIA_COLUMNS})`,
    "order=position.asc,created_at.desc",
    "listing_media.order=kind.asc,position.asc"
  ];
  if (publishedOnly) filters.push("published=eq.true");
  if (propertyIds) filters.push(`building_id=in.(${propertyIds.map(encodeURIComponent).join(",")})`);

  const response = await restRequest(env, `listings?${filters.join("&")}`);
  return response.json();
}

export async function fetchListing(env, id, { publishedOnly = true } = {}) {
  const filters = [
    `select=${LISTING_COLUMNS},listing_media(${MEDIA_COLUMNS})`,
    `id=eq.${encodeURIComponent(id)}`,
    "listing_media.order=kind.asc,position.asc"
  ];
  if (publishedOnly) filters.push("published=eq.true");

  const response = await restRequest(env, `listings?${filters.join("&")}`);
  const [row] = await response.json();
  return row || null;
}

export async function insertListing(env, values) {
  const response = await restRequest(env, "listings", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function updateListing(env, id, values) {
  const response = await restRequest(env, `listings?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function deleteListing(env, id) {
  await restRequest(env, `listings?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function insertMedia(env, values) {
  const response = await restRequest(env, "listing_media", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function updateMedia(env, id, values) {
  const response = await restRequest(env, `listing_media?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function fetchMediaRow(env, id) {
  const response = await restRequest(
    env,
    `listing_media?id=eq.${encodeURIComponent(id)}&select=${MEDIA_COLUMNS}`
  );
  const [row] = await response.json();
  return row || null;
}

export async function deleteMediaRow(env, id) {
  await restRequest(env, `listing_media?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ssn_encrypted is deliberately excluded: the ciphertext only leaves the
// database through fetchApplicationSsn for the admin reveal endpoint.
const APPLICATION_COLUMNS =
  "id,listing_id,name,first_name,last_name,email,phone,current_address,move_in," +
  "lease_term_months,dob,ssn_last4,children_under_11,income_note," +
  "current_employer,employment_history,rental_history,reference_contacts," +
  "emergency_contacts,pets,message,status,notes,created_at,updated_at";

// These columns arrived with the branched application form: whether the
// applicant works or studies, which kind of identity number they gave, the
// school record a student fills in instead of an employer, the window guard
// request, and the roommates who will sign alongside. On a database that has
// not run supabase/schema.sql they are left out together — the portal and
// console then treat every application the way they treated all of them
// before the branch existed.
const APPLICATION_WORK_OR_SCHOOL =
  "employment_status,id_type,student,wants_window_guards,roommates";
let workOrSchoolColumns = true;

// What PostgREST said, without the request in front of it. The request names
// every column it asked for, so a match on the whole message would blame
// whichever column happened to be in the select, not the one that is missing.
function errorBody(error) {
  const message = String(error && error.message);
  const at = message.indexOf(" failed: ");
  return at === -1 ? message : message.slice(at + 9).replace(/^\d{3}\s*/, "");
}

function namesWorkOrSchool(error) {
  return /\bemployment_status\b|\bid_type\b|\bstudent\b|\bwants_window_guards\b|\broommates\b/i
    .test(errorBody(error));
}

// What the leasing team asked the applicant for lives in the workspace column
// the back office writes. The portal reads it so "More information needed"
// can say what; a database without the column lists applications as before.
let workspaceColumn = true;

function namesWorkspace(error) {
  return /\bworkspace\b/i.test(errorBody(error));
}

// Two columns arrived after some databases were created: `submitted`, which is
// what the applicant wrote before an agent corrected it, and `concession_terms`,
// which is the rent concession rider. Asking PostgREST for a column that is not
// there fails the whole request, so the first failure is remembered and every
// later read leaves them out. A database that has not had supabase/schema.sql
// run on it still lists its applications; correcting one is refused with a
// message naming the SQL to run, rather than quietly losing the original.
const APPLICATION_CORRECTIONS = "submitted,concession_terms";
let correctionColumns = true;

// Remembered separately: a database can have concession_terms and not yet have
// submitted, and losing the rider's text over a column the rider does not use
// would be a strange way to fail.
let concessionColumn = true;

// Who moved an application to the status it is on, when, and why. It arrived
// with the decision panel, so it degrades the same way — a database that has
// not had supabase/schema.sql run on it still lists its applications and still
// takes a decision; it just cannot say afterwards who made it.
const APPLICATION_DECISION = "decision";
let decisionColumn = true;

export function recordsDecisions() {
  return decisionColumn;
}

function namesDecision(error) {
  return /\bdecision\b/i.test(String(error && error.message));
}

// The values a lease was generated from, frozen when it went out. Its own flag
// rather than sharing `decision`'s: a database that has one and not the other
// should lose only the one it is missing.
const APPLICATION_SNAPSHOT = "lease_snapshot";
let snapshotColumn = true;

export function keepsLeaseSnapshots() {
  return snapshotColumn;
}

function namesSnapshot(error) {
  return /\blease_snapshot\b/i.test(String(error && error.message));
}

export function keepsSubmitted() {
  return correctionColumns;
}

// The documents table arrived with the applicant portal. A database that has
// not run supabase/schema.sql since still lists its applications — just with
// no document checklist on them — the same way the correction columns degrade.
let documentsTable = true;

const APPLICATION_DOCUMENTS_SELECT =
  "application_documents(id,doc_type,file_name,content_type,size_bytes,uploaded_by,created_at)";

function missingColumn(error) {
  return /42703|does not exist/i.test(String(error && error.message));
}

// A write names a missing column differently from a read. A select gets
// PostgreSQL's own 42703 "column applications.decision does not exist"; an
// insert or update gets PostgREST's PGRST204, "Could not find the 'decision'
// column of 'applications' in the schema cache", which says nothing about
// existing. Reading only the first shape made the write path refuse instead of
// degrading, which is the whole point of these flags.
function missingWriteColumn(error) {
  return missingColumn(error) || /PGRST204|Could not find the '/i.test(String(error && error.message));
}

// PostgREST answers a select that embeds an unknown table with PGRST200
// ("could not find a relationship"), not with a column error.
function missingDocumentsTable(error) {
  return /PGRST200|relationship|42P01/i.test(String(error && error.message));
}

async function selectApplications(env, filter) {
  const parts = [APPLICATION_COLUMNS];
  if (workOrSchoolColumns) parts.push(APPLICATION_WORK_OR_SCHOOL);
  if (correctionColumns) parts.push(APPLICATION_CORRECTIONS);
  if (decisionColumn) parts.push(APPLICATION_DECISION);
  if (snapshotColumn) parts.push(APPLICATION_SNAPSHOT);
  if (documentsTable) parts.push(APPLICATION_DOCUMENTS_SELECT);
  const order = documentsTable ? "&application_documents.order=created_at.asc" : "";

  try {
    return await restRequest(env, `applications?select=${parts.join(",")}${filter}${order}`);
  } catch (error) {
    let degraded = false;
    if (documentsTable && missingDocumentsTable(error)) {
      documentsTable = false;
      degraded = true;
    } else if (workOrSchoolColumns && missingColumn(error) && namesWorkOrSchool(error)) {
      workOrSchoolColumns = false;
      degraded = true;
    } else if (snapshotColumn && missingColumn(error) && namesSnapshot(error)) {
      snapshotColumn = false;
      degraded = true;
    } else if (decisionColumn && missingColumn(error) && namesDecision(error)) {
      // Named explicitly rather than lumped in below. A database can have
      // `submitted` and not `decision`, and turning both off over one missing
      // column would throw away the record of what the applicant wrote.
      decisionColumn = false;
      degraded = true;
    } else if (correctionColumns && missingColumn(error)) {
      correctionColumns = false;
      degraded = true;
    }
    if (!degraded) throw error;
    return selectApplications(env, filter);
  }
}

export async function insertApplication(env, values) {
  const response = await restRequest(env, "applications", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function fetchApplications(env, { listingIds } = {}) {
  if (listingIds && !listingIds.length) return [];
  // price_amount comes with the row because the leases list states the rent,
  // and asking for it per row would be one request per lease to show a column.
  const response = await selectApplications(
    env, ",listings(id,title,property_name,unit,price_amount)&order=created_at.desc"
      + (listingIds ? `&listing_id=in.(${listingIds.map(encodeURIComponent).join(",")})` : ""));
  return response.json();
}

export async function fetchApplication(env, id) {
  const response = await selectApplications(env, `&id=eq.${encodeURIComponent(id)}`);
  const [row] = await response.json();
  return row ?? null;
}

export async function updateApplication(env, id, values, { version } = {}) {
  const send = async (body) => {
    const response = await restRequest(env, `applications?id=eq.${encodeURIComponent(id)}${version === undefined ? "" : `&workspace_version=eq.${Number(version)}`}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body)
    });
    const [row] = await response.json();
    return row;
  };

  const WORK_OR_SCHOOL_KEYS =
    ["employment_status", "id_type", "student", "wants_window_guards", "roommates"];

  const known = { ...values };
  if (!decisionColumn) delete known.decision;
  if (!snapshotColumn) delete known.lease_snapshot;
  if (!workOrSchoolColumns) for (const key of WORK_OR_SCHOOL_KEYS) delete known[key];

  try {
    return await send(known);
  } catch (error) {
    if (!missingWriteColumn(error)) throw error;

    // The correction is the point; the note of who made it, the copy of what
    // the lease said, and the branched-form answers are not worth refusing it
    // over on a database that has not been migrated yet. Flip the one flag
    // the error names and go again — each retry strips one more group, so
    // this ends.
    if (decisionColumn && namesDecision(error)) decisionColumn = false;
    else if (snapshotColumn && namesSnapshot(error)) snapshotColumn = false;
    else if (workOrSchoolColumns && namesWorkOrSchool(error)) workOrSchoolColumns = false;
    else throw error;
    return updateApplication(env, id, values, { version });
  }
}

export async function deleteApplication(env, id) {
  await restRequest(env, `applications?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchApplicationSsn(env, id) {
  // `id_type` says whether the ciphertext holds an SSN or a passport number,
  // which decides how the reveal formats it — behind the same degrade flag
  // as every other read of the work-or-school columns.
  const columns = workOrSchoolColumns ? "id,ssn_encrypted,id_type" : "id,ssn_encrypted";
  let response;
  try {
    response = await restRequest(
      env,
      `applications?id=eq.${encodeURIComponent(id)}&select=${columns}`
    );
  } catch (error) {
    if (!workOrSchoolColumns || !missingColumn(error) || !namesWorkOrSchool(error)) throw error;
    workOrSchoolColumns = false;
    return fetchApplicationSsn(env, id);
  }
  const [row] = await response.json();
  return row ?? null;
}

// ------------------------------------------------------- the applicant portal

// Everything the portal shows, and nothing it must not: no screening notes,
// no SSN digits, no income detail. The email match is case-insensitive
// (ilike with the pattern characters escaped), then checked exactly here,
// because "_" in an address would otherwise be a single-character wildcard
// to the database.
const PORTAL_APPLICATION_COLUMNS =
  "id,name,email,status,created_at,move_in,lease_term_months," +
  "listings(title,property_name,unit,location)," +
  "application_documents(id,doc_type,file_name,content_type,size_bytes,created_at)";

function escapeLikePattern(value) {
  return value.replace(/([\\%_*])/g, "\\$1");
}

// `employment_status` decides which document checklist the applicant sees, so
// the portal reads it — behind the same degrade flag as the console, because
// both are asking the same database.
export async function fetchApplicationsByEmail(env, email) {
  const columns = [PORTAL_APPLICATION_COLUMNS, workOrSchoolColumns && "employment_status", workspaceColumn && "workspace"]
    .filter(Boolean).join(",");
  let response;
  try {
    response = await restRequest(
      env,
      `applications?select=${columns}` +
      `&email=ilike.${encodeURIComponent(escapeLikePattern(email))}` +
      "&order=created_at.desc&application_documents.order=created_at.asc"
    );
  } catch (error) {
    if (missingColumn(error) && workOrSchoolColumns && namesWorkOrSchool(error)) {
      workOrSchoolColumns = false;
      return fetchApplicationsByEmail(env, email);
    }
    if (missingColumn(error) && workspaceColumn && namesWorkspace(error)) {
      workspaceColumn = false;
      return fetchApplicationsByEmail(env, email);
    }
    throw error;
  }
  const rows = await response.json();
  return rows.filter((row) => String(row.email || "").trim().toLowerCase() === email);
}

// One application, with only what the portal's upload path needs: whose it
// is, which checklist applies, and enough of the listing to name it in the
// completion notice.
export async function fetchPortalApplication(env, id) {
  const columns = workOrSchoolColumns
    ? "id,name,email,status,employment_status,listings(title,property_name,unit)"
    : "id,name,email,status,listings(title,property_name,unit)";
  let response;
  try {
    response = await restRequest(
      env,
      `applications?id=eq.${encodeURIComponent(id)}&select=${columns}`
    );
  } catch (error) {
    if (!workOrSchoolColumns || !missingColumn(error) || !namesWorkOrSchool(error)) throw error;
    workOrSchoolColumns = false;
    return fetchPortalApplication(env, id);
  }
  const [row] = await response.json();
  return row || null;
}

const DOCUMENT_COLUMNS =
  "id,application_id,doc_type,path,file_name,content_type,size_bytes,uploaded_by,created_at";

export async function insertApplicationDocument(env, values) {
  const response = await restRequest(env, "application_documents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function fetchDocumentsForApplication(env, applicationId) {
  const response = await restRequest(
    env,
    `application_documents?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&select=${DOCUMENT_COLUMNS}&order=created_at.asc`
  );
  return response.json();
}

// The owning application's email rides along: it is how the portal decides
// whether the session asking for a document may have it.
export async function fetchApplicationDocument(env, id) {
  const response = await restRequest(
    env,
    `application_documents?id=eq.${encodeURIComponent(id)}` +
    `&select=${DOCUMENT_COLUMNS},applications(email)`
  );
  const [row] = await response.json();
  return row || null;
}

export async function deleteApplicationDocument(env, id) {
  await restRequest(env, `application_documents?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export function mediaUrl(path) {
  return path ? `/media/${path}` : "";
}

const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

function formatPrice(row) {
  if (row.price_display) return row.price_display;
  if (row.price_amount === null || row.price_amount === undefined) return "";

  const amount = Number(row.price_amount);
  if (!Number.isFinite(amount)) return "";

  const formatted = priceFormatter.format(amount);
  return row.transaction_type === "rental" ? `${formatted}/mo` : formatted;
}

function numberToText(value) {
  if (value === null || value === undefined || value === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : "";
}

function sortedPhotos(row) {
  return (row.listing_media || [])
    .filter((media) => media.kind === "photo")
    .sort((a, b) => a.position - b.position);
}

// Shapes a database row into the JSON the listing pages already consume, so the
// frontend contract stays unchanged. The cover image is the first photo.
export function toFeedListing(row) {
  const cover = sortedPhotos(row)[0];

  return {
    id: row.id,
    category: row.category,
    transaction_group: row.transaction_type,
    status: row.transaction_type === "rental" ? "For Rent" : "For Sale",
    title: row.title || "",
    price: formatPrice(row),
    property_type: row.property_type || "",
    use_type: row.use_type || "",
    size: row.size || "",
    term_label: row.term_label || "",
    location: row.location || "",
    neighborhood: row.neighborhood || "",
    bedrooms: numberToText(row.bedrooms),
    bathroom: numberToText(row.bathrooms),
    details_url: row.details_url || "",
    kind_label: row.kind_label || "",
    image_label: cover?.caption || "",
    image_url: mediaUrl(cover?.path)
  };
}

// Everything a property detail page needs: the feed fields plus the copy and
// media the cards have no room for.
export function toDetailListing(row) {
  const plan = (row.listing_media || []).find((item) => item.kind === "floor_plan");

  return {
    ...toFeedListing(row),
    property_name: row.property_name || "",
    unit: row.unit || "",
    description: row.description || "",
    video_url: row.video_url || "",
    photos: sortedPhotos(row).map((photo) => ({
      url: mediaUrl(photo.path),
      caption: photo.caption || ""
    })),
    floor_plan: plan ? { url: mediaUrl(plan.path), caption: plan.caption || "Floor plan" } : null
  };
}

// Admin representation: full row plus ready-to-use URLs for every media item.
export function toAdminListing(row) {
  const media = (row.listing_media || [])
    .sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind.localeCompare(b.kind)))
    .map((item) => ({ ...item, url: mediaUrl(item.path) }));

  return { ...row, listing_media: media };
}

// ---------------------------------------------------------------- leases

const BUILDING_BASE = "id,name,street,city,state,state_abbr,zip,created_at,updated_at";

// Where the landlord's signature request is sent. It arrived with the property
// setup screen, so it degrades the way the application columns do: a database
// that has not had supabase/schema.sql run on it still lists its buildings and
// still generates leases — it just cannot record a signer address, and the
// screen says so rather than failing.
let signerEmailColumn = true;

export function keepsSignerEmail() {
  return signerEmailColumn;
}

function namesSignerEmail(error) {
  return /\blandlord_signer_email\b/i.test(String(error && error.message));
}

function buildingColumns() {
  return signerEmailColumn ? `${BUILDING_BASE},landlord_signer_email` : BUILDING_BASE;
}

async function selectBuildings(env, filter, includeIntake = true) {
  try {
    return await restRequest(env, `buildings?select=${buildingColumns()}${includeIntake ? ",declared_units" : ""}${filter}`);
  } catch (error) {
    // Optional display metadata; older properties remain readable before intake is enabled.
    if (includeIntake && missingColumn(error) && /\bdeclared_units\b/i.test(String(error.message))) return selectBuildings(env, filter, false);
    if (!signerEmailColumn || !missingColumn(error) || !namesSignerEmail(error)) throw error;
    signerEmailColumn = false;
    return selectBuildings(env, filter, includeIntake);
  }
}

export async function fetchBuildings(env, { propertyIds } = {}) {
  if (propertyIds && !propertyIds.length) return [];
  const scope = propertyIds ? `&id=${encodeURIComponent(`in.(${propertyIds.join(",")})`)}` : "";
  const response = await selectBuildings(env, `&order=name.asc${scope}`);
  return response.json();
}

export async function fetchBuilding(env, id) {
  const response = await selectBuildings(env, `&id=eq.${encodeURIComponent(id)}`);
  const [row] = await response.json();
  return row || null;
}

export async function insertBuilding(env, values) {
  const response = await restRequest(env, "buildings", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row;
}

export async function updateBuilding(env, id, values) {
  const send = async (body) => {
    const response = await restRequest(env, `buildings?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body)
    });
    const [row] = await response.json();
    return row;
  };

  if (!("landlord_signer_email" in values)) return send(values);

  const without = () => {
    const { landlord_signer_email: dropped, ...rest } = values;
    // Nothing left to write is not an error: the row is returned unchanged.
    return Object.keys(rest).length === 0 ? fetchBuilding(env, id) : send(rest);
  };

  // Already known to be absent — from the select this session, which runs
  // first on every screen that offers the field. Trying anyway would fail, and
  // the catch below only forgives the first failure.
  if (!signerEmailColumn) return without();

  try {
    return await send(values);
  } catch (error) {
    if (!missingWriteColumn(error) || !namesSignerEmail(error)) throw error;
    // Refusing the whole save would lose an address change over a column the
    // address does not use. The screen reports the signer as unrecordable
    // afterwards, which is true of this database.
    signerEmailColumn = false;
    return without();
  }
}

// One application with everything a lease needs from its listing: the address
// line the parts are read from, the rent, the unit, and the building whose
// settings layer applies.
export async function fetchApplicationForLease(env, id) {
  // The rider's text is a deal value, so it has to arrive with the rest of the
  // application or the Rent Concession Rider prints blank however carefully it
  // was written — and the window guard request the same, or the notice's third
  // checkbox prints unticked whatever the applicant asked for. Named
  // explicitly rather than selected with * because the encrypted SSN lives on
  // this row and a lease has no business reading it.
  const base = "id,listing_id,name,email,phone,move_in,lease_term_months," +
    "children_under_11,status," +
    "listings(id,title,property_name,unit,location,price_amount,building_id,created_at)";
  const select = (columns) =>
    restRequest(env, `applications?id=eq.${encodeURIComponent(id)}&select=${columns}`);

  const parts = [base];
  if (concessionColumn) parts.push("concession_terms");
  if (workOrSchoolColumns) parts.push("wants_window_guards");

  let response;
  try {
    response = await select(parts.join(","));
  } catch (error) {
    if (!missingColumn(error)) throw error;
    if (concessionColumn && /\bconcession_terms\b/i.test(String(error && error.message))) {
      concessionColumn = false;
    } else if (workOrSchoolColumns && namesWorkOrSchool(error)) {
      workOrSchoolColumns = false;
    } else {
      throw error;
    }
    return fetchApplicationForLease(env, id);
  }

  const [row] = await response.json();
  return row || null;
}

// One settings layer, or null when that layer has never been saved. An absent
// row and an empty row mean the same thing: this layer answers nothing.
export async function fetchLeaseSettingsLayer(env, { scope, buildingId = null, listingId = null }) {
  const filters = [`select=id,scope,building_id,listing_id,field_values,updated_at`, `scope=eq.${scope}`];
  filters.push(buildingId ? `building_id=eq.${encodeURIComponent(buildingId)}` : "building_id=is.null");
  filters.push(listingId ? `listing_id=eq.${encodeURIComponent(listingId)}` : "listing_id=is.null");

  const response = await restRequest(env, `lease_settings?${filters.join("&")}`);
  const [row] = await response.json();
  return row || null;
}

async function callRpc(env, name, args) {
  const response = await restRequest(env, `rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(args)
  });
  return response.json();
}

// The three layers that apply to one unit, unmerged. The caller merges them,
// because it also has to report which layer answered each field.
export async function fetchLeaseLayers(env, listingId) {
  return callRpc(env, "lease_settings_for_listing", { p_listing_id: listingId });
}

// PostgREST can only set a column to a literal, so saving part of a layer
// without overwriting the rest goes through a function. A null in the patch
// means "this layer no longer answers that field".
export async function applyLeaseSettings(env, { scope, buildingId = null, listingId = null, patch, actor }) {
  return callRpc(env, "lease_settings_apply", {
    p_scope: scope,
    p_building_id: buildingId,
    p_listing_id: listingId,
    p_patch: patch,
    p_actor: actor || null
  });
}

// ------------------------------------------------------- the admin's own accounts

// A table that is not there yet is a deploy that ran ahead of its migration —
// an operational state to report, not a permission to decide. Told apart from
// a genuine refusal so nobody reads "run the SQL" as "you are not allowed".
export function isMissingTable(error) {
  const message = String(error && error.message);
  // PGRST205 is the missing-table code specifically. "does not exist" on its
  // own also matches PGRST204's missing-COLUMN message, which would send an
  // operator to re-run a migration that is already applied.
  return /PGRST205|Could not find the table|relation .* does not exist/i.test(message);
}

// Includes optional property_ids after the back-office migration. Older staff
// tables remain readable so an admin can still sign in before migration.
const STAFF_COLUMNS = "*";

export async function fetchStaffMember(env, email) {
  const response = await restRequest(
    env,
    `staff?select=${STAFF_COLUMNS}&email=eq.${encodeURIComponent(email)}`
  );
  const [row] = await response.json();
  return row ?? null;
}

export async function fetchStaff(env) {
  const response = await restRequest(
    env, `staff?select=${STAFF_COLUMNS}&order=role.asc,email.asc`);
  return response.json();
}

// One row per email, so re-adding somebody who left restores them rather than
// failing on the primary key.
export async function upsertStaffMember(env, values) {
  const response = await restRequest(env, "staff?on_conflict=email", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(values)
  });
  const [row] = await response.json();
  return row ?? null;
}

export async function deleteStaffMember(env, email) {
  await restRequest(env, `staff?email=eq.${encodeURIComponent(email)}`, { method: "DELETE" });
}
