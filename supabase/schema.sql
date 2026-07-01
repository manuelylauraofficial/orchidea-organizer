-- Orchidea Organizer - Schema Supabase
-- Esegui questo file nel SQL Editor di Supabase.

create extension if not exists pgcrypto;


-- =========================
-- Protezione registrazione con PIN
-- =========================

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

  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'signup_pin';

  return new;
end;
$$;

drop trigger if exists trg_enforce_orchidea_signup_pin on auth.users;

create trigger trg_enforce_orchidea_signup_pin
before insert on auth.users
for each row
execute function public.enforce_orchidea_signup_pin();

-- =========================
-- Tabelle base
-- =========================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.space_members (
  space_id uuid references public.spaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id)
);


-- Utile se la tabella esiste già: quando crei uno spazio dal browser,
-- Supabase deve sapere automaticamente chi è l'utente autenticato.
alter table public.spaces alter column created_by set default auth.uid();

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'todo' check (status in ('todo','doing','done')),
  priority text not null default 'media' check (priority in ('bassa','media','alta','urgente')),
  due_date date,
  assigned_to uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  category text not null default 'generale',
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  folder text not null default 'Generale',
  title text not null,
  content text,
  pinned boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  title text not null,
  type text not null default 'operativa',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.lists(id) on delete cascade,
  label text not null,
  done boolean not null default false,
  amount numeric(10,2),
  assigned_to uuid references auth.users(id) on delete set null,
  due_date date,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  title text not null,
  category text not null default 'Documenti',
  file_path text,
  file_name text,
  file_size bigint,
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  title text not null,
  amount numeric(10,2) not null default 0,
  category text not null default 'generale',
  paid_by uuid references auth.users(id) on delete set null,
  paid_at date not null default current_date,
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  title text not null,
  body text,
  importance text not null default 'normale' check (importance in ('normale','importante','urgente')),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =========================
-- Funzioni utili
-- =========================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['profiles','spaces','tasks','events','notes','lists','list_items','documents','expenses','announcements']
  loop
    execute format('drop trigger if exists trg_%I_updated_at on public.%I', t, t);
    execute format('create trigger trg_%I_updated_at before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

create or replace function public.is_space_member(target_space_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.space_members sm
    where sm.space_id = target_space_id
      and sm.user_id = target_user_id
  );
$$;

create or replace function public.is_space_admin(target_space_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.space_members sm
    where sm.space_id = target_space_id
      and sm.user_id = target_user_id
      and sm.role in ('owner','admin')
  );
$$;

create or replace function public.join_space_by_code(join_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  found_space_id uuid;
begin
  select id into found_space_id
  from public.spaces
  where upper(invite_code) = upper(trim(join_code))
  limit 1;

  if found_space_id is null then
    raise exception 'Codice invito non valido';
  end if;

  insert into public.space_members(space_id, user_id, role)
  values (found_space_id, auth.uid(), 'member')
  on conflict (space_id, user_id) do nothing;

  return found_space_id;
end;
$$;


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
grant execute on function public.join_space_by_code(text) to authenticated;

-- =========================
-- Storage documenti
-- =========================

insert into storage.buckets (id, name, public)
values ('orchidea-documents', 'orchidea-documents', false)
on conflict (id) do nothing;

-- =========================
-- Row Level Security
-- =========================

alter table public.profiles enable row level security;
alter table public.spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.tasks enable row level security;
alter table public.events enable row level security;
alter table public.notes enable row level security;
alter table public.lists enable row level security;
alter table public.list_items enable row level security;
alter table public.documents enable row level security;
alter table public.expenses enable row level security;
alter table public.announcements enable row level security;

-- Rimozione policy se lo script viene eseguito più volte
drop policy if exists "profiles_select_authenticated" on public.profiles;
drop policy if exists "profiles_insert_self" on public.profiles;
drop policy if exists "profiles_update_self" on public.profiles;
drop policy if exists "spaces_select_members" on public.spaces;
drop policy if exists "spaces_insert_owner" on public.spaces;
drop policy if exists "spaces_update_admin" on public.spaces;
drop policy if exists "members_select_space" on public.space_members;
drop policy if exists "members_insert_self_or_admin" on public.space_members;
drop policy if exists "members_update_admin" on public.space_members;
drop policy if exists "members_delete_self_or_admin" on public.space_members;
drop policy if exists "tasks_all_members" on public.tasks;
drop policy if exists "events_all_members" on public.events;
drop policy if exists "notes_all_members" on public.notes;
drop policy if exists "lists_all_members" on public.lists;
drop policy if exists "documents_all_members" on public.documents;
drop policy if exists "expenses_all_members" on public.expenses;
drop policy if exists "announcements_all_members" on public.announcements;
drop policy if exists "list_items_all_members" on public.list_items;
drop policy if exists "storage_documents_select_members" on storage.objects;
drop policy if exists "storage_documents_insert_members" on storage.objects;
drop policy if exists "storage_documents_update_members" on storage.objects;
drop policy if exists "storage_documents_delete_members" on storage.objects;

-- Profili
create policy "profiles_select_authenticated" on public.profiles
for select to authenticated using (true);

create policy "profiles_insert_self" on public.profiles
for insert to authenticated with check (id = auth.uid());

create policy "profiles_update_self" on public.profiles
for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Spazi
create policy "spaces_select_members" on public.spaces
for select to authenticated using (public.is_space_member(id) or created_by = auth.uid());

create policy "spaces_insert_owner" on public.spaces
for insert to authenticated with check (created_by = auth.uid());

create policy "spaces_update_admin" on public.spaces
for update to authenticated using (public.is_space_admin(id)) with check (public.is_space_admin(id));

-- Membri
create policy "members_select_space" on public.space_members
for select to authenticated using (user_id = auth.uid() or public.is_space_member(space_id));

create policy "members_insert_self_or_admin" on public.space_members
for insert to authenticated with check (user_id = auth.uid() or public.is_space_admin(space_id));

create policy "members_update_admin" on public.space_members
for update to authenticated using (public.is_space_admin(space_id)) with check (public.is_space_admin(space_id));

create policy "members_delete_self_or_admin" on public.space_members
for delete to authenticated using (user_id = auth.uid() or public.is_space_admin(space_id));

-- Tabelle collegate allo spazio
create policy "tasks_all_members" on public.tasks
for all to authenticated using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));

