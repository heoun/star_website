-- Additive, inactive until an operator provisions and verifies the separate Auth project.
-- The Worker verifies /auth/v1/user with this issuer before invoking the service-only resolver.
create or replace function public.resolve_applicant_identity(p_subject uuid,p_email text,p_issuer text)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid; provider_key text;
begin
  if not exists(select 1 from public.applicant_auth_config where issuer=p_issuer and enabled) then
    raise exception 'Applicant authentication is not ready';
  end if;
  if coalesce(p_email,'')='' or p_email<>lower(p_email) then raise exception 'Verified mailbox required';end if;
  provider_key:='supabase-applicant:'||p_issuer;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('applicant:'||p_email,7));
  select user_id into uid from public.auth_bindings where provider=provider_key and subject=p_subject::text;
  if uid is null then
    if exists(select 1 from public.app_users where realm='applicant' and email=p_email) then
      raise exception 'Identity binding requires operator review';
    end if;
    if exists(select 1 from public.applications a join public.app_users u on u.id=a.user_id where u.realm='workspace' and lower(a.email)=p_email) then
      raise exception 'Existing applications require identity migration';
    end if;
    insert into public.app_users(email,realm) values(p_email,'applicant') returning id into uid;
    insert into public.auth_bindings(provider,subject,user_id) values(provider_key,p_subject::text,uid);
  end if;
  if not exists(select 1 from public.app_users where id=uid and realm='applicant' and active and email=p_email) then
    raise exception 'Applicant account unavailable';
  end if;
  return uid;
end $$;
revoke all on function public.resolve_applicant_identity(uuid,text,text) from public,anon,authenticated;
grant execute on function public.resolve_applicant_identity(uuid,text,text) to service_role;

create table if not exists public.applicant_identity_migrations (
  old_subject uuid primary key,
  old_user_id uuid not null references public.app_users(id),
  new_subject uuid not null unique,
  new_user_id uuid not null unique references public.app_users(id),
  email text not null,
  issuer text not null references public.applicant_auth_config(issuer),
  migrated_at timestamptz not null default now()
);
alter table public.applicant_identity_migrations enable row level security;
revoke all on public.applicant_identity_migrations from public,anon,authenticated;
grant select on public.applicant_identity_migrations to service_role;

-- Only the migration RPC may change a pinned application identity, and only
-- along the exact old/new mapping it recorded inside the same transaction.
create or replace function public.attach_application_identity() returns trigger language plpgsql security definer set search_path='' as $$
declare uid uuid; expected_realm text;
begin
  if tg_op='UPDATE' and old.user_id is not null then
    if new.user_id is distinct from old.user_id and not (
      coalesce(current_setting('app.applicant_migration',true),'')=new.user_id::text
      and exists(select 1 from public.applicant_identity_migrations m where m.old_user_id=old.user_id and m.new_user_id=new.user_id and m.email=lower(new.email))
    ) then raise exception 'Application identity cannot be reassigned'; end if;
    return new;
  end if;
  expected_realm:=case when exists(select 1 from public.applicant_auth_config where enabled) then 'applicant' else 'workspace' end;
  select a.id into uid from public.app_users a where a.realm=expected_realm and a.email=lower(new.email);
  if new.user_id is not null and new.user_id is distinct from uid then raise exception 'Application identity mismatch'; end if;
  new.user_id:=uid;
  return new;
end $$;

