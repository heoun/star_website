// Where each address and contact in a lease belongs.
//
// The text is read as blocks. A heading such as "Landlord:", "Property Manager
// (for repairs, ...)" or "Name, address and telephone number of person or entity
// to whom payments can be made" opens a contact block, and the Name / Address /
// Phone lines under it belong to that party until a numbered clause, a rider
// title, a signature line or a run of a dozen lines ends the block. Two headings
// in a row with no values between them are the two columns of a side-by-side
// table, which a PDF prints column by column: the first Name/Address/Phone group
// belongs to the left heading, the second to the right one.
//
// The premises address is scored from every place the lease names it. One
// building mentioned six ways is one candidate; two different buildings both
// named strongly is a conflict for the reviewer; an address that also belongs to
// the manager or the payee is an office, not the property.
import {ADDRESS_PATTERN, ADDRESS_AT_START, findAddress, cleanPropertyAddress, splitImportedAddress, addressKey, houseNumber, clean} from './lease-import-address.js';
export {cleanPropertyAddress, splitImportedAddress};

// "3. Management.", "38.2 Broker" and "II. PETS ALLOWED." all start a clause; "2 bedroom" does not.
const CLAUSE = /^(?:\d{1,2}[.)]|\d{1,2}\.\d{1,2}|[IVX]{1,5}\.)\s+[A-Za-z]/;
const SUBCLAUSE = /^[A-Z][.)]\s+[A-Z][a-z]/;
const SIGNATURE = /^(?:signature|print(?:ed)? name|date|dated|by|title|initials?|signed)s?\s*(?:[:：]|$)/i;
const TITLE_WORD = /\b(?:rider|notice|disclosure|statement|agreement|addendum|consent|schedule|appendix|form)\b/i;
const LABEL = /(Name of landlord \(owner or managing agent\)|Address of landlord \(owner or managing agent\)|Mailing Address|MAILING ADDRESS|Email Address|EMAIL ADDRESS|E-?mail|E-?MAIL|Telephone Number|TELEPHONE NUMBER|Telephone|TELEPHONE|Phone Number|PHONE NUMBER|Phone|PHONE|Address|ADDRESS|Name\(s\)|NAME\(S\)|Name|NAME|Fax|FAX)\s*[:：]/g;
const FIELD_LABEL = /^(?:name(?:\(s\))?|address|mailing address|e-?mail(?: address)?|phone(?: number)?|telephone(?: number)?|fax|tenant names?)\s*[:：]/i;
const NAMED_PREMISES = /\(the\s*"(?:Leased\s+)?(?:Premises|Unit|Apartment|Property|Building|Dwelling)"\)/i;
const ROLES = [
  ['legal_notice', /^landlord or person authorized to receive legal service/i],
  ['legal_notice', /^(?:agent for service of process|legal notices?(?: to)?)\s*[:：]*$/i],
  ['owner_rep', /^owner\/owner representative contact information/i],
  ['payee', /^name, address and telephone number of person or entity to whom payments/i],
  ['payee', /^(?:payments? (?:should|shall|must|may|can|will) be (?:sent|made|mailed|remitted) to|make (?:all )?(?:rent )?payments? (?:payable )?to|rent (?:is )?payable to|payee|remit(?:tance)? to)\b/i],
  ['payee', /^(?:payment|rent payment)(?:\s+(?:details|information|address|instructions))?\s*[:：]*$/i],
  ['tenant', /^tenant contact information/i],
  ['tenant', /^(?:tenant|lessee|resident)s?(?:\s+(?:details|information|contact(?:\s+information)?))?\s*[:：]*$/i],
  ['landlord', /^(?:landlord|owner|lessor)s?(?:\s+(?:details|information|contact(?:\s+information)?))?\s*[:：]*$/i],
  ['landlord', /^return this form to\s*[:：]*$/i],
  ['manager', /^(?:property manager|property management|management(?: company)?|managing agent)\b/i],
  ['other', /^notices?\s*[:：]*$/i]
];
const CONTACT_FIELDS = {
  landlord: {name: 'landlord.entity_name', address: 'landlord.address', phone: 'landlord.phone'},
  manager: {name: 'manager.name', address: 'manager.address', phone: 'manager.phone'},
  payee: {name: 'payee.name', address: 'payee.address', phone: 'payee.phone'},
  legal_notice: {name: 'legal_notice.name', address: 'legal_notice.address', phone: 'legal_notice.phone'},
  owner_rep: {name: 'owner_rep.name', address: 'owner_rep.mailing_address', email: 'owner_rep.email'}
};
const roleOf = word => /landlord|owner|lessor/i.test(word) ? 'landlord' : /manager|management|agent/i.test(word) ? 'manager' : /payee/i.test(word) ? 'payee' : 'tenant';
const kindOf = label => /e-?mail/i.test(label) ? 'email' : /address/i.test(label) ? 'address' : /phone/i.test(label) ? 'phone' : /fax/i.test(label) ? 'fax' : 'name';
const isRoleHeading = line => ROLES.some(([, re]) => re.test(line));
// "Sprinkler Disclosure Statement" and "Key Rider" are titles; "the landlord
// shall provide 30 days notice" merely mentions one.
const looksLikeTitle = line => {
  if (/[:：]/.test(line) || line.length < 4 || line.length > 90 || /[.;]$/.test(line) || !TITLE_WORD.test(line)) return false;
  const words = line.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  return words.length > 0 && words.filter(word => /^[A-Z]/.test(word)).length / words.length >= 0.6;
};
const nameLike = value => value.length >= 2 && value.length <= 90 && !/[:：]/.test(value) && !/[.!?]$/.test(value) && !/^\(.*\)$/.test(value)
  && !/^[\d() .+-]+$/.test(value) && !/^\d+\.\d/.test(value) && !/\bmeans\b/i.test(value) && !/\b\d{5}\b/.test(value) && !/\b(?:signature|initials?|dated?|copy)\b/i.test(value) && !ADDRESS_PATTERN.test(value);

