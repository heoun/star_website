-- Apply after workspace.sql. Service-only household writes with atomic version checks.
begin;
alter table public.applications add column if not exists rental_group_id uuid references public.applications(id);
update public.applications set rental_group_id=id where rental_group_id is null;
create index if not exists applications_rental_group_idx on public.applications(rental_group_id);
create or replace function public.initialize_rental_group() returns trigger language plpgsql set search_path='' as $$
begin
 new.rental_group_id:=coalesce(new.rental_group_id,new.id);
 new.workspace:=coalesce(new.workspace,'{}'::jsonb)||'{"rental_flow":"automatic"}'::jsonb;
 return new;
end $$;
drop trigger if exists initialize_rental_group on public.applications;
create trigger initialize_rental_group before insert on public.applications for each row execute function public.initialize_rental_group();

create or replace function public.commit_rental_group(p_root uuid,p_versions jsonb,p_patches jsonb,p_actor text,p_join uuid default null)
returns void language plpgsql security invoker set search_path='' as $$
declare a public.applications; source public.applications; entry record; patch jsonb;
begin
 -- This short transaction serializes membership changes with legacy writers and
 -- document inserts. No network calls run while the lock is held.
 lock table public.applications in share row exclusive mode;
 select * into a from public.applications where id=p_root and rental_group_id=p_root;
 if not found then raise exception 'Rental not found' using errcode='23505';end if;
 if p_actor is null or length(trim(p_actor))=0 or jsonb_typeof(p_versions)<>'object' or jsonb_typeof(p_patches)<>'object' then raise exception 'Invalid rental command';end if;
 if p_join is not null then
  select * into source from public.applications where id=p_join and rental_group_id=id;
  if not found or source.listing_id<>a.listing_id or source.id=a.id
    or (select count(*) from public.applications where rental_group_id=p_join)<>1 then raise exception 'Application cannot be joined' using errcode='23505';end if;
  -- Any stage before signing starts, on either side. An envelope out for
  -- signature is voided through its own flow first; a signature on file, an
  -- executed lease or a closed case never joins. The signing guard trigger
  -- separately refuses while a signing package is active.
  if exists(select 1 from public.applications m where (m.rental_group_id=p_root or m.id=p_join) and (
   m.status in ('lease_sent','lease_signed','declined') or m.workspace ? 'signed_lease'
   or m.workspace ? 'tenant_signature' or m.workspace ? 'landlord_signature'
   or coalesce(m.workspace->'signature_receipts','{}'::jsonb)<>'{}'::jsonb
   or (m.workspace ? 'signing' and coalesce(m.workspace->'signing'->>'phase','') not in ('voided','declined'))))
  then raise exception 'Signing or closed applications cannot be joined' using errcode='23505';end if;
 end if;
 if (select count(*) from jsonb_object_keys(p_versions))<>(select count(*) from public.applications where rental_group_id=p_root or id=p_join) or exists(
  select 1 from public.applications m where (m.rental_group_id=p_root or m.id=p_join) and (p_versions->>m.id::text)::integer is distinct from m.workspace_version
 ) then raise exception 'Rental changed' using errcode='23505';end if;
 if exists(select 1 from jsonb_object_keys(p_patches) k where not p_versions ? k) then raise exception 'Invalid member patch';end if;
 perform set_config('star.rental_write','on',true);
 if p_join is not null then update public.applications set rental_group_id=p_root,responsible_email=a.responsible_email,collaborator_emails=a.collaborator_emails where id=p_join;end if;
 for entry in select key,value from jsonb_each(p_patches) loop
  patch:=entry.value;
  if jsonb_typeof(patch)<>'object' or exists(select 1 from jsonb_object_keys(patch) k where k not in ('workspace','status','notes','lease_snapshot','responsible_email','collaborator_emails')) then raise exception 'Unsupported rental patch';end if;
  update public.applications m set
   workspace=case when patch ? 'workspace' then patch->'workspace' else m.workspace end,
   status=case when patch ? 'status' then patch->>'status' else m.status end,
   notes=case when patch ? 'notes' then patch->>'notes' else m.notes end,
   lease_snapshot=case when patch ? 'lease_snapshot' then nullif(patch->'lease_snapshot','null'::jsonb) else m.lease_snapshot end,
   responsible_email=case when patch ? 'responsible_email' then patch->>'responsible_email' else m.responsible_email end,
   collaborator_emails=case when patch ? 'collaborator_emails' then array(select jsonb_array_elements_text(patch->'collaborator_emails')) else m.collaborator_emails end,
   updated_at=now() where id=entry.key::uuid;
 end loop;
 -- Always advance the root, including per-person report updates.
 if not p_patches ? p_root::text then update public.applications set updated_at=now() where id=p_root;end if;
 select * into a from public.applications where id=p_root;
 update public.applications set responsible_email=a.responsible_email,collaborator_emails=a.collaborator_emails
  where rental_group_id=p_root and id<>p_root and (responsible_email is distinct from a.responsible_email or collaborator_emails is distinct from a.collaborator_emails);
 perform set_config('star.rental_write','off',true);
