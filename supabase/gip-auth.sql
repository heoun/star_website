-- Apply after account-security.sql and applicant-auth.sql. No live switch occurs
-- without explicitly configured/enabled realms. Only the trusted Worker may call
-- these resolvers after verifying Google's issuer, audience, tenant and user.
create table if not exists public.gip_identity_migrations (
  realm text not null references public.gip_auth_realms(realm),
  old_subject uuid not null,
  old_user_id uuid not null references public.app_users(id),
  new_subject text not null check(length(new_subject) between 1 and 128),
  new_user_id uuid not null references public.app_users(id),
  provider text not null,
  email text not null check(email=lower(email)),
  migrated_at timestamptz not null default now(),
  primary key(realm,old_subject),unique(provider,new_subject),unique(provider,new_user_id)
);
alter table public.gip_identity_migrations enable row level security;
revoke all on public.gip_identity_migrations from public,anon,authenticated;
grant select on public.gip_identity_migrations to service_role;

create or replace function public.resolve_gip_identity(p_subject text,p_email text,p_realm text,p_project text,p_tenant text)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid; provider_key text; s public.staff;
begin
  if not exists(select 1 from public.gip_auth_realms where realm=p_realm and project_id=p_project and tenant_id=p_tenant and enabled) then raise exception 'Authentication realm is not ready';end if;
  if p_subject is null or length(p_subject) not between 1 and 128 or p_email is null or p_email<>lower(p_email) or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Verified identity required';end if;
  provider_key:='gip:'||p_project||':'||p_tenant;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_realm||':'||p_email,7));
  select user_id into uid from public.auth_bindings where provider=provider_key and subject=p_subject;
  if uid is null then
    if exists(select 1 from public.app_users where realm=p_realm and email=p_email) then raise exception 'Identity binding requires operator review';end if;
    if p_realm='workspace' then
      -- Only a newly invited, unbound member can obtain a new business identity.
      -- Existing accounts and Owner must have an explicit migration binding.
      select * into s from public.staff where email=p_email for update;
      if not found or not s.active or s.access_state<>'invited' or s.user_id is not null or s.auth_user_id is not null or p_email='info@starreusa.com' then raise exception 'Workspace invitation required';end if;
    elsif exists(select 1 from public.applications where lower(email)=p_email) or exists(select 1 from public.rental_drafts where owner_email=p_email) then
      raise exception 'Existing applicant records require migration';
    end if;
    insert into public.app_users(email,realm) values(p_email,p_realm) returning id into uid;
    insert into public.auth_bindings(provider,subject,user_id) values(provider_key,p_subject,uid);
    if p_realm='workspace' then update public.staff set user_id=uid where email=p_email;end if;
  end if;
  if not exists(select 1 from public.app_users where id=uid and realm=p_realm and active and email=p_email) then raise exception 'Account unavailable';end if;
  return uid;
end $$;

