-- Draft fields/media remain editable while the public site reads an immutable snapshot.
alter table public.listings add column if not exists draft_revision integer not null default 1;
alter table public.listings add column if not exists published_revision integer;
alter table public.listings add column if not exists published_snapshot jsonb;

create or replace function public.listing_snapshot(p_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select (to_jsonb(l) - 'published_snapshot' - 'draft_revision' - 'published_revision' - 'updated_at')
    || jsonb_build_object('listing_media', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.kind, m.position, m.id)
      from public.listing_media m where m.listing_id=l.id
    ), '[]'::jsonb))
  from public.listings l where l.id=p_id;
$$;

-- Capture existing live content once, before introducing draft-only saves.
update public.listings set published_snapshot=public.listing_snapshot(id), published_revision=draft_revision
where published and published_snapshot is null;

create or replace function public.listing_draft_changed()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if (to_jsonb(new) - array['published_snapshot','published_revision','draft_revision','updated_at','published'])
    is distinct from (to_jsonb(old) - array['published_snapshot','published_revision','draft_revision','updated_at','published']) then
    new.draft_revision := old.draft_revision + 1;
  end if;
  return new;
end;
$$;
drop trigger if exists listing_draft_changed on public.listings;
create trigger listing_draft_changed before update on public.listings
for each row execute function public.listing_draft_changed();

create or replace function public.listing_media_draft_changed()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  -- Lock the parent before changing media so publication captures a complete version.
  if TG_OP='UPDATE' and new.listing_id is distinct from old.listing_id then
    raise exception 'Media cannot move between listings';
  end if;
  update public.listings set draft_revision=draft_revision+1
    where id=case when TG_OP='DELETE' then old.listing_id else new.listing_id end;
  if TG_OP='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists listing_media_draft_changed on public.listing_media;
create trigger listing_media_draft_changed before insert or update or delete on public.listing_media
for each row execute function public.listing_media_draft_changed();

create or replace function public.publish_listing(p_id uuid, p_revision integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare l public.listings; snapshot jsonb;
begin
  select * into l from public.listings where id=p_id for update;
  if not found or l.draft_revision <> p_revision then return null; end if;
  snapshot := public.listing_snapshot(p_id) || jsonb_build_object('published', true);
  update public.listings set published=true, published_snapshot=snapshot,
    published_revision=draft_revision where id=p_id;
  return snapshot;
end;
$$;
revoke all on function public.listing_snapshot(uuid), public.publish_listing(uuid,integer),
  public.listing_draft_changed(), public.listing_media_draft_changed() from public, anon, authenticated;
grant execute on function public.listing_snapshot(uuid), public.publish_listing(uuid,integer),
  public.listing_draft_changed(), public.listing_media_draft_changed() to service_role;
