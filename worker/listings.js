import { fetchListing, fetchListings, toDetailListing, toFeedListing } from "./supabase.js";

const FEED_PATH = "/data/listings.json";
const DETAIL_PATH = "/data/property.json";
const CACHE_SECONDS = 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A fixed key so query strings (the pages fetch with cache-busting params)
// cannot fragment or bypass the cache.
function cacheKey(request) {
  return new Request(new URL(FEED_PATH, request.url).toString(), { method: "GET" });
}

function jsonResponse(payload, cacheSeconds) {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheSeconds > 0 ? `public, s-maxage=${cacheSeconds}` : "no-store"
    }
  });
}

// Falls back to the copy bundled with the deployment so the site keeps
// rendering listings even while Supabase is unreachable.
async function bundledFallback(request, env) {
  const response = await env.ASSETS.fetch(new Request(new URL(FEED_PATH, request.url).toString()));
  if (!response.ok) {
    return jsonResponse({ synced_at: new Date().toISOString(), source: "unavailable", listings: [] }, 0);
  }

  const payload = await response.json();
  return jsonResponse({ ...payload, source: "fallback" }, 0);
}

export async function serveListingsFeed(request, env, ctx) {
  const cache = caches.default;
  const key = cacheKey(request);

  const cached = await cache.match(key);
  if (cached) return cached;

  let response;
  try {
    const rows = await fetchListings(env, { publishedOnly: true });
    response = jsonResponse(
      {
        synced_at: new Date().toISOString(),
        source: "supabase",
        listings: rows.map(toFeedListing)
      },
      CACHE_SECONDS
    );
    ctx.waitUntil(cache.put(key, response.clone()));
  } catch (error) {
    console.error("Listings feed failed, serving bundled fallback", error);
    response = await bundledFallback(request, env);
  }

  return response;
}

function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function detailKey(request, id) {
  const url = new URL(DETAIL_PATH, request.url);
  url.searchParams.set("id", id);
  return new Request(url.toString(), { method: "GET" });
}

export async function servePropertyDetail(request, env, ctx) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!UUID_PATTERN.test(id)) {
    return errorResponse("Unknown property.", 400);
  }

  const cache = caches.default;
  const key = detailKey(request, id);

  const cached = await cache.match(key);
  if (cached) return cached;

  let row;
  try {
    row = await fetchListing(env, id, { publishedOnly: true });
  } catch (error) {
    console.error("Property detail lookup failed", error);
    return errorResponse("Listings are temporarily unavailable.", 503);
  }

  if (!row) {
    return errorResponse("This property is no longer listed.", 404);
  }

  const response = jsonResponse(toDetailListing(row), CACHE_SECONDS);
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

// Cache entries are per-location, so this clears the colo that handled the
// write; everywhere else expires within CACHE_SECONDS.
export async function purgeListingsCache(request, id) {
  const cache = caches.default;
  await cache.delete(cacheKey(request));
  if (id) await cache.delete(detailKey(request, id));
}