-- An operator must first create and verify the target Auth record against the
-- new provider's Admin API. No passwords, MFA factors or staff grants are copied.
create or replace function public.migrate_applicant_identity(p_old_subject uuid,p_new_subject uuid,p_email text,p_issuer text)
returns uuid language plpgsql security definer set search_path='' as $$
declare old_uid uuid; new_uid uuid; prior public.applicant_identity_migrations; provider_key text;
begin
  if not exists(select 1 from public.applicant_auth_config where issuer=p_issuer and not enabled) then
    raise exception 'Migration requires inactive applicant authentication';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('applicant:'||lower(p_email),7));
  select * into prior from public.applicant_identity_migrations where old_subject=p_old_subject;
  if found then
    if prior.new_subject<>p_new_subject or prior.email<>lower(p_email) or prior.issuer<>p_issuer then raise exception 'Conflicting migration';end if;
    return prior.new_user_id;
  end if;
  select b.user_id into old_uid from public.auth_bindings b join public.app_users u on u.id=b.user_id
    join auth.users a on a.id=p_old_subject and lower(a.email)=lower(p_email) and a.email_confirmed_at is not null and not coalesce(a.is_anonymous,false)
    where b.provider='supabase' and b.subject=p_old_subject::text and u.realm='workspace' and u.email=lower(p_email);
  if old_uid is null then raise exception 'Original verified identity required';end if;
  if exists(select 1 from public.app_users where realm='applicant' and email=lower(p_email)) then raise exception 'Review existing applicant identity';end if;
  insert into public.app_users(email,realm,active) select lower(p_email),'applicant',active from public.app_users where id=old_uid returning id into new_uid;
  provider_key:='supabase-applicant:'||p_issuer;
  insert into public.auth_bindings(provider,subject,user_id) values(provider_key,p_new_subject::text,new_uid);
  insert into public.applicant_identity_migrations(old_subject,old_user_id,new_subject,new_user_id,email,issuer)
    values(p_old_subject,old_uid,p_new_subject,new_uid,lower(p_email),p_issuer);
  perform set_config('app.applicant_migration',new_uid::text,true);
  update public.applications set user_id=new_uid where user_id=old_uid and lower(email)=lower(p_email);
  -- These older references still store provider subjects, not business IDs.
  update public.rental_drafts set owner_id=p_new_subject::text,
    test_run=case when test_run->>'account_id'=p_old_subject::text then jsonb_set(test_run,'{account_id}',to_jsonb(p_new_subject::text)) else test_run end
    where owner_id=p_old_subject::text and owner_email=lower(p_email);
  update public.applications set workspace=jsonb_set(workspace,'{test_run,account_id}',to_jsonb(p_new_subject::text))
    where workspace->'test_run'->>'account_id'=p_old_subject::text;
  insert into public.identity_audit(actor_id,acting_role,action,target_id,details)
    values(null,'operator','migrate_applicant_identity',new_uid,jsonb_build_object('old_user_id',old_uid,'issuer',p_issuer));
  return new_uid;
end $$;
revoke all on function public.migrate_applicant_identity(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.migrate_applicant_identity(uuid,uuid,text,text) to service_role;

-- Refuse a partial cutover; operators resolve orphaned/legacy records explicitly.
create or replace function public.check_applicant_auth_cutover() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and new.issuer is distinct from old.issuer and exists(select 1 from public.applicant_identity_migrations) then
    raise exception 'Cannot replace an issuer with migrated identities';
  end if;
  if new.enabled then
    if exists(select 1 from public.applications a left join public.app_users u on u.id=a.user_id where u.realm is distinct from 'applicant') then
      raise exception 'All applications must have applicant identities before cutover';
    end if;
    if exists(select 1 from public.rental_drafts d where not exists(
      select 1 from public.auth_bindings b join public.app_users u on u.id=b.user_id
      where b.provider='supabase-applicant:'||new.issuer and b.subject=d.owner_id and u.realm='applicant' and u.email=d.owner_email
    )) then raise exception 'All rental drafts must have applicant identities before cutover'; end if;
  end if;
  return new;
end $$;
drop trigger if exists applicant_auth_cutover on public.applicant_auth_config;
create trigger applicant_auth_cutover before insert or update on public.applicant_auth_config for each row execute function public.check_applicant_auth_cutover();
revoke all on function public.check_applicant_auth_cutover() from public,anon,authenticated;
notify pgrst,'reload schema';
