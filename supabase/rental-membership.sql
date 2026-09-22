-- Apply after rental-flow.sql. Membership changes commit with the whole group.
begin;
create or replace function public.separate_rental_member(
 p_root uuid,p_versions jsonb,p_member uuid,p_remaining_root uuid,p_delete boolean,p_patches jsonb,p_actor text)
returns void language plpgsql security invoker set search_path='' as $$
declare original public.applications;
begin
 lock table public.applications in share row exclusive mode;
 select * into original from public.applications where id=p_root and rental_group_id=p_root;
 if not found or p_delete is null or p_member=p_remaining_root
  or (select count(*) from public.applications where rental_group_id=p_root)<2
  or not exists(select 1 from public.applications where id=p_member and rental_group_id=p_root)
  or not exists(select 1 from public.applications where id=p_remaining_root and rental_group_id=p_root)
  or (p_member<>p_root and p_remaining_root<>p_root)
 then raise exception 'Invalid group member selection' using errcode='23505';end if;
 if exists(select 1 from public.applications where rental_group_id=p_root and (
  status in ('lease_sent','lease_signed','declined') or workspace ? 'signed_lease'
  or workspace ? 'tenant_signature' or workspace ? 'landlord_signature'
  or coalesce(workspace->'signature_receipts','{}'::jsonb)<>'{}'::jsonb
  or (workspace ? 'signing' and coalesce(workspace->'signing'->>'phase','') not in ('voided','declined'))))
 then raise exception 'Signing or closed applications are locked' using errcode='23505';end if;
 if p_delete and exists(select 1 from public.applications where id=p_member and workspace ? 'signing')
 then raise exception 'Retain application signing history' using errcode='23505';end if;
 if jsonb_typeof(p_patches)<>'object' or (select count(*) from jsonb_object_keys(p_patches))<>(select count(*) from public.applications where rental_group_id=p_root)
 then raise exception 'Every member requires an invalidation patch';end if;
 -- The existing CAS checks all members, applies patches and advances versions.
 perform public.commit_rental_group(p_root,p_versions,p_patches,p_actor,null);
 perform set_config('star.rental_write','on',true);
 update public.applications set rental_group_id=p_remaining_root,updated_at=now()
  where rental_group_id=p_root and id<>p_member;
 update public.applications set rental_group_id=id,updated_at=now() where id=p_member;
 perform set_config('star.rental_write','off',true);
 if p_delete then delete from public.applications where id=p_member;end if;
end $$;
revoke all on function public.separate_rental_member(uuid,jsonb,uuid,uuid,boolean,jsonb,text) from public,anon,authenticated;
grant execute on function public.separate_rental_member(uuid,jsonb,uuid,uuid,boolean,jsonb,text) to service_role;
commit;
