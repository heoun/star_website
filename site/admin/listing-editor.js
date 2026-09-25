import { propertyAddress } from "../shared/property-address.js";

// Presentation only. Property scope and inherited values are enforced by the API.
export function syncListingKind(form, editing = false, selectedType = form.elements.property_type.value) {
  const commercial = form.elements.category.value === "commercial";
  const rental = form.elements.transaction_type.value === "rental";
  for (const [name, visible] of [["use_type", commercial], ["bedrooms", !commercial], ["term_label", rental]]) {
    const input = form.elements[name];
    (name === "term_label" ? input.parentElement.parentElement : input.parentElement).hidden = !visible;
  }
  form.querySelector("#listing-price-label").textContent = rental ? "Monthly Rent (USD / Month)" : "Asking Price (USD)";
  const types = commercial ? ["Retail", "Office", "Mixed Use", "Industrial", "Land"] : ["Apartment", "Condo", "Co-op", "House", "Townhouse", "Multi-family"];
  const select = form.elements.property_type;
  select.replaceChildren(new Option("Select Property Type", ""), ...types.map(type => new Option(type, type)));
  if (selectedType && !types.includes(selectedType)) select.add(new Option(selectedType, selectedType));
  select.value = selectedType || "";

  form.querySelector("#listing-publish-hint").textContent = "Save your draft, review the website preview, then publish. The live listing stays unchanged until publication.";
  form.querySelector("#save").textContent = "Save Draft & Review";
}

export function syncListingProperty(form, property, linked) {
  const name = form.elements.property_name;
  name.readOnly = linked;
  if (property) name.value = property.name || "";
  form.querySelector("#listing-property-address").hidden = !linked;
  form.elements.location.parentElement.hidden = linked;
  // Never replace legacy data with blanks just because the property list failed to load.
  if (property) form.elements.location.value = propertyAddress(property);
  for (const [id, value] of [["street", property?.street], ["city", property?.city], ["state", property?.state_abbr || property?.state], ["zip", property?.zip]]) {
    const input = form.querySelector(`#listing-${id}`);
    input.value = value || "";
    input.placeholder = property ? "Not set on property" : "Loading property…";
  }
  form.querySelector("#listing-address-hint").textContent = property && !propertyAddress(property)
    ? "This property has no address yet. Add it in Properties & Settings before publishing."
    : "To correct this address, update Properties & Settings.";
}

// Existing listings store human-readable terms. Preserve unfamiliar legacy text until edited.
export function setListingTerm(input, value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(months?|mos?|years?|yrs?)?$/i);
  input.value = match ? String(Number(match[1]) * (/^(year|yr)/i.test(match[2] || "") ? 12 : 1)) : "";
  input.dataset.originalTerm = text;
  input.dataset.initialMonths = input.value;
}

export function listingTermValue(input) {
  if (input.dataset.originalTerm !== undefined && input.value === input.dataset.initialMonths) return input.dataset.originalTerm;
  return input.value ? `${input.value} months` : "";
}
