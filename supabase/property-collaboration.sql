-- Temporary property work is isolated from live settings until explicit approval.
create table if not exists public.property_collaborations (
 id uuid primary key default gen_random_uuid(),
 building_id uuid not null references public.buildings(id),
 agent_email text not null references public.staff(email),
 granted_by text not null,
 expires_at timestamptz not null,
 state text not null default 'draft' check(state in ('draft','submitted','approved','revoked')),
 version integer not null default 0,
 base_property jsonb not null,
 base_settings jsonb not null,
 property_patch jsonb not null default '{}',
 settings_patch jsonb not null default '{}',
 documents jsonb not null default '[]',
 note text not null default '',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists property_collaborations_agent on public.property_collaborations(agent_email,expires_at);
create table if not exists public.property_collaboration_history (
 id uuid primary key default gen_random_uuid(),
 collaboration_id uuid not null references public.property_collaborations(id),
 actor text not null, action text not null, details jsonb not null,
 created_at timestamptz not null default now()
);
alter table public.property_collaborations enable row level security;
alter table public.property_collaboration_history enable row level security;
revoke all on public.property_collaborations,public.property_collaboration_history from public,anon,authenticated;
grant select on public.property_collaborations,public.property_collaboration_history to service_role;

create or replace function public.property_collaboration_command(
 p_actor text, p_action text, p_id uuid default null, p_body jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 actor public.staff; r public.property_collaborations; b public.buildings;
 settings jsonb; result jsonb; before_row jsonb; target public.staff; expiry timestamptz;
begin
 select * into actor from public.staff where email=p_actor and active for share;
 if not found or actor.role not in ('manager','agent') then return jsonb_build_object('error','Workspace access required.','status',403); end if;
 if p_action='list' then
   select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'building_id',c.building_id,'name',building_row.name,'agent_email',c.agent_email,
    'expires_at',c.expires_at,'state',c.state,'version',c.version) order by c.created_at desc),'[]') into result
   from public.property_collaborations c join public.buildings building_row on building_row.id=c.building_id
   where (actor.role='manager' or (c.agent_email=p_actor and c.expires_at>now() and c.state in ('draft','submitted')))
    and (p_body->>'building_id' is null or c.building_id=(p_body->>'building_id')::uuid);
   return jsonb_build_object('collaborations',result);
 end if;
 if p_action='grant' then
   if actor.role<>'manager' then return jsonb_build_object('error','Only Admin can grant access.','status',403); end if;
   select * into target from public.staff where email=p_body->>'agent_email' and active and role='agent' for share;
   if not found then return jsonb_build_object('error','Choose an active Agent.','status',422); end if;
   expiry:=(p_body->>'expires_at')::timestamptz;
   if expiry is null or expiry<=now() or expiry>now()+interval '90 days' then return jsonb_build_object('error','Choose an expiry within 90 days.','status',422); end if;
   select * into b from public.buildings where id=(p_body->>'building_id')::uuid for update;
   if not found then return jsonb_build_object('error','Property not found.','status',404); end if;
   if exists(select 1 from public.property_collaborations where building_id=b.id and agent_email=target.email and state in ('draft','submitted') and expires_at>now()) then
    return jsonb_build_object('error','This Agent already has an open assignment for this property.','status',409);
   end if;
   select coalesce(field_values,'{}') into settings from public.lease_settings where scope='building' and building_id=b.id;
   insert into public.property_collaborations(building_id,agent_email,granted_by,expires_at,base_property,base_settings)
   values(b.id,target.email,p_actor,expiry,to_jsonb(b),coalesce(settings,'{}')) returning * into r;
 else
   select * into r from public.property_collaborations where id=p_id for update;
   if not found then return jsonb_build_object('error','Assignment not found.','status',404); end if;
   if actor.role<>'manager' and (r.agent_email<>p_actor or r.expires_at<=now() or r.state not in ('draft','submitted')) then
    return jsonb_build_object('error','Temporary access has expired, ended or is not assigned to you.','status',403);
   end if;
   if p_action='detail' then
    select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at desc),'[]') into result from public.property_collaboration_history h where collaboration_id=r.id;
    return jsonb_build_object('collaboration',to_jsonb(r),'history',result);
   end if;
   if r.version is distinct from (p_body->>'version')::integer then return jsonb_build_object('error','This assignment changed. Refresh before continuing.','status',409); end if;
   before_row:=to_jsonb(r);
   if p_action in ('save','submit','document') then
    if actor.role<>'agent' or r.agent_email<>p_actor or r.state<>'draft' then return jsonb_build_object('error','Only the assigned Agent can edit an open draft.','status',403); end if;
    if p_action='save' then
     r.property_patch:=p_body->'property_patch'; r.settings_patch:=p_body->'settings_patch';
     if jsonb_typeof(r.property_patch) is distinct from 'object' or jsonb_typeof(r.settings_patch) is distinct from 'object' then
      return jsonb_build_object('error','Invalid draft.','status',422);
     end if;
    elsif p_action='document' then
     if jsonb_array_length(r.documents)>=20 then return jsonb_build_object('error','Up to 20 documents per assignment.','status',422); end if;
     r.documents:=r.documents||jsonb_build_array(p_body->'document');
    else r.state:='submitted';
    end if;
   elsif p_action in ('approve','return','revoke') then
    if actor.role<>'manager' then return jsonb_build_object('error','Only Admin can review or end access.','status',403); end if;
    if r.state in ('approved','revoked') then return jsonb_build_object('error','This assignment is already closed.','status',409); end if;
    if p_action='approve' and r.agent_email=p_actor then return jsonb_build_object('error','Another Admin must approve your own draft.','status',403); end if;
    if p_action='revoke' then r.state:='revoked';
    else
     if r.state<>'submitted' then return jsonb_build_object('error','Only submitted drafts can be reviewed.','status',409); end if;
     if p_action='return' then
      if length(trim(coalesce(p_body->>'note','')))<5 then return jsonb_build_object('error','Explain what needs correction.','status',422); end if;
      r.state:='draft'; r.note:=p_body->>'note';
     else
      -- Lock both live rows before comparing/applying. Missing settings rows are
      -- inserted first to serialize concurrent legacy settings writers as well.
      select * into b from public.buildings where id=r.building_id for update;
      insert into public.lease_settings(scope,building_id,field_values) values('building',b.id,'{}') on conflict do nothing;
      select field_values into settings from public.lease_settings where scope='building' and building_id=b.id for update;
      if (to_jsonb(b)-'updated_at') is distinct from (r.base_property-'updated_at') or settings is distinct from r.base_settings then
       return jsonb_build_object('error','Live property settings changed since this assignment began. End this assignment and create a fresh one; the old draft remains in history.','status',409);
      end if;
      update public.buildings set
       name=case when r.property_patch?'name' then r.property_patch->>'name' else name end,
       street=case when r.property_patch?'street' then r.property_patch->>'street' else street end,
       city=case when r.property_patch?'city' then r.property_patch->>'city' else city end,
       state=case when r.property_patch?'state' then r.property_patch->>'state' else state end,
       state_abbr=case when r.property_patch?'state_abbr' then r.property_patch->>'state_abbr' else state_abbr end,
       zip=case when r.property_patch?'zip' then r.property_patch->>'zip' else zip end,
       landlord_signer_email=case when r.property_patch?'landlord_signer_email' then r.property_patch->>'landlord_signer_email' else landlord_signer_email end
       where id=b.id;
      perform public.lease_settings_apply('building',b.id,null,r.settings_patch,p_actor);
      r.state:='approved';
     end if;
    end if;
   else return jsonb_build_object('error','Unknown action.','status',400);
   end if;
   update public.property_collaborations set property_patch=r.property_patch,settings_patch=r.settings_patch,documents=r.documents,
    state=r.state,note=r.note,version=version+1,updated_at=now() where id=r.id returning * into r;
 end if;
 insert into public.property_collaboration_history(collaboration_id,actor,action,details)
 values(r.id,p_actor,p_action,jsonb_build_object('before',before_row,'after',to_jsonb(r)));
 return jsonb_build_object('collaboration',to_jsonb(r));
end;
$$;
revoke all on function public.property_collaboration_command(text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.property_collaboration_command(text,text,uuid,jsonb) to service_role;
