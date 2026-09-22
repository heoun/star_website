-- Ring 9: the v2 flow runs on the real inventory in public.listings.
--
--   1. Every existing residential rental gets its whole-unit rentable row,
--      deterministically keyed 'rl-<listing id>' (new listings are ensured
--      lazily by the adapter with the same key).
--   2. cases.listing_id now holds a public.listings uuid, so the FK to the
--      sandbox backend.listings table has to go.
--   3. backend.listing_state is a v2-owned overlay for states the legacy
--      boolean cannot express (rented, archived). public.listings itself is
--      not altered in any way.
--
-- Run in the Supabase SQL Editor (Star dev). Safe to re-run.

insert into backend.rentables (id, kind, unit_ref)
select 'rl-' || l.id, 'whole_unit', l.id::text
from public.listings l
where l.transaction_type = 'rental' and l.category = 'residential'
on conflict (id) do nothing;

alter table backend.cases drop constraint if exists cases_listing_id_fkey;

create table if not exists backend.listing_state (
  listing_id text primary key,
  status     text not null check (status in ('rented', 'archived')),
  updated_at timestamptz not null default now()
);
alter table backend.listing_state enable row level security;
grant all on backend.listing_state to service_role;
