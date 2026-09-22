// One address format for listing previews and persisted listing copies.
export function propertyAddress(property) {
  if (!property) return "";
  return [property.street, property.city, [property.state_abbr || property.state, property.zip].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");
}
