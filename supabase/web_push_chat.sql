-- Orchidea Organizer v7 - Web Push + Chat utenti
-- Esegui questo file nel SQL Editor di Supabase dopo lo schema principale.

create extension if not exists pgcrypto;

-- Profilo: aggiungiamo email per poter cercare utenti da invitare in chat.
alter table public.profiles add column if not exists email text;
create index if not exists idx_profiles_email_lower on public.profiles (lower(email));

-- =========================
-- Notifiche persistenti + abbonamenti push
-- =========================

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  space_id uuid references public.spaces(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  space_id uuid references public.spaces(id) on delete cascade,
  kind text not null default 'generic',
  title text not null,
  body text,
  priority text not null default 'normale',
  source_table text,
  source_id text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- =========================
-- Chat privata con richiesta/accettazione
-- =========================

create table if not exists public.contact_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> recipient_id)
);

create index if not exists idx_contact_requests_requester on public.contact_requests(requester_id);
create index if not exists idx_contact_requests_recipient on public.contact_requests(recipient_id);
create index if not exists idx_contact_requests_pair on public.contact_requests(requester_id, recipient_id, status);

create table if not exists public.direct_chats (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_a <> user_b),
  unique (user_a, user_b)
);

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.direct_chats(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_direct_chats_user_a on public.direct_chats(user_a);
create index if not exists idx_direct_chats_user_b on public.direct_chats(user_b);
create index if not exists idx_direct_messages_chat_created on public.direct_messages(chat_id, created_at);

-- Updated_at generico sulle nuove tabelle.
do $$
declare
  t text;
begin
  foreach t in array array['push_subscriptions','direct_chats']
  loop
    execute format('drop trigger if exists trg_%I_updated_at on public.%I', t, t);
    execute format('create trigger trg_%I_updated_at before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

create or replace function public.touch_direct_chat_after_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.direct_chats
  set updated_at = now()
  where id = new.chat_id;
  return new;
end;
$$;

drop trigger if exists trg_direct_message_touch_chat on public.direct_messages;
create trigger trg_direct_message_touch_chat
after insert on public.direct_messages
for each row execute function public.touch_direct_chat_after_message();

create or replace function public.direct_chat_member(target_chat_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.direct_chats c
    where c.id = target_chat_id
      and target_user_id in (c.user_a, c.user_b)
  );
$$;

create or replace function public.have_accepted_contact(other_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.contact_requests cr
    where cr.status = 'accepted'
      and (
        (cr.requester_id = auth.uid() and cr.recipient_id = other_user_id)
        or
        (cr.requester_id = other_user_id and cr.recipient_id = auth.uid())
      )
  );
$$;

create or replace function public.send_contact_request(target_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_id uuid;
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Utente non autenticato';
  end if;

  if target_user_id = auth.uid() then
    raise exception 'Non puoi inviare una richiesta a te stesso';
  end if;

  if not exists (select 1 from public.profiles where id = target_user_id) then
    raise exception 'Utente non trovato';
  end if;

  select id into existing_id
  from public.contact_requests
  where status in ('pending','accepted')
    and (
      (requester_id = auth.uid() and recipient_id = target_user_id)
      or
      (requester_id = target_user_id and recipient_id = auth.uid())
    )
  order by created_at desc
  limit 1;

  if existing_id is not null then
    return existing_id;
  end if;

  insert into public.contact_requests(requester_id, recipient_id, status)
  values (auth.uid(), target_user_id, 'pending')
  returning id into new_id;

  return new_id;
end;
$$;

create or replace function public.respond_contact_request(request_id uuid, accept boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
  a uuid;
  b uuid;
  chat_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Utente non autenticato';
  end if;

  select * into req
  from public.contact_requests
  where id = request_id
    and recipient_id = auth.uid()
    and status = 'pending';

  if req.id is null then
    raise exception 'Richiesta non trovata o già gestita';
  end if;

  update public.contact_requests
  set status = case when accept then 'accepted' else 'rejected' end,
      responded_at = now()
  where id = request_id;

  if not accept then
    return null;
  end if;

  if req.requester_id::text < req.recipient_id::text then
    a := req.requester_id;
    b := req.recipient_id;
  else
    a := req.recipient_id;
    b := req.requester_id;
  end if;

  insert into public.direct_chats(user_a, user_b)
  values (a, b)
  on conflict (user_a, user_b) do update set updated_at = now()
  returning id into chat_id;

  return chat_id;
end;
$$;

create or replace function public.ensure_direct_chat(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
  b uuid;
  chat_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Utente non autenticato';
  end if;

  if not public.have_accepted_contact(other_user_id) then
    raise exception 'La chat si può aprire solo dopo una richiesta accettata';
  end if;

  if auth.uid()::text < other_user_id::text then
    a := auth.uid();
    b := other_user_id;
  else
    a := other_user_id;
    b := auth.uid();
  end if;

  insert into public.direct_chats(user_a, user_b)
  values (a, b)
  on conflict (user_a, user_b) do update set updated_at = now()
  returning id into chat_id;

  return chat_id;
end;
$$;

grant execute on function public.send_contact_request(uuid) to authenticated;
grant execute on function public.respond_contact_request(uuid, boolean) to authenticated;
grant execute on function public.ensure_direct_chat(uuid) to authenticated;

-- =========================
-- RLS
-- =========================

alter table public.push_subscriptions enable row level security;
alter table public.app_notifications enable row level security;
alter table public.contact_requests enable row level security;
alter table public.direct_chats enable row level security;
alter table public.direct_messages enable row level security;

drop policy if exists "push_subscriptions_own_select" on public.push_subscriptions;
drop policy if exists "push_subscriptions_own_insert" on public.push_subscriptions;
drop policy if exists "push_subscriptions_own_update" on public.push_subscriptions;
drop policy if exists "push_subscriptions_own_delete" on public.push_subscriptions;
drop policy if exists "app_notifications_own_select" on public.app_notifications;
drop policy if exists "app_notifications_own_update" on public.app_notifications;
drop policy if exists "app_notifications_own_delete" on public.app_notifications;
drop policy if exists "contact_requests_own_select" on public.contact_requests;
drop policy if exists "contact_requests_requester_insert" on public.contact_requests;
drop policy if exists "contact_requests_recipient_update" on public.contact_requests;
drop policy if exists "direct_chats_member_select" on public.direct_chats;
drop policy if exists "direct_messages_member_select" on public.direct_messages;
drop policy if exists "direct_messages_member_insert" on public.direct_messages;
drop policy if exists "direct_messages_member_update" on public.direct_messages;

create policy "push_subscriptions_own_select" on public.push_subscriptions
for select to authenticated using (user_id = auth.uid());

create policy "push_subscriptions_own_insert" on public.push_subscriptions
for insert to authenticated with check (user_id = auth.uid());

create policy "push_subscriptions_own_update" on public.push_subscriptions
for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "push_subscriptions_own_delete" on public.push_subscriptions
for delete to authenticated using (user_id = auth.uid());

create policy "app_notifications_own_select" on public.app_notifications
for select to authenticated using (recipient_id = auth.uid());

create policy "app_notifications_own_update" on public.app_notifications
for update to authenticated using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

create policy "app_notifications_own_delete" on public.app_notifications
for delete to authenticated using (recipient_id = auth.uid());

create policy "contact_requests_own_select" on public.contact_requests
for select to authenticated using (requester_id = auth.uid() or recipient_id = auth.uid());

create policy "contact_requests_requester_insert" on public.contact_requests
for insert to authenticated with check (requester_id = auth.uid());

create policy "contact_requests_recipient_update" on public.contact_requests
for update to authenticated using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

create policy "direct_chats_member_select" on public.direct_chats
for select to authenticated using (auth.uid() in (user_a, user_b));

create policy "direct_messages_member_select" on public.direct_messages
for select to authenticated using (public.direct_chat_member(chat_id));

create policy "direct_messages_member_insert" on public.direct_messages
for insert to authenticated with check (sender_id = auth.uid() and public.direct_chat_member(chat_id));

create policy "direct_messages_member_update" on public.direct_messages
for update to authenticated using (public.direct_chat_member(chat_id)) with check (public.direct_chat_member(chat_id));

-- Realtime sulle nuove tabelle.
do $$
declare
  tbl text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach tbl in array array['app_notifications','contact_requests','direct_chats','direct_messages']
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
