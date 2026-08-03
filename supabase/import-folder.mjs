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

const BUCKET = "listing-media";

// Child processes (wrangler, sips, textutil) have no business seeing the
// database key, so they run with it stripped from their environment.
const SAFE_ENV = { ...process.env };
delete SAFE_ENV.SUPABASE_SERVICE_ROLE_KEY;
delete SAFE_ENV.SUPABASE_URL;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
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
const unitMatch = folderName.match(/^(.*?)\s+([0-9]+[A-Za-z]?)$/);
const buildingName = unitMatch ? unitMatch[1].trim() : folderName;
const unit = unitMatch ? unitMatch[2] : null;

// ---- Parse the .docx copy ----

const entries = readdirSync(folder).filter((name) => !name.startsWith("."));
const docx = entries.find((name) => name.toLowerCase().endsWith(".docx"));
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

const lines = docText.split("\n").map((line) => line.trim()).filter(Boolean);

const priceLine = lines[0] || "";
const priceAmount = Number((priceLine.match(/[\d,]+(?:\.\d+)?/) || [""])[0].replace(/,/g, "")) || null;
const transactionType = /\/\s*mo|month|\brent\b|\blease\b/i.test(priceLine) ? "rental" : "sale";

const title = lines[1] || folderName;

const addressLine = lines[2] || "";
const addressParts = addressLine.split(",").map((part) => part.trim()).filter(Boolean);
const neighborhood = addressParts[0] || null;
const location = addressParts.slice(1).join(", ") || null;

const factsLine = lines[3] || "";
const propertyType = (factsLine.split(",")[0] || "").trim() || null;
const bedrooms = (() => {
  const match = factsLine.match(/(\d+)\s*bed/i);
  if (match) return Number(match[1]);
  return /\bstudio\b/i.test(factsLine) ? 0 : null;
})();
const bathrooms = (() => {
  const match = factsLine.match(/([\d.]+)\s*bath/i);
  return match ? Number(match[1]) : null;
})();

const description = lines.slice(4).join("\n").replace(/[“”]/g, "").trim() || null;

// ---- Classify media files ----

const isFloorPlan = (name) => {
  const base = name.toLowerCase();
  // "5A-7A.png", "3D-4D,5C-7C.png" — unit-range names — or anything with "plan".
  return base.includes("plan") || /\d+[a-z]\s*-\s*\d+[a-z]/i.test(path.basename(name, path.extname(name)));
};

const photos = [];
let floorPlan = null;
let video = null;

for (const name of entries) {
  const extension = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    if (isFloorPlan(name)) floorPlan = name;
    else photos.push(name);
  } else if (VIDEO_EXTENSIONS.has(extension)) {
    video = name;
  }
}

photos.sort();

const caption = (name) => path.basename(name, path.extname(name)).replace(/[_]+/g, "/").trim();

console.log("Parsed listing:");
console.log(JSON.stringify({
  category, transaction_type: transactionType, title,
  building_name: buildingName, unit,
  price_amount: priceAmount, property_type: propertyType,
  bedrooms, bathrooms, neighborhood, location,
  description: description ? `${description.slice(0, 60)}…` : null,
  photos: photos.map(caption), floor_plan: floorPlan, video
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
    transaction_type: transactionType,
    title,
    building_name: buildingName,
    unit,
    description,
    price_amount: priceAmount,
    property_type: propertyType,
    bedrooms,
    bathrooms,
    neighborhood,
    location,
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
  mediaRows.push({ listing_id: listing.id, kind: "photo", path: objectKey, caption: caption(name), position: index });
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
