-- Both buckets stay private. The Worker serves listing media publicly and
-- verifies applicant/staff ownership before serving private documents.
insert into storage.buckets (id, name, public)
values ('listing-media', 'listing-media', false), ('applicant-docs', 'applicant-docs', false)
on conflict (id) do update set public = false;

-- Restrictive policies also deny access if another permissive policy exists.
-- service_role bypasses RLS; it is held only by the Worker.
drop policy if exists star_private_objects on storage.objects;
create policy star_private_objects on storage.objects as restrictive
for all to anon, authenticated
using (bucket_id not in ('listing-media', 'applicant-docs'))
with check (bucket_id not in ('listing-media', 'applicant-docs'));
