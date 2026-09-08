-- ===========================================================================
-- Bildschirmzeit-App: Datenbankschema
-- ===========================================================================
-- Führe dieses komplette Skript einmal im Supabase SQL-Editor aus
-- (Dashboard -> SQL Editor -> New query -> einfügen -> Run).
-- Das Skript ist so geschrieben, dass es auch mehrfach ausgeführt werden
-- kann, ohne Fehler zu werfen (idempotent), damit du bei Bedarf einzelne
-- Teile problemlos erneut laufen lassen kannst.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabelle: sessions (einzelne Zockzeiten)
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id                bigint generated always as identity primary key,
  started_at        timestamptz not null,
  ended_at          timestamptz,
  duration_seconds  integer,
  is_manual         boolean not null default false,
  created_at        timestamptz not null default now(),
  constraint sessions_manual_needs_end check (not is_manual or ended_at is not null)
);

-- Es darf zu jedem Zeitpunkt nur EINE aktive Session (ended_at IS NULL) geben.
-- Trick: Unique-Index auf einen konstanten Ausdruck, aber nur für Zeilen,
-- die den WHERE-Filter erfüllen -> es kann höchstens eine solche Zeile geben.
drop index if exists sessions_one_active_idx;
create unique index sessions_one_active_idx
  on public.sessions ((true))
  where ended_at is null;

create index if not exists sessions_started_at_idx on public.sessions (started_at);

-- duration_seconds wird NIE vom Client übernommen, sondern immer serverseitig
-- aus started_at/ended_at berechnet. Das verhindert, dass jemand über einen
-- manipulierten Request eine falsche (zu kurze) Dauer einträgt.
create or replace function public.sessions_compute_duration()
returns trigger
language plpgsql
as $$
begin
  if new.ended_at is not null then
    if new.ended_at <= new.started_at then
      raise exception 'ended_at muss nach started_at liegen';
    end if;
    new.duration_seconds := extract(epoch from (new.ended_at - new.started_at))::integer;
  else
    new.duration_seconds := null;
  end if;
  return new;
end;
$$;

drop trigger if exists sessions_compute_duration_trigger on public.sessions;
create trigger sessions_compute_duration_trigger
  before insert or update on public.sessions
  for each row execute function public.sessions_compute_duration();

-- ---------------------------------------------------------------------------
-- 2. Tabelle: time_adjustments (von Eltern gewährte Bonuszeit)
-- ---------------------------------------------------------------------------
create table if not exists public.time_adjustments (
  id              bigint generated always as identity primary key,
  week_start      date not null,
  amount_seconds  integer not null check (amount_seconds > 0),
  note            text,
  created_at      timestamptz not null default now()
);

create index if not exists time_adjustments_week_idx on public.time_adjustments (week_start);

-- ---------------------------------------------------------------------------
-- 3. Tabelle: parent_sessions (kurzlebige Sitzungstoken nach PIN-Login)
-- ---------------------------------------------------------------------------
-- Diese Tabelle wird ausschließlich von der Edge Function "parent-api" mit
-- dem service_role Key gelesen/geschrieben. Sie ist für anon/authenticated
-- vollständig gesperrt (siehe RLS unten).
create table if not exists public.parent_sessions (
  token       uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- ---------------------------------------------------------------------------
-- 4. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.sessions enable row level security;
alter table public.time_adjustments enable row level security;
alter table public.parent_sessions enable row level security;

-- sessions: Lesen ist für die App (anon Key) uneingeschränkt möglich -
-- es handelt sich um eine private Familien-App ohne mehrere Haushalte.
drop policy if exists sessions_select on public.sessions;
create policy sessions_select
  on public.sessions for select
  to anon, authenticated
  using (true);

-- sessions: Einfügen ist nur in zwei erlaubten Formen möglich:
--   a) Timer starten:      ended_at ist NULL, is_manual = false
--   b) Zeit nachtragen:    ended_at gesetzt, is_manual = true,
--                          Zeitraum liegt in der Vergangenheit,
--                          maximal 24 Stunden Dauer.
-- Elternzeit-Gutschriften laufen NICHT über diese Tabelle, sondern über
-- time_adjustments (siehe unten) - dort hat anon keinerlei Schreibrechte.
drop policy if exists sessions_insert on public.sessions;
create policy sessions_insert
  on public.sessions for insert
  to anon, authenticated
  with check (
    (
      ended_at is null
      and is_manual = false
      and started_at between now() - interval '1 minute' and now() + interval '1 minute'
    )
    or (
      is_manual = true
      and ended_at is not null
      and ended_at > started_at
      and started_at <= now()
      and ended_at <= now() + interval '1 minute'
      and (ended_at - started_at) <= interval '24 hours'
    )
  );

-- sessions: Updaten darf die App nur, um eine laufende Session zu beenden
-- (ended_at von NULL auf einen Zeitpunkt setzen). Bereits abgeschlossene
-- oder nachgetragene Einträge können darüber nicht mehr verändert werden -
-- das Bearbeiten/Löschen abgeschlossener Einträge ist ausschließlich den
-- Eltern über die Edge Function (service_role, umgeht RLS) vorbehalten.
drop policy if exists sessions_update on public.sessions;
create policy sessions_update
  on public.sessions for update
  to anon, authenticated
  using (ended_at is null)
  with check (ended_at is not null and ended_at <= now() + interval '1 minute');

-- Kein DELETE für anon/authenticated -> es existiert bewusst keine Policy.

-- Zusätzliche Absicherung auf Spaltenebene: selbst innerhalb der oben
-- erlaubten UPDATE-Zeilen darf die App ausschließlich die Spalte ended_at
-- verändern (duration_seconds wird ohnehin per Trigger überschrieben,
-- started_at/is_manual dürfen nachträglich nicht mehr angefasst werden).
revoke update on public.sessions from anon, authenticated;
grant update (ended_at) on public.sessions to anon, authenticated;

-- time_adjustments: Lesen erlaubt, Schreiben ausschließlich über
-- die Edge Function (service_role umgeht RLS und alle GRANTs vollständig).
drop policy if exists time_adjustments_select on public.time_adjustments;
create policy time_adjustments_select
  on public.time_adjustments for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.time_adjustments from anon, authenticated;

-- parent_sessions: für anon/authenticated vollständig gesperrt (kein Zugriff,
-- weder lesend noch schreibend). Es gibt bewusst keine Policies.
revoke all on public.parent_sessions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Realtime aktivieren, damit mehrere Geräte den aktuellen Stand sehen
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sessions'
  ) then
    alter publication supabase_realtime add table public.sessions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'time_adjustments'
  ) then
    alter publication supabase_realtime add table public.time_adjustments;
  end if;
end $$;
