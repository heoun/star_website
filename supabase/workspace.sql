-- Three-role workspace; additive, repeatable. Run after schema.sql/backoffice.sql.
-- Existing approvals are NOT treated as evidence of landlord consent.
begin;
alter table public.applications add column if not exists responsible_email text;
alter table public.applications add column if not exists collaborator_emails text[] not null default '{}';
alter table public.applications add column if not exists workspace_version integer not null default 0;
alter table public.applications add column if not exists workspace jsonb not null default '{}';
alter table public.applications drop constraint if exists applications_status_check;
alter table public.applications add constraint applications_status_check check (status in (
  'new','contacted','fee_pending','screening','review','sent_to_landlord','needs_info',
  'approved','landlord_approved','declined','lease_sent','lease_signed'));
create index if not exists applications_responsible_idx on public.applications(responsible_email);
create index if not exists applications_collaborators_idx on public.applications using gin(collaborator_emails);

-- Every writer (including the older corrections and applicant document flow)
-- advances the version, so stale decisions cannot overwrite newer input.
create or replace function public.bump_application_workspace_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.workspace_version := old.workspace_version + 1;
  return new;
end $$;
drop trigger if exists application_workspace_version on public.applications;
create trigger application_workspace_version before update on public.applications
for each row execute function public.bump_application_workspace_version();

create or replace function public.update_application_workspace(
  p_id uuid, p_version integer, p_patch jsonb, p_actor text
) returns setof public.applications
language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_patch) <> 'object' or exists (
    select 1 from jsonb_object_keys(p_patch) k where k not in
      ('responsible_email','collaborator_emails','workspace','status','notes','lease_snapshot')
  ) then raise exception 'Unsupported workspace patch'; end if;
  if p_actor is null or length(trim(p_actor)) = 0 then raise exception 'Actor required'; end if;
  return query update public.applications a set
    responsible_email = case when p_patch ? 'responsible_email' then p_patch->>'responsible_email' else a.responsible_email end,
    collaborator_emails = case when p_patch ? 'collaborator_emails' then array(select jsonb_array_elements_text(p_patch->'collaborator_emails')) else a.collaborator_emails end,
    workspace = case when p_patch ? 'workspace' then p_patch->'workspace' else a.workspace end,
    status = case when p_patch ? 'status' then p_patch->>'status' else a.status end,
    notes = case when p_patch ? 'notes' then p_patch->>'notes' else a.notes end,
    lease_snapshot = case when p_patch ? 'lease_snapshot' then p_patch->'lease_snapshot' else a.lease_snapshot end,
    updated_at = now()
  where a.id = p_id and a.workspace_version = p_version
  returning a.*;
end $$;
revoke all on function public.update_application_workspace(uuid, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.update_application_workspace(uuid, integer, jsonb, text) to service_role;

-- Raw files changing after manual verification reopen review. A completed lease
-- remains immutable; its executed file lives in a separate private R2 prefix.
create or replace function public.invalidate_workspace_document_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare app_id uuid;
begin
  app_id := case when TG_OP = 'DELETE' then old.application_id else new.application_id end;
  update public.applications a set
    workspace = (a.workspace - 'review' - 'recommendation' - 'landlord_decision' - 'lease_preparation')
      || jsonb_build_object('checks', coalesce(a.workspace->'checks', '{}'::jsonb) || '{"documents":"pending"}'::jsonb),
    status = 'review', lease_snapshot = null, updated_at = now()
  where a.id = app_id and a.status not in ('declined','lease_sent','lease_signed')
    and a.workspace ? 'checks';
  return null;
end $$;
drop trigger if exists workspace_document_changed on public.application_documents;
create trigger workspace_document_changed after insert or delete on public.application_documents
for each row execute function public.invalidate_workspace_document_check();

alter table public.listing_change_requests add column if not exists proposal jsonb;
create or replace function public.publish_property_change_request(p_id uuid, p_actor text)
returns public.listing_change_requests language plpgsql security invoker set search_path = '' as $$
declare r public.listing_change_requests; current_value jsonb; field_id text;
begin
  select * into r from public.listing_change_requests where id = p_id for update;
  if not found or r.status not in ('open','in_progress') or r.proposal is null or r.building_id is null then
    raise exception 'Request not publishable';
  end if;
  field_id := r.proposal->>'field_id';
  if field_id not in ('rent.due_day','lease.end_time') and field_id not like 'utility.%' then raise exception 'Unsupported default'; end if;
  -- Briefly serialize settings writes, including first creation of a layer.
  -- This prevents an approved stale proposal overwriting a concurrent direct edit.
  lock table public.lease_settings in share row exclusive mode;
  select s.field_values->field_id into current_value from public.lease_settings s
    where s.scope = 'building' and s.building_id = r.building_id and s.listing_id is null;
  if coalesce(current_value, 'null'::jsonb) is distinct from r.proposal->'previous_value' then raise exception 'Default changed'; end if;
  perform public.lease_settings_apply('building', r.building_id, null,
    jsonb_build_object(field_id, r.proposal->'value'), p_actor);
  update public.listing_change_requests set status = 'resolved', response = 'Approved and published to property defaults.',
    updated_by = p_actor, updated_at = now() where id = p_id returning * into r;
  return r;
end $$;
revoke all on function public.publish_property_change_request(uuid, text) from public, anon, authenticated;
grant execute on function public.publish_property_change_request(uuid, text) to service_role;
notify pgrst, 'reload schema';
commit;
