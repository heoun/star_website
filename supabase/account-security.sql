-- Apply after identity.sql and all business schemas. Repeatable; no credentials are exported.
create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check(email=lower(email)),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
-- A mailbox can independently belong to a workspace account and an applicant.
alter table public.app_users add column if not exists realm text not null default 'workspace'
  check(realm in ('workspace','applicant'));
alter table public.app_users drop constraint if exists app_users_email_key;
create unique index if not exists app_users_realm_email on public.app_users(realm,email);
create table if not exists public.applicant_auth_config (
  singleton boolean primary key default true check(singleton),
  issuer text not null unique check(issuer ~ '^https://[^/]+/auth/v1$'),
  enabled boolean not null default false
);
alter table public.applicant_auth_config enable row level security;
revoke all on public.applicant_auth_config from public,anon,authenticated;
grant select,insert,update on public.applicant_auth_config to service_role;
create table if not exists public.auth_bindings (
  provider text not null, subject text not null,
  user_id uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  primary key(provider,subject), unique(provider,user_id)
);
-- One row, protected from ordinary account management; bootstrap is operator-only.
create table if not exists public.platform_owner (
  singleton boolean primary key default true check(singleton),
  user_id uuid not null unique references public.app_users(id),
  admin_enabled boolean not null default false,
  version integer not null default 0
);
create table if not exists public.identity_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.app_users(id), acting_role text not null,
  action text not null, target_id uuid references public.app_users(id),
  details jsonb not null default '{}', created_at timestamptz not null default now()
);
alter table public.staff add column if not exists user_id uuid references public.app_users(id);
alter table public.staff add column if not exists access_state text not null default 'active' check(access_state in ('invited','active'));
alter table public.staff alter column access_state set default 'invited';
create unique index if not exists staff_internal_user_unique on public.staff(user_id) where user_id is not null;
alter table public.applications add column if not exists user_id uuid references public.app_users(id);
create index if not exists applications_internal_user on public.applications(user_id);
create table if not exists public.workspace_invitations (
  email text primary key, role text not null check(role in ('manager','agent','landlord')),
  token_hash text not null unique check(length(token_hash)=64),
  expires_at timestamptz not null, accepted_by uuid references public.app_users(id),
  accepted_at timestamptz, revoked_at timestamptz, created_at timestamptz not null default now()
);
alter table public.app_users add column if not exists password_setup_required boolean not null default false;
alter table public.workspace_invitations add column if not exists needs_password boolean not null default false;
do $$ declare t text; begin
  foreach t in array array['app_users','auth_bindings','platform_owner','identity_audit','workspace_invitations'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select,insert,update on public.%I to service_role',t);
  end loop;
end $$;

create or replace function public.resolve_business_identity(p_subject uuid,p_email text)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid; reserved uuid;
begin
  if not exists(select 1 from auth.users where id=p_subject and lower(email)=lower(p_email)
    and email_confirmed_at is not null and not coalesce(is_anonymous,false)) then raise exception 'Verified identity required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(p_email),7));
  select user_id into uid from public.auth_bindings where provider='supabase' and subject=p_subject::text;
  if uid is null then
    select id into reserved from public.app_users where realm='workspace' and email=lower(p_email);
    if reserved is not null then raise exception 'Identity binding requires operator review'; end if;
    insert into public.app_users(email) values(lower(p_email)) returning id into uid;
    insert into public.auth_bindings(provider,subject,user_id) values('supabase',p_subject::text,uid);
  end if;
  if not exists(select 1 from public.app_users where id=uid and realm='workspace' and active and email=lower(p_email)) then raise exception 'Account unavailable'; end if;
  return uid;
end $$;

create or replace function public.bootstrap_platform_owner(p_subject uuid,p_email text)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid; existing uuid;
begin
  if lower(p_email)<>'info@starreusa.com' then raise exception 'Owner email does not match the approved identity'; end if;
  perform pg_catalog.pg_advisory_xact_lock(78124421);
  uid:=public.resolve_business_identity(p_subject,p_email);
  select user_id into existing from public.platform_owner where singleton;
  if existing is not null and existing<>uid then raise exception 'An owner already exists'; end if;
  insert into public.platform_owner(user_id) values(uid) on conflict(singleton) do nothing;
  insert into public.staff(email,role,active,access_state,user_id,auth_user_id) values(lower(p_email),'manager',true,'active',uid,p_subject)
    on conflict(email) do update set user_id=excluded.user_id,auth_user_id=excluded.auth_user_id,access_state='active',role='manager',active=true;

  insert into public.identity_audit(actor_id,acting_role,action,target_id) select uid,'operator','bootstrap_owner',uid where existing is null;
  return uid;
end $$;

create or replace function public.resolve_workspace_access(p_subject uuid,p_email text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid; s public.staff; own public.platform_owner; has_password boolean;
begin
  uid:=public.resolve_business_identity(p_subject,p_email);
  -- to_jsonb keeps this migration compatible with minimal schema test fixtures.
  select coalesce(to_jsonb(u)->>'encrypted_password','')<>'' and not (select password_setup_required from public.app_users where id=uid) into has_password from auth.users u where id=p_subject;
  select * into own from public.platform_owner where user_id=uid;
  if found then return jsonb_build_object('user_id',uid,'is_owner',true,'admin_enabled',own.admin_enabled,'version',own.version,'has_password',has_password); end if;
  select * into s from public.staff where email=lower(p_email) for update;
  if not found or not s.active or (s.auth_user_id is not null and s.auth_user_id<>p_subject)
    or (s.user_id is not null and s.user_id<>uid) then raise exception 'Workspace access unavailable'; end if;
  if s.auth_user_id is null or s.user_id is null then
    update public.staff set auth_user_id=p_subject,user_id=uid where email=s.email;
  end if;
  return jsonb_build_object('user_id',uid,'is_owner',false,'role',s.role,'name',s.name,
    'property_ids',s.property_ids,'access_state',s.access_state,'has_password',has_password,
    'onboarding_pending',s.role='landlord' and cardinality(s.property_ids)=0);
end $$;

create or replace function public.set_owner_admin(p_subject uuid,p_email text,p_enabled boolean,p_version integer,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid; result public.platform_owner;
begin
  uid:=public.resolve_business_identity(p_subject,p_email);
  if length(trim(p_reason))<5 then raise exception 'Authorization reason required'; end if;
  update public.platform_owner set admin_enabled=p_enabled,version=version+1 where singleton and user_id=uid and version=p_version returning * into result;
  if not found then raise exception 'Owner authorization changed; reload before saving'; end if;
  insert into public.identity_audit(actor_id,acting_role,action,target_id,details)
    values(uid,'owner','set_owner_admin',uid,jsonb_build_object('enabled',p_enabled,'reason',p_reason));
  return to_jsonb(result);
end $$;

create or replace function public.accept_workspace_invitation(p_subject uuid,p_email text,p_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid; inv public.workspace_invitations; s public.staff;
begin
  uid:=public.resolve_business_identity(p_subject,p_email);
  select * into inv from public.workspace_invitations where email=lower(p_email) and token_hash=p_hash for update;
  if not found or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at<=now() then raise exception 'Invitation expired or already accepted'; end if;
  select * into s from public.staff where email=lower(p_email) for update;
  if not found or not s.active or s.role<>inv.role or (s.user_id is not null and s.user_id<>uid)
    or (s.auth_user_id is not null and s.auth_user_id<>p_subject) then raise exception 'Invitation access has changed'; end if;
  if inv.needs_password then update public.app_users set password_setup_required=true where id=uid;end if;
  update public.staff set user_id=uid,auth_user_id=p_subject,access_state='active' where email=lower(p_email);
  update public.workspace_invitations set accepted_at=now(),accepted_by=uid where email=lower(p_email);
  insert into public.identity_audit(actor_id,acting_role,action,target_id,details)
    values(uid,inv.role,'accept_invitation',uid,jsonb_build_object('email',lower(p_email)));
  return true;
end $$;

-- Never inherit old application records merely by registering a reused email.
create or replace function public.attach_application_identity() returns trigger language plpgsql security definer set search_path='' as $$
declare uid uuid; expected_realm text;
begin
  if tg_op='UPDATE' and old.user_id is not null then
    if new.user_id is distinct from old.user_id then raise exception 'Application identity cannot be reassigned'; end if;
    return new;
  end if;
  expected_realm:=case when exists(select 1 from public.applicant_auth_config where enabled) then 'applicant' else 'workspace' end;
  select a.id into uid from public.app_users a where a.realm=expected_realm and a.email=lower(new.email);
  if new.user_id is not null and new.user_id is distinct from uid then raise exception 'Application identity mismatch'; end if;
  new.user_id:=uid;
  return new;
end $$;
drop trigger if exists application_identity on public.applications;
create trigger application_identity before insert or update on public.applications for each row execute function public.attach_application_identity();
-- Pin existing verified identities at migration time. Subsequent email reuse is rejected.
do $$ declare u record; uid uuid; begin
  for u in select id,email from auth.users where email_confirmed_at is not null and not coalesce(is_anonymous,false) and email is not null loop
    uid:=public.resolve_business_identity(u.id,u.email);
    update public.staff set user_id=uid,auth_user_id=u.id where email=lower(u.email) and (auth_user_id is null or auth_user_id=u.id) and user_id is null;
    if not exists(select 1 from public.applicant_auth_config where enabled) then
      update public.applications set user_id=uid where lower(email)=lower(u.email) and user_id is null;
    end if;
  end loop;
end $$;

do $$ declare signature text; begin
  foreach signature in array array[
    'resolve_business_identity(uuid,text)','bootstrap_platform_owner(uuid,text)',
    'resolve_workspace_access(uuid,text)','set_owner_admin(uuid,text,boolean,integer,text)',
    'accept_workspace_invitation(uuid,text,text)'] loop
    execute 'revoke all on function public.'||signature||' from public,anon,authenticated';
    execute 'grant execute on function public.'||signature||' to service_role';
  end loop;
end $$;
notify pgrst,'reload schema';

-- Landlords get a restricted workspace account when invited, before approval.
create or replace function public.prepare_landlord_account() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    if exists(select 1 from public.app_users a join public.platform_owner o on o.user_id=a.id where a.email=lower(new.email)) then raise exception 'Owner cannot become Landlord'; end if;
    if exists(select 1 from public.staff where email=lower(new.email) and (role<>'landlord' or not active)) then raise exception 'Account is not an active Landlord'; end if;
    insert into public.staff(email,role,name,active,access_state,property_ids) values(lower(new.email),'landlord',new.contact_name,true,'invited','{}') on conflict(email) do nothing;
  end if;
  if tg_op='INSERT' or new.token_hash is distinct from old.token_hash then
    insert into public.workspace_invitations(email,role,token_hash,expires_at) values(lower(new.email),'landlord',new.token_hash,new.expires_at)
      on conflict(email) do update set token_hash=excluded.token_hash,expires_at=excluded.expires_at,accepted_by=null,accepted_at=null,revoked_at=null,needs_password=false,created_at=now();
  elsif new.status in ('cancelled','rejected') then
    update public.workspace_invitations set revoked_at=now() where email=lower(new.email) and token_hash=new.token_hash;
  end if;
  return new;
end $$;
drop trigger if exists landlord_account_invitation on public.landlord_onboarding;
create trigger landlord_account_invitation after insert or update on public.landlord_onboarding for each row execute function public.prepare_landlord_account();

-- Reserve a NEW passwordless identity before its first mailbox verification.
-- The operator marker is Auth app metadata, which public clients cannot set.
create or replace function public.reserve_platform_owner(p_subject uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid; existing uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(78124421);
  if not exists(select 1 from auth.users u where id=p_subject and lower(email)='info@starreusa.com'
    and email_confirmed_at is null and to_jsonb(u)->'raw_app_meta_data'->>'star_owner_provisioned'='true' and to_jsonb(u)->>'last_sign_in_at' is null and not coalesce(is_anonymous,false)) then raise exception 'An operator-provisioned, unused Owner identity is required'; end if;
  select user_id into existing from public.platform_owner where singleton;
  if existing is not null then
    if exists(select 1 from public.auth_bindings where provider='supabase' and subject=p_subject::text and user_id=existing) then return existing; end if;
    raise exception 'An Owner already exists';
  end if;
  if exists(select 1 from public.app_users where realm='workspace' and email='info@starreusa.com') then raise exception 'Review existing identity before reservation'; end if;
  insert into public.app_users(email,password_setup_required) values('info@starreusa.com',true) returning id into uid;
  insert into public.auth_bindings(provider,subject,user_id) values('supabase',p_subject::text,uid);
  insert into public.platform_owner(user_id) values(uid);
  insert into public.staff(email,role,active,access_state,user_id,auth_user_id) values('info@starreusa.com','manager',true,'active',uid,p_subject)
    on conflict(email) do update set user_id=excluded.user_id,auth_user_id=excluded.auth_user_id,access_state='active',role='manager',active=true;
  insert into public.identity_audit(actor_id,acting_role,action,target_id) values(uid,'operator','reserve_owner',uid);
  return uid;
end $$;
revoke all on function public.reserve_platform_owner(uuid) from public,anon,authenticated;
grant execute on function public.reserve_platform_owner(uuid) to service_role;


create or replace function public.workspace_email_verified(p_email text)
returns boolean language sql security definer set search_path='' as $$
  select exists(select 1 from auth.users where lower(email)=lower(p_email) and email_confirmed_at is not null and not coalesce(is_anonymous,false));
$$;
create or replace function public.complete_workspace_password_setup(p_subject uuid,p_email text)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid;
begin
  uid:=public.resolve_business_identity(p_subject,p_email);
  if not exists(select 1 from auth.users u where id=p_subject and coalesce(to_jsonb(u)->>'encrypted_password','')<>'') then raise exception 'Set a password first';end if;
  update public.app_users set password_setup_required=false where id=uid;
  insert into public.identity_audit(actor_id,acting_role,action,target_id) values(uid,'account','password_setup_completed',uid);
end $$;
revoke all on function public.workspace_email_verified(text),public.complete_workspace_password_setup(uuid,text) from public,anon,authenticated;
grant execute on function public.workspace_email_verified(text),public.complete_workspace_password_setup(uuid,text) to service_role;
