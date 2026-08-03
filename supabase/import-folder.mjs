#!/usr/bin/env node
// Imports one marketing folder as a listing: parses the .docx copy, resizes the
// photos, uploads all media to R2 through wrangler, and inserts the rows into
// Supabase. macOS only (uses the built-in textutil and sips tools).
//
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   node supabase/import-folder.mjs "/path/to/Evergarden 7A" [--category residential] [--dry-run]
//
// Expected folder layout (see "Marketing (Website)" for examples):
//   7A.docx        listing copy: price / title / area+address / facts / description
//   *.png *.jpg    photos, captioned from the file name ("Living room.png")
//   5A-7A.png      floor plan (detected by unit-range file names or "plan")
//   7A.mp4         optional video tour

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  captionFromFilename,
  classifyFiles,
  parseFolderName,
  parseListingCopy
} from "../shared/listing-parse.js";

const BUCKET = "listing-media";

// Child processes (wrangler, sips, textutil) have no business seeing the
// database key, so they run with it stripped from their environment.
const SAFE_ENV = { ...process.env };
delete SAFE_ENV.SUPABASE_SERVICE_ROLE_KEY;
delete SAFE_ENV.SUPABASE_URL;
const VIDEO_TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

const args = [];
let dryRun = false;
let category = "residential";

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--category") { category = process.argv[i + 1] || ""; i += 1; }
  else if (arg.startsWith("--")) { console.error(`Unknown flag: ${arg}`); process.exit(1); }
  else args.push(arg);
}

if (!["residential", "commercial"].includes(category)) {
  console.error(`Invalid --category "${category}": use residential or commercial.`);
  process.exit(1);
}

const folder = args[0];
const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!folder) {
  console.error('Usage: node supabase/import-folder.mjs "/path/to/Evergarden 7A" [--category commercial] [--dry-run]');
  process.exit(1);
}

if (!dryRun && (!url || !key)) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or use --dry-run to preview parsing).");
  process.exit(1);
}

// ---- Parse the folder name: "Evergarden 7A" -> building + unit ----

const folderName = path.basename(folder.replace(/\/+$/, ""));
const { building_name: buildingName, unit } = parseFolderName(folderName);

// ---- Parse the .docx copy ----

const entries = readdirSync(folder);
const { document: docx, photos, floorPlan, video } = classifyFiles(entries);

if (!docx) {
  console.error("No .docx file found in the folder.");
  process.exit(1);
}

const scratch = mkdtempSync(path.join(os.tmpdir(), "listing-import-"));
const docText = (() => {
  const out = path.join(scratch, "copy.txt");
  execFileSync("textutil", ["-convert", "txt", "-output", out, path.join(folder, docx)], { env: SAFE_ENV });
  return readFileSync(out, "utf8");
})();

const copy = parseListingCopy(docText);
const title = copy.title || folderName;

console.log("Parsed listing:");
console.log(JSON.stringify({
  category, transaction_type: copy.transaction_type, title,
  building_name: buildingName, unit,
  price_amount: copy.price_amount, property_type: copy.property_type,
  bedrooms: copy.bedrooms, bathrooms: copy.bathrooms,
  neighborhood: copy.neighborhood, location: copy.location,
  description: copy.description ? `${copy.description.slice(0, 60)}…` : null,
  photos: photos.map(captionFromFilename), floor_plan: floorPlan, video
}, null, 2));

if (dryRun) {
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

// ---- Helpers: Supabase REST + R2 upload via wrangler ----

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function rest(pathname, init = {}) {
  const response = await fetch(`${url}/rest/v1/${pathname}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

function uploadToR2(objectKey, filePath, contentType) {
  execFileSync("npx", [
    "--yes", "wrangler@4", "r2", "object", "put", `${BUCKET}/${objectKey}`,
    "--file", filePath, "--content-type", contentType, "--remote"
  ], { stdio: ["ignore", "ignore", "inherit"], env: SAFE_ENV });
}

function resizeImage(sourcePath, maxDimension) {
  const out = path.join(scratch, `${crypto.randomUUID()}.jpg`);
  execFileSync("sips", ["-Z", String(maxDimension), "-s", "format", "jpeg", "-s", "formatOptions", "82", sourcePath, "--out", out], { stdio: "ignore", env: SAFE_ENV });
  return out;
}

// ---- Insert listing, then upload media ----

const listingResponse = await rest("listings", {
  method: "POST",
  headers: { Prefer: "return=representation" },
  body: JSON.stringify({
    category,
    transaction_type: copy.transaction_type,
    title,
    building_name: buildingName,
    unit,
    description: copy.description || null,
    price_amount: copy.price_amount,
    property_type: copy.property_type || null,
    bedrooms: copy.bedrooms,
    bathrooms: copy.bathrooms,
    neighborhood: copy.neighborhood || null,
    location: copy.location || null,
    kind_label: title,
    published: true
  })
});
const [listing] = await listingResponse.json();
console.log(`Created listing ${listing.id}`);

const mediaRows = [];

for (const [index, name] of photos.entries()) {
  const resized = resizeImage(path.join(folder, name), 1600);
  const objectKey = `${listing.id}/${crypto.randomUUID()}.jpg`;
  uploadToR2(objectKey, resized, "image/jpeg");
  mediaRows.push({ listing_id: listing.id, kind: "photo", path: objectKey, caption: captionFromFilename(name), position: index });
  console.log(`Uploaded photo: ${name} (${Math.round(statSync(resized).size / 1024)} KB)`);
}

if (floorPlan) {
  const resized = resizeImage(path.join(folder, floorPlan), 2000);
  const objectKey = `${listing.id}/${crypto.randomUUID()}.jpg`;
  uploadToR2(objectKey, resized, "image/jpeg");
  mediaRows.push({ listing_id: listing.id, kind: "floor_plan", path: objectKey, caption: "Floor plan", position: 0 });
  console.log(`Uploaded floor plan: ${floorPlan}`);
}

if (mediaRows.length > 0) {
  await rest("listing_media", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(mediaRows) });
}

if (video) {
  const extension = path.extname(video).toLowerCase();
  const objectKey = `${listing.id}/${crypto.randomUUID()}${extension}`;
  uploadToR2(objectKey, path.join(folder, video), VIDEO_TYPES[extension] || "video/mp4");
  await rest(`listings?id=eq.${listing.id}`, {
    method: "PATCH",
    body: JSON.stringify({ video_url: `/media/${objectKey}` })
  });
  console.log(`Uploaded video: ${video}`);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`Done: "${title}" (${buildingName}${unit ? ` ${unit}` : ""}) with ${photos.length} photos${floorPlan ? ", floor plan" : ""}${video ? ", video" : ""}.`);
