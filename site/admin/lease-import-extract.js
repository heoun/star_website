// Conservative, evidence-based extraction. Only registry manager fields can
// become defaults. No inference of legal status, tenant terms or bank accounts.
export const MAX_TEXT = 500000;
export const EXCLUSIVE_PAIRS = [
  ['insurance.required_yes', 'insurance.required_no'],
  ['smoking.in_unit_yes', 'smoking.in_unit_no'],
  ['sprinkler.mark_option2', 'sprinkler.mark_option1'],
  ['good_cause.mark_yes', 'good_cause.mark_no']
];
const clean = value => String(value ?? '').replace(/[_\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function extractPropertyAddress(text) {
  // A cover-sheet "Address" can be a former tenant's mailing address. Only
  // explicitly identified premises/building addresses belong in this review.
  const labelled = /(?:^|\n)[ \t]*(?:Property|Building|Premises) address:[ \t]*([^\n]{5,180})/i.exec(text);
  const propertyClause = /(?:^|\n)\s*\d+\.\s*Property\.[\s\S]*?(?=\n\s*\d+\.\s|$)/i.exec(text);
  const located = propertyClause && /located at\s+([^\n]{5,180}?\b\d{5}(?:-\d{4})?)\s*\(the\s*"Building"\)/i.exec(propertyClause[0]);
  const address = clean(labelled?.[1] || located?.[1] || '');
  return address
    .replace(/\b(?:Unit|Apartment|Apt\.?|Suite|Ste\.?)\s*#?\s*\d+[A-Za-z0-9-]*\b/gi, '')
    .replace(/\b(Road|Rd\.?|Street|St\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Place|Pl\.?)\s+#?\d+[A-Za-z]?\s*(?=,)/gi, '$1')
    .replace(/,\s*,/g, ',').replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim();
}
export function normalizeImportValue(field, raw) {
  if (typeof raw === 'boolean') return field.type === 'checkbox' ? raw : null;
  const value = clean(raw);
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
    const [,m,d,y] = match.map(Number), date = new Date(Date.UTC(y,m-1,d));
    if (date.getUTCMonth() !== m-1 || date.getUTCDate() !== d) return null;
  }
  // The settings API stores at most 400 characters per field.
  return value.length <= 400 ? value : null;
}

export function extractLeaseDefaults(text, fields) {
  if (text.length > MAX_TEXT) throw new Error('This lease has too much text. Upload a smaller lease package.');
  const allowed = new Map(fields.filter(field => field.source === 'manager').map(field => [field.id, field]));
  text = text.replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[ \t]+/g, ' ');
  const found = new Map(), warnings = [];
  const add = (id, raw, evidence, index = 0) => {
    const field = allowed.get(id); if (!field) return;
    const value = normalizeImportValue(field, raw); if (value === null) return;
    const item = {value, evidence: clean(evidence).slice(0, 700), location: `Text line ${text.slice(0, index).split('\n').length}`};
    const list = found.get(id) || [];
    if (!list.some(previous => previous.value === value)) list.push(item);
    found.set(id, list);
  };
  const match = (id, regex, group = 1, transform = value => value) => {
    for (const item of text.matchAll(new RegExp(regex.source, 'gi'))) add(id, transform(item[group]), item[0], item.index);
  };
  // Labelled forms and tables. Exact labels only; ambiguous labels like "Other"
  // and generic "Bank address" cannot establish a field's context on their own.
  for (const field of allowed.values()) {
    if (field.label.length < 8 || ['deposit.bank_address'].includes(field.id)) continue;
    const label = escapeRe(field.label).replace(/\s+/g, '[ \\t]+');
    match(field.id, new RegExp(`(?:^|\\n)[ \\t]*${label}[ \\t]*[:\\t][ \\t]*([^\\n]+)`));
    match(field.id, new RegExp(`(?:^|\\n)[ \\t]*${label}[ \\t]*:?[ \\t]*\\n[ \\t]*([^\\n]+)`));
  }
  match('landlord.entity_name', /by and between\s+([^\n]{2,160}?)\s*\(the\s*"Landlord"\)/);
  match('manager.name', /(?:Tenant is hereby notified that)\s+([^\n]{2,160}?)\s+is the property manager/);
  match('rent.due_day', /payable in advance on the\s+(\d{1,2}(?:st|nd|rd|th)?)\s+day of each month/);
  match('fee.returned_payment', /(?:Non-Sufficient Funds|Returned (?:payment|check)s?)[.\s:]+(?:Tenant will be charged a monetary fee of|Fee[:\s]*)\s*\$([\d,]+(?:\.\d{1,2})?)/);
  match('payee.address', /Payment address:\s*([^\n]+?)(?:,?\s+or at such other place|\n|$)/);
  // Only inside the payment instructions, never the security-deposit bank.
  const payment = /For ACH,[\s\S]{0,900}?Account Name:\s*([^\n]+)/i.exec(text);
  if (payment) add('payee.name', payment[1], payment[0].split(/Account Number:/i)[0], payment.index);
  const management = /\d+\.\s*Management\.[\s\S]*?(?=\n\s*\d+\.\s|$)/i.exec(text);
  if (management) {
    for (const [id, label] of [['manager.address', 'Address'], ['manager.phone', 'Telephone']]) {
      const item = new RegExp(`${label}:[ \\t]*([^\\n]+)`, 'i').exec(management[0]);
      if (item) add(id, item[1], item[0], management.index + item.index);
    }
  }
  const notice = /\d+\.\s*Notice\.[\s\S]*?(?=\n\s*\d+\.\s|$)/i.exec(text);
  if (notice) {
    const item = /Landlord:\s*\n\s*([^\n]+)\s*\n\s*([^\n]+)/i.exec(notice[0]);
    if (item) {
      add('landlord.entity_name', item[1], item[0], notice.index + item.index);
      add('landlord.address', item[2], item[0], notice.index + item.index);
      // Notice recipient is explicit here, not inferred from an unrelated address.
      add('legal_notice.name', item[1], item[0], notice.index + item.index);
      add('legal_notice.address', item[2], item[0], notice.index + item.index);
    }
  }
  match('insurance.min_liability', /(?:tenant must maintain insurance with coverage of at least)\s*\$([\d,]+(?:\.\d{1,2})?)\s+for general liability/);
  match('insurance.required_yes', /(tenant must maintain insurance with coverage of at least\s*\$[\d,]+(?:\.\d{1,2})?\s+for general liability)/, 1, () => true);
  match('smoking.in_unit_no', /(Smoking is prohibited in any area in or on the Property, both private and common, whether enclosed or outdoors)/, 1, () => true);
  match('sprinkler.mark_option1', /(The Leased Premises is NOT serviced by a maintained and operative sprinkler system)/, 1, () => true);
  const bedbug = /(?:\[\s*[xX]\s*\]|☒|☑)\s*(There is no history of any bedbug infestation within the past year in the building or in any apartment)/g;
  match('bedbug.mark_none', bedbug, 1, () => true);
  const utilities = /Utilities and Services\.[\s\S]*?except for the following, which will be paid by Landlord:\s*([\s\S]*?)(?=Tenant acknowledges|\n\s*\d+\.|$)/i.exec(text);
  if (utilities) {
    for (const [id, word] of [['water','Water'], ['trash','Garbage'], ['gas','Gas'], ['electricity','Electricity'], ['internet','Internet']]) {
      if (new RegExp(`(?:^|\\n)\\s*(?:[-•]\\s*)?${word}\\s*(?:\\n|$)`, 'i').test(utilities[1])) add(`utility.${id}`, 'Landlord', `Paid by Landlord: ${clean(utilities[1])}`, utilities.index);
    }
  }
  match('utility.electricity', /(Tenant shall be responsible for paying the electricity used for the heating system)/, 1, () => 'Tenant');
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
    if (a?.some(v=>v.value === true) && b?.some(v=>v.value === true)) warnings.push(`Conflicting choices: ${allowed.get(yes)?.label}. Review both rows.`);
  }
  // Unit identifiers and former tenant details are outside this import's
  // scope. They do not produce review candidates or discrepancy warnings.
  if (/rekeying fee/i.test(text)) warnings.push('A rekeying fee appears in the lease. Confirm whether it is a lock-change fee or a per-key replacement charge before entering it.');
  return {
    sourceAddress: extractPropertyAddress(text), warnings,
    candidates: [...found].map(([id, options]) => ({id, ...options[0], conflict: options.length > 1, alternatives: options.slice(1)}))
  };
}

// Narrow the outgoing patch again after review; a draft can never introduce a
// tenant field. Callers refresh current values immediately before this step.
export function buildImportPatch(rows, fields, current, baseline) {
  const patch = {}, allowed = new Map(fields.filter(f=>f.source === 'manager').map(f=>[f.id,f]));
  for (const row of rows.filter(row=>row.selected)) {
    const field = allowed.get(row.id);
    if (!field) throw new Error('This field cannot be saved as a property default.');
    const value = normalizeImportValue(field, row.value);
    if (value === null) throw new Error(`Check the value for ${field.label}. Empty values will not erase existing settings.`);
    if ((current[row.id] ?? null) !== (baseline[row.id] ?? null)) throw new Error(`${field.label} changed while you were reviewing. Close and reopen the import to review the latest settings.`);
    patch[row.id] = value;
  }
  if (!Object.keys(patch).length) throw new Error('Select at least one field to save.');
  for (const [yes,no] of EXCLUSIVE_PAIRS) {
    if (!(yes in patch) && !(no in patch)) continue;
    // Clearing the opposite must be explicitly included in the reviewed rows.
    if ((patch[yes] ?? current[yes]) === true && (patch[no] ?? current[no]) === true) throw new Error('Opposite choices are both marked. Review and select both rows to save a consistent answer.');
  }
  return patch;
}
