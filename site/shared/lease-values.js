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
// Money values are stored with their "$" already in them and dates in the form
// the document uses, so nothing is reformatted here — a value shown in a shape
// the lease does not use is a value somebody will "correct".
export function formatSettingValue(field, value) {
  if (field.type === "checkbox") return value === true ? "Marked" : "Not marked";
  return value === undefined || value === null ? "" : String(value);
}
