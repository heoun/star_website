-- Run after deploying code that no longer selects or writes these columns.
-- Deletes obsolete listing metadata only. Photo order and media remain intact.
begin;
drop index if exists public.listings_feed_idx;
alter table public.listings
  drop column if exists price_display,
  drop column if exists neighborhood,
  drop column if exists kind_label,
  drop column if exists position;
create index listings_feed_idx on public.listings (published, created_at desc, id desc);
commit;
notify pgrst, 'reload schema';
