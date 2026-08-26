// Which lease values the application row owns.
//
// The registry already says where every deal value comes from — `"from":
// "applications.move_in"` — so the map is read off that rather than written
// down a second time. Both admin screens and the Worker import this one
// function, which is what lets a correction made on either screen be the same
// correction: the overview edits the application row directly, the lease
// screen writes the same column through PATCH /applications/:id, and the next
// lease generated reads it back through dealValues().
//
// Only an exact `applications.<column>` matches. That is deliberate:
// `lease.end_date` is "computed: move_in + lease_term_months - 1 day" and
// `window_guard.mark_no_children` is "NOT applications.children_under_11".
// Neither owns a column, and a derived value with two owners is a value that
// ends up disagreeing with itself.

const COLUMN = /^applications\.([a-z0-9_]+)$/;

// The columns that exist and that an agent may correct. Keep this in step
// with the fields worker/apply.js accepts a correction for.
const WRITABLE = new Set([
  "name", "email", "phone", "move_in", "lease_term_months", "dob",
  "current_address", "household_size", "income_note", "children_under_11",
  "wants_window_guards", "message", "concession_terms"
]);

export function applicationColumns(fields) {
  const columns = {};
  for (const field of fields || []) {
    if (field.source !== "deal") continue;
    const found = COLUMN.exec(field.from || "");
    if (found && WRITABLE.has(found[1])) columns[field.id] = found[1];
  }
  return columns;
}

// The window guard notice asks one question with two check boxes. Ticking
// either one answers it, so both write the same column — the second inverted.
export const INVERTED_FIELD = "window_guard.mark_no_children";

// Where one lease value goes on the application row, if it goes anywhere.
//
// Every screen that lets someone correct a tenant value calls this, so the
// inversion above is written down once. Two screens each deciding for
// themselves is how "no child under 11" ends up saved as "yes".
export function applicationWrite(fields, fieldId, value) {
  if (fieldId === INVERTED_FIELD) return { column: "children_under_11", value: !value };
  const column = applicationColumns(fields)[fieldId];
  return column ? { column, value } : null;
}
