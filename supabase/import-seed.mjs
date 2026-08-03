#!/usr/bin/env node
// One-off import of the sample data in data/listings.json into Supabase.
// Real listings should be added through /admin/ or supabase/import-folder.mjs;
// this exists so the site has placeholder inventory before real data lands.
//
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   node supabase/import-seed.mjs [--replace]
//
// Without --replace the import refuses to run when the table already has rows.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const replace = process.argv.includes("--replace");

if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.");
  process.exit(1);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json"
};

async function rest(pathname, init = {}) {
  const response = await fetch(`${url}/rest/v1/${pathname}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

function parseAmount(value) {
  // First number group only, so a range like "$2,500 - $3,000" becomes 2500
  // instead of the two numbers concatenated.
  const match = String(value ?? "").match(/\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function parseNumber(value, { integer = false } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return integer ? Math.round(parsed) : parsed;
}

function toRow(listing, index) {
  const status = String(listing.status ?? "").toLowerCase();
  return {
    category: String(listing.category ?? "").toLowerCase().includes("comm") ? "commercial" : "residential",
    transaction_type: status.includes("rent") || status.includes("lease") ? "rental" : "sale",
    title: listing.title || "Untitled listing",
    price_amount: parseAmount(listing.price),
    property_type: listing.property_type || null,
    use_type: listing.use_type || null,
    size: listing.size || null,
    term_label: listing.term_label || null,
    location: listing.location || null,
    neighborhood: listing.neighborhood || null,
    bedrooms: parseNumber(listing.bedrooms, { integer: true }),
    bathrooms: parseNumber(listing.bathroom),
    details_url: listing.details_url || null,
    kind_label: listing.kind_label || null,
    published: true,
    position: index
  };
}

const payload = JSON.parse(await readFile(path.join(root, "data", "listings.json"), "utf8"));
const rows = (payload.listings || []).map(toRow);

if (rows.length === 0) {
  console.error("No listings found in data/listings.json.");
  process.exit(1);
}

const existing = await (await rest("listings?select=id&limit=1")).json();

if (existing.length > 0) {
  if (!replace) {
    console.error("The listings table already has rows. Re-run with --replace to overwrite them.");
    process.exit(1);
  }

  // Deleting rows here would strand their R2 objects with nothing referencing
  // them. Listings that have media must be deleted through /admin/, which
  // cleans up storage as well.
  const withMedia = await (await rest("listing_media?select=id&limit=1")).json();
  if (withMedia.length > 0) {
    console.error("Some listings have uploaded media. Delete them through /admin/ first so their R2 files are cleaned up; --replace only handles media-less rows.");
    process.exit(1);
  }

  await rest("listings?id=not.is.null", { method: "DELETE" });
  console.log("Cleared existing rows.");
}

await rest("listings", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows) });

console.log(`Imported ${rows.length} listings.`);
