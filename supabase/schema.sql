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

-- No policies are defined, so anon and authenticated roles can do nothing.
-- Every read and write goes through the Worker using the service role key,
-- which bypasses RLS. No database key is ever shipped to a browser.
alter table public.listings enable row level security;
alter table public.listing_media enable row level security;

-- Newer Supabase projects no longer grant table privileges to service_role
-- automatically, so grant them explicitly.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.listings to service_role;
grant select, insert, update, delete on public.listing_media to service_role;