// One line of text for sentence patterns, with a way back to the line a match
// sits on: a PDF wraps sentences wherever the page ends and a Word file does not.
export function flattenLines(lines) {
  const starts = []; let text = '';
  for (const line of lines) { starts.push(text.length); if (line) text += line + ' '; }
  const lineAt = offset => { let low = 0, high = starts.length - 1; while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid] <= offset) low = mid; else high = mid - 1; } return low + 1; };
  return {text, lineAt};
}

export function contextualLeaseData(text) {
  const rawLines = text.replace(/\r/g, '').split('\n'), lines = rawLines.map(clean), offsets = [];
  let offset = 0; for (const line of rawLines) { offsets.push(offset); offset += line.length + 1; }
  const flat = flattenLines(lines);
  const contacts = [], mentions = [];
  let blocks = [], active = -1, blockLines = 0, clause = '', clauseSeen = false, skipTo = -1;
  const current = () => blocks[active];
  const endBlocks = () => { blocks = []; active = -1; };
  const evidenceAt = (from, to) => lines.slice(Math.max(0, from), Math.min(lines.length, to + 1)).filter(Boolean).join(' ').slice(-700);

  const record = (role, kind, raw, i, reason, confidence = 90) => {
    const id = CONTACT_FIELDS[role]?.[kind]; if (!id) return false;
    let value = clean(raw);
    // The defined party label is not part of the legal entity name.
    if (kind === 'name') value = value.replace(/\s*\((?:the\s+)?["“”]?(?:Landlord|Owner|Lessor)["“”]?\)\s*$/i, '');
    // An address the pattern cannot parse is kept only when it still reads as one.
    if (kind === 'address') value = findAddress(value) || (/\d/.test(value) && value.length <= 120 && !/[:：]/.test(value) && !/\b(?:signature|date|print|initials?|call|phone|tel)\b/i.test(value) ? value : '');
    if (!value || FIELD_LABEL.test(value) || /^(?:Email|Fax)\s*:/i.test(value)) return false;
    if (kind === 'phone' && (/[A-Za-z]/.test(value) || !/^\d{7,15}$/.test(value.replace(/\D/g, '')))) return false;
    if (kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
    if (kind === 'name' && !nameLike(value)) return false;
    const evidence = evidenceAt((current()?.start ?? i) - 1, i + 3);
    contacts.push({id, value, evidence, index: offsets[i], reason, confidence});
    // A Notice clause names who receives legal notices, not only who the landlord is.
    if (role === 'landlord' && /notice/i.test(clause) && CONTACT_FIELDS.legal_notice[kind]) contacts.push({id: CONTACT_FIELDS.legal_notice[kind], value, evidence, index: offsets[i], reason: 'Notice clause', confidence: confidence - 5});
    return true;
  };
  const mention = (raw, i, reason, confidence) => {
    const value = findAddress(raw); if (!value) return;
    mentions.push({value, reason, confidence, evidence: evidenceAt(i - 1, i + 2), location: `Text line ${i + 1}`});
  };
  // The lines after `index` that still belong to one multi-line address.
  const continuation = index => {
    const parts = []; let last = index - 1, seen = 0;
    for (let n = index; n < lines.length && seen < 4; n++) {
      const line = lines[n]; if (!line) continue;
      if (FIELD_LABEL.test(line) || isRoleHeading(line) || CLAUSE.test(line) || SIGNATURE.test(line) || looksLikeTitle(line)) break;
      if (/\b(?:signature|initials?)\b/i.test(line) || /^date\b/i.test(line) || (line.length > 70 && !/\b\d{5}\b/.test(line))) break;
      parts.push(line); last = n; seen++;
      if (/\b\d{5}(?:-\d{4})?\b/.test(line)) break;
    }
    return {text: parts.join(' '), last};
  };
  const nextValue = index => {
    for (let n = index + 1; n < Math.min(lines.length, index + 4); n++) {
      const line = lines[n]; if (!line) continue;
      return FIELD_LABEL.test(line) || isRoleHeading(line) || CLAUSE.test(line) || SIGNATURE.test(line) || looksLikeTitle(line) || /[:：]/.test(line) || line.length > 80 ? '' : line;
    }
    return '';
  };
  const splitLabels = line => {
    const segments = []; let last = null;
    for (const found of line.matchAll(LABEL)) {
      // "Bank Name:" and "Tenant Name:" are somebody else's label, not this block's.
      if (/(?:^|\s)(?:Bank|Account|Tenant|Occupant|Guarantor|Emergency|Contact|Company|Business|Entity|Legal|Full|First|Last|Print(?:ed)?|Routing|Card|Property|Building|Premises)\s*$/i.test(line.slice(Math.max(0, found.index - 14), found.index))) continue;
      if (last) last.value = line.slice(last.end, found.index).trim();
      last = {label: found[1], kind: kindOf(found[1]), end: found.index + found[0].length, value: ''};
      segments.push(last);
    }
    if (last) last.value = line.slice(last.end).trim();
    return segments;
  };
  const open = (role, i, bare) => {
    if (active >= 0 && current().role === role && !blocks.some(block => block.used)) return;
    const block = {role, start: i, seen: {}, used: false, bare};
    if (active >= 0 && !blocks.some(b => b.used) && blockLines <= 3) blocks.push(block);
    else { blocks = [block]; active = 0; blockLines = 0; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || i <= skipTo) continue;
    const heading = line.replace(/^(?:\d{1,2}[.)]|[A-Z][.)]|\(\w\)|[-•●▪*])\s+/, '');
    if (CLAUSE.test(line)) { clause = heading.split(/[.:]/)[0].trim(); clauseSeen = true; }
    if (active >= 0) { blockLines++; if (CLAUSE.test(line) || SUBCLAUSE.test(line) || SIGNATURE.test(line) || looksLikeTitle(line) || blockLines > 12) endBlocks(); }

    // The premises named outright: a unit information block, a labelled
    // property address, a property section or the cover sheet of a lease.
    if (/^STREET\s*[:：]/i.test(heading)) {
      const joined = lines.slice(i).filter(Boolean).slice(0, 12).join(' ');
      const unit = /STREET\s*[:：]\s*(.*?)\s*UNIT OR APARTMENT NUMBER\s*[:：]\s*(.*?)\s*CITY\/TOWN\/VILLAGE\s*[:：]\s*(.*?)\s*STATE\s*[:：]\s*(.*?)\s*ZIP CODE\s*[:：]\s*(\d{5}(?:-\d{4})?)/i.exec(joined);
      if (unit && unit[1] && unit[3]) mention(`${unit[1]}, ${unit[3]}, ${unit[4]} ${unit[5]}`, i, 'Unit information block', 100);
      continue;
    }
    const explicit = /^(?:subject\s+)?(?:(?:property|building|premises|apartment|rental(?:\s+unit|\s+property)?|leased\s+premises|unit|dwelling)(?:\s+(?:street|mailing))?\s+address|(?:leased\s+)?premises)\s*(?:[:：–—-]\s*|$)(.*)$/i.exec(heading);
    if (explicit) { const more = explicit[1] ? null : continuation(i + 1); mention(explicit[1] || more.text, i, 'Explicit property address', 98); if (more) skipTo = more.last; continue; }
    if (/^(?:property|premises|rental unit|leased premises)\s*[:.]?$/i.test(heading)) { mention(lines.slice(i + 1, i + 6).filter(Boolean).join(' '), i, 'Property section', 90); continue; }
    if (i < 30 && !clauseSeen && active < 0 && /^address\s*[:：]/i.test(line) && lines.slice(0, i).some(l => /residential\s+lease(?:\s+agreement)?/i.test(l))) {
      const tenant = lines.slice(0, i).find(l => /^tenant names?\s*[:：]/i.test(l));
      const filled = tenant && clean(tenant.split(/[:：]/).slice(1).join(':'));
      mention(line.replace(/^address\s*[:：]\s*/i, '') + ' ' + continuation(i + 1).text, i, filled ? 'Cover address near tenant details' : 'Lease cover address', filled ? 50 : 80);
      continue;
    }

    // Role-prefixed labels need no heading: "Landlord's Address: ..."
    const prefixed = /^(landlord|owner|lessor|property manager|property management|management|managing agent|payee)(?:'s)?[\s—–-]+(?:mailing\s+)?(address|phone(?: number)?|telephone(?: number)?|name|e-?mail(?: address)?)\s*[:：–—-]?\s*(.*)$/i.exec(heading);
    if (prefixed) {
      const kind = kindOf(prefixed[2]);
      let raw = prefixed[3];
      if (kind === 'address' && !/\d{5}/.test(raw)) { const more = continuation(i + 1); raw = `${raw} ${more.text}`.trim(); if (raw) skipTo = more.last; }
      else if (!raw) raw = nextValue(i);
      record(roleOf(prefixed[1]), kind, raw, i, 'Role-labelled ' + kind);
      continue;
    }

    // Headings open contact blocks; "Landlord: 8043 KG LLC" opens one and names it.
    const hit = ROLES.find(([, re]) => re.test(heading));
    const inlineHeading = !hit && /^(landlord|owner|lessor|property manager|management|managing agent|payee)\s*[:：]\s*(.+)$/i.exec(heading);
    // "Landlord: 8043 KG LLC" names a party; "Landlord: The Term means..." defines a word.
    const inline = inlineHeading && inlineHeading[2].length <= 80 && (findAddress(inlineHeading[2]) || nameLike(inlineHeading[2])) ? inlineHeading : null;
    if (hit || inline) {
      const role = hit ? hit[0] : roleOf(inline[1]);
      open(role, i, hit ? heading.length <= 40 && !/\(/.test(heading) : true);
      if (/landlord or person authorized to receive legal service/i.test(heading.slice(12))) open('legal_notice', i, false);
      if (inline) {
        const rest = inline[2];
        if (findAddress(rest)) { if (record(role, 'address', rest, i, 'Heading value')) current().seen.address = true; }
        else if (record(role, 'name', rest, i, 'Heading value')) current().seen.name = true;
        if (contacts.length && contacts[contacts.length - 1].index === offsets[i]) current().used = true;
      }
      continue;
    }
    if (active < 0 || ['tenant', 'other'].includes(current().role)) continue;

    const segments = splitLabels(line);
    if (segments.length) {
      for (const segment of segments) {
        if (segment.kind === 'fax') continue;
        // A repeated label starts the next column of a side-by-side table.
        if (current().seen[segment.kind] && blocks[active + 1]) active++;
        const block = current();
        block.seen[segment.kind] = true;
        let raw = segment.value;
        if (segment.kind === 'address') {
          if (NAMED_PREMISES.test(line)) { mention(`${raw} ${continuation(i + 1).text}`, i, 'Named premises', 95); continue; }
          if (!/\d{5}/.test(raw)) { const more = continuation(i + 1); if (more.text) { raw = `${raw} ${more.text}`.trim(); skipTo = more.last; } }
        } else if (!raw) raw = nextValue(i);
        if (record(block.role, segment.kind, raw, i, 'Contact block')) block.used = true;
      }
      continue;
    }
    // A bare heading such as "Landlord:" is followed by the name and then the
    // address, with no labels at all.
    const block = current();
    // Prose ends a block; a long line that ends in a colon is a heading still being read.
    if (line.length > 70 && !/\b\d{5}\b/.test(line) && !/[:：]\s*$/.test(line)) { endBlocks(); continue; }
    if (!block.bare) continue;
    if (!block.seen.name && !block.seen.address && nameLike(line)) { block.seen.name = true; if (record(block.role, 'name', line, i, 'Under heading')) block.used = true; continue; }
    if (!block.seen.address) {
      const more = continuation(i + 1), raw = `${line} ${more.text}`.trim();
      if (findAddress(raw)) { block.seen.address = true; if (record(block.role, 'address', raw, i, 'Under heading')) block.used = true; skipTo = more.last; }
    }
  }

  // Sentences that name the premises, read across line breaks.
  const flatText = flat.text;
  for (const found of flatText.matchAll(/\b(premises|property|apartment|rental unit|dwelling(?: unit)?|unit|building)\b([^.]{0,120}?)\b(?:located at|situated at|known as|at the address(?: of)?)\s*:?\s*/gi)) {
    if (/\b(?:manager|management|landlord|tenant|owner|agent|office)\b/i.test(found[2]) || /\b(?:manager|management|landlord|tenant|owner|agent)\W*$/i.test(flatText.slice(Math.max(0, found.index - 30), found.index))) continue;
    const end = found.index + found[0].length, address = ADDRESS_AT_START.exec(flatText.slice(end, end + 240));
    if (address) mention(address[1], flat.lineAt(end) - 1, 'Rental premises clause', 95);
  }
  for (const found of flatText.matchAll(new RegExp(`(${ADDRESS_PATTERN.source})\\s*\\(the\\s*"(?:Leased\\s+)?(?:Premises|Unit|Apartment|Property|Building|Dwelling)"\\)`, 'g'))) mention(found[1], flat.lineAt(found.index) - 1, 'Named premises', 95);

  // One candidate per building. The best-supported mention supplies the text,
  // and a hyphenated Queens house number wins over its unhyphenated twin.
  const groups = new Map();
  for (const item of mentions) { const key = addressKey(item.value); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  const offices = new Set(contacts.filter(c => /\.(?:address|mailing_address)$/.test(c.id)).map(c => addressKey(c.value)));
  const candidates = [...groups].map(([key, list]) => {
    const shape = item => item.confidence * 10 + Math.min(9, (cleanPropertyAddress(item.value).match(/,/g) || []).length);
    const best = list.reduce((a, b) => shape(b) > shape(a) ? b : a);
    let value = cleanPropertyAddress(best.value);
    const number = houseNumber(value), hyphenated = list.map(m => houseNumber(m.value)).find(n => n.includes('-'));
    if (hyphenated && number && !number.includes('-') && hyphenated.replace('-', '') === number) value = hyphenated + value.slice(number.length);
    const confidence = offices.has(key) && best.confidence < 98 ? best.confidence - 30 : best.confidence;
    return {value, evidence: best.evidence, location: best.location, reason: best.reason, confidence, mentions: list.length};
  }).sort((a, b) => b.confidence - a.confidence || b.mentions - a.mentions);
  const strong = candidates.filter(c => c.confidence >= 75);
  contacts.sort((a, b) => b.confidence - a.confidence);
  return {contacts, address: {value: strong.length === 1 ? strong[0].value : '', candidates, conflict: strong.length > 1}, flat};
}
