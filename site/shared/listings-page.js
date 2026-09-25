// Server-rendered grids are final: never clear them or fetch them again on entry.
(async () => {
  const pagePath = document.currentScript.dataset.listingPage;
  if ([...document.querySelectorAll("[data-grid]")].every(grid => grid.dataset.rendered === "true")) return;
  const [{listingCollections}, {listingCollectionMarkup, listingStateMarkup}] = await Promise.all([
    import("./listing-collections.js"), import("./listing-cards.js")
  ]);
  const configs = listingCollections[pagePath] || [];
  try {
    const response = await fetch("/data/listings.json", {cache:"no-store"});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.source === "unavailable") throw new Error("Listings unavailable");
    for (const config of configs) {
      const grid = document.querySelector(config.gridSelector);
      if (grid) grid.innerHTML = listingCollectionMarkup(payload, config, new URLSearchParams(location.search).get("q") || "");
    }
  } catch {
    for (const config of configs) {
      const grid = document.querySelector(config.gridSelector);
      if (grid) grid.innerHTML = listingStateMarkup(config, "error");
    }
  }
})();
