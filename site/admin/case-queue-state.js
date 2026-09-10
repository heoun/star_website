// Filters only the cases already scoped by the API; this is not an access check.
export const PIPELINE = [
  { key: "review", label: "Reviewing", statuses: ["new", "contacted", "fee_pending", "screening", "review", "needs_info"] },
  { key: "approved", label: "Approved", statuses: ["approved"] },
  { key: "landlord", label: "With the Landlord", statuses: ["sent_to_landlord"] },
  { key: "lease", label: "Lease", statuses: ["landlord_approved"] },
  { key: "signing", label: "Signing", statuses: ["lease_sent"] },
  { key: "closed", label: "Closed", statuses: ["lease_signed", "declined"] }
];
export function selectQueueCases(cases, view, session) {
  const query = String(view.query || "").trim().toLowerCase();
  const since = row => Date.parse(row.next_step?.since || row.updated_at || row.created_at || "") || 0;
  const rank = row => ["declined", "lease_signed"].includes(row.status) ? 3
    : session.role === "manager" && !row.responsible_email ? 0
      : row.next_step?.bucket === "attention" ? 1 : 2;
  return cases.filter(row => {
    if (view.bucket !== "all" && row.next_step?.bucket !== view.bucket) return false;
    if (view.stage && !PIPELINE.find(p => p.key === view.stage)?.statuses.includes(row.status)) return false;
    if (view.person === "unassigned" && row.responsible_email) return false;
    if (view.person === "lead" && row.responsible_email !== session.email) return false;
    if (view.person === "collaborating" && (row.responsible_email === session.email || !(row.collaborator_emails || []).includes(session.email))) return false;
    if (view.person && !["unassigned", "lead", "collaborating"].includes(view.person) && row.responsible_email !== view.person) return false;
    return !query || [row.name, row.email, row.listings?.title, row.listings?.property_name, row.listings?.unit, row.responsible_email]
      .filter(Boolean).join(" ").toLowerCase().includes(query);
  }).sort((a,b) => (view.bucket === "all" ? rank(a)-rank(b) : 0) || since(a)-since(b) || String(a.id).localeCompare(String(b.id)));
}