create or replace function public.resolve_gip_workspace_access(p_subject text,p_email text,p_project text,p_tenant text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid; s public.staff; own public.platform_owner; has_password boolean;
begin
  uid:=public.resolve_gip_identity(p_subject,p_email,'workspace',p_project,p_tenant);
  select not password_setup_required into has_password from public.app_users where id=uid;
  select * into own from public.platform_owner where user_id=uid;
  if found then return jsonb_build_object('user_id',uid,'is_owner',true,'admin_enabled',own.admin_enabled,'version',own.version,'has_password',has_password);end if;
  select * into s from public.staff where user_id=uid and email=p_email;
  if not found or not s.active then raise exception 'Workspace access unavailable';end if;
  return jsonb_build_object('user_id',uid,'is_owner',false,'role',s.role,'name',s.name,'property_ids',s.property_ids,'access_state',s.access_state,'has_password',has_password,'onboarding_pending',s.role='landlord' and cardinality(s.property_ids)=0);
end $$;

create or replace function public.accept_gip_workspace_invitation(p_subject text,p_email text,p_project text,p_tenant text,p_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid; inv public.workspace_invitations; s public.staff;
begin
  uid:=public.resolve_gip_identity(p_subject,p_email,'workspace',p_project,p_tenant);
  select * into inv from public.workspace_invitations where email=p_email and token_hash=p_hash for update;
  if not found or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at<=now() then raise exception 'Invitation expired or already accepted';end if;
  select * into s from public.staff where email=p_email for update;
  if not found or not s.active or s.role<>inv.role or s.user_id is distinct from uid then raise exception 'Invitation access has changed';end if;
  update public.staff set access_state='active' where email=p_email;
  update public.workspace_invitations set accepted_at=now(),accepted_by=uid where email=p_email;
  insert into public.identity_audit(actor_id,acting_role,action,target_id,details) values(uid,inv.role,'accept_invitation',uid,jsonb_build_object('provider','gip'));
  return true;
end $$;

-- The caller must have just proved a password login with this exact provider UID
-- (including MFA if enrolled). A bare reset code or unverified email is not proof.
create or replace function public.complete_gip_workspace_password_setup(p_subject text,p_email text,p_project text,p_tenant text)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid;
begin
  uid:=public.resolve_gip_identity(p_subject,p_email,'workspace',p_project,p_tenant);
  update public.app_users set password_setup_required=false where id=uid and password_setup_required;
  if found then insert into public.identity_audit(actor_id,acting_role,action,target_id) values(uid,'account','password_setup_completed',uid);end if;
end $$;

create or replace function public.set_gip_owner_admin(p_subject text,p_email text,p_project text,p_tenant text,p_enabled boolean,p_version integer,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid; result public.platform_owner;
begin
  uid:=public.resolve_gip_identity(p_subject,p_email,'workspace',p_project,p_tenant);
  if p_reason is null or length(trim(p_reason))<5 then raise exception 'Authorization reason required';end if;
  update public.platform_owner set admin_enabled=p_enabled,version=version+1 where singleton and user_id=uid and version=p_version returning * into result;
  if not found then raise exception 'Owner authorization changed; reload before saving';end if;
  insert into public.identity_audit(actor_id,acting_role,action,target_id,details) values(uid,'owner','set_owner_admin',uid,jsonb_build_object('enabled',p_enabled,'reason',p_reason));
  return to_jsonb(result);
end $$;

-- Reassignment is permitted only for a previously recorded migration within its
-- transaction. Routine application edits cannot alter the pinned business user.
create or replace function public.attach_application_identity() returns trigger language plpgsql security definer set search_path='' as $$
declare uid uuid; expected_realm text;
begin
  if tg_op='UPDATE' and old.user_id is not null then
    if new.user_id is distinct from old.user_id and not (
      coalesce(current_setting('app.applicant_migration',true),'')=new.user_id::text and (
        exists(select 1 from public.applicant_identity_migrations m where m.old_user_id=old.user_id and m.new_user_id=new.user_id and m.email=lower(new.email)) or
        exists(select 1 from public.gip_identity_migrations m where m.realm='applicant' and m.old_user_id=old.user_id and m.new_user_id=new.user_id and m.email=lower(new.email))
      )
    ) then raise exception 'Application identity cannot be reassigned';end if;
    return new;
  end if;
  expected_realm:=case when exists(select 1 from public.applicant_auth_config where enabled) or exists(select 1 from public.gip_auth_realms where realm='applicant' and enabled) then 'applicant' else 'workspace' end;
  select a.id into uid from public.app_users a where a.realm=expected_realm and a.email=lower(new.email);
  if new.user_id is not null and new.user_id is distinct from uid then raise exception 'Application identity mismatch';end if;
  new.user_id:=uid;
  return new;
end $$;

-- Operator-only migration: target Google UID/mailbox must be checked against
-- Google's Admin API before calling. Never export passwords or TOTP secrets here.
create or replace function public.migrate_gip_identity(p_old_subject uuid,p_new_subject text,p_email text,p_realm text,p_project text,p_tenant text)
returns uuid language plpgsql security definer set search_path='' as $$
declare old_uid uuid; new_uid uuid; provider_key text; prior public.gip_identity_migrations; signing_write text;
begin
  if not exists(select 1 from public.gip_auth_realms where realm=p_realm and project_id=p_project and tenant_id=p_tenant and not enabled) then raise exception 'Migration requires inactive authentication';end if;
  if exists(select 1 from public.applicant_auth_config where enabled) or exists(select 1 from public.applicant_identity_migrations) then raise exception 'Review existing applicant provider migration first';end if;
  if p_new_subject is null or length(p_new_subject) not between 1 and 128 or p_email is null or p_email<>lower(p_email) then raise exception 'Invalid migration identity';end if;
  provider_key:='gip:'||p_project||':'||p_tenant;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_realm||':'||p_email,7));
  select * into prior from public.gip_identity_migrations where realm=p_realm and old_subject=p_old_subject;
  if found then
    if prior.new_subject<>p_new_subject or prior.provider<>provider_key or prior.email<>p_email then raise exception 'Conflicting migration';end if;
    return prior.new_user_id;
  end if;
  select b.user_id into old_uid from public.auth_bindings b join public.app_users u on u.id=b.user_id join auth.users a on a.id=p_old_subject
    where b.provider='supabase' and b.subject=p_old_subject::text and u.realm='workspace' and u.email=p_email and lower(a.email)=p_email and a.email_confirmed_at is not null and not coalesce(a.is_anonymous,false);
  if old_uid is null then raise exception 'Original verified identity required';end if;
  if p_realm='workspace' then
    if not exists(select 1 from public.staff where user_id=old_uid and email=p_email) and not exists(select 1 from public.platform_owner where user_id=old_uid) then raise exception 'Existing workspace account required';end if;
    new_uid:=old_uid;
    update public.app_users set password_setup_required=true where id=new_uid;
  else
    if exists(select 1 from public.app_users where realm='applicant' and email=p_email) then raise exception 'Review existing applicant identity';end if;
    insert into public.app_users(email,realm,active) select email,'applicant',active from public.app_users where id=old_uid returning id into new_uid;
  end if;
  insert into public.auth_bindings(provider,subject,user_id) values(provider_key,p_new_subject,new_uid);
  insert into public.gip_identity_migrations(realm,old_subject,old_user_id,new_subject,new_user_id,provider,email) values(p_realm,p_old_subject,old_uid,p_new_subject,new_uid,provider_key,p_email);
  if p_realm='applicant' then
    perform set_config('app.applicant_migration',new_uid::text,true);
    update public.applications set user_id=new_uid where user_id=old_uid and lower(email)=p_email;
    update public.rental_drafts set owner_id=p_new_subject,
      test_run=case when test_run->>'account_id'=p_old_subject::text then jsonb_set(test_run,'{account_id}',to_jsonb(p_new_subject)) else test_run end
      where owner_id=p_old_subject::text and owner_email=p_email;
    -- Only this verified operator migration may rewrite the test identity
    -- marker on an already locked signing case. All lease/signing fields stay
    -- untouched, and the normal signing guard is restored immediately.
    signing_write:=current_setting('star.signing_write',true);
    perform set_config('star.signing_write','on',true);
    update public.applications set workspace=jsonb_set(workspace,'{test_run,account_id}',to_jsonb(p_new_subject)) where user_id=new_uid and lower(email)=p_email and workspace->'test_run'->>'account_id'=p_old_subject::text;
    perform set_config('star.signing_write',coalesce(signing_write,''),true);
  end if;
  insert into public.identity_audit(actor_id,acting_role,action,target_id,details) values(null,'operator','migrate_gip_identity',new_uid,jsonb_build_object('old_user_id',old_uid,'realm',p_realm,'provider',provider_key));
  return new_uid;
end $$;

create or replace function public.check_gip_auth_cutover() returns trigger language plpgsql security definer set search_path='' as $$
declare provider_key text;
begin
  if tg_op='UPDATE' and (new.project_id<>old.project_id or new.tenant_id<>old.tenant_id or new.realm<>old.realm) and
    (exists(select 1 from public.gip_identity_migrations where realm=old.realm) or exists(select 1 from public.auth_bindings where provider='gip:'||old.project_id||':'||old.tenant_id)) then raise exception 'Cannot replace a bound provider';end if;
  if not new.enabled then return new;end if;
  provider_key:='gip:'||new.project_id||':'||new.tenant_id;
  if new.realm='workspace' then
    if not exists(select 1 from public.platform_owner o join public.app_users u on u.id=o.user_id join public.auth_bindings b on b.user_id=u.id where b.provider=provider_key and u.realm='workspace' and u.email='info@starreusa.com' and u.active) then raise exception 'Pinned Owner migration required';end if;
    if exists(select 1 from public.staff s where s.active and (s.user_id is not null or s.access_state='active') and not exists(select 1 from public.auth_bindings b where b.provider=provider_key and b.user_id=s.user_id)) then raise exception 'All existing active workspace identities must be migrated';end if;
  else
    if exists(select 1 from public.applications a left join public.app_users u on u.id=a.user_id where u.realm is distinct from 'applicant' or not exists(select 1 from public.auth_bindings b where b.provider=provider_key and b.user_id=a.user_id)) then raise exception 'All applications must have migrated applicant identities';end if;
    if exists(select 1 from public.rental_drafts d where not exists(select 1 from public.auth_bindings b join public.app_users u on u.id=b.user_id where b.provider=provider_key and b.subject=d.owner_id and u.realm='applicant' and u.email=d.owner_email)) then raise exception 'All rental drafts must have migrated applicant identities';end if;
  end if;
  return new;
end $$;
drop trigger if exists gip_auth_cutover on public.gip_auth_realms;
create trigger gip_auth_cutover before insert or update on public.gip_auth_realms for each row execute function public.check_gip_auth_cutover();

do $$ declare signature text;begin
  foreach signature in array array[
    'resolve_gip_identity(text,text,text,text,text)',
    'resolve_gip_workspace_access(text,text,text,text)',
    'accept_gip_workspace_invitation(text,text,text,text,text)',
    'complete_gip_workspace_password_setup(text,text,text,text)',
    'set_gip_owner_admin(text,text,text,text,boolean,integer,text)',
    'migrate_gip_identity(uuid,text,text,text,text,text)',
    'check_gip_auth_cutover()'
  ] loop
    execute 'revoke all on function public.'||signature||' from public,anon,authenticated';
    execute 'grant execute on function public.'||signature||' to service_role';
  end loop;
end $$;
notify pgrst,'reload schema';

-- Server-only throttling for branded admin-generated email actions. No codes,
-- email addresses, credentials or raw IP addresses are retained in this table.
create table if not exists public.gip_auth_email_requests (
  id uuid primary key default gen_random_uuid(),
  request_key text not null check(request_key ~ '^[a-f0-9]{64}$'),
  ip_key text not null check(ip_key ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz not null default now()
);
create index if not exists gip_email_key_time on public.gip_auth_email_requests(request_key,requested_at);
create index if not exists gip_email_ip_time on public.gip_auth_email_requests(ip_key,requested_at);
alter table public.gip_auth_email_requests enable row level security;
revoke all on public.gip_auth_email_requests from public,anon,authenticated;
create or replace function public.reserve_gip_auth_email(p_key text,p_ip text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_key is null or p_ip is null or p_key !~ '^[a-f0-9]{64}$' or p_ip !~ '^[a-f0-9]{64}$' then raise exception 'Invalid email request';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gip-mail-ip:'||p_ip,7));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gip-mail-key:'||p_key,7));
  if exists(select 1 from public.gip_auth_email_requests where request_key=p_key and requested_at>now()-interval '1 minute') or
    (select count(*) from public.gip_auth_email_requests where request_key=p_key and requested_at>now()-interval '1 hour')>=10 or
    (select count(*) from public.gip_auth_email_requests where ip_key=p_ip and requested_at>now()-interval '1 hour')>=30 then return false;end if;
  delete from public.gip_auth_email_requests where requested_at<now()-interval '1 day';
  insert into public.gip_auth_email_requests(request_key,ip_key) values(p_key,p_ip);
  return true;
end $$;
revoke all on function public.reserve_gip_auth_email(text,text) from public,anon,authenticated;
grant execute on function public.reserve_gip_auth_email(text,text) to service_role;
