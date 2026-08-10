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
  building_name text,
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
  ssn_encrypted text,
  ssn_last4 text,
  household_size integer check (household_size >= 1),
  children_under_11 boolean,
  income_note text,

  -- Structured sections, shaped by the Worker (never raw client JSON):
  -- current_employer  {employer, position, start, supervisor_name, supervisor_phone, supervisor_email}
  -- employment_history [{employer, position, start, end, supervisor_name, supervisor_phone, supervisor_email}]
  -- rental_history     [{address, start, end, monthly_rent, landlord_name, landlord_phone, landlord_email}]
  -- reference_contacts [{name, relationship, phone, email}]  (3 required)
  -- emergency_contacts [{name, relationship, phone, email}]
  -- pets               [{type, species, weight}]
  current_employer jsonb,
  employment_history jsonb,
  rental_history jsonb,
  reference_contacts jsonb,
  emergency_contacts jsonb,
  pets jsonb,

  message text,

  status text not null default 'new'
    check (status in ('new', 'contacted', 'fee_pending', 'screening', 'review',
                      'sent_to_landlord', 'approved', 'declined', 'lease_sent', 'lease_signed')),
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Migration for databases created before the full application form. Safe to
-- run repeatedly; a fresh install already has all of this from create table.
alter table public.applications add column if not exists first_name text;
alter table public.applications add column if not exists last_name text;
alter table public.applications add column if not exists current_address text;
alter table public.applications add column if not exists lease_term_months integer;
alter table public.applications add column if not exists dob text;
alter table public.applications add column if not exists ssn_encrypted text;
alter table public.applications add column if not exists ssn_last4 text;
alter table public.applications add column if not exists children_under_11 boolean;
alter table public.applications add column if not exists current_employer jsonb;
alter table public.applications add column if not exists employment_history jsonb;
alter table public.applications add column if not exists rental_history jsonb;
alter table public.applications add column if not exists reference_contacts jsonb;
alter table public.applications add column if not exists emergency_contacts jsonb;
alter table public.applications add column if not exists pets jsonb;
alter table public.applications drop constraint if exists applications_status_check;
alter table public.applications add constraint applications_status_check
  check (status in ('new', 'contacted', 'fee_pending', 'screening', 'review',
                    'sent_to_landlord', 'approved', 'declined', 'lease_sent', 'lease_signed'));

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
