-- Additive upgrade for the role-aware /admin/ workspace. Run after schema.sql.
begin;
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check check (role in ('manager', 'agent', 'landlord'));
alter table public.staff add column if not exists property_ids uuid[] not null default '{}';

create table if not exists public.listing_change_requests (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings(id) on delete set null,
  building_id uuid references public.buildings(id) on delete set null,
  listing_title text not null,
  message text not null check (char_length(message) between 10 and 4000),
  created_by text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'declined')),
  response text not null default '' check (char_length(response) <= 4000),
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists listing_change_requests_actor_idx on public.listing_change_requests(created_by, created_at desc);
alter table public.listing_change_requests enable row level security;
revoke all on public.listing_change_requests from anon, authenticated;
grant select, insert, update on public.listing_change_requests to service_role;
commit;