create policy "events_all_members" on public.events
for all to authenticated using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));

create policy "notes_all_members" on public.notes
for all to authenticated using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));

create policy "lists_all_members" on public.lists
for all to authenticated using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));

create policy "documents_all_members" on public.documents
for all to authenticated using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));

create policy "expenses_all_members" on public.expenses
for all to authenticated using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));

create policy "announcements_all_members" on public.announcements
for all to authenticated using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));

-- Gli elementi lista prendono lo spazio dalla tabella lists
create policy "list_items_all_members" on public.list_items
for all to authenticated
using (
  exists (
    select 1 from public.lists l
    where l.id = list_items.list_id
      and public.is_space_member(l.space_id)
  )
)
with check (
  exists (
    select 1 from public.lists l
    where l.id = list_items.list_id
      and public.is_space_member(l.space_id)
  )
);

-- Storage: path consigliato = <space_id>/<timestamp>_<nomefile>
create policy "storage_documents_select_members" on storage.objects
for select to authenticated
using (
  bucket_id = 'orchidea-documents'
  and public.is_space_member(((storage.foldername(name))[1])::uuid)
);

create policy "storage_documents_insert_members" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'orchidea-documents'
  and public.is_space_member(((storage.foldername(name))[1])::uuid)
);

create policy "storage_documents_update_members" on storage.objects
for update to authenticated
using (
  bucket_id = 'orchidea-documents'
  and public.is_space_member(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'orchidea-documents'
  and public.is_space_member(((storage.foldername(name))[1])::uuid)
);

create policy "storage_documents_delete_members" on storage.objects
for delete to authenticated
using (
  bucket_id = 'orchidea-documents'
  and public.is_space_member(((storage.foldername(name))[1])::uuid)
);

-- Indici utili
create index if not exists idx_space_members_user on public.space_members(user_id);
create index if not exists idx_tasks_space_status on public.tasks(space_id, status);
create index if not exists idx_events_space_start on public.events(space_id, starts_at);
create index if not exists idx_notes_space_folder on public.notes(space_id, folder);
create index if not exists idx_expenses_space_paid_at on public.expenses(space_id, paid_at);


-- Realtime: utile per vedere aggiornamenti subito tra Manuel e Laura.
do $$
declare
  tbl text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach tbl in array array['tasks','events','notes','lists','list_items','documents','expenses','announcements','space_members']
    loop
      if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = tbl
      ) then
        execute format('alter publication supabase_realtime add table public.%I', tbl);
      end if;
    end loop;
  end if;
end $$;
