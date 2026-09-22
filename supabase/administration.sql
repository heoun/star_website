-- Run after schema.sql, backoffice.sql and workspace.sql. Additive / repeatable.
begin;
alter table public.staff add column if not exists account_version integer not null default 0;
create or replace function public.bump_staff_account_version() returns trigger language plpgsql set search_path='' as $$
begin
  if (old.role = 'landlord') <> (new.role = 'landlord') then raise exception 'Landlord and internal team account types cannot be switched'; end if;
  new.account_version := old.account_version + 1;
  return new;
end $$;
drop trigger if exists staff_account_version on public.staff;
create trigger staff_account_version before update on public.staff for each row execute function public.bump_staff_account_version();
create table if not exists public.account_access_audit (
  id uuid primary key default gen_random_uuid(), email text not null, actor text not null,
  action text not null, reason text not null default '', before_record jsonb, after_record jsonb,
  created_at timestamptz not null default now()
);
create index if not exists account_access_audit_email_idx on public.account_access_audit(email, created_at desc);
alter table public.account_access_audit enable row level security;
revoke all on public.account_access_audit from anon, authenticated;
grant select, insert on public.account_access_audit to service_role;

create or replace function public.manage_workspace_account(
  p_actor text, p_owner_email text, p_email text, p_version integer, p_action text, p_data jsonb, p_reason text
) returns public.staff language plpgsql security invoker set search_path='' as $$
declare old_row public.staff; result public.staff; is_owner boolean; target_role text; target_active boolean; properties uuid[];
begin
  is_owner := coalesce(p_owner_email,'') <> '' and p_actor = p_owner_email;
  if not is_owner and not exists(select 1 from public.staff where email=p_actor and active and role='manager') then raise exception 'Only Admin can manage accounts'; end if;
  if p_email = p_owner_email or p_email = p_actor then raise exception 'Your account and the platform owner cannot be changed here'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_email,0));
  select * into old_row from public.staff where email=p_email for update;
  if (old_row.email is null and p_version <> -1) or (old_row.email is not null and old_row.account_version <> p_version) then raise exception 'Account changed. Refresh before saving'; end if;
  if (old_row.role='manager' or p_action in ('grant_admin','revoke_admin','create_admin','remove_admin')) and not is_owner then raise exception 'Only the platform owner can manage Admin accounts'; end if;
  if p_action='create_admin' then
    if old_row.email is not null or p_version <> -1 or length(trim(coalesce(p_data->>'name',''))) = 0 or length(trim(coalesce(p_reason,''))) < 5 then raise exception 'Use an unused email, name and authorization reason'; end if;
    target_role := 'manager'; target_active := true; properties := '{}';
  elsif p_action='remove_admin' then
    if old_row.role is distinct from 'manager' or not old_row.active or length(trim(coalesce(p_reason,''))) < 5 then raise exception 'Choose an active Admin and record the removal reason'; end if;
    target_role := 'manager'; target_active := false; properties := old_row.property_ids;
  elsif p_action='remove_account' then
    if old_row.email is null or old_row.role not in ('agent','landlord') or not old_row.active or length(trim(coalesce(p_reason,''))) < 5 then raise exception 'Choose an active Agent or Landlord and record the removal reason'; end if;
    target_role := old_row.role; target_active := false; properties := old_row.property_ids;
  elsif p_action='grant_admin' then
    if old_row.role is distinct from 'agent' or not old_row.active or length(trim(coalesce(p_reason,''))) < 5 then raise exception 'An active Agent and an authorization reason are required'; end if;
    target_role := 'manager'; target_active := old_row.active; properties := old_row.property_ids;
  elsif p_action='revoke_admin' then
    if old_row.role is distinct from 'manager' or length(trim(coalesce(p_reason,''))) < 5 then raise exception 'Choose an Admin and record the reason'; end if;
    target_role := 'agent'; target_active := old_row.active; properties := old_row.property_ids;
  elsif p_action='save' then
    target_role := p_data->>'role';
    if old_row.email is null and target_role not in ('agent','landlord') then raise exception 'Create an Agent or Landlord; Owner authorization grants Admin access'; end if;
    if old_row.email is not null and target_role is distinct from old_row.role then raise exception 'Account type is fixed. Use the separate authorization action'; end if;
    target_active := coalesce((p_data->>'active')::boolean, old_row.active, true);
    if old_row.role='manager' and old_row.active is distinct from target_active and length(trim(coalesce(p_reason,''))) < 5 then raise exception 'Record why Admin access is changing'; end if;
    properties := case when p_data ? 'property_ids' then array(select distinct jsonb_array_elements_text(p_data->'property_ids')::uuid) else coalesce(old_row.property_ids,'{}'::uuid[]) end;
    if target_role='landlord' and old_row.email is null then raise exception 'Landlord accounts must be created through approved onboarding'; end if;
    if old_row.role='landlord' and not (properties @> coalesce(old_row.property_ids,'{}'::uuid[]) and properties <@ coalesce(old_row.property_ids,'{}'::uuid[])) then raise exception 'Landlord property bindings cannot be changed in account management'; end if;
    if exists(select 1 from unnest(properties) property_id where not exists(select 1 from public.buildings b where b.id=property_id)) then raise exception 'A selected property no longer exists'; end if;
  else raise exception 'Unknown account action'; end if;
  insert into public.staff(email,role,name,active,property_ids)
    values(p_email,target_role,case when p_action in ('save','create_admin') then nullif(p_data->>'name','') else old_row.name end,target_active,properties)
    on conflict(email) do update set role=excluded.role,name=excluded.name,active=excluded.active,property_ids=excluded.property_ids
    returning * into result;
  insert into public.account_access_audit(email,actor,action,reason,before_record,after_record)
    values(p_email,p_actor,p_action,coalesce(p_reason,''),case when old_row.email is null then null else to_jsonb(old_row) end,to_jsonb(result));
  return result;
