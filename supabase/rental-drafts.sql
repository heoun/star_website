-- Apply after rental-flow.sql. An invitation exists before anyone submits.
begin;
create table if not exists public.rental_drafts (
 id uuid primary key,
 listing_id uuid not null references public.listings(id),
 owner_id text not null,
 owner_email text not null,
 invitations jsonb not null,
 test_run jsonb,
 activated boolean not null default false,
 created_at timestamptz not null default now()
);
alter table public.rental_drafts enable row level security;
revoke all on public.rental_drafts from public,anon,authenticated;
grant select,insert,update on public.rental_drafts to service_role;
create index if not exists rental_drafts_listing_idx on public.rental_drafts(listing_id);

-- Actor identity and test metadata are supplied only by the authenticated Worker.
create or replace function public.save_rental_draft(p_id uuid,p_listing uuid,p_owner text,p_email text,p_roommates jsonb,p_test jsonb default null)
returns public.rental_drafts language plpgsql security invoker set search_path='' as $$
declare d public.rental_drafts; r public.applications; item jsonb; entries jsonb; capacity integer;
begin
 lock table public.applications in share row exclusive mode;
 lock table public.rental_drafts in share row exclusive mode;
 select * into d from public.rental_drafts where id=p_id;
 if d.id is null then
  if exists(select 1 from public.applications where id=p_id) then raise exception 'Group ID already in use' using errcode='23505';end if;
  if coalesce(p_owner,'')='' or coalesce(p_email,'')='' then raise exception 'Authenticated owner required';end if;
  insert into public.rental_drafts(id,listing_id,owner_id,owner_email,invitations,test_run)
   values(p_id,p_listing,p_owner,lower(p_email),jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'email',lower(p_email),'name',lower(p_email),'role','inviter','delivery','sent','expires',now()+interval '14 days')),p_test) returning * into d;
 end if;
 if d.owner_id<>p_owner or d.owner_email<>lower(p_email) or d.listing_id<>p_listing or (d.test_run is null)<>(p_test is null) then raise exception 'Group belongs to another account' using errcode='23505';end if;
 entries:=d.invitations;
 if d.activated then
  select * into r from public.applications where id=d.id and rental_group_id=id;
  if r.id is null or r.status in ('sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined') then raise exception 'Group is closed' using errcode='23505';end if;
  entries:=r.workspace->'invitations';
 end if;
 if not exists(select 1 from jsonb_array_elements(entries) i where i->>'role'='inviter' and not i ? 'accepted' and (i->>'expires')::timestamptz>=now()) then raise exception 'Inviter already submitted or invitation expired' using errcode='23505';end if;
 for item in select * from jsonb_array_elements(p_roommates) loop
  if lower(item->>'email')=lower(p_email) then raise exception 'Cannot invite yourself' using errcode='23505';end if;
  if not exists(select 1 from jsonb_array_elements(entries) i where i->>'email'=lower(item->>'email')) then
   entries:=entries||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'email',lower(item->>'email'),'name',item->>'name','delivery','pending','expires',now()+interval '14 days'));
  end if;
 end loop;
 select greatest(1,least(5,coalesce(bedrooms,2))) into capacity from public.listings where id=p_listing;
 if jsonb_array_length(entries)>capacity then raise exception 'Group capacity exceeded' using errcode='23505';end if;
 update public.rental_drafts set invitations=entries where id=p_id returning * into d;
 if d.activated then update public.applications set workspace=jsonb_set(workspace,'{invitations}',entries),updated_at=now() where id=p_id;end if;
 return d;
end $$;

