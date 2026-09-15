import {contextualLeaseData} from './lease-import-context.js';
import {clean} from './lease-import-address.js';
// Conservative, evidence-based extraction. Only registry manager fields can
// become defaults; tenant terms, unit numbers and bank account numbers are never
// read. Every candidate carries the sentence it came from and the line it was
// found on, because a reviewer accepts evidence, not a guess.
//
// The text is searched two ways. Line by line for labels and tables, and as one
// flattened line for sentences and marked boxes, because a PDF wraps a sentence
// wherever the page ends and a Word file does not.
export const MAX_TEXT = 500000;
export const EXCLUSIVE_PAIRS = [
  ['insurance.required_yes', 'insurance.required_no'],
  ['smoking.in_unit_yes', 'smoking.in_unit_no'],
  ['sprinkler.mark_option2', 'sprinkler.mark_option1'],
  ['good_cause.mark_yes', 'good_cause.mark_no']
];
const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CHECKED = '(?:\\[\\s*[xX✓✔]\\s*\\]|☒|☑|■|✓|✔)';
const UNCHECKED = '(?:\\[\\s*\\]|☐|□|❑)';
const MARK = `(${CHECKED}|${UNCHECKED})`;
const AMOUNT = '\\$\\s*([\\d,]+(?:\\.\\d{1,2})?)';
const checked = mark => new RegExp(`^${CHECKED}$`).test(mark || '');

