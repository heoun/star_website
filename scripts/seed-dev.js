// Fills a development Supabase project with a copy of the live listings, so
// the local admin has something real to work on.
//
//     SOURCE_SUPABASE_URL=https://<prod>.supabase.co \
//     SOURCE_SUPABASE_SERVICE_ROLE_KEY=<prod service role key> \
//     npm run seed:dev
//
// The target is whatever .dev.vars points at, and the script refuses to run if
// that turns out to be the same project as the source.
//
// Rows keep their original ids, including listing_media.path — so the media
// read-through in worker/media.js finds the photos at the same /media/ URLs and
// the local site looks like the real one without copying a byte of R2.
//
// Applications are deliberately NOT copied. They hold real names, addresses and
// encrypted SSNs, and a development database is not the place for any of that.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function readDevVars() {
  const file = path.join(root, ".dev.vars");
  if (!fs.existsSync(file)) {
    throw new Error("No .dev.vars — copy .dev.vars.example to .dev.vars and fill it in first.");
  }

  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at === -1) continue;
    values[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

function client(url, key, label) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base || !key) throw new Error(`${label} is missing its URL or service role key.`);

  return {
    host: new URL(base).hostname,
    async request(pathAndQuery, init = {}) {
      const response = await fetch(`${base}/rest/v1/${pathAndQuery}`, {
        ...init,
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...init.headers
        }
      });
      if (!response.ok) {
        throw new Error(`${label}: ${init.method || "GET"} ${pathAndQuery} → ${response.status} ${await response.text()}`);
      }
      return response.status === 204 ? null : response.json();
    }
  };
}

// Upsert rather than insert, so the script can be run again after the live
// listings change without clearing what is already there.
async function upsert(target, table, rows) {
  if (rows.length === 0) return 0;
  await target.request(`${table}?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows)
  });
  return rows.length;
}

async function main() {
  const vars = readDevVars();
  const source = client(process.env.SOURCE_SUPABASE_URL, process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY, "source");
  const target = client(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, "development target (.dev.vars)");

  if (source.host === target.host) {
    throw new Error(
      `.dev.vars points at ${target.host}, the same project as the source. ` +
      "Point SUPABASE_URL at your development project before seeding."
    );
  }

  console.log(`Seeding ${target.host} from ${source.host}`);

  const buildings = await source.request("buildings?select=*").catch(() => []);
  console.log(`  buildings        ${await upsert(target, "buildings", buildings)}`);

  const listings = await source.request("listings?select=*&published=eq.true&order=position.asc");
  console.log(`  listings         ${await upsert(target, "listings", listings)}`);

  const ids = listings.map((row) => row.id);
  const media = ids.length === 0
    ? []
    : await source.request(`listing_media?select=*&listing_id=in.(${ids.join(",")})`);
  console.log(`  listing media    ${await upsert(target, "listing_media", media)}`);

  console.log("\nApplications were not copied: they hold real applicant data.");
  console.log("Lease settings were not copied either — fill them in through the admin,");
  console.log("which is the flow worth exercising locally anyway.");
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
