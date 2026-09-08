# Bildschirmzeit-App

Eine Web-App zur Verwaltung des wöchentlichen Bildschirmzeit-Guthabens.
Läuft als statische Seite auf **GitHub Pages** und nutzt **Supabase** für
Datenbank, Berechtigungen und Echtzeit-Synchronisierung zwischen mehreren
Geräten.

- **Kind-Ansicht** (Startseite): Timer starten/stoppen, Zeit nachtragen,
  Wochenübersicht, Verlauf.
- **Elternbereich** (über PIN geschützt): Zeit hinzufügen, Einträge
  bearbeiten/löschen, vergangene Wochen einsehen.
- Alle Berechnungen laufen in der Zeitzone **Europe/Berlin**, der
  Wochenwechsel (jeden Montag 00:00 Uhr) passiert automatisch, ohne dass
  jemand die Seite zu einem bestimmten Zeitpunkt öffnen muss.

## Projektstruktur

```text
index.html
css/style.css
js/config.js                       <- hier trägst du deine Zugangsdaten ein
js/time.js
js/api.js
js/child.js
js/parent.js
js/main.js
supabase/schema.sql                 <- einmal im SQL-Editor ausführen
supabase/functions/parent-api/index.ts   <- Edge Function für PIN-Login etc.
README.md
```

## Wie die Sicherheit funktioniert (kurz erklärt)

- Der **anon Key** ist öffentlich und darf im Frontend stehen. Über ihn kann
  die App nur das, was Row Level Security (RLS) in `schema.sql` erlaubt:
  Sessions lesen, eine neue Session starten, eine laufende Session beenden,
  vergangene Zeit nachtragen.
- Der **PIN-Vergleich und alle Eltern-Aktionen** (Zeit hinzufügen, Einträge
  bearbeiten/löschen) laufen ausschließlich in der Edge Function
  `parent-api`. Diese läuft auf Supabase's Servern, nicht im Browser, und
  benutzt dort den `service_role` Key sowie die PIN - beides als **Supabase
  Secrets**, die nie an den Browser ausgeliefert werden.
- `duration_seconds` einer Session wird nie vom Client übernommen, sondern
  von einem Datenbank-Trigger immer aus den echten Zeitstempeln neu
  berechnet.
- Es kann laut Datenbank-Constraint nie mehr als eine aktive Session
  gleichzeitig existieren.

---

## Schritt-für-Schritt-Anleitung

### 1. Supabase-Konto erstellen

