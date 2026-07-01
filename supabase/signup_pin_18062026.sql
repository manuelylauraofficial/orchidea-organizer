-- Protezione registrazione Orchidea Organizer con PIN.
-- PIN richiesto in fase di registrazione: 18062026
-- Esegui questo file nel SQL Editor di Supabase.

create extension if not exists pgcrypto;

create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

insert into public.app_settings (key, value, updated_at)
values ('signup_pin_hash', crypt('18062026', gen_salt('bf')), now())
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

create or replace function public.enforce_orchidea_signup_pin()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  provided_pin text;
  stored_hash text;
begin
  provided_pin := coalesce(new.raw_user_meta_data ->> 'signup_pin', '');

  select value
  into stored_hash
  from public.app_settings
  where key = 'signup_pin_hash';

  if stored_hash is null or crypt(provided_pin, stored_hash) <> stored_hash then
    raise exception 'PIN di registrazione non valido';
  end if;

  -- Non salviamo il PIN nei metadati dell'utente.
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'signup_pin';

  return new;
end;
$$;

drop trigger if exists trg_enforce_orchidea_signup_pin on auth.users;

create trigger trg_enforce_orchidea_signup_pin
before insert on auth.users
for each row
execute function public.enforce_orchidea_signup_pin();
