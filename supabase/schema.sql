-- Star Realty listings schema.
-- Run once in the Supabase SQL editor (Dashboard > SQL Editor > New query).
--
-- Media bytes (photos, floor plans, videos) live in Cloudflare R2, not in
-- Supabase. This database stores listing data plus the R2 object paths that
-- tie each listing to its media.

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),

  -- Drives which page a listing appears on. Both values are required because
  -- the frontend filters on category + transaction type together.
  category text not null check (category in ('residential', 'commercial')),
  transaction_type text not null check (transaction_type in ('sale', 'rental')),

  title text not null,
  -- The name of the property this unit is in, as the website displays it. For
  -- a unit under a property row the Worker copies buildings.name into it on
  -- every save, so the label and the address a lease prints can never name
  -- two different buildings; a listing under no property — a house for sale —
  -- keeps a typed name.
  property_name text,
  unit text,
  description text,

  -- Stored as a number so listings can be sorted and filtered later. The Worker
  -- formats it for display; price_display overrides that when a listing needs
  -- wording like "Price on request".
  price_amount numeric,
  price_display text,

  property_type text,
  use_type text,
  size text,
  term_label text,
  location text,
  neighborhood text,
  bedrooms integer check (bedrooms >= 0),
  bathrooms numeric check (bathrooms >= 0),

  -- Either a /media/<path> URL for a video uploaded to R2, or an external
  -- link (e.g. an unlisted YouTube URL).
  video_url text,

  details_url text,
  kind_label text,

  published boolean not null default true,
  position integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Matches the feed query exactly: filter on published, order by position then
-- newest first (category filtering happens in the browser).
create index if not exists listings_feed_idx
  on public.listings (published, position, created_at desc);

