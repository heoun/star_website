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
// the two layers merge property < unit, that saving part of a layer
// does not wipe the rest, that every change is audited, that the anon key
// cannot read any of it, and that the staff table cannot hold a row the Worker
// would then have to guess about.

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
import { readFileSync } from 'node:fs';
import { STATUSES } from '../../site/admin/application-view.js';

const SQL = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
const FIELDS = JSON.parse(readFileSync(new URL('../schema/fields.json', import.meta.url), 'utf8'));

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
   values ('Evergarden','12 Example Street','Long Island City','New York','NY','11101') returning id`);
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
t('the company layer is gone, and its scope refused',
  !(await scoped(`insert into lease_settings (scope) values ('company')`, [])));
t('building row may not carry a listing',
  !(await scoped(`insert into lease_settings (scope, building_id, listing_id) values ('building',$1,$2)`,
    [b.id, l.id])));
t('building row requires a building',
  !(await scoped(`insert into lease_settings (scope) values ('building')`, [])));
t('a second building row for one building is refused',
  (await scoped(`insert into lease_settings (scope, building_id) values ('building',$1)`, [b.id]))
  && !(await scoped(`insert into lease_settings (scope, building_id) values ('building',$1)`, [b.id])));
await db.query(`delete from lease_settings where scope='building'`);

// 5. apply RPC: merge, then clear
await db.query(`select lease_settings_apply('building', $1, null, $2::jsonb, 'a@x.com')`,
  [b.id, '{"fee.returned_payment":"$25.00","rent.due_day":"1"}']);
await db.query(`select lease_settings_apply('building', $1, null, $2::jsonb, 'a@x.com')`,
  [b.id, '{"rent.due_day":"5"}']);
let { rows: [c] } = await db.query(`select field_values from lease_settings where scope='building'`);
t('apply merges without dropping untouched keys',
  c.field_values['fee.returned_payment'] === '$25.00' && c.field_values['rent.due_day'] === '5',
  JSON.stringify(c.field_values));
await db.query(`select lease_settings_apply('building', $1, null, $2::jsonb, 'a@x.com')`,
  [b.id, '{"rent.due_day":null}']);
({ rows: [c] } = await db.query(`select field_values from lease_settings where scope='building'`));
t('a json null unanswers a field (key removed, not blanked)',
  !('rent.due_day' in c.field_values), JSON.stringify(c.field_values));

// 6. two-layer merge order
await db.query(`select lease_settings_apply('building', $1, null, $2::jsonb, 'a@x.com')`,
  [b.id, '{"utility.water":"Landlord","bedbug.mark_none":true}']);
await db.query(`select lease_settings_apply('unit', null, $1, $2::jsonb, 'a@x.com')`,
  [l.id, '{"utility.water":"Tenant"}']);
const { rows: [m] } = await db.query(`select lease_settings_for_listing($1) as layers`, [l.id]);
const merged = { ...m.layers.building, ...m.layers.unit };
t('unit overrides the property', merged['utility.water'] === 'Tenant', merged['utility.water']);
t('property value survives where the unit is silent', merged['bedbug.mark_none'] === true);
t('a value nothing later answers survives', merged['fee.returned_payment'] === '$25.00');
t('the merge has two layers and no third',
  Object.keys(m.layers).sort().join(',') === 'building,unit', Object.keys(m.layers).join(','));

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

// 10. the admin's own accounts
//
// The Worker looks a person up by the lower-cased address Cloudflare Access
// gave it. A row stored with a capital in it would be invisible to that lookup
// while looking present in the table, so the column refuses one.
const staff = async (sql, params=[]) => {
  try { await db.query(sql, params); return true; } catch { return false; }
};

t('a staff row is accepted',
  await staff(`insert into staff (email, role, name) values ('sam@x.com','agent','Sam')`));
t('a second row for the same address is refused',
  !(await staff(`insert into staff (email, role) values ('sam@x.com','manager')`)));
t('an address with a capital in it is refused, because the lookup lower-cases',
  !(await staff(`insert into staff (email, role) values ('Sam@X.com','agent')`)));
t('an address that is not one is refused',
  !(await staff(`insert into staff (email, role) values ('sam','agent')`)));
t('an address with a stray space is refused, for the same reason as a capital',
  !(await staff(`insert into staff (email, role) values (' kim@x.com','agent')`)));
t('a role the Worker does not know is refused',
  !(await staff(`insert into staff (email, role) values ('kim@x.com','sysadmin')`)));
t('a row with no role is refused',
  !(await staff(`insert into staff (email, name) values ('kim@x.com','Kim')`)));
t('an account is active unless it says otherwise',
  (await db.query(`select active from staff where email='sam@x.com'`)).rows[0].active === true);

await db.query(`update staff set role='manager' where email='sam@x.com'`);
const { rows: [touched] } = await db.query(
  `select updated_at > created_at as moved from staff where email='sam@x.com'`);
t('updated_at moves when a role changes', touched.moved === true);

t('service_role can manage staff', await priv('service_role','public.staff','SELECT'));
t('anon cannot read staff',        !(await priv('anon','public.staff','SELECT')));
t('authenticated cannot read staff — an applicant is signed in as that role',
  !(await priv('authenticated','public.staff','SELECT')));

// 9. an application's status, and the record of who set it
//
// Every status exposed by the application view must be accepted by storage.
// Import the shared list; the Worker now advances status through workspace actions.
const statuses = STATUSES.map(([value]) => value);

const insertStatus = async (status) => {
  try {
    await db.query(
      `insert into applications (listing_id, name, email, status) values ($1,'T','t@x.com',$2)`,
      [l.id, status]);
    return true;
  } catch { return false; }
};

const refused = [];
for (const status of statuses) if (!(await insertStatus(status))) refused.push(status);
t('every displayed application status is accepted by the table', refused.length === 0,
  refused.length ? `refused: ${refused.join(', ')}` : `${statuses.length} statuses`);
t('"needs information" is one of them', statuses.includes('needs_info'));
t('a status neither of them knows is still refused', !(await insertStatus('maybe')));

const { rows: [decided] } = await db.query(
  `insert into applications (listing_id, name, email, status) values ($1,'T','t@x.com','approved')
   returning id`, [l.id]);
await db.query(`update applications set decision = $2::jsonb where id = $1`, [decided.id,
  JSON.stringify({ status: 'approved', by: 'a@x.com', at: '2026-08-24T00:00:00Z', reason: 'income checks out' })]);
const { rows: [record] } = await db.query(
  `select decision->>'by' as who, decision->>'reason' as why from applications where id = $1`, [decided.id]);
t('the decision record keeps who decided and why',
  record.who === 'a@x.com' && record.why === 'income checks out');

// 10. what a property fixes, and what a sent lease keeps
//
// The signer's printed name is a lease value and lives in the settings layer
// with the other ninety-two. The address the signature request goes to is not
// in the document at all, so it has no placeholder and no registry entry, and
// it lives on the building it signs for.
await db.query(`update buildings set landlord_signer_email = 'signer@example.com' where id = $1`, [b.id]);
const { rows: [signer] } = await db.query(
  `select landlord_signer_email from buildings where id = $1`, [b.id]);
t('a property records where its signature request goes',
  signer.landlord_signer_email === 'signer@example.com');

// A lease that has gone out stops following the settings screen.
const { rows: [sent] } = await db.query(
  `insert into applications (listing_id, name, email, status) values ($1,'T','t@x.com','lease_sent')
   returning id`, [l.id]);
await db.query(`update applications set lease_snapshot = $2::jsonb where id = $1`, [sent.id,
  JSON.stringify({ 'landlord.entity_name': 'As it was when sent', 'rent.monthly': '$4,500.00' })]);
const { rows: [frozen] } = await db.query(
  `select lease_snapshot->>'landlord.entity_name' as entity from applications where id = $1`, [sent.id]);
t('a sent lease keeps the values it was generated from',
  frozen.entity === 'As it was when sent');

// The database checks the shape of a settings key, not its meaning — the
// registry is the Worker's to enforce (see test-permissions.mjs). Worth
// pinning down, because a reader who assumes otherwise would leave the only
// real check off a new route.
t('the database checks a settings key\'s shape, not the registry',
  await shape('{"not.aregistryfield":"x"}'));

console.log(`PASS ${ok.length}`);
for (const o of ok) console.log('  ok   ' + o);
if (bad.length) { console.log(`\nFAIL ${bad.length}`); for (const x of bad) console.log('  FAIL ' + x); process.exit(1); }
