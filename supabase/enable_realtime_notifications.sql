-- Orchidea Organizer - abilita Realtime sulle tabelle usate dalle notifiche.
-- Esegui questo file solo se le notifiche in tempo reale non arrivano tra utenti.

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
