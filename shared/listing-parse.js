// Parsing rules for a marketing folder, shared by the browser admin page and
// the command-line importer so both read the same documents the same way.
//
// Expected .docx layout (see the Evergarden folders):
//   $4500/mo
//   Kew Gardens Luxury Rental
//   Kew Gardens, 81-07 Kew Gardens Road,NY
//   Apartment,2bed 2 bath,Kew Gardens
//   "Modern Comfort at Evergarden
//   Stylish 2-bed, 2-bath residence ...

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".avif"];
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm"];

const extensionOf = (name) => {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
};

const stem = (name) => {
  const index = name.lastIndexOf(".");
  return index === -1 ? name : name.slice(0, index);
};

// "Evergarden 7A" -> { building_name: "Evergarden", unit: "7A" }
export function parseFolderName(folderName) {
  const match = folderName.match(/^(.*?)\s+([0-9]+[A-Za-z]?)$/);
  return match
    ? { building_name: match[1].trim(), unit: match[2] }
    : { building_name: folderName, unit: null };
}

export function parseListingCopy(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);

  const priceLine = lines[0] || "";
  const priceMatch = priceLine.match(/\d[\d,]*(?:\.\d+)?/);
  const priceAmount = priceMatch ? Number(priceMatch[0].replace(/,/g, "")) : null;

  const addressParts = (lines[2] || "").split(",").map((part) => part.trim()).filter(Boolean);
  const factsLine = lines[3] || "";
  const bedroomsMatch = factsLine.match(/(\d+)\s*bed/i);
  const bathroomsMatch = factsLine.match(/([\d.]+)\s*bath/i);

  return {
    transaction_type: /\/\s*mo|month|\brent\b|\blease\b/i.test(priceLine) ? "rental" : "sale",
    price_amount: Number.isFinite(priceAmount) && priceAmount >= 0 ? priceAmount : null,
    title: lines[1] || "",
    neighborhood: addressParts[0] || "",
    location: addressParts.slice(1).join(", "),
    property_type: (factsLine.split(",")[0] || "").trim(),
    bedrooms: bedroomsMatch ? Number(bedroomsMatch[1]) : (/\bstudio\b/i.test(factsLine) ? 0 : null),
    bathrooms: bathroomsMatch ? Number(bathroomsMatch[1]) : null,
    description: lines.slice(4).join("\n").replace(/[“”]/g, "").trim()
  };
}

// Floor plans are named for the units they cover ("5A-7A.png",
// "3D-4D,5C-7C.png") or simply contain "plan".
export function isFloorPlanName(name) {
  const base = stem(name);
  return /plan/i.test(base) || /\d+[a-z]\s*-\s*\d+[a-z]/i.test(base);
}

// "Living room.png" -> "Living room";  "W_D.jpg" -> "W/D"
export function captionFromFilename(name) {
  return stem(name).replace(/_+/g, "/").replace(/\s+/g, " ").trim();
}

export function classifyFiles(names) {
  const photos = [];
  let floorPlan = null;
  let video = null;
  let document = null;

  for (const name of names) {
    if (name.startsWith(".")) continue;
    const extension = extensionOf(name);

    if (extension === ".docx") document = document || name;
    else if (VIDEO_EXTENSIONS.includes(extension)) video = video || name;
    else if (IMAGE_EXTENSIONS.includes(extension)) {
      if (isFloorPlanName(name) && !floorPlan) floorPlan = name;
      else photos.push(name);
    }
  }

  photos.sort();
  return { document, photos, floorPlan, video };
}
