-- Run after schema.sql, backoffice.sql, workspace.sql and administration.sql.
-- Auth IDs remain pinned even if an Auth user is deleted and the email reused.
alter table public.staff add column if not exists auth_user_id uuid;
create unique index if not exists staff_auth_user_id_unique on public.staff(auth_user_id) where auth_user_id is not null;

create or replace function public.bind_staff_identity(p_email text, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare matched boolean;
begin
  if not exists (select 1 from auth.users where id = p_user_id
    and lower(email) = lower(p_email) and email_confirmed_at is not null
    and coalesce(is_anonymous, false) = false) then return false; end if;
  update public.staff set auth_user_id = p_user_id
    where email = lower(p_email) and active = true
    and (auth_user_id is null or auth_user_id = p_user_id);
  matched := found;
  return matched;
end;
$$;
revoke all on function public.bind_staff_identity(text, uuid) from public, anon, authenticated;
grant execute on function public.bind_staff_identity(text, uuid) to service_role;
