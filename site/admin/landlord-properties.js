import { esc, empty, generation } from "./admin-ui.js";
export async function renderLandlordProperties(host, { api, listings, id }) {
  const current = generation(host);
  const heading = '<div class="pagehead"><div><span class="k">Your portfolio</span><h1>My properties</h1><p>Your registered properties and their marketing listings. Contact your leasing team to update property details.</p></div></div>';
  host.innerHTML = heading + '<p role="status">Loading your properties…</p>';
  try {
    const result = await api(id ? `/buildings/${encodeURIComponent(id)}` : "/buildings");
    if (!current()) return;
    const buildings = id ? [result.building] : result.buildings;
    host.innerHTML = heading + (id ? '<a href="#/properties">← All my properties</a>' : "") + (buildings.length ? `<div class="desk-grid">${buildings.map(b => {
      const units = listings.filter(l => l.building_id === b.id);
      return `<section class="desk-panel desk-panel-body" data-landlord-property="${esc(b.id)}"><span class="k">Registered property</span><h2>${esc(b.name)}</h2><p>${esc([b.street,b.city,b.state_abbr,b.zip].filter(Boolean).join(", "))}</p>${b.declared_units ? `<p>${esc(b.declared_units)} rental units reported</p>` : ""}<h3>Listings</h3>${units.length ? units.map(l => `<a class="admin-shortcut" href="#/listings/${esc(l.id)}"><b>${esc(l.title)}</b><small>${l.published ? "Published on website" : "Not published"}</small><span>→</span></a>`).join("") : '<p class="soft">Your property is registered. The leasing team can add listings when you are ready to market individual units.</p>'}</section>`;
    }).join("")}</div>` : empty("No properties assigned yet", "Approved properties will appear here once your leasing team has completed your onboarding."));
  } catch (error) { if (current()) host.innerHTML = heading + `<p role="alert">${esc(error.message)}</p>`; }
}