export function extractPropertyAddress(text) { return contextualLeaseData(text).address.value; }
export function normalizeImportValue(field, raw) {
  if (typeof raw === 'boolean') return field.type === 'checkbox' ? raw : null;
  const value = clean(raw);
  if (/^[A-Za-z][A-Za-z /—'()–-]{1,70}:\s*/.test(value)) return null;
  if (field.type === 'choice') return field.options.find(option => option.toLowerCase() === value.toLowerCase()) || null;
  if (!value || /\{\{|s_Af_|d_Af_|^(?:n\/?a|not answered|not entered|unknown|tbd)$/i.test(value)) return null;
  if (field.type === 'checkbox') {
    if (/^(?:true|yes|marked|checked|\[x\]|☒|☑)$/i.test(value)) return true;
    if (/^(?:false|no|not marked|unchecked|\[\s*\]|☐)$/i.test(value)) return false;
    return null;
  }
  if (field.type === 'money') {
    const numeric = value.replace(/^\$\s*/, '').replace(/,/g, '');
    if (!/^\d+(?:\.\d{1,2})?$/.test(numeric) || !Number.isFinite(Number(numeric))) return null;
    return `$${Number(numeric).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  }
  if (field.type === 'integer') {
    const numeric = value.replace(/(?:st|nd|rd|th)$/i, '');
    if (!/^\d+$/.test(numeric) || !Number.isSafeInteger(Number(numeric))) return null;
    if (field.id === 'rent.due_day' && (+numeric < 1 || +numeric > 31)) return null;
    return String(Number(numeric));
  }
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  if (field.type === 'date') {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
    if (!match) return null;
    const [, m, d, y] = match.map(Number), date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  }
  // The settings API stores at most 400 characters per field.
  return value.length <= 400 ? value : null;
}

// Rows of the three tables the template prints, in the order they print.
const UTILITY_ROWS = [['Water', 'utility.water'], ['Sewer', 'utility.sewer'], ['Stormwater\\s*\\/\\s*Drainage', 'utility.stormwater'], ['Gas', 'utility.gas'], ['Heating Gas or Oil', 'utility.heating'], ['Steam Heat', 'utility.steam_heat'], ['Electricity', 'utility.electricity'], ['Domestic Hot Water', 'utility.hot_water'], ['Trash', 'utility.trash'], ['Pest Control', 'utility.pest_control'], ['Cable\\s*\\/\\s*Satellite TV\\s*\\(Service\\)', 'utility.cable'], ['Internet Access\\s*\\(Service\\)', 'utility.internet']];
const KEY_ROWS = [['Unit Key', 'unit'], ['Building Key', 'building'], ['Mailbox Key', 'mailbox'], ['Keyless Entry Remote\\s*\\/\\s*FOB', 'fob'], ['Garage Door Remote', 'garage']];
const FINE_ROWS = [['Smoking Indoors', 'fine.smoking_indoors'], ['Dog waste in common areas', 'fine.dog_waste'], ['Failure to maintain cleanliness of common spaces', 'fine.common_space_cleanliness'], ['Leaving items in hallway', 'fine.hallway_items'], ['Improper disposal of trash\\s*\\/\\s*recycling', 'fine.trash_disposal'], ['Damage to building furniture\\s*\\/\\s*structures', 'fine.furniture_damage'], ['Parking Violations', 'fine.parking'], ['Listing apartment for short-term rental\\s*\\(<\\s*30 days\\)', 'fine.short_term_rental'], ['Violations of any other house (?:roles|rules) or lease terms not listed above', 'fine.other_violation'], ["Failure to provide proof of renter'?s insurance", 'fine.no_insurance']];
const BEDBUG_ROWS = [['There is no history of any bedbug', 'bedbug.mark_none'], ['During the past year the building had a bedbug infestation history that has been the subject', 'bedbug.mark_building_eradicated'], ['During the past year the building had a bedbug infestation history on the', 'bedbug.mark_building_not_eradicated'], ['During the past year the apartment had a bedbug infestation history and eradication measures were employed', 'bedbug.mark_apartment_eradicated'], ['During the past year the apartment had a bedbug infestation history and eradication measures were not employed', 'bedbug.mark_apartment_not_eradicated'], ['Other\\s*:', 'bedbug.mark_other']];
const SMOKING_ROWS = [['Inside of residential units', 'smoking.inside_units'], ['Outside of areas that are part of residential units', 'smoking.outside_unit_areas'], ['Outdoor common areas', 'smoking.outdoor_common'], ['Outdoors within 15 feet', 'smoking.within_15_feet'], ['Other areas\\s*\\/\\s*exceptions', 'smoking.other_areas']];
// Good Cause answers are identified by the statute they cite, which survives
// any rewording of the sentence around the box.
const EXEMPTIONS = {1: 'small_landlord', 2: 'owner_occupied', 5: 'rent_regulated', 6: 'income_restricted', 7: 'condo_coop', 8: 'new_construction', 9: 'seasonal', 10: 'institutional', 11: 'manufactured_home', 12: 'hotel_transient', 13: 'dormitory', 14: 'religious', 15: 'high_rent'};
const NONRENEWAL_PARAGRAPHS = {a: 'unpaid_rent', b: 'lease_violation', c: 'nuisance', d: 'illegal_occupancy', e: 'illegal_use', f: 'refused_access', g: 'owner_use', h: 'demolition', i: 'withdrawal', j: 'refused_terms'};
const ALIASES = {
  'landlord.entity_name': ['Landlord Legal Name', 'Landlord Name', 'Owner Legal Entity', 'Lessor Name'],
  'landlord.print_name': ["Landlord Signer's Name", 'Landlord Signatory Name'],
  'landlord.signer_mailing_address': ["Landlord Signer's Mailing Address"],
  'landlord.phone': ['Landlord Phone', 'Landlord Telephone', 'Owner Phone Number'],
  'manager.name': ["Property Manager's Name", 'Management Company', 'Managing Agent Name'],
  'manager.address': ["Property Management's Address", 'Management Address'],
  'manager.phone': ["Property Management's Phone", 'Management Phone', 'Property Manager Telephone'],
  'emergency.phone': ['Housing Emergency Contact', 'Emergency Phone', 'Emergency Contact Number'],
  'fee.returned_payment': ['Returned Check Fee', 'Returned Payment Fee', 'NSF Fee'],
  'fee.lock_change_admin': ['Lock Change Administrative Fee', 'Lock-change Fee'],
  'rent.due_day': ['Rent Due Day', 'Rent Due on Day'],
  'insurance.min_liability': ['Required Renters Liability Coverage'],
  'legal_notice.name': ["Landlord / Authorized Recipient's Name"],
  'legal_notice.address': ["Landlord / Authorized Recipient's Address"],
  'legal_notice.phone': ["Landlord / Authorized Recipient's Phone Number"]
};

export function extractLeaseDefaults(text, fields) {
  if (text.length > MAX_TEXT) throw new Error('This lease has too much text. Upload a smaller lease package.');
  const allowed = new Map(fields.filter(field => field.source === 'manager').map(field => [field.id, field]));
  text = text.replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/ +/g, ' ');
  const found = new Map(), warnings = [];
  const add = (id, raw, evidence, line = 1) => {
    const field = allowed.get(id); if (!field) return;
    const value = normalizeImportValue(field, raw); if (value === null) return;
    const item = {value, evidence: clean(evidence).slice(0, 700), location: `Text line ${line}`};
    const list = found.get(id) || [];
    if (!list.some(previous => previous.value === value)) list.push(item);
    found.set(id, list);
  };
  const lineOf = index => text.slice(0, index).split('\n').length;
  const match = (id, regex, group = 1, transform = value => value) => {
    for (const item of text.matchAll(new RegExp(regex.source, 'gi'))) add(id, transform(item[group]), item[0], lineOf(item.index));
  };
  const context = contextualLeaseData(text);
  const flat = context.flat.text, lineAt = context.flat.lineAt;
  const scan = (regex, handler) => { for (const item of flat.matchAll(new RegExp(regex.source, regex.flags.replace('g', '') + 'g'))) handler(item, lineAt(item.index)); };
  const sentence = (id, regex, group = 1, transform = value => value) => scan(regex, (item, line) => add(id, transform(item[group]), item[0], line));
  const pair = (yes, no, item, line) => { const a = checked(item[1]), b = checked(item[2]); if (a || b) { add(yes, a, item[0], line); add(no, b, item[0], line); } };
  // A stretch of the flattened text between two headings, with its own line numbers.
  const region = (startRe, endRe, limit) => {
    const start = startRe.exec(flat); if (!start) return null;
    const from = start.index, tail = flat.slice(from, from + limit), end = endRe ? new RegExp(endRe.source, endRe.flags).exec(tail.slice(start[0].length)) : null;
    return {text: end ? tail.slice(0, start[0].length + end.index) : tail, at: offset => lineAt(from + offset)};
  };
  const inRegion = (part, regex, handler) => { if (part) for (const item of part.text.matchAll(new RegExp(regex.source, regex.flags.replace('g', '') + 'g'))) handler(item, part.at(item.index)); };
  const hasContact = id => context.contacts.some(contact => contact.id === id);

  for (const item of context.contacts) add(item.id, item.value, item.evidence, lineOf(item.index));

  // Labelled forms and tables. Exact labels only; ambiguous labels like "Other"
  // and generic "Bank address" cannot establish a field's context on their own.
  for (const field of allowed.values()) {
    if (['landlord.address', 'manager.address'].includes(field.id) && hasContact(field.id)) continue;
    if (field.label.length < 8 || ['deposit.bank_address'].includes(field.id)) continue;
    const label = escapeRe(field.label).replace(/\s+/g, '[ \\t]+');
    match(field.id, new RegExp(`(?:^|\\n)[ \\t]*${label}[ \\t]*[:\\t][ \\t]*([^\\n]+)`));
    match(field.id, new RegExp(`(?:^|\\n)[ \\t]*${label}[ \\t]*:?[ \\t]*\\n[ \\t]*([^\\n]+)`));
  }
  for (const [id, labels] of Object.entries(ALIASES)) for (const label of labels) {
    if (['landlord.address', 'manager.address'].includes(id) && hasContact(id)) continue;
    const pattern = escapeRe(label).replace(/\s+/g, '[ \\t]+');
    match(id, new RegExp(`(?:^|\\n)[ \\t]*${pattern}[ \\t]*(?:[:：–—]|\\t)[ \\t]*([^\\n]+)`));
    match(id, new RegExp(`(?:^|\\n)[ \\t]*${pattern}[ \\t]*:?[ \\t]*\\n[ \\t]*([^\\n]+)`));
  }

  // Parties, manager and payee, wherever the sentence names them.
  sentence('landlord.entity_name', /by and between\s+(.{2,160}?)\s*\(the\s*"Landlord"\)/i);
  sentence('landlord.print_name', /\bI,\s*(.{2,120}?)\s*\(owner or representative name in print\)/i);
  scan(/Name of landlord \(owner or managing agent\):\s*(.*?)\s*Address of landlord \(owner or managing agent\):\s*(.*?)\s*(?=For further information|$)/i, (item, line) => { add('landlord.entity_name', item[1], item[0], line); add('landlord.address', item[2], item[0], line); });
  sentence('manager.name', /Tenant is hereby notified that\s+(.{2,160}?)\s+is the property manager/i);
  scan(/Landlord\/Manager listed here:\s*([^,.]{2,80}?)\s*,\s*([\d() .+-]{7,25}?)\s*\./i, (item, line) => { add('manager.name', item[1], item[0], line); add('manager.phone', item[2], item[0], line); });
  const management = /\d+\.\s*Management\.[\s\S]*?(?=\n\s*\d+\.\s|$)/i.exec(text);
  if (management) for (const [id, label] of [['manager.address', 'Address'], ['manager.phone', 'Telephone']]) {
    const item = new RegExp(`${label}:[ \\t]*([^\\n]+)`, 'i').exec(management[0]);
    if (item && !hasContact(id)) add(id, item[1], item[0], lineOf(management.index + item.index));
  }
  sentence('payee.address', /Payment address:\s*(.+?)(?:,?\s+or at such other place|\.\s|$)/i);
  // Only inside the payment instructions, never the security-deposit bank.
  const payment = /For ACH,[\s\S]{0,900}?Account Name:\s*([^\n]+)/i.exec(text);
  if (payment) add('payee.name', payment[1], payment[0].split(/Account Number:/i)[0], lineOf(payment.index));
  sentence('emergency.phone', /In case of a housing emergency,? call:?\s*(\d[\d() .+-]{6,24}\d)/i);
  scan(/gas service provider for this building as follows:\s*(.{2,60}?)\s*:?\s+(\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\s*Provider\s*:?\s+Number/i, (item, line) => { add('gas.provider_name', item[1], item[0], line); add('gas.provider_phone', item[2], item[0], line); });

  // Terms and fees stated in the body of the lease.
  sentence('rent.due_day', /payable in advance on the\s+(\d{1,2}(?:st|nd|rd|th)?)\s+day of each month/i);
  sentence('rent.due_day', /due date for the Monthly Rent payment shall be day\s+(\d{1,2})\b/i);
  sentence('lease.end_time', /shall end on\s+\S+\s+at\s+(\d{1,2}:\d{2}\s*[AaPp]\.?[Mm]\.?)\s*\(the "End Date"\)/i);
  scan(/in the following bank:\s*(.{2,200}?)\.\s+In the event that the Security Deposit/i, (item, line) => { const [name, ...rest] = item[1].split(','); add('deposit.bank_name', name, item[0], line); if (rest.length) add('deposit.bank_address', rest.join(',').trim(), item[0], line); });
  scan(/more than\s+(\d{1,3})\s+consecutive days or\s+(\d{1,3})\s+total days within any\s+(\d{1,3})[- ]day period/i, (item, line) => { add('guest.consecutive_days', item[1], item[0], line); add('guest.total_days', item[2], item[0], line); add('guest.window_days', item[3], item[0], line); });
  sentence('fee.returned_payment', new RegExp(`(?:Non-Sufficient Funds|Returned (?:payment|check)s?)[.\\s:]+(?:Tenant will be charged a monetary fee of|Fee[:\\s]*)\\s*${AMOUNT}`, 'i'));
  sentence('fee.returned_payment', new RegExp(`Returned Checks or Electronic Payment Rejection.{0,400}?processing fee of\\s*${AMOUNT}`, 'i'));
  sentence('fee.lock_change_admin', new RegExp(`costs? of changing the locks?\\s*,?\\s*plus an administrative fee of\\s*${AMOUNT}`, 'i'));
  sentence('fee.animal_liability_cap', new RegExp(`Landlord'?s liability, if any, shall not exceed\\s*${AMOUNT}`, 'i'));
  sentence('fee.lptli_monthly', new RegExp(`at Tenant'?s monthly expense of\\s*${AMOUNT}`, 'i'));
  sentence('fee.renters_insurance_waiver_monthly', new RegExp(`Monthly Renters Insurance Waiver:\\s*${AMOUNT}`, 'i'));
  sentence('fee.lptli_admin_monthly', new RegExp(`Monthly Administrative Fee for Landlord Placed Liability Insurance:\\s*${AMOUNT}`, 'i'));
  scan(new RegExp(`${MARK}\\s*:?\\s*If checkbox is selected, attorneys'? fees recovery for the prevailing party shall not exceed\\s*(?:${AMOUNT})?`, 'i'), (item, line) => { add('attorney_fees.cap_enabled', checked(item[1]), item[0], line); if (item[2]) add('attorney_fees.cap_amount', item[2], item[0], line); });

  // Insurance and smoking, as a sentence or as a pair of boxes.
  sentence('insurance.min_liability', new RegExp(`tenant must maintain insurance with coverage of at least\\s*${AMOUNT}\\s+for general liability`, 'i'));
  sentence('insurance.required_yes', /(tenant must maintain insurance with coverage of at least\s*\$[\d,]+(?:\.\d{1,2})?\s+for general liability)/i, 1, () => true);
  sentence('insurance.min_liability', new RegExp(`minimum liability coverage of\\s*${AMOUNT}\\s+per occurrence`, 'i'));
  scan(new RegExp(`Renters insurance\\s*${MARK}\\s*IS\\s+or\\s*${MARK}\\s*IS NOT required`, 'i'), (item, line) => pair('insurance.required_yes', 'insurance.required_no', item, line));
  scan(new RegExp(`Smoking\\s*${MARK}\\s*IS\\s+or\\s*${MARK}\\s*IS NOT allowed in the Unit`, 'i'), (item, line) => pair('smoking.in_unit_yes', 'smoking.in_unit_no', item, line));
  sentence('smoking.in_unit_no', /(Smoking is prohibited in any area in or on the Property, both private and common, whether enclosed or outdoors)/i, 1, () => true);

  // Utilities: the responsible-party table, or a list of what the landlord pays.
  const utilityTable = region(/UTILITY OR SERVICE\s*:?\s*RESPONSIBLE PARTY/i, /RESPONSIBLE PARTY\s*\.\s*The Responsible Party/i, 1500);
  for (const [label, id] of UTILITY_ROWS) inRegion(utilityTable, new RegExp(`(?:^|PARTY|Landlord|Tenant|N\\/A)\\s*:?\\s*${label}\\s*:?\\s*(Landlord|Tenant|N\\/A)\\b`, 'i'), (item, line) => add(id, item[1], item[0], line));
  let others = 0;
  // A payer printed beside an unnamed spare row is the old lease's slip, not a
  // setting; only a name, or the N/A that parks the row, is worth importing.
  inRegion(utilityTable, /Other:\s*([^:]{0,60}?)\s*:?\s*\b(Landlord|Tenant|N\/A)\b/i, (item, line) => { others += 1; if (others > 2) return; const name = item[1].trim(); if (name) add(`utility.other${others}_label`, item[1], item[0], line); if (name || /^N\/A$/i.test(item[2])) add(`utility.other${others}`, item[2], item[0], line); });
  const utilities = /Utilities and Services\.[\s\S]*?except for the following, which will be paid by Landlord:\s*([\s\S]*?)(?=Tenant acknowledges|\n\s*\d+\.|$)/i.exec(text);
  if (utilities) for (const [id, word] of [['water', 'Water'], ['trash', 'Garbage'], ['gas', 'Gas'], ['electricity', 'Electricity'], ['internet', 'Internet']]) {
    if (new RegExp(`(?:^|\\n)\\s*(?:[-•]\\s*)?${word}\\s*(?:\\n|$)`, 'i').test(utilities[1])) add(`utility.${id}`, 'Landlord', `Paid by Landlord: ${clean(utilities[1])}`, lineOf(utilities.index));
  }
  sentence('utility.electricity', /(Tenant shall be responsible for paying the electricity used for the heating system)/i, 1, () => 'Tenant');

  // The key rider and the fine schedule.
  const keyTable = region(/Key Description/i, /\bLOCKS\b/i, 900);
  for (const [label, id] of KEY_ROWS) inRegion(keyTable, new RegExp(`${label}\\s*:?\\s*(?:(\\d{1,3})\\b(?!\\.))?\\s*(?:${AMOUNT})?`, 'i'), (item, line) => { if (item[1] !== undefined) add(`key.${id}_qty`, item[1], item[0], line); if (item[2] !== undefined) add(`key.${id}_charge`, item[2], item[0], line); });
  inRegion(keyTable, new RegExp(`Other:\\s*([A-Za-z][^\\d$]{0,40})?\\s*(?:(\\d{1,3})\\b(?!\\.))?\\s*(?:${AMOUNT})?`, 'i'), (item, line) => { if (item[1]?.trim()) add('key.other_label', item[1], item[0], line); if (item[2] !== undefined) add('key.other_qty', item[2], item[0], line); if (item[3] !== undefined) add('key.other_charge', item[3], item[0], line); });
  const fineTable = region(/Fine Schedule/i, /Charges assessed as Additional Rent/i, 1500);
  if (fineTable) {
    const rows = FINE_ROWS.map(([label, id]) => { const item = new RegExp(label, 'i').exec(fineTable.text); return item && {id, start: item.index, end: item.index + item[0].length}; }).filter(Boolean).sort((a, b) => a.start - b.start);
    rows.forEach((row, n) => { const value = fineTable.text.slice(row.end, rows[n + 1]?.start ?? fineTable.text.length).replace(/^\s*[:：]?\s*/, '').trim(); if (value) add(row.id, value, `${fineTable.text.slice(row.start, row.end)} ${value}`, fineTable.at(row.start)); });
  }

  // Building disclosures: bedbug history, sprinkler, gas, smoking policy.
  const bedbugForm = region(/\(Only boxes checked apply\)/i, /Signature of Tenant|Signature of\s+Owner|DBB-N/i, 1800);
  for (const [phrase, id] of BEDBUG_ROWS) inRegion(bedbugForm, new RegExp(`${MARK}\\s*:?\\s*${phrase}`, 'i'), (item, line) => add(id, checked(item[1]), item[0], line));
  match('bedbug.mark_none', /(?:\[\s*[xX]\s*\]|☒|☑)\s*(There is no history of any bedbug infestation within the past year in the building or in any apartment)/, 1, () => true);
  scan(new RegExp(`(?:^|[\\s(])(?:${CHECKED}|X)\\s*:?\\s*Option\\s*([12])\\s*:`), (item, line) => add(`sprinkler.mark_option${item[1]}`, true, item[0], line));
  scan(new RegExp(`(?:^|[\\s(])${UNCHECKED}\\s*:?\\s*Option\\s*([12])\\s*:`), (item, line) => add(`sprinkler.mark_option${item[1]}`, false, item[0], line));
  sentence('sprinkler.mark_option1', /(The Leased Premises is NOT serviced by a maintained and operative sprinkler system)/i, 1, () => true);
  sentence('sprinkler.last_inspection', /maintained and inspected was on\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const smokingPolicy = region(/Location\(s\) where smoking is not allowed/i, /Rent-stabilized and rent-controlled units may be exempt/i, 1500);
  for (const [phrase, id] of SMOKING_ROWS) inRegion(smokingPolicy, new RegExp(`${MARK}\\s*:?\\s*${phrase}`, 'i'), (item, line) => add(id, checked(item[1]), item[0], line));
  inRegion(smokingPolicy, /Other areas\s*\/\s*exceptions:\s*([^*]{0,200}?)\s*(?=\*|$)/i, (item, line) => { if (/[A-Za-z]/.test(item[1])) add('smoking.other_areas_text', item[1], item[0], line); });

  // DHCR consent and the Good Cause Eviction notice.
  scan(new RegExp(`Lease Description:\\s*(?:\\(Please\\s*select only one\\))?\\s*${MARK}\\s*:?\\s*Vacancy lease\\s*${MARK}\\s*:?\\s*Renewal lease`, 'i'), (item, line) => { const vacancy = checked(item[1]), renewal = checked(item[2]); if (vacancy !== renewal) add('dhcr.lease_type', vacancy ? 'Vacancy lease' : 'Renewal lease', item[0], line); });
  scan(new RegExp(`MARK APPLICABLE ANSWER\\)\\s*YES\\s*:?\\s*(X|${CHECKED})?\\s*NO\\s*:?\\s*(X|${CHECKED})?`), (item, line) => { if (item[1] || item[2]) { add('good_cause.mark_yes', Boolean(item[1]), item[0], line); add('good_cause.mark_no', Boolean(item[2]), item[0], line); } });
  const exemptions = region(/WHY IS IT EXEMPT FROM THAT LAW/i, /JUSTIFICATION FOR INCREASING THE RENT|NOT RENEWING A LEASE/i, 9000);
  inRegion(exemptions, new RegExp(`(?:(section 213 of the Real Property Law)|\\(exemption under subdivision (\\d{1,2}) of section 214 of the Real Property Law\\))\\s*:?\\s*${MARK}?\\s*;`, 'i'), (item, line) => { const id = item[1] ? 'not_adopted' : EXEMPTIONS[item[2]]; if (id && item[3]) add(`good_cause.exempt_${id}`, checked(item[3]), item[0], line); });
  const increase = region(/JUSTIFICATION FOR INCREASING THE RENT/i, /NOT RENEWING A LEASE/i, 4000);
  inRegion(increase, new RegExp(`not being increased above the threshold for presumptively unreasonable rent increases described above\\s*:?\\s*${MARK}?\\s*;`, 'i'), (item, line) => { if (item[1]) add('good_cause.increase_below_threshold', checked(item[1]), item[0], line); });
  inRegion(increase, new RegExp(`(?<!not )being increased above the threshold for presumptively unreasonable rent increases described above\\s*:?\\s*${MARK}?\\s*;`, 'i'), (item, line) => { if (item[1]) add('good_cause.increase_above_threshold', checked(item[1]), item[0], line); });
  inRegion(increase, /what is the justification for the increase:\s*(.{0,600}?)\s*(?=4\.\s*IF THIS UNIT|IF THIS UNIT IS SUBJECT|$)/i, (item, line) => { if (/[A-Za-z]/.test(item[1])) add('good_cause.increase_justification', item[1], item[0], line); });
  const nonrenewal = region(/NOT RENEWING A LEASE, WHAT IS THE GOOD CAUSE/i, null, 12000);
  inRegion(nonrenewal, new RegExp(`(?:\\((IF THIS ANSWER IS CHECKED, NO OTHER ANSWERS TO THIS QUESTION SHOULD BE CHECKED)\\)|\\(exemption under subdivision ([34]) of section 214 of the Real Property Law\\)|\\(good cause for eviction under paragraph ([a-j]) of subdivision 1 of section 216 of the Real Property Law\\))\\s*:?\\s*${MARK}?\\s*[;.]`, 'i'), (item, line) => {
    const before = nonrenewal.text.slice(Math.max(0, item.index - 400), item.index);
    const id = item[1] ? (/first lease or a renewal lease/i.test(before) ? 'first_or_renewal' : 'exempt') : item[2] ? (item[2] === '3' ? 'sublet' : 'employment') : NONRENEWAL_PARAGRAPHS[item[3].toLowerCase()];
    if (id && item[4]) add(`good_cause.nonrenewal_${id}`, checked(item[4]), item[0], line);
  });

  // Completing a binary answer also clears its opposite. Both remain visible
  // as separate rows so the reviewer sees the entire proposed change.
  for (const [yes, no] of EXCLUSIVE_PAIRS) {
    const a = found.get(yes), b = found.get(no);
    if (a?.length === 1 && a[0].value === true && !b) {
      add(no, false, a[0].evidence);
      if (found.has(no)) found.get(no)[0].location = a[0].location;
    }
    if (b?.length === 1 && b[0].value === true && !a) {
      add(yes, false, b[0].evidence);
      if (found.has(yes)) found.get(yes)[0].location = b[0].location;
    }
    if (a?.some(v => v.value === true) && b?.some(v => v.value === true)) warnings.push(`Conflicting choices: ${allowed.get(yes)?.label}. Review both rows.`);
  }
  // Unit identifiers and former tenant details are outside this import's
  // scope. They do not produce review candidates or discrepancy warnings.
  if (/rekeying fee/i.test(text)) warnings.push('A rekeying fee appears in the lease. Confirm whether it is a lock-change fee or a per-key replacement charge before entering it.');
  if (context.address.conflict) warnings.push('Different property addresses were found. Choose the correct premises address in Properties; no address was selected automatically.');
  else if (!context.address.value && context.address.candidates.length) warnings.push('A possible property address appears near tenant details. Confirm its role in Properties before using it.');
  return {
    sourceAddress: context.address.value, addressReview: context.address, warnings,
    candidates: [...found].map(([id, options]) => ({id, ...options[0], conflict: options.length > 1, alternatives: options.slice(1)}))
  };
}

// Narrow the outgoing patch again after review; a draft can never introduce a
// tenant field. Callers refresh current values immediately before this step.
export function buildImportPatch(rows, fields, current, baseline) {
  const patch = {}, allowed = new Map(fields.filter(f => f.source === 'manager').map(f => [f.id, f]));
  for (const row of rows.filter(row => row.selected)) {
    const field = allowed.get(row.id);
    if (!field) throw new Error('This field cannot be saved as a property default.');
    const value = normalizeImportValue(field, row.value);
    if (value === null) throw new Error(`Check the value for ${field.label}. Empty values will not erase existing settings.`);
    if ((current[row.id] ?? null) !== (baseline[row.id] ?? null)) throw new Error(`${field.label} changed while you were reviewing. Close and reopen the import to review the latest settings.`);
    patch[row.id] = value;
  }
  if (!Object.keys(patch).length) throw new Error('Select at least one field to save.');
  for (const [yes, no] of EXCLUSIVE_PAIRS) {
    if (!(yes in patch) && !(no in patch)) continue;
    // Clearing the opposite must be explicitly included in the reviewed rows.
    if ((patch[yes] ?? current[yes]) === true && (patch[no] ?? current[no]) === true) throw new Error('Opposite choices are both marked. Review and select both rows to save a consistent answer.');
  }
  return patch;
}
