// The one-line address, composed from its parts.
//
// Imported by BOTH the Worker that produces the .docx and the admin screen that
// previews it, because they have to agree character for character: the screen
// exists so that what an agent reads is what gets signed, and an address is the
// one value a lease repeats in every rider.
//
// It is derived rather than stored so that correcting a ZIP or a city changes
// every place the address prints. A lease naming the same apartment two
// different ways is a lease somebody has to explain later.

export const ADDRESS_FIELD = "property.address_full";

export const ADDRESS_PARTS = [
  "property.street",
  "property.unit",
  "property.city",
  "property.state",
  "property.state_abbr",
  "property.zip"
];

export function composeAddress(values) {
  const unit = values["property.unit"];
  return [
    [values["property.street"], unit ? `Unit ${unit}` : ""].filter(Boolean).join(", "),
    values["property.city"],
    [values["property.state"] || values["property.state_abbr"], values["property.zip"]]
      .filter(Boolean).join(" ")
  ].filter(Boolean).join(", ");
}
