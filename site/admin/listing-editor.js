import { propertyAddress } from "../shared/property-address.js";

// Presentation only. Property scope and inherited values are enforced by the API.
export function syncListingKind(form, editing = false) {
  const commercial = form.elements.category.value === "commercial";
  const rental = form.elements.transaction_type.value === "rental";
  for (const [name, visible] of [["use_type", commercial], ["bedrooms", !commercial], ["term_label", rental]]) {
    form.elements[name].parentElement.hidden = !visible;
  }
  form.querySelector("#listing-price-label").textContent = rental ? "Monthly rent (USD / month)" : "Asking price (USD)";
  form.elements.property_type.placeholder = commercial ? "Retail, Office, Mixed use" : "Apartment, Condo, House";
  const types = commercial ? ["Retail", "Office", "Mixed use", "Industrial", "Land"] : ["Apartment", "Condo", "Co-op", "House", "Townhouse", "Multi-family"];
  form.querySelector("#listing-property-types").innerHTML = types.map(type => `<option value="${type}"></option>`).join("");
  form.elements.term_label.placeholder = commercial ? "e.g. 5 years" : "e.g. 12 months";
  const published = form.elements.published.checked;
  form.querySelector("#listing-publish-hint").textContent = published
    ? "Saving makes this listing visible on the website."
    : "Saved as a draft. Only staff with access to this property can see it.";
  form.querySelector("#save").textContent = published ? (editing ? "Save & publish" : "Publish listing") : "Save draft";
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
    ? "This property has no address yet. Add it in Properties & settings before publishing."
    : "To correct this address, update Properties & settings.";
}