create table if not exists public.listing_media (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  kind text not null default 'photo' check (kind in ('photo', 'floor_plan')),

  -- Object key inside the Cloudflare R2 bucket, e.g. "<listing-id>/<uuid>.webp".
  path text not null,

  caption text,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists listing_media_listing_idx
  on public.listing_media (listing_id, kind, position);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists listings_set_updated_at on public.listings;
create trigger listings_set_updated_at
  before update on public.listings
  for each row execute function public.set_updated_at();

-- Rental applications submitted from the public website. Full application:
-- identity, residence, employment, rental history, references, emergency
-- contacts, pets. The SSN never exists in plaintext here — the Worker
-- encrypts it (AES-256-GCM, key in the APP_ENCRYPTION_KEY Worker secret)
-- before insert, and only the last four digits are stored readable.
-- Credit reports, fee payment, and lease signing happen in outside systems;
-- their outcomes land in `status` and `notes`.
create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,

  name text not null,
  first_name text,
  last_name text,
  email text not null,
  phone text,
  current_address text,
  move_in text,
  lease_term_months integer check (lease_term_months between 1 and 60),
  dob text,
  -- The identity number is an SSN or a passport number — international
  -- students rarely have the first. `id_type` says which one `ssn_encrypted`
  -- holds; null means an SSN.
  id_type text check (id_type in ('ssn', 'passport')),
  ssn_encrypted text,
  ssn_last4 text,
  children_under_11 boolean,
  -- The window guard notice's third answer, for applicants without young
  -- children who want the guards anyway. The lease registry reads it as
  -- window_guard.mark_wants_anyway.
  wants_window_guards boolean,
  income_note text,

  -- Whether the applicant supports the rent by working or by studying. It
  -- decides which of `current_employer` and `student` is filled in, and which
  -- documents the portal checklist asks for.
  employment_status text check (employment_status in ('employed', 'student')),

  -- Structured sections, shaped by the Worker (never raw client JSON):
  -- current_employer  {employer, position, start, supervisor_name, supervisor_phone, supervisor_email}
  -- student            {school_name, major, entry_year, graduation_year, country}
  -- employment_history [{employer, position, start, income}]  (older rows also carry end, supervisor_*)
  -- rental_history     [{address, start, end, monthly_rent, landlord_name, landlord_phone, landlord_email}]
  -- reference_contacts [{name, relationship, phone, email}]  (2 required)
  -- emergency_contacts [{name, relationship, phone, email}]
  -- roommates          [{first_name, last_name, phone, email}]
  -- pets               [{type, species, weight}]
  current_employer jsonb,
  student jsonb,
  employment_history jsonb,
  rental_history jsonb,
  reference_contacts jsonb,
  emergency_contacts jsonb,
  roommates jsonb,
  pets jsonb,

  message text,

  -- What the applicant wrote, for any field an agent has since corrected in
  -- the admin console: {column: submitted_value}, written once per column the
  -- first time it changes. The lease has the tenant warrant that the
  -- application is accurate, so the version they warranted has to survive
  -- being corrected.
  submitted jsonb,

  -- The Rent Concession Rider, written for this tenancy. It reaches the lease
  -- as a deal value, so the overview and the lease screen edit the same text.
  concession_terms text,

  -- Every value the lease was generated from, frozen the moment it went out
  -- for signature: {field_id: value}. Without it a manager correcting a
  -- building default — a payee address, a fee, a disclosure — would silently
  -- change what an already-signed lease says the next time anyone opened it.
  -- A signed instrument does not follow the settings screen.
  lease_snapshot jsonb,

  status text not null default 'new'
    check (status in ('new', 'contacted', 'fee_pending', 'screening', 'review',
                      'sent_to_landlord', 'needs_info', 'approved', 'landlord_approved', 'declined',
                      'lease_sent', 'lease_signed')),
  notes text,

  -- The last time somebody moved this application to the status it is on:
  -- {status, by, at, reason}. Written by the Worker, never by the browser —
  -- the console says what it is doing, not who is doing it.
  --
  -- It is a column rather than a derivation because there is nowhere else for
  -- it to come from. `updated_at` says when the row last changed, which is not
  -- the same as when it was decided, and nothing anywhere records who. A
  -- decision panel that shows "reviewed by" has to have somebody to name.
  decision jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists applications_listing_idx
  on public.applications (listing_id, created_at desc);

drop trigger if exists applications_set_updated_at on public.applications;
create trigger applications_set_updated_at
  before update on public.applications
  for each row execute function public.set_updated_at();

-- No policies are defined, so anon and authenticated roles can do nothing.
-- Every read and write goes through the Worker using the service role key,
-- which bypasses RLS. No database key is ever shipped to a browser.
alter table public.listings enable row level security;
alter table public.listing_media enable row level security;
alter table public.applications enable row level security;

-- Newer Supabase projects no longer grant table privileges to service_role
-- automatically, so grant them explicitly.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.listings to service_role;
grant select, insert, update, delete on public.listing_media to service_role;
grant select, insert, update, delete on public.applications to service_role;

-- ---------------------------------------------------------------------------
-- Lease generation
-- ---------------------------------------------------------------------------

-- Of the lease's 130 placeholders, 110 are answered by a manager rather than
-- by the deal, and those answer at two levels: something true of a property,
-- something true of one unit. Generating a lease reads both and the later
-- layer wins — property < unit.
--
-- There is deliberately no layer above the property. One existed, holding the
-- terms that are the same company-wide, and it meant a lease could assert a
-- fine or a gas emergency number that nobody remembered setting and that no
-- property page showed. Every manager value is now typed on the property it
-- prints for: the same figure typed on ten properties is worth more than one
-- figure inherited invisibly by ten.
--
-- lease/schema/fields.json is the authority on which field ids exist and what
-- each one means. Nothing here repeats it: this stores values, the registry
-- says what a value is for.

-- The building layer needs something stable to hang off. listings.property_name
-- is a display label, so keying settings on that string would let a typo or a
-- rename silently point a unit at another building's bedbug history — a false
-- statement in a signed lease. Buildings get rows instead.
--
-- The address parts live here because this is where they are true: the bedbug
-- disclosure and the Good Cause notice want street, city, state and ZIP on
-- separate lines, and within one building only the unit number differs.
create table if not exists public.buildings (
  id uuid primary key default gen_random_uuid(),

  -- The property's name. Copied into listings.property_name for every unit
  -- under it, which is why that column is never typed twice.
  name text not null,

  street text,
  city text,
  state text,
  state_abbr text,
  zip text,

  -- Where the landlord's signature request goes. The signer's *name* is a
  -- lease value (landlord.print_name) because it prints above the signature
  -- line; the address it is sent to never appears in the document, so it has
  -- no placeholder and no registry entry, and it lives here on the building
  -- it signs for. One landlord signer per property, fixed by a manager.
  landlord_signer_email text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Two rows for one building would split its settings in half, and a lease
-- would be generated from whichever half the listing happened to point at.
create unique index if not exists buildings_name_idx
  on public.buildings (lower(name));

drop trigger if exists buildings_set_updated_at on public.buildings;
create trigger buildings_set_updated_at
  before update on public.buildings
  for each row execute function public.set_updated_at();

-- Which property a unit belongs to. Declared here rather than in the listings
-- table above because buildings is declared later in this file. Nullable: a
-- listing under no property has no landlord values at all. property_name is
-- the display string; this is what settings key off. Deleting a building that
-- still has units is refused rather than quietly unlinking them: an unlinked
-- unit loses its whole building layer, which is the silent-miss this table
-- exists to prevent.
alter table public.listings add column if not exists building_id uuid
  references public.buildings (id) on delete restrict;

create index if not exists listings_building_idx
  on public.listings (building_id);

-- Postgres cannot read fields.json, so it cannot know whether "utility.water"
-- is a real field — the Worker checks that against the registry before it
-- writes. What the database can insist on is shape.
--
-- Empty strings and nulls are rejected on purpose. A key being absent means
-- "this layer does not answer that field"; if a form could store "" for an
-- untouched input, a required setting nobody filled in would read as answered
-- and print as a blank line on a signed lease.
create or replace function public.lease_settings_shape_ok(settings jsonb)
returns boolean
language sql
immutable
as $$
  select case jsonb_typeof(settings)
    when 'object' then not exists (
      select 1
      from jsonb_each(settings) as entry
      where entry.key !~ '^[a-z0-9_]+\.[a-z0-9_]+$'
         or jsonb_typeof(entry.value) in ('object', 'array', 'null')
         or (jsonb_typeof(entry.value) = 'string' and entry.value #>> '{}' = '')
    )
    else false
  end;
$$;

-- One row per layer: one per building, one per unit. field_values holds only
-- what that layer actually answers, keyed by registry field id, so merging a
-- lease is building || unit.
create table if not exists public.lease_settings (
  id uuid primary key default gen_random_uuid(),

  scope text not null check (scope in ('building', 'unit')),

  -- Exactly one of these is set, decided by scope.
  building_id uuid references public.buildings (id) on delete cascade,
  listing_id uuid references public.listings (id) on delete cascade,

  -- Checkbox fields are true/false; everything else is the string substituted
  -- into the document verbatim ("$25.00", "Landlord", "1").
  field_values jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lease_settings_scope_target check (
    (scope = 'building' and building_id is not null and listing_id is null) or
    (scope = 'unit'     and building_id is null     and listing_id is not null)
  ),

  constraint lease_settings_shape check (
    public.lease_settings_shape_ok(field_values)
  )
);

-- Partial unique indexes rather than one composite key, because the two scopes
-- key off different columns.
create unique index if not exists lease_settings_building_idx
  on public.lease_settings (building_id) where scope = 'building';

create unique index if not exists lease_settings_unit_idx
  on public.lease_settings (listing_id) where scope = 'unit';

drop trigger if exists lease_settings_set_updated_at on public.lease_settings;
create trigger lease_settings_set_updated_at
  before update on public.lease_settings
  for each row execute function public.set_updated_at();

-- What a lease says about a building is a legal representation, so every
-- change to one is kept. The trigger catches cascade deletes too, which a
-- Worker-written audit row could not.
create table if not exists public.lease_settings_audit (
  id uuid primary key default gen_random_uuid(),
  settings_id uuid,
  scope text,
  building_id uuid,
  listing_id uuid,

  -- The whole layer as it stood after the change, not just the keys touched,
  -- so one row answers "what did this building assert on that date".
  field_values jsonb,

  action text not null,
  actor text,
  created_at timestamptz not null default now()
);

create index if not exists lease_settings_audit_settings_idx
  on public.lease_settings_audit (settings_id, created_at desc);

create or replace function public.lease_settings_record_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.lease_settings_audit
      (settings_id, scope, building_id, listing_id, field_values, action, actor)
    values
      (old.id, old.scope, old.building_id, old.listing_id, old.field_values,
       'delete', nullif(current_setting('app.actor', true), ''));
  else
    insert into public.lease_settings_audit
      (settings_id, scope, building_id, listing_id, field_values, action, actor)
    values
      (new.id, new.scope, new.building_id, new.listing_id, new.field_values,
       lower(tg_op), nullif(current_setting('app.actor', true), ''));
  end if;
  return null;
end;
$$;

drop trigger if exists lease_settings_audit_trigger on public.lease_settings;
create trigger lease_settings_audit_trigger
  after insert or update or delete on public.lease_settings
  for each row execute function public.lease_settings_record_change();

-- The Worker talks to PostgREST, which can only set a column to a literal —
-- it cannot express `field_values = field_values || $1`. Saving a few settings
-- without overwriting the rest therefore has to be a function, and making it
-- one is what lets the change and its audit row land in a single transaction.
--
-- A json null in the patch means "this layer no longer answers that field",
-- which || cannot express, so removals are applied separately.
create or replace function public.lease_settings_apply(
  p_scope text,
  p_building_id uuid,
  p_listing_id uuid,
  p_patch jsonb,
  p_actor text
)
returns public.lease_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  cleared text[];
  additions jsonb;
  result public.lease_settings;
begin
  select coalesce(array_agg(entry.key), '{}')
    into cleared
    from jsonb_each(p_patch) as entry
    where jsonb_typeof(entry.value) = 'null';

  select coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    into additions
    from jsonb_each(p_patch) as entry
    where jsonb_typeof(entry.value) <> 'null';

  -- Read by the audit trigger, and scoped to this transaction.
  perform set_config('app.actor', coalesce(p_actor, ''), true);

  update public.lease_settings
     set field_values = (field_values || additions) - cleared
   where scope = p_scope
     and building_id is not distinct from p_building_id
     and listing_id is not distinct from p_listing_id
  returning * into result;

  if not found then
    insert into public.lease_settings (scope, building_id, listing_id, field_values)
    values (p_scope, p_building_id, p_listing_id, additions - cleared)
    returning * into result;
  end if;

  return result;
end;
$$;

-- The two layers that apply to one unit, returned separately rather than
-- pre-merged: the admin screen has to show which layer answered each field,
-- because "inherited from the building" and "set on this unit" are different
-- things to a person deciding whether a lease is safe to send.
create or replace function public.lease_settings_for_listing(p_listing_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'building', coalesce(
      (select s.field_values
         from public.lease_settings s
         join public.listings l on l.building_id = s.building_id
        where s.scope = 'building' and l.id = p_listing_id),
      '{}'::jsonb),
    'unit', coalesce(
      (select field_values
         from public.lease_settings
        where scope = 'unit' and listing_id = p_listing_id),
      '{}'::jsonb)
  );
$$;

alter table public.buildings enable row level security;
alter table public.lease_settings enable row level security;
alter table public.lease_settings_audit enable row level security;

grant select, insert, update, delete on public.buildings to service_role;
grant select, insert, update, delete on public.lease_settings to service_role;
grant select on public.lease_settings_audit to service_role;
grant execute on function public.lease_settings_apply(text, uuid, uuid, jsonb, text) to service_role;
grant execute on function public.lease_settings_for_listing(uuid) to service_role;

-- On Supabase projects created before mid-2026 these roles were granted
-- everything in public by default, which would expose the lease field set to
-- anyone holding the anon key. Revoking is a no-op on newer projects.
revoke all on public.buildings from anon, authenticated;
revoke all on public.lease_settings from anon, authenticated;
revoke all on public.lease_settings_audit from anon, authenticated;
revoke execute on function public.lease_settings_apply(text, uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function public.lease_settings_for_listing(uuid) from public, anon, authenticated;
revoke execute on function public.lease_settings_shape_ok(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Applicant portal
-- ---------------------------------------------------------------------------

-- Applicant accounts live in Supabase Auth (the auth schema), not here:
-- registration, email confirmation, password hashing, and password reset are
-- all the platform's. The Worker proxies /api/portal/* to the auth API, so
-- the browser still never talks to Supabase directly. Ownership of what
-- follows is by the account's verified email address.

-- Documents an applicant uploads to support an application: identity, income,
-- rental history. The bytes live in the private applicant-docs R2 bucket —
-- never in listing-media, whose objects are served to anyone at /media/ — and
-- this table ties each object to its application. Reads only ever go through
-- the Worker: the applicant's own signed-in session, or Cloudflare Access for
-- staff.
create table if not exists public.application_documents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,

  doc_type text not null check (doc_type in (
    'government_id_front', 'government_id_back', 'job_offer_letter',
    'paystub', 'school_offer_letter', 'student_visa_i20',
    'bank_statement', 'tax_return', 'landlord_reference')),

  -- Object key inside the applicant-docs R2 bucket:
  -- "<application-id>/<doc-type>/<uuid>.<ext>".
  path text not null,

  -- What the applicant called the file, kept for display only. The object key
  -- is random, so a filename can say anything without touching storage.
  file_name text,
  content_type text,
  size_bytes bigint,

  uploaded_by text not null default 'applicant'
    check (uploaded_by in ('applicant', 'staff')),

  created_at timestamptz not null default now()
);

create index if not exists application_documents_application_idx
  on public.application_documents (application_id, doc_type, created_at);

alter table public.application_documents enable row level security;

grant select, insert, update, delete on public.application_documents to service_role;

revoke all on public.application_documents from anon, authenticated;

-- Who may use the admin console, and as what.
--
-- Cloudflare Access decides whether a request reaches the Worker at all. This
-- table decides what it may do once it has. The two are deliberately separate:
-- Access group membership is offboarding — one switch, everything at once —
-- while a role is business data a manager changes here, in the console, and
-- wants to be able to read back.
--
-- There is no default role. An email absent from this table is refused, not
-- treated as an agent: anyone mistakenly added to the Access group would
-- otherwise acquire an agent's permissions simply by arriving.
--
-- The email is the primary key because that is what Cloudflare Access proves,
-- and it is forced to lower case so a lookup cannot miss a row that is there.
create table if not exists public.staff (
  -- Lower case and untrimmed-free, because the Worker looks a person up by the
  -- exact lower-cased address Cloudflare Access gave it: a row with a capital
  -- or a stray space would sit in the table looking present and never match.
  email text primary key check (
    email = lower(email) and email = btrim(email) and email like '%_@_%._%'),
  role text not null check (role in ('manager', 'agent')),
  name text,

  -- Deactivating rather than deleting keeps an audit row's actor resolvable to
  -- a person after they leave. The console offers both; prefer this one.
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists staff_set_updated_at on public.staff;
create trigger staff_set_updated_at
  before update on public.staff
  for each row execute function public.set_updated_at();

alter table public.staff enable row level security;

grant select, insert, update, delete on public.staff to service_role;

revoke all on public.staff from anon, authenticated;