1. Gehe auf [supabase.com](https://supabase.com).
2. Klicke auf **Start your project** und melde dich an (z. B. mit GitHub).

### 2. Neues Supabase-Projekt erstellen

1. Klicke im Dashboard auf **New project**.
2. Wähle einen Projektnamen (z. B. `bildschirmzeit`) und ein Datenbank-Passwort
   (notiere es dir - du brauchst es normalerweise nicht mehr, aber sicher ist
   sicher).
3. Wähle als Region idealerweise eine Region in Europa (z. B. Frankfurt),
   damit die App schnell reagiert.
4. Klicke auf **Create new project** und warte, bis es fertig eingerichtet ist
   (das dauert ein bis zwei Minuten).

### 3. Datenbank einrichten (SQL ausführen)

1. Öffne im Supabase-Dashboard links **SQL Editor**.
2. Klicke auf **New query**.
3. Öffne die Datei `supabase/schema.sql` aus diesem Projekt, kopiere den
   **gesamten** Inhalt und füge ihn in den SQL-Editor ein.
4. Klicke auf **Run**.
5. Das erstellt automatisch:
   - die Tabellen `sessions`, `time_adjustments`, `parent_sessions`
   - alle nötigen Trigger und Indizes
   - Row Level Security (RLS) und alle Berechtigungen
   - die Realtime-Aktivierung für `sessions` und `time_adjustments`

Falls beim Realtime-Teil ein Fehler auftaucht (z. B. weil die Publikation
`supabase_realtime` in deinem Projekt anders heißt), aktiviere Realtime
alternativ manuell: **Database -> Replication -> supabase_realtime** und
schalte dort `sessions` und `time_adjustments` ein.

### 4. RLS aktivieren

Das ist im Skript aus Schritt 3 bereits enthalten (`enable row level
security`). Du kannst es unter **Authentication -> Policies** kontrollieren:
bei `sessions` und `time_adjustments` solltest du dort Policies sehen, bei
`parent_sessions` bewusst keine.

### 5. Policies einrichten

Ebenfalls bereits in `schema.sql` enthalten. Kurz zusammengefasst:

| Tabelle            | anon darf                                            |
|--------------------|-------------------------------------------------------|
| `sessions`         | lesen, neue Session starten, laufende Session beenden, Zeit nachtragen |
| `time_adjustments` | nur lesen                                              |
| `parent_sessions`  | nichts                                                 |

Alles andere (Zeit hinzufügen, Einträge bearbeiten/löschen, Login) läuft über
die Edge Function mit dem `service_role` Key.

### 6. Authentifizierung einrichten (Eltern-PIN als Secret)

Der PIN wird **nicht** in der Datenbank oder im Code gespeichert, sondern als
Supabase-Secret, das nur die Edge Function lesen kann.

Am einfachsten mit der [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
npm install -g supabase
supabase login
supabase link --project-ref DEIN-PROJEKT-REF
supabase secrets set PARENT_PIN=343276
```

`DEIN-PROJEKT-REF` findest du im Dashboard unter **Project Settings ->
General -> Reference ID**.

Alternativ geht das Setzen von Secrets auch über das Dashboard unter **Edge
Functions -> Manage secrets** (falls dein Supabase-Plan/Version das dort
anbietet) - die CLI-Variante funktioniert aber immer.

### 7. Elternkonto/PIN konfigurieren

Die Standard-PIN in dieser Anleitung ist `343276`. Möchtest du sie ändern,
setze einfach einen anderen Wert in Schritt 6 (`supabase secrets set
PARENT_PIN=DEINE-NEUE-PIN`) und deploye die Funktion danach neu (Schritt 9).

### 8. Edge Function deployen

Ebenfalls mit der Supabase CLI, aus dem Projektordner heraus:

```bash
supabase functions deploy parent-api --no-verify-jwt
```

Der Zusatz `--no-verify-jwt` ist hier unproblematisch, da die Funktion ihre
eigene Prüfung (PIN bzw. Sitzungstoken) durchführt und sonst nur mit dem
öffentlichen anon Key aufgerufen wird - genau wie jeder andere Aufruf an
Supabase über den anon Key auch.

Nach dem Deploy findest du die Funktion unter **Edge Functions** im
Dashboard und kannst dort auch ihre Logs einsehen (praktisch zum
Fehlersuchen).

### 9. Supabase URL eintragen

1. Öffne im Dashboard **Project Settings -> API**.
2. Kopiere den Wert bei **Project URL**.
3. Trage ihn in `js/config.js` bei `SUPABASE_URL` ein.

### 10. Supabase Anon Key eintragen

1. Kopiere im selben Bereich den **anon public** Key (NICHT den
   `service_role` Key!).
2. Trage ihn in `js/config.js` bei `SUPABASE_ANON_KEY` ein.

### 11. Website lokal testen

Da die App ES-Module verwendet, funktioniert sie nicht durch einfaches
Doppelklicken der `index.html` (Browser blockieren `file://`-Module aus
Sicherheitsgründen). Starte stattdessen einen kleinen lokalen Server im
Projektordner, zum Beispiel:

```bash
python3 -m http.server 8080
```

und öffne dann `http://localhost:8080` im Browser.

Teste dabei insbesondere:
- Timer starten, Seite neu laden -> Timer läuft weiter.
- Timer stoppen -> Eintrag erscheint im Verlauf.
- "Zeit nachtragen" mit einem Beispiel-Zeitraum.
- Elternbereich mit der PIN öffnen, Zeit hinzufügen, einen Eintrag bearbeiten
  und löschen.

### 12. GitHub Repository erstellen

1. Erstelle auf [github.com](https://github.com) ein neues, leeres
   Repository (z. B. `bildschirmzeit-app`). Öffentlich oder privat ist beides
   möglich - beachte aber, dass bei einem **öffentlichen** Repository auch
   dein anon Key öffentlich sichtbar ist (das ist bei Supabase so
   vorgesehen, siehe Sicherheits-Hinweis oben; der PIN und der
   `service_role` Key stehen nirgendwo in diesem Code).

### 13. Dateien hochladen

Im Projektordner:

```bash
git init
git add .
git commit -m "Erste Version der Bildschirmzeit-App"
git branch -M main
git remote add origin https://github.com/DEIN-NUTZERNAME/bildschirmzeit-app.git
git push -u origin main
```

### 14. GitHub Pages aktivieren

1. Öffne dein Repository auf GitHub.
2. Gehe zu **Settings -> Pages**.
3. Wähle bei **Source** den Branch `main` und den Ordner `/ (root)`.
4. Klicke **Save**.
5. Nach ein bis zwei Minuten ist die Seite unter
   `https://DEIN-NUTZERNAME.github.io/bildschirmzeit-app/` erreichbar.

### 15. Website testen

Öffne die veröffentlichte Seite auf mehreren Geräten (z. B. Smartphone und
PC) und wiederhole die Tests aus Schritt 11. Starte den Timer auf einem
Gerät und prüfe, ob er auf einem anderen Gerät nach einem kurzen Moment
ebenfalls als "läuft" angezeigt wird.

---

## Getestete Szenarien

- Neue Woche ohne bisherige Nutzung -> `07:00:00`.
- 30 Minuten Nutzung -> `06:30:00`.
- Timer starten, Seite neu laden -> Timer läuft korrekt mit echten
  Zeitstempeln weiter, kein einfacher Sekunden-Countdown.
- Timer stoppen -> Eintrag erscheint sofort im Verlauf.
- 30 Minuten Elternzeit hinzufügen -> verbleibende Zeit steigt sofort um 30
  Minuten.
- Wochenwechsel Sonntag -> Montag -> neue Woche startet automatisch mit 7
  Stunden, alte Daten bleiben erhalten und einsehbar.
- Zugriff auf den Elternbereich erfordert die PIN; falsche PIN wird
  abgelehnt.
- Direkte, manipulierte Datenbankzugriffe (z. B. Zeit hinzufügen oder
  fremde Einträge löschen ohne gültiges Eltern-Token) werden von den
  RLS-Regeln bzw. der Edge Function abgelehnt.

## Bekannte Grenzen

Diese App ist für den privaten Gebrauch in einem Haushalt gedacht, nicht für
mehrere getrennte Familien auf einer Installation. Der `anon` Key ist wie
bei jeder Supabase-App öffentlich einsehbar; die Absicherung erfolgt über
RLS, Spaltenrechte und die Edge Function, nicht über Geheimhaltung des Keys.
Wer technisch sehr versiert ist, könnte über direkte API-Aufrufe weiterhin
z. B. eine plausible "Zeit nachtragen"-Buchung simulieren - er kann aber
nicht an mehr Zeit kommen als über die Kinderseite ohnehin möglich wäre, und
kann ohne die PIN nicht auf Eltern-Funktionen zugreifen.

## Die PIN später ändern

```bash
supabase secrets set PARENT_PIN=NEUE-PIN
supabase functions deploy parent-api --no-verify-jwt
```
