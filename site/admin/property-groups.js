const nameOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export const compareNames = (a, b) => nameOrder.compare(String(a || "").trim(), String(b || "").trim());
export const compareProperties = (a, b) => compareNames(a.name, b.name)
 || String(a.key || a.id || "").localeCompare(String(b.key || b.id || ""));

// Group by the linked property ID; unrelated standalone listings stay separate.
export function propertyGroups(records, listingOf = row => row) {
 const groups=new Map();
 for(const row of records){const listing=listingOf(row) || {},key=listing.building_id || `standalone:${listing.id || row.id}`;
  if(!groups.has(key))groups.set(key,{key,name:listing.property_name || listing.title || 'Property unavailable',rows:[],units:new Map()});
  const group=groups.get(key),unit=String(listing.unit || '').trim(),unitKey=unit || `listing:${listing.id || row.id}`;
  group.rows.push(row);if(!group.units.has(unitKey))group.units.set(unitKey,{name:unit || 'Unit not specified',rows:[]});group.units.get(unitKey).rows.push(row);
 }
 return [...groups.values()].sort(compareProperties);
}
