-- One-time migration: remove the company settings layer.
--
-- Landlord values used to answer at three levels — company, building, unit —
-- and the top one held the 32 terms that are the same everywhere: the fines,
-- the returned payment fee, the guest limits, the gas provider, the DHCR owner
-- representative. Nothing showed those on a property's page, so a lease could
-- assert a figure nobody remembered setting.
--
-- They are property values now. Every one of them is typed on the property it
-- prints for, and there is no layer above it.
--
-- Run this once per database (development and production), in the Supabase SQL
-- editor, BEFORE deploying the Worker that stops reading the company layer.
-- Running it after would leave every property short of 32 values until it is
-- run — the lease screen would say so rather than print blanks, but nobody
-- could send a lease in the meantime.
--
-- Safe to re-run: the copy is a no-op once the company row is gone.

begin;

-- 1. The values themselves. A property keeps every answer it already has —
--    `shared || existing` puts the existing one last, so a building that
--    overrode a company fee keeps its own figure and inherits the other 31.
do $$
declare
  shared jsonb;
begin
  select field_values into shared
    from public.lease_settings
   where scope = 'company';

  if shared is null or shared = '{}'::jsonb then
    return;
  end if;

  -- Read by the audit trigger, so the copy is attributable like any other
  -- change to what a lease asserts.
  perform set_config('app.actor', 'drop-company-layer migration', true);

  update public.lease_settings s
     set field_values = shared || s.field_values
   where s.scope = 'building';

  -- A property that never had a layer of its own still inherited these, so it
  -- gets one now rather than losing them.
  insert into public.lease_settings (scope, building_id, field_values)
  select 'building', b.id, shared
    from public.buildings b
   where not exists (
     select 1 from public.lease_settings s
      where s.scope = 'building' and s.building_id = b.id);

  delete from public.lease_settings where scope = 'company';
end $$;

-- 2. The structure. Nothing may write that layer again.
drop index if exists public.lease_settings_company_idx;

do $$
declare
  doomed text;
begin
  for doomed in
    select conname
      from pg_constraint
     where conrelid = 'public.lease_settings'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%company%'
  loop
    execute format('alter table public.lease_settings drop constraint %I', doomed);
  end loop;
end $$;

alter table public.lease_settings
  drop constraint if exists lease_settings_scope_check;
alter table public.lease_settings
  drop constraint if exists lease_settings_scope_target;

alter table public.lease_settings
  add constraint lease_settings_scope_check
    check (scope in ('building', 'unit'));

alter table public.lease_settings
  add constraint lease_settings_scope_target check (
    (scope = 'building' and building_id is not null and listing_id is null) or
    (scope = 'unit'     and building_id is null     and listing_id is not null)
  );

-- 3. What the Worker reads. Same function as in schema.sql; repeated here so
--    one run of this file leaves the database consistent with the code.
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

commit;

-- The audit trail keeps the company layer's history: the delete above wrote a
-- row into lease_settings_audit holding every value it carried, so what a
-- lease asserted before this migration is still answerable.
