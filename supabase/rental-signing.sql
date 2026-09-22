-- Apply after rental-flow.sql. No external calls are made inside transactions.
begin;
create table if not exists public.rental_signing_packages (
 id uuid primary key, rental_id uuid not null references public.applications(id),
 record jsonb not null, member_versions jsonb not null, reserved boolean not null default false,
 active boolean not null default false, created_at timestamptz not null default now()
);
create unique index if not exists rental_signing_active on public.rental_signing_packages(rental_id) where active;
create unique index if not exists rental_signing_envelope on public.rental_signing_packages((record->'envelope'->>'accountId'),(record->'envelope'->>'envelopeId')) where record->'envelope'->>'envelopeId' is not null;
create table if not exists public.rental_signing_jobs (
 package_id uuid primary key references public.rental_signing_packages(id),
 due_at timestamptz, claim_token uuid, expires_at timestamptz,
 wake boolean not null default false
);
create table if not exists public.rental_signing_inbox (
 hash text primary key, notice jsonb not null, received_at timestamptz not null default now()
);
alter table public.rental_signing_packages enable row level security;
alter table public.rental_signing_jobs enable row level security;
alter table public.rental_signing_inbox enable row level security;
revoke all on public.rental_signing_packages,public.rental_signing_jobs,public.rental_signing_inbox from public,anon,authenticated;
grant all on public.rental_signing_packages,public.rental_signing_jobs,public.rental_signing_inbox to service_role;

-- Covers legacy writers as well as the new routes. Allow notes and assignment;
-- changes to any signing facts, documents or membership must await a void.
create or replace function public.guard_rental_signing() returns trigger language plpgsql security definer set search_path='' as $$
declare rid uuid; destination uuid; locked boolean;
begin
 if current_setting('star.signing_write',true)='on' then
  if tg_op='DELETE' then return old; else return new; end if;
 end if;
 if tg_table_name='application_documents' then
  select rental_group_id into rid from public.applications where id=case when tg_op='INSERT' then new.application_id else old.application_id end;
  if tg_op='UPDATE' then select rental_group_id into destination from public.applications where id=new.application_id;end if;
 else rid:=case when tg_op='INSERT' then new.rental_group_id else old.rental_group_id end;
  if tg_op='UPDATE' then destination:=new.rental_group_id;end if;
 end if;
 -- Same table lock order as reserve/commit_rental_group; document changes also
 -- serialize against sending while their existing trigger invalidates readiness.
 perform 1 from public.applications where id in (rid,destination) order by id for update;
 select exists(select 1 from public.rental_signing_packages where rental_id in (rid,destination) and active) into locked;
 if not locked then if tg_op='DELETE' then return old; else return new; end if; end if;
 if tg_table_name='applications' and tg_op='UPDATE' then
  if (to_jsonb(new)-array['user_id','workspace_version','updated_at','notes','responsible_email','collaborator_emails','workspace'])=
     (to_jsonb(old)-array['user_id','workspace_version','updated_at','notes','responsible_email','collaborator_emails','workspace']) and
     (new.workspace-array['admin_note','activity'])=(old.workspace-array['admin_note','activity']) then return new; end if;
 end if;
 raise exception 'Void the DocuSign lease before changing signing information' using errcode='23505';
end $$;
drop trigger if exists aa_guard_rental_signing on public.applications;
create trigger aa_guard_rental_signing before insert or update or delete on public.applications for each row execute function public.guard_rental_signing();
drop trigger if exists aa_guard_rental_signing on public.application_documents;
create trigger aa_guard_rental_signing before insert or update or delete on public.application_documents for each row execute function public.guard_rental_signing();