end $$;
revoke all on function public.manage_workspace_account(text,text,text,integer,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.manage_workspace_account(text,text,text,integer,text,jsonb,text) to service_role;

create table if not exists public.landlord_onboarding (
  id uuid primary key, email text not null, contact_name text not null, created_by text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  token_hash text not null unique check(length(token_hash)=64), expires_at timestamptz not null,
  version integer not null default 0,
  status text not null default 'invited' check(status in ('invited','submitted','changes_requested','approved','rejected','cancelled')),
  email_state text not null default 'pending' check(email_state in ('pending','sent','failed','preview')),
  data jsonb not null default '{}', review_note text not null default '', building_ids uuid[] not null default '{}',
  activity jsonb not null default '[]'
);
create index if not exists landlord_onboarding_status_idx on public.landlord_onboarding(status,created_at desc);
alter table public.landlord_onboarding enable row level security;
revoke all on public.landlord_onboarding from anon,authenticated;
grant select,insert,update on public.landlord_onboarding to service_role;
alter table public.buildings add column if not exists onboarding_id uuid references public.landlord_onboarding(id);
alter table public.buildings add column if not exists landlord_email text;
alter table public.buildings add column if not exists declared_units integer;
alter table public.buildings add column if not exists onboarding_notes text;

create or replace function public.update_landlord_onboarding(p_id uuid,p_version integer,p_patch jsonb)
returns setof public.landlord_onboarding language plpgsql security invoker set search_path='' as $$
begin
  if jsonb_typeof(p_patch) <> 'object' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('data','status','review_note','activity','token_hash','expires_at','email_state')) then raise exception 'Unsupported onboarding change'; end if;
  if p_patch->>'status' = 'approved' then raise exception 'Use the atomic approval operation'; end if;
  return query update public.landlord_onboarding r set
    data=case when p_patch ? 'data' then p_patch->'data' else r.data end,
    status=coalesce(p_patch->>'status',r.status), review_note=coalesce(p_patch->>'review_note',r.review_note),
    activity=coalesce(p_patch->'activity',r.activity),token_hash=coalesce(p_patch->>'token_hash',r.token_hash),
    expires_at=coalesce((p_patch->>'expires_at')::timestamptz,r.expires_at),email_state=coalesce(p_patch->>'email_state',r.email_state),
    version=r.version+1,updated_at=now()
    where r.id=p_id and r.version=p_version and r.status not in ('approved','rejected','cancelled') returning r.*;