create or replace function public.submit_draft_application(p_group uuid,p_actor text,p_application jsonb,p_invite uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.rental_drafts; r public.applications; a public.applications; invitation jsonb; entries jsonb; app_id uuid; capacity integer; w jsonb;
begin
 -- Same lock order as membership changes and ordinary intake; duplicate clicks
 -- and simultaneous lead/roommate submissions cannot create two cases.
 lock table public.applications in share row exclusive mode;
 lock table public.rental_drafts in share row exclusive mode;
 select * into d from public.rental_drafts where id=p_group;
 if d.id is null or d.listing_id<>(p_application->>'listing_id')::uuid then raise exception 'Invitation not found' using errcode='23505';end if;
 entries:=d.invitations;
 if d.activated then
  select * into r from public.applications where id=d.id and rental_group_id=id;
  if r.id is null then raise exception 'Group was removed or separated' using errcode='23505';end if;
  entries:=coalesce(r.workspace->'invitations','[]');
 end if;
 select i into invitation from jsonb_array_elements(entries) i where i->>'email'=lower(p_application->>'email') and (p_invite is null or i->>'id'=p_invite::text);
 if invitation is null or (invitation->>'role'='inviter' and d.owner_id<>p_actor) then raise exception 'Invitation belongs to another account' using errcode='23505';end if;
 if invitation ? 'accepted' then
  select * into a from public.applications where id=(invitation->>'accepted')::uuid and rental_group_id=p_group and lower(email)=lower(p_application->>'email');
  if a.id is null then raise exception 'Membership changed' using errcode='23505';end if;
  return jsonb_build_object('application',to_jsonb(a),'replayed',true);
 end if;
 if (invitation->>'expires')::timestamptz<now() or r.status in ('sent_to_landlord','landlord_approved','lease_sent','lease_signed','declined') then raise exception 'Invitation expired or group closed' using errcode='23505';end if;
 select greatest(1,least(5,coalesce(bedrooms,2))) into capacity from public.listings where id=d.listing_id;
 if (select count(*) from public.applications where rental_group_id=p_group)>=capacity then raise exception 'Group is full' using errcode='23505';end if;
 -- Internal test groups intentionally permit repeat runs. Normal applications
 -- retain the existing one-active-application-per-home rule.
 if d.test_run is null and exists(select 1 from public.applications where listing_id=d.listing_id and lower(email)=lower(p_application->>'email') and status<>'declined') then raise exception 'An application already exists for this home' using errcode='23505';end if;
 -- Only the inviter chooses an agent on intake. If a roommate created the
 -- case first, honor that later choice without overwriting a staff assignment.
 if d.activated and invitation->>'role'='inviter' and r.responsible_email is null and nullif(p_application->>'responsible_email','') is not null then
  r.responsible_email:=p_application->>'responsible_email';
  update public.applications set responsible_email=r.responsible_email,updated_at=now() where rental_group_id=p_group;
 end if;
 app_id:=case when d.activated then gen_random_uuid() else p_group end;
 select jsonb_agg(case when i->>'id'=invitation->>'id' then i||jsonb_build_object('accepted',app_id) else i end) into entries from jsonb_array_elements(entries) i;
 w:=(coalesce(p_application->'workspace','{}')-'test_run')||jsonb_build_object('rental_flow','automatic','invitations',case when d.activated then '[]'::jsonb else entries end);
 if d.test_run is not null then w:=w||jsonb_build_object('test_run',d.test_run||jsonb_build_object('member_of',p_group));end if;
 a:=jsonb_populate_record(null::public.applications,p_application||jsonb_build_object('id',app_id,'rental_group_id',p_group,'status','new','workspace',w,'workspace_version',0,'created_at',now(),'updated_at',now(),'collaborator_emails',coalesce(to_jsonb(r.collaborator_emails),'[]'::jsonb)));
 if d.activated then a.responsible_email:=r.responsible_email;end if;
 insert into public.applications select (a).* returning * into a;
 if d.activated then update public.applications set workspace=jsonb_set(workspace,'{invitations}',entries),updated_at=now() where id=p_group;end if;
 update public.rental_drafts set activated=true,invitations=entries where id=p_group;
 return jsonb_build_object('application',to_jsonb(a),'replayed',false);
end $$;
create or replace function public.record_draft_invite_delivery(p_group uuid,p_sent jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare d public.rental_drafts; entries jsonb;
begin
 lock table public.applications in share row exclusive mode;
 lock table public.rental_drafts in share row exclusive mode;
 select * into d from public.rental_drafts where id=p_group;
 entries:=d.invitations;
 if d.activated then select workspace->'invitations' into entries from public.applications where id=p_group and rental_group_id=id;end if;
 if entries is null then return false;end if;
 select jsonb_agg(case when p_sent ? (i->>'email') then i||'{"delivery":"sent"}'::jsonb else i end) into entries from jsonb_array_elements(entries) i;
 update public.rental_drafts set invitations=entries where id=p_group;
 if d.activated then update public.applications set workspace=jsonb_set(workspace,'{invitations}',entries),updated_at=now() where id=p_group;end if;
 return true;
end $$;
revoke all on function public.record_draft_invite_delivery(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_draft_invite_delivery(uuid,jsonb) to service_role;
revoke all on function public.save_rental_draft(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.submit_draft_application(uuid,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.save_rental_draft(uuid,uuid,text,text,jsonb,jsonb) to service_role;
grant execute on function public.submit_draft_application(uuid,text,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
commit;