end $$;
revoke all on function public.commit_rental_group(uuid,jsonb,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.commit_rental_group(uuid,jsonb,jsonb,text,uuid) to service_role;

-- Applicant corrections revoke the whole group's offer, not just one person's checks.
create or replace function public.invalidate_rental_group() returns trigger language plpgsql security definer set search_path='' as $$
declare root_id uuid; group_status text;
begin
 if current_setting('star.rental_write',true)='on' then return new;end if;
 if (to_jsonb(new)-array['workspace','workspace_version','status','notes','updated_at','responsible_email','collaborator_emails','lease_snapshot']) is not distinct from
    (to_jsonb(old)-array['workspace','workspace_version','status','notes','updated_at','responsible_email','collaborator_emails','lease_snapshot']) then return new;end if;
 root_id:=old.rental_group_id;
 select status into group_status from public.applications where id=root_id;
 if group_status in ('lease_sent','lease_signed') then raise exception 'The signing lease must be voided before changing applicants';end if;
 new.workspace:=(new.workspace-'screening_result')||jsonb_build_object('checks',(coalesce(new.workspace->'checks','{}'::jsonb)-'credit_score')||'{"screening":"pending"}'::jsonb);
 if new.id=root_id then
  new.workspace:=new.workspace-array['recommendation','landlord_decision','delivery','lease_draft','lease_preparation','signature_receipts'];new.status:='review';new.lease_snapshot:=null;
 else
  update public.applications set workspace=workspace-array['recommendation','landlord_decision','delivery','lease_draft','lease_preparation','signature_receipts'],status='review',lease_snapshot=null,updated_at=now() where id=root_id;
 end if;
 return new;
end $$;
drop trigger if exists invalidate_rental_group on public.applications;
create trigger invalidate_rental_group before update on public.applications for each row execute function public.invalidate_rental_group();

create or replace function public.invalidate_deleted_rental_member() returns trigger language plpgsql security definer set search_path='' as $$
declare group_status text;
begin
 select status into group_status from public.applications where id=old.rental_group_id for update;
 if group_status in ('lease_sent','lease_signed') then raise exception 'The signing lease is locked';end if;
 if old.id<>old.rental_group_id then
  update public.applications set workspace=workspace-array['recommendation','landlord_decision','delivery','lease_draft','lease_preparation','signature_receipts'],status='review',lease_snapshot=null,updated_at=now() where id=old.rental_group_id;
 end if;
 return old;
end $$;
drop trigger if exists invalidate_deleted_rental_member on public.applications;
create trigger invalidate_deleted_rental_member before delete on public.applications for each row execute function public.invalidate_deleted_rental_member();

create or replace function public.invalidate_workspace_document_check() returns trigger
language plpgsql security definer set search_path='' as $$
declare app_id uuid; root_id uuid; group_status text;
begin
 app_id:=case when TG_OP='DELETE' then old.application_id else new.application_id end;
 select rental_group_id into root_id from public.applications where id=app_id;
 select status into group_status from public.applications where id=root_id for update;
 if group_status in ('lease_sent','lease_signed') then raise exception 'The signing lease is locked';end if;
 update public.applications a set workspace=(a.workspace-array['review','recommendation','landlord_decision','delivery','lease_draft','lease_preparation','signature_receipts'])||jsonb_build_object('checks',coalesce(a.workspace->'checks','{}'::jsonb)||'{"documents":"pending"}'::jsonb),status='review',lease_snapshot=null,updated_at=now()
 where a.id in (app_id,root_id) and a.status<>'declined';
 return null;
end $$;

-- Validated intake is inserted and invitation membership consumed in one transaction.
create or replace function public.submit_rental_application(p_application jsonb,p_root uuid default null,p_invite uuid default null)
returns public.applications language plpgsql security invoker set search_path='' as $$
declare a public.applications; r public.applications; invitation jsonb; members jsonb;
begin
 lock table public.applications in share row exclusive mode;
 if p_root is not null then
  select * into r from public.applications where id=p_root and rental_group_id=id;
  select i into invitation from jsonb_array_elements(coalesce(r.workspace->'invitations','[]'::jsonb)) i where i->>'id'=p_invite::text;
  if invitation is null or invitation ? 'accepted' or (invitation->>'expires')::timestamptz<now() or lower(invitation->>'email')<>lower(p_application->>'email') or r.listing_id<>(p_application->>'listing_id')::uuid or r.status in ('sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined') then raise exception 'Invitation is unavailable or belongs to another account' using errcode='23505';end if;
  if exists(select 1 from public.applications where rental_group_id=p_root and lower(email)=lower(p_application->>'email')) then raise exception 'Already in this group' using errcode='23505';end if;
 end if;
 if exists(select 1 from public.applications where listing_id=(p_application->>'listing_id')::uuid and lower(email)=lower(p_application->>'email') and status<>'declined') then raise exception 'An application already exists for this home. Ask the team to join your application to the group.' using errcode='23505';end if;
 a:=jsonb_populate_record(null::public.applications,p_application||jsonb_build_object('id',gen_random_uuid(),'status','new','workspace_version',0,'created_at',now(),'updated_at',now(),'collaborator_emails',coalesce(to_jsonb(r.collaborator_emails),'[]'::jsonb)));
 a.rental_group_id:=coalesce(p_root,a.id);a.workspace:=coalesce(a.workspace,'{}'::jsonb)||'{"rental_flow":"automatic"}'::jsonb;
 if p_root is not null then a.responsible_email:=r.responsible_email;end if;
 insert into public.applications select (a).* returning * into a;
 if p_root is not null then
  select jsonb_agg(case when i->>'id'=p_invite::text then i||jsonb_build_object('accepted',a.id) else i end) into members from jsonb_array_elements(r.workspace->'invitations') i;
  update public.applications set workspace=jsonb_set(workspace,'{invitations}',members),updated_at=now() where id=p_root;
 end if;
 return a;
end $$;
revoke all on function public.submit_rental_application(jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.submit_rental_application(jsonb,uuid,uuid) to service_role;
-- Enable new presentation for existing rows, preserving completed agreements.
update public.applications set workspace=workspace||'{"rental_flow":"automatic"}'::jsonb where workspace->>'rental_flow' is distinct from 'automatic';
-- Existing roommate names are pending invitations, never silently assumed to
-- have submitted an application or consented to merge with a competing group.
update public.applications a set workspace=a.workspace||jsonb_build_object('invitations',(
 select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'name',trim(coalesce(m->>'first_name','')||' '||coalesce(m->>'last_name','')),'email',lower(coalesce(m->>'email','')),'expires',now()+interval '14 days','delivery','pending')) from jsonb_array_elements(a.roommates) m
)),status='review',lease_snapshot=null
where a.rental_group_id=a.id and a.status not in ('landlord_approved','lease_sent','lease_signed','declined')
 and not a.workspace ? 'invitations' and jsonb_typeof(a.roommates)='array' and jsonb_array_length(a.roommates)>0;
update public.applications set workspace=workspace-array['recommendation','landlord_decision','delivery','lease_draft','lease_preparation']
where status='review' and jsonb_array_length(coalesce(workspace->'invitations','[]'::jsonb))>0;
notify pgrst,'reload schema';
commit;