create or replace function public.reserve_rental_signing(p_id uuid,p_actor text,p_versions jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.applications; s public.rental_signing_packages; staff_role text; w jsonb;
begin
 lock table public.applications in share row exclusive mode;
 select * into s from public.rental_signing_packages where id=p_id for update;
 if not found then raise exception 'Preview not found' using errcode='23505'; end if;
 select * into a from public.applications where id=s.rental_id;
 select role into staff_role from public.staff where lower(email)=lower(p_actor) and active;
 if staff_role not in ('manager','agent') or staff_role is null or
  (staff_role='agent' and lower(p_actor)<>coalesce(lower(a.responsible_email),'') and not lower(p_actor)=any(coalesce(a.collaborator_emails,'{}'))) then raise exception 'Staff access required' using errcode='42501';end if;
 if s.reserved then return s.record;end if;
 if s.created_at<now()-interval '1 hour' or a.status<>'landlord_approved' or a.lease_snapshot is null
  or a.lease_snapshot is distinct from s.record->'package'->'values'
  or a.workspace->'landlord_decision'->>'outcome' is distinct from 'accepted'
  or a.workspace->'recommendation'->'revision' is distinct from s.record->'package'->'approvalRevision'
  or a.workspace->'landlord_decision'->'revision' is distinct from s.record->'package'->'approvalRevision'
  or p_versions is distinct from s.member_versions then raise exception 'Lease preview changed or expired' using errcode='23505';end if;
 if (select count(*) from jsonb_object_keys(p_versions))<>(select count(*) from public.applications where rental_group_id=a.id)
  or exists(select 1 from public.applications m where rental_group_id=a.id and (p_versions->>m.id::text)::integer is distinct from m.workspace_version)
  then raise exception 'Rental changed' using errcode='23505';end if;
 update public.rental_signing_packages set reserved=true,active=true where id=p_id;
 insert into public.rental_signing_jobs(package_id,due_at) values(p_id,now());
 perform set_config('star.signing_write','on',true);
 w:=a.workspace||jsonb_build_object('signing',jsonb_build_object('package_id',p_id,'phase','preparing'));
 w:=jsonb_set(w,'{activity}',coalesce(w->'activity','[]')||jsonb_build_array(jsonb_build_object('action','send_lease','by',p_actor,'at',now(),'detail','Requested DocuSign signing for the reviewed lease.')));
 update public.applications set workspace=w where id=a.id;
 perform set_config('star.signing_write','off',true);
 return s.record;
end $$;

create or replace function public.claim_rental_signing(p_limit integer) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 with due as (select package_id from public.rental_signing_jobs where due_at<=now() and (expires_at is null or expires_at<now()) order by due_at for update skip locked limit least(greatest(p_limit,1),5)),
 claimed as (update public.rental_signing_jobs j set claim_token=gen_random_uuid(),expires_at=now()+interval '5 minutes',wake=false from due where j.package_id=due.package_id returning j.*)
 select coalesce(jsonb_agg(jsonb_build_object('packageId',package_id,'claimToken',claim_token,'expiresAt',expires_at)),'[]') into result from claimed;
 return result;
end $$;

create or replace function public.save_rental_signing(p_id uuid,p_record jsonb,p_version integer,p_token uuid) returns void language plpgsql security invoker set search_path='' as $$
declare s public.rental_signing_packages; a public.applications; w jsonb; signer jsonb; receipt jsonb; receipts jsonb:='{}'; all_tenants boolean:=true; landlord_done boolean:=false; phase text; old_phase text; env jsonb;
begin
 lock table public.applications in share row exclusive mode;
 select * into s from public.rental_signing_packages where id=p_id for update;
 if not found or not s.reserved or (s.record->>'version')::integer<>p_version or s.record->'package' is distinct from p_record->'package'
  or not exists(select 1 from public.rental_signing_jobs where package_id=p_id and claim_token=p_token and expires_at>now()) then raise exception 'Signing claim expired or changed' using errcode='23505';end if;
 phase:=p_record->>'phase';old_phase:=s.record->>'phase';env:=p_record->'envelope';
 if old_phase in ('completed','voided','declined') and phase<>old_phase then raise exception 'Terminal signing state cannot regress';end if;
 if s.record->'envelope'->>'envelopeId' is not null and (s.record->'envelope'->>'envelopeId' is distinct from env->>'envelopeId' or s.record->'envelope'->>'accountId' is distinct from env->>'accountId') then raise exception 'Envelope binding cannot change';end if;
 select * into a from public.applications where id=s.rental_id;
 w:=a.workspace;
 for signer in select value from jsonb_array_elements(p_record->'package'->'signers') loop
  select value into receipt from jsonb_array_elements(coalesce(env->'recipients','[]')) where value->>'recipientId'=signer->>'recipientId' and value->>'status'='completed';
  if signer->>'role'='tenant' then
   if receipt is null then all_tenants:=false;else receipts:=receipts||jsonb_build_object(signer->>'memberId',jsonb_build_object('reference',env->>'envelopeId','by','docusign','at',receipt->>'signedAt'));end if;
  elsif receipt is not null then landlord_done:=true;end if;
 end loop;
 if phase='completed' and (env->>'status'<>'completed' or not all_tenants or not landlord_done or p_record->'signedPdf' is null or p_record->'certificate' is null) then raise exception 'Signing archive incomplete';end if;
 w:=w||jsonb_build_object('signature_receipts',receipts,'signing',jsonb_build_object('package_id',p_id,'phase',phase));
 if all_tenants then w:=w||jsonb_build_object('tenant_signature',jsonb_build_object('reference',env->>'envelopeId','by','docusign','at',env->>'statusChangedAt'));end if;
 if landlord_done and all_tenants then w:=w||jsonb_build_object('landlord_signature',jsonb_build_object('reference',env->>'envelopeId','by','docusign','at',env->>'statusChangedAt'));end if;
 if phase='completed' then w:=w||jsonb_build_object('signed_lease',p_record->'signedPdf');end if;
 if phase<>old_phase then w:=jsonb_set(w,'{activity}',coalesce(w->'activity','[]')||jsonb_build_array(jsonb_build_object('action','signing_update','by','docusign','at',now(),'detail','DocuSign: '||phase)));end if;
 perform set_config('star.signing_write','on',true);
 update public.applications set workspace=w,status=case when phase='completed' then 'lease_signed' when env->>'status' in ('sent','delivered','completed') then 'lease_sent' else status end where id=a.id;
 -- Voiding/declining closes this signing version. A new landlord approval is required.
 if phase in ('voided','declined') and old_phase<>phase then
  update public.applications set status='review',lease_snapshot=null,workspace=(w-array['recommendation','landlord_decision','lease_draft','lease_preparation','tenant_signature','landlord_signature','signature_receipts']) where id=a.id;
 end if;
 update public.rental_signing_packages set record=jsonb_set(p_record,'{version}',to_jsonb(p_version+1)),active=phase not in ('voided','declined') where id=p_id;
 perform set_config('star.signing_write','off',true);
end $$;

create or replace function public.release_rental_signing(p_id uuid,p_token uuid,p_retry timestamptz) returns void language plpgsql security invoker set search_path='' as $$
begin
 update public.rental_signing_jobs set due_at=case when wake then now() else p_retry end,claim_token=null,expires_at=null,wake=false where package_id=p_id and claim_token=p_token;
end $$;

create or replace function public.enqueue_rental_signing(p_notice jsonb,p_hash text) returns void language plpgsql security invoker set search_path='' as $$
begin
 insert into public.rental_signing_inbox(hash,notice)values(p_hash,p_notice) on conflict do nothing;
 if not found then return;end if;
 update public.rental_signing_jobs j set wake=true,due_at=least(coalesce(due_at,now()),now()) from public.rental_signing_packages s
 where j.package_id=s.id and s.record->'envelope'->>'accountId'=p_notice->>'accountId' and s.record->'envelope'->>'envelopeId'=p_notice->>'envelopeId';
end $$;

create or replace function public.void_rental_signing(p_id uuid,p_actor text,p_reason text) returns void language plpgsql security invoker set search_path='' as $$
declare s public.rental_signing_packages; a public.applications; r text;
begin
 lock table public.applications in share row exclusive mode;
 select * into s from public.rental_signing_packages where id=p_id for update;
 select * into a from public.applications where id=s.rental_id;
 select role into r from public.staff where lower(email)=lower(p_actor) and active;
 if r is null or r not in ('manager','agent') or (r='agent' and lower(p_actor)<>coalesce(lower(a.responsible_email),'') and not lower(p_actor)=any(coalesce(a.collaborator_emails,'{}'))) then raise exception 'Staff access required' using errcode='42501';end if;
 if not s.active or s.record->>'phase' in ('archiving','completed') or s.record->'envelope'->>'status'='completed' or length(trim(p_reason)) not between 1 and 200 then raise exception 'This envelope cannot be voided';end if;
 update public.rental_signing_packages set record=jsonb_set(jsonb_set(record,'{voidReason}',to_jsonb(p_reason)),'{version}',to_jsonb((record->>'version')::integer+1)) where id=p_id;
 update public.rental_signing_jobs set wake=true,due_at=now() where package_id=p_id;
end $$;

-- Execute rights are limited to the backend service identity.
do $$ declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('reserve_rental_signing','claim_rental_signing','save_rental_signing','release_rental_signing','enqueue_rental_signing','void_rental_signing') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
notify pgrst, 'reload schema';