end $$;
revoke all on function public.update_landlord_onboarding(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.update_landlord_onboarding(uuid,integer,jsonb) to service_role;

create or replace function public.approve_landlord_onboarding(p_id uuid,p_version integer,p_actor text,p_owner_email text)
returns public.landlord_onboarding language plpgsql security invoker set search_path='' as $$
declare r public.landlord_onboarding; existing public.staff; member public.staff; property jsonb; building_id uuid; ids uuid[] := '{}'; defaults jsonb; utility record;
begin
  if p_actor=p_owner_email or not exists(select 1 from public.staff where email=p_actor and role='manager' and active) then raise exception 'Only business Admin can approve onboarding'; end if;
  select * into r from public.landlord_onboarding where id=p_id for update;
  if not found or r.version<>p_version or r.status<>'submitted' then raise exception 'Submission changed or already reviewed'; end if;
  if r.email=p_owner_email then raise exception 'The platform owner cannot become a landlord account'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(r.email,0));
  select * into existing from public.staff where email=r.email for update;
  if existing.email is not null and (existing.role<>'landlord' or not existing.active) then raise exception 'This address belongs to an internal or inactive account'; end if;
  if coalesce(r.data->>'legal_name','')='' or coalesce(r.data->>'contact_name','')='' or coalesce(r.data->>'phone','')='' or coalesce(r.data->>'mailing_address','')='' then raise exception 'Complete the landlord details'; end if;
  if jsonb_typeof(r.data->'properties') is distinct from 'array' or jsonb_array_length(r.data->'properties') not between 1 and 10 then raise exception 'Add between one and ten properties'; end if;
  for property in select value from jsonb_array_elements(r.data->'properties') order by lower(value->>'street'), lower(value->>'city'), value->>'zip' loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(property->>'street')||'|'||lower(property->>'city')||'|'||(property->>'zip'),1));
  end loop;
  -- Lock in a stable order, but keep returned IDs aligned with the submitted form.
  for property in select value from jsonb_array_elements(r.data->'properties') loop
    if coalesce(property->>'name','')='' or coalesce(property->>'street','')='' or coalesce(property->>'city','')='' or coalesce(property->>'state_abbr','') !~ '^[A-Z]{2}$' or coalesce(property->>'zip','') !~ '^\d{5}(-\d{4})?$' then raise exception 'Complete every property address'; end if;
    -- Existing properties are never silently overwritten or reassigned by intake.
    if exists(select 1 from public.buildings b where lower(b.name)=lower(property->>'name') or (lower(b.street)=lower(property->>'street') and lower(b.city)=lower(property->>'city') and b.zip=property->>'zip')) then raise exception 'A property with this name or address already exists. Review the duplicate before approving'; end if;
    insert into public.buildings(name,street,city,state,state_abbr,zip,landlord_signer_email,onboarding_id,landlord_email,declared_units,onboarding_notes)
      values(property->>'name',property->>'street',property->>'city',property->>'state_abbr',property->>'state_abbr',property->>'zip',r.email,r.id,r.email,nullif(property->>'unit_count','')::integer,property->>'notes') returning id into building_id;
    ids := array_append(ids,building_id);
    defaults := jsonb_build_object('landlord.entity_name',r.data->>'legal_name','landlord.print_name',r.data->>'contact_name','landlord.address',r.data->>'mailing_address');
    for utility in select key,value from jsonb_each_text(coalesce(property->'utilities','{}'::jsonb)) loop
      if utility.key not in ('water','sewer','gas','electricity','trash','internet') or utility.value not in ('Landlord','Tenant','N/A') then raise exception 'Invalid utility preference'; end if;
      defaults := defaults || jsonb_build_object('utility.'||utility.key,utility.value);
    end loop;
    perform public.lease_settings_apply('building',building_id,null,defaults,p_actor);
  end loop;
  insert into public.staff(email,role,name,active,property_ids) values(r.email,'landlord',r.data->>'contact_name',true,ids)
    on conflict(email) do update set property_ids=array(select distinct unnest(public.staff.property_ids || excluded.property_ids)) returning * into member;
  insert into public.account_access_audit(email,actor,action,reason,before_record,after_record)
    values(r.email,p_actor,'onboarding_approved',r.id::text,case when existing.email is null then null else to_jsonb(existing) end,to_jsonb(member));
  update public.landlord_onboarding set status='approved',building_ids=ids,version=version+1,updated_at=now(),
    activity=activity||jsonb_build_array(jsonb_build_object('action','approved','by',p_actor,'at',now())) where id=p_id returning * into r;
  return r;
end $$;
revoke all on function public.approve_landlord_onboarding(uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.approve_landlord_onboarding(uuid,integer,text,text) to service_role;
notify pgrst,'reload schema';
commit;
