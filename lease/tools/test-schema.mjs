// Runs supabase/schema.sql against a real PostgreSQL and checks the lease
// settings tables behave the way a legal document needs them to.
//
// Unlike the other tools here this one needs a database, so it is opt-in:
//
//     npm install --no-save @electric-sql/pglite
//     node lease/tools/test-schema.mjs
//
// PGlite is real PostgreSQL compiled to WebAssembly, so the constraints,
// partial indexes, triggers and grants are exercised for real rather than
// hand-read. package.json is deliberately left without dependencies — install
// it when you need it and let it go again.
//
// What it guards: that an unanswered setting cannot be stored as a blank, that
// the three layers merge company < building < unit, that saving part of a layer
// does not wipe the rest, that every change is audited, and that the anon key
// cannot read any of it.

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const SQL = readFileSync('/Users/seaxu/Downloads/star_website/supabase/schema.sql', 'utf8');
const FIELDS = JSON.parse(readFileSync('/Users/seaxu/Downloads/star_website/lease/schema/fields.json', 'utf8'));

const db = new PGlite();
const ok = [], bad = [];
const t = (name, cond, extra='') => (cond ? ok : bad).push(name + (extra ? ` — ${extra}` : ''));

await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;`);

// 1. runs clean, and runs clean a second time
try { await db.exec(SQL); t('schema.sql applies', true); }
catch (e) { t('schema.sql applies', false, e.message); throw e; }
try { await db.exec(SQL); t('schema.sql is re-runnable (idempotent)', true); }
catch (e) { t('schema.sql is re-runnable (idempotent)', false, e.message); }

// 2. seed a building + listing
const { rows: [b] } = await db.query(
  `insert into buildings (name, street, city, state, state_abbr, zip)
   values ('Evergarden','37-34 33rd Street','Long Island City','New York','NY','11101') returning id`);
const { rows: [l] } = await db.query(
  `insert into listings (category, transaction_type, title, unit, building_id)
   values ('residential','rental','LIC Condo','4E',$1) returning id`, [b.id]);

// 3. shape check
const shape = async (json) => { try { await db.query(
  `insert into lease_settings (scope, listing_id, field_values) values ('unit',$1,$2::jsonb)`,
  [l.id, json]); await db.query(`delete from lease_settings where scope='unit'`); return true;
} catch { return false; } };
t('shape accepts a normal value',      await shape('{"utility.water":"Landlord"}'));
t('shape accepts a checkbox boolean',   await shape('{"bedbug.mark_none":true}'));
t('shape rejects an empty string',     !(await shape('{"deposit.bank_name":""}')));
t('shape rejects json null',           !(await shape('{"deposit.bank_name":null}')));
t('shape rejects a nested object',     !(await shape('{"a.b":{"c":1}}')));
t('shape rejects a bad key',           !(await shape('{"notafield":"x"}')));

// every real registry id is storable
const all = Object.fromEntries(FIELDS.fields.map(f => [f.id, f.type === 'checkbox' ? true : 'x']));
t('all 130 registry ids are accepted', await shape(JSON.stringify(all)), `${FIELDS.fields.length} ids`);

// 4. scope constraints
const scoped = async (sql, params) => { try { await db.query(sql, params); return true; } catch { return false; } };
t('company row may not carry a listing',
  !(await scoped(`insert into lease_settings (scope, listing_id) values ('company',$1)`, [l.id])));
t('building row requires a building',
  !(await scoped(`insert into lease_settings (scope) values ('building')`, [])));
await db.query(`insert into lease_settings (scope) values ('company')`);
t('a second company row is refused',
  !(await scoped(`insert into lease_settings (scope) values ('company')`, [])));
t('a second building row for one building is refused',
  (await scoped(`insert into lease_settings (scope, building_id) values ('building',$1)`, [b.id]))
  && !(await scoped(`insert into lease_settings (scope, building_id) values ('building',$1)`, [b.id])));
await db.query(`delete from lease_settings where scope='building'`);

// 5. apply RPC: merge, then clear
await db.query(`select lease_settings_apply('company', null, null, $1::jsonb, 'a@x.com')`,
  ['{"fee.returned_payment":"$25.00","rent.due_day":"1"}']);
await db.query(`select lease_settings_apply('company', null, null, $1::jsonb, 'a@x.com')`,
  ['{"rent.due_day":"5"}']);
let { rows: [c] } = await db.query(`select field_values from lease_settings where scope='company'`);
t('apply merges without dropping untouched keys',
  c.field_values['fee.returned_payment'] === '$25.00' && c.field_values['rent.due_day'] === '5',
  JSON.stringify(c.field_values));
await db.query(`select lease_settings_apply('company', null, null, $1::jsonb, 'a@x.com')`,
  ['{"rent.due_day":null}']);
({ rows: [c] } = await db.query(`select field_values from lease_settings where scope='company'`));
t('a json null unanswers a field (key removed, not blanked)',
  !('rent.due_day' in c.field_values), JSON.stringify(c.field_values));

// 6. three-layer merge order
await db.query(`select lease_settings_apply('building', $1, null, $2::jsonb, 'a@x.com')`,
  [b.id, '{"utility.water":"Landlord","bedbug.mark_none":true}']);
await db.query(`select lease_settings_apply('unit', null, $1, $2::jsonb, 'a@x.com')`,
  [l.id, '{"utility.water":"Tenant"}']);
const { rows: [m] } = await db.query(`select lease_settings_for_listing($1) as layers`, [l.id]);
const merged = { ...m.layers.company, ...m.layers.building, ...m.layers.unit };
t('unit overrides building', merged['utility.water'] === 'Tenant', merged['utility.water']);
t('building value survives where the unit is silent', merged['bedbug.mark_none'] === true);
t('company value survives', merged['fee.returned_payment'] === '$25.00');

// 7. audit
const { rows: [a1] } = await db.query(`select count(*)::int n from lease_settings_audit`);
t('audit rows are written', a1.n > 0, `${a1.n} rows`);
const { rows: [a2] } = await db.query(
  `select actor from lease_settings_audit order by created_at desc limit 1`);
t('audit records the actor', a2.actor === 'a@x.com', String(a2.actor));

// audit survives a cascade delete
const before = (await db.query(`select count(*)::int n from lease_settings_audit`)).rows[0].n;
await db.query(`delete from lease_settings where scope='unit'`);
const after = (await db.query(`select count(*)::int n from lease_settings_audit`)).rows[0].n;
t('a delete is audited too', after > before, `${before} -> ${after}`);

// 8. a building with units cannot be deleted out from under its settings
t('deleting a building with units is refused',
  !(await scoped(`delete from buildings where id=$1`, [b.id])));

// 9. privileges
const priv = async (role, table, p) => (await db.query(
  `select has_table_privilege($1,$2,$3) as y`, [role, table, p])).rows[0].y;
t('service_role can read lease_settings', await priv('service_role','public.lease_settings','SELECT'));
t('anon cannot read lease_settings',     !(await priv('anon','public.lease_settings','SELECT')));
t('anon cannot read buildings',          !(await priv('anon','public.buildings','SELECT')));
t('audit is not updatable by service_role', !(await priv('service_role','public.lease_settings_audit','UPDATE')));

console.log(`PASS ${ok.length}`);
for (const o of ok) console.log('  ok   ' + o);
if (bad.length) { console.log(`\nFAIL ${bad.length}`); for (const x of bad) console.log('  FAIL ' + x); process.exit(1); }
