// One place for what an address is. Finding one in text, deciding whether two
// mentions are the same building and splitting one into form fields all live
// here so the three can never disagree: "81-07 Kew Gardens Rd" and "8107 Kew
// Gardens Road 7A" are one building, "10 First Road" and "20 Second Avenue" are
// not. Comparison follows USPS conventions: Queens hyphens, ordinal streets and
// suffix abbreviations are all normalised away before two addresses are compared.
export const clean = value => String(value ?? '').replace(/[_ ]+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

const STATE_NAMES = {'new york':'NY','new jersey':'NJ','connecticut':'CT','pennsylvania':'PA','massachusetts':'MA','rhode island':'RI','vermont':'VT','new hampshire':'NH','maine':'ME','maryland':'MD','delaware':'DE','virginia':'VA','florida':'FL','california':'CA','texas':'TX','illinois':'IL','ohio':'OH','georgia':'GA'};
const STATE_CODES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
const titleCase = name => name.replace(/\b\w/g, c => c.toUpperCase());
// Two-letter codes must be upper case: "or 10001" in prose is not Oregon.
export const STATE = `(?:${STATE_CODES}|${Object.keys(STATE_NAMES).flatMap(n => [titleCase(n), n.toUpperCase()]).join('|')})`;
const SUFFIXES = {street:'st',avenue:'ave',road:'rd',boulevard:'blvd',lane:'ln',drive:'dr',court:'ct',place:'pl',parkway:'pkwy',terrace:'ter',highway:'hwy',expressway:'expy',plaza:'plz',square:'sq',circle:'cir',turnpike:'tpke'};
export const SUFFIX_WORDS = 'Road|Rd|Street|St|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Parkway|Pkwy|Terrace|Ter|Highway|Hwy|Expressway|Expy|Plaza|Plz|Square|Sq|Circle|Cir|Turnpike|Tpke|Way|Broadway';
// A house number may be hyphenated (Queens: 81-07) and a street may start with
// an ordinal (37th Avenue, 33rd Street). The lookbehind keeps "34 33rd Street"
// from being read out of the middle of "37-34 33rd Street".
const HOUSE = '(?<![\\d-])\\d{1,6}(?:-\\d{1,4})?';
const STREET = '(?:\\d{1,4}(?:st|nd|rd|th)?\\s*)?[A-Za-z][^\\n;]{2,180}?';
export const ADDRESS_PATTERN = new RegExp(`\\b${HOUSE}\\s+${STREET}\\b${STATE}\\s+\\d{5}(?:-\\d{4})?\\b`);
export const ADDRESS_AT_START = new RegExp(`^\\s*(${ADDRESS_PATTERN.source})`);

// The leftmost match can drag in prose that happens to start with a number
// ("2 bathroom, located at 8107 ..."). When a later house number reaches the
// same ZIP and what it drops reads as prose rather than street, drop it.
export function findAddress(text) {
  const source = clean(text);
  const match = ADDRESS_PATTERN.exec(source);
  if (!match) return '';
  let value = match[0];
  const later = new RegExp(ADDRESS_PATTERN.source, 'g');
  later.lastIndex = 1;
  for (let inner; (inner = later.exec(value)); later.lastIndex = inner.index + 1) {
    const dropped = value.slice(0, inner.index);
    const prose = /[,.:;()]/.test(dropped) || /\b(?:at|to|of|is|as|in)\s*$/i.test(dropped) || dropped.length > 40;
    if (prose && !streetLike(dropped)) { value = inner[0]; later.lastIndex = 1; }
  }
  return value;
}

// "14222 37thAvenue," is a street even without the space; "2 bathroom," is not.
const streetLike = text => text.split(/\s+/, 5).some(word => new RegExp(`(?:${SUFFIX_WORDS})\\b|^\\d+(?:st|nd|rd|th)\\b`).test(word));

export function houseNumber(value) { return /^\d{1,6}(?:-\d{1,4})?/.exec(clean(value))?.[0] || ''; }

// The building without its unit: "Unit 4E", "#405", "7A" after the street type
// and a stray "4E" before the state all go. Contact addresses are never cleaned
// this way; a manager's suite number is part of where the mail goes.
export function cleanPropertyAddress(value) {
  return clean(value)
    .replace(/\b(?:Unit|Apartment|Apt\.?|Suite|Ste\.?)\s*#?\s*[A-Za-z0-9-]+\b\.?/gi, '')
    .replace(/\s*#\s*[A-Za-z0-9-]+\b/g, '')
    .replace(/,?\s*\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Floor|Fl\.?)\b/gi, '')
    .replace(new RegExp(`\\b(${SUFFIX_WORDS})\\.?\\s+\\d{1,4}[A-Za-z]?\\b,?`, 'g'), '$1,')
    .replace(new RegExp(`\\s+\\d{1,4}[A-Za-z]\\b(?=\\s*,|\\s+${STATE}\\s+\\d{5})`, 'g'), '')
    .replace(/\s*,\s*/g, ', ').replace(/(?:, )+/g, ', ').replace(/^[, ]+|[, ]+$/g, '').replace(/\s+/g, ' ');
}

// What two mentions of one building have in common once spelling is set aside.
export function addressKey(value) {
  return cleanPropertyAddress(value).toLowerCase()
    .replace(/\b(\d{1,3})-(\d{2,4})\b/g, '$1$2')
    .replace(/[.,#]/g, ' ')
    .replace(new RegExp(`\\b(${Object.keys(SUFFIXES).join('|')})\\b`, 'g'), word => SUFFIXES[word])
    .replace(/\b(north|south|east|west)\b/g, word => word[0])
    .replace(new RegExp(`\\b(${Object.keys(STATE_NAMES).join('|')})\\b`, 'g'), name => STATE_NAMES[name].toLowerCase())
    .replace(/\s+/g, ' ').trim();
}

export function splitImportedAddress(value) {
  const address = cleanPropertyAddress(value);
  const match = new RegExp(`^(.*?)[, ]+(${STATE})\\s+(\\d{5}(?:-\\d{4})?)$`).exec(address);
  if (!match) return {street: address, city: '', state_abbr: '', zip: ''};
  const parts = match[1].split(',').map(s => s.trim()).filter(Boolean);
  let street = parts.shift() || '', city = parts.join(', ');
  if (!city) { const split = new RegExp(`^(.*?\\b(?:${SUFFIX_WORDS})\\.?)\\s+(.+)$`, 'i').exec(street); if (split) { street = split[1]; city = split[2]; } }
  return {street, city, state_abbr: STATE_NAMES[match[2].toLowerCase()] || match[2].toUpperCase(), zip: match[3]};
}
