-- Fix 403 su creazione spazio Orchidea Organizer
-- Esegui questo file nel SQL Editor di Supabase se quando premi "Crea Orchidea"
-- vedi: POST /rest/v1/spaces?select=* 403 Forbidden.

create extension if not exists pgcrypto;

alter table public.spaces alter column created_by set default auth.uid();

drop policy if exists "spaces_select_members" on public.spaces;
create policy "spaces_select_members" on public.spaces
for select to authenticated using (public.is_space_member(id) or created_by = auth.uid());

create or replace function public.create_space_with_owner(space_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_space_id uuid;
  new_invite_code text;
begin
  if auth.uid() is null then
    raise exception 'Utente non autenticato';
  end if;

  loop
    new_invite_code := 'ORCH-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    exit when not exists (
      select 1
      from public.spaces
      where invite_code = new_invite_code
    );
  end loop;

  insert into public.spaces(name, invite_code, created_by)
  values (coalesce(nullif(trim(space_name), ''), 'Orchidea'), new_invite_code, auth.uid())
  returning id into new_space_id;

  insert into public.space_members(space_id, user_id, role)
  values (new_space_id, auth.uid(), 'owner')
  on conflict (space_id, user_id) do update set role = 'owner';

  return new_space_id;
end;
$$;

grant execute on function public.create_space_with_owner(text) to authenticated;
