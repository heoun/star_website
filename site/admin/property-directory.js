import {esc as escapeHtml} from "./admin-ui.js";

export function propertyDirectoryRow({building, entity, signer, ready, count=null, note="", action="Manage"}) {
  return `<a class="prop-row" href="#/properties/${escapeHtml(building.id)}">
        <span class="prop-identity">
          <b class="property-list-name">${escapeHtml(building.name)}</b>
          <small>${escapeHtml([building.street, building.city, building.state_abbr, building.zip]
            .filter(Boolean).join(", ")) || "No address recorded"}</small>
          ${count == null ? "" : `<span class="prop-listing-count">${count} linked listing${count === 1 ? "" : "s"}</span>`}
          ${note ? `<span class="prop-listing-count">${escapeHtml(note)}</span>` : ""}
        </span>
        <span class="prop-landlord">
          <span class="prop-mobile-caption">Landlord</span>
          <span class="prop-entity">${entity.answered ? escapeHtml(entity.value) : '<span class="soft">Entity not set</span>'}</span>
          <small><span class="prop-signer-label">Signer</span> · ${signer.answered
            ? escapeHtml(signer.value)
            : '<span class="prop-need">Not set</span>'}</small>
        </span>
        <span class="prop-readiness"><span class="prop-mobile-caption">Lease status</span><span class="pill is-${ready.state === "ready" ? "good" : ready.state === "one" ? "warn" : "bad"}">${
          escapeHtml(ready.label)}</span></span>
        <span class="prop-go">${escapeHtml(action)} <span aria-hidden="true">↗</span></span>
      </a>`;
}

export function propertyDirectory(rows) {
  return `<div class="rows prop-directory"><div class="prop-row is-head" aria-hidden="true"><span>Property</span><span>Landlord</span><span>Lease status</span><span></span></div>${rows}</div>`;
}
