-- Apply after schema.sql. Creating a property and its initial defaults is one
-- transaction. A retry token identifies a creation request, never a property
-- to update. Only the trusted Worker can call this function.
create table if not exists public.property_creation_requests (
  token uuid primary key,
  actor text not null,
  payload jsonb not null,
  building_id uuid not null references public.buildings(id),
  created_at timestamptz not null default now()
);
alter table public.property_creation_requests enable row level security;
revoke all on public.property_creation_requests from public, anon, authenticated;
grant select, insert on public.property_creation_requests to service_role;

create or replace function public.create_property_with_defaults(
  p_token uuid, p_property jsonb, p_defaults jsonb, p_actor text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  prior public.property_creation_requests;
  property public.buildings;
  payload jsonb := jsonb_build_object('property',p_property,'defaults',p_defaults);
begin
  if p_token is null or coalesce(trim(p_actor),'') = '' or
     jsonb_typeof(p_property) is distinct from 'object' or
     jsonb_typeof(p_defaults) is distinct from 'object' or
     coalesce(trim(p_property->>'name'),'') = '' then
    raise exception 'Invalid property creation request';
  end if;
  -- Serialize concurrent retries without accepting a caller-supplied building ID.
  perform pg_advisory_xact_lock(hashtextextended(p_token::text,0));
  select * into prior from public.property_creation_requests where token=p_token;
  if found then
    if prior.actor <> p_actor or prior.payload <> payload then
      raise exception 'This creation request was already submitted with different information';
    end if;
    select * into strict property from public.buildings where id=prior.building_id;
    return to_jsonb(property);
  end if;
  insert into public.buildings(name,street,city,state,state_abbr,zip,landlord_signer_email)
    values(p_property->>'name',p_property->>'street',p_property->>'city',p_property->>'state',
      p_property->>'state_abbr',p_property->>'zip',p_property->>'landlord_signer_email')
    returning * into property;
  if p_defaults <> '{}'::jsonb then
    perform public.lease_settings_apply('building',property.id,null,p_defaults,p_actor);
  end if;
  insert into public.property_creation_requests(token,actor,payload,building_id)
    values(p_token,p_actor,payload,property.id);
  return to_jsonb(property);
end;
$$;
revoke all on function public.create_property_with_defaults(uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_property_with_defaults(uuid,jsonb,jsonb,text) to service_role;
