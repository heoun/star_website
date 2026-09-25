// Reading a stored lease value, on any screen that shows one.
//
// A settings layer stores exactly two shapes: a boolean for a check box, and a
// string for everything else. A key that is absent, or present as null, is how
// the database records "this layer does not answer that field" — which is not
// the same as an empty answer, and is the distinction the whole three-layer
// model rests on.

// Does this layer answer this field at all?
//
// For a check box, false is an answer: "no bedbug infestation history" is a
// legal assertion someone made, not a gap. For everything else, an empty
// string is what the Worker writes when a value is cleared, so it is not one.
export function isAnswered(field, value) {
  if (value === undefined || value === null) return false;
  if (field.type === "checkbox") return typeof value === "boolean";
  return String(value).trim() !== "";
}

// What the field says on the page, as close as possible to what it prints.
//
// Currency belongs to the field's format, not to the text somebody typed.
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export function moneyInputValue(value) {
  return String(value ?? "").trim().replace(/^(-?)\$\s*/, "$1");
}

export function formatLeaseMoney(value) {
  const text = moneyInputValue(value);
  if (!text) return "";
  const numeric = text.replace(/,/g, "");
  // Preserve explicit non-numeric answers instead of turning them into $0.
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric)) return String(value).trim();
  const amount = Number(numeric);
  return Number.isFinite(amount) ? dollars.format(amount) : String(value).trim();
}

export function formatLeaseFieldValue(field, value) {
  return field?.type === "money" || field?.id?.startsWith("fine.") ? formatLeaseMoney(value) : value;
}

export function formatSettingValue(field, value) {
  if (field.type === "checkbox") return value === true ? "Marked" : "Not marked";
  if (field.type === "money" || field.id?.startsWith("fine.")) return formatLeaseMoney(value);
  return value === undefined || value === null ? "" : String(value);
}
