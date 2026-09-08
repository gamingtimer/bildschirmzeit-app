// ===========================================================================
// Edge Function: parent-api
// ===========================================================================
// Übernimmt ALLE eltern-geschützten Aktionen serverseitig:
//   - PIN-Login (Ausstellen eines kurzlebigen Sitzungstokens)
//   - Token-Prüfung
//   - Zeit hinzufügen (time_adjustments)
//   - Session bearbeiten / löschen
//
// Läuft in Supabase's Deno Edge Runtime - NICHT im Browser. Der
// service_role Key existiert ausschließlich hier als Supabase-Secret und
// wird niemals an den Client ausgeliefert. Die PIN wird ebenfalls nur hier
// (als Secret) mit der Eingabe verglichen, nie im Frontend-Code.
//
// Benötigte Secrets (siehe README, "Supabase Secrets setzen"):
//   PARENT_PIN                 z.B. 343276
// Automatisch von Supabase bereitgestellt:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// ===========================================================================

// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12 Stunden Gültigkeit
const TIME_ZONE = "Europe/Berlin";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new HttpError(500, "Supabase ist auf dem Server nicht korrekt konfiguriert.");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Wochenbeginn (Montag 00:00 Uhr Europe/Berlin) - analog zu js/time.js im
// Frontend, hier unabhängig implementiert, da Edge Functions eigenständig
// deployt werden.
// ---------------------------------------------------------------------------
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function getZonedParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const map = {};
  for (const part of dtf.formatToParts(date)) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: map.weekday,
  };
}

function zonedMidnightToUtc(year, month, day) {
  let guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  for (let i = 0; i < 3; i++) {
    const parts = getZonedParts(guess);
    const guessedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
    const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);
    const diff = wanted - guessedUtc;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

function currentWeekStartUtc() {
  const now = new Date();
  const parts = getZonedParts(now);
  const isoWeekday = WEEKDAY_INDEX[parts.weekday];
  const todayMidnight = zonedMidnightToUtc(parts.year, parts.month, parts.day);
  const rough = new Date(todayMidnight.getTime() - isoWeekday * 24 * 60 * 60 * 1000);
  const roughParts = getZonedParts(rough);
  return zonedMidnightToUtc(roughParts.year, roughParts.month, roughParts.day);
}

// WICHTIG: Der Kalendertag "YYYY-MM-DD" eines UTC-Zeitpunkts darf NIEMALS
// naiv über date.toISOString().slice(0, 10) gebildet werden - Berlin liegt
// vor UTC (+1/+2h), daher würde das um Mitternacht herum auf den falschen
// (vorherigen) Tag zeigen. Stattdessen wird der Kalendertag aus den
// Europe/Berlin-Zeitfeldern selbst gebildet.
function berlinDateKey(date) {
  const p = getZonedParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Token-Prüfung
// ---------------------------------------------------------------------------
async function requireValidToken(supabase, token) {
  if (!token) throw new HttpError(401, "Nicht angemeldet.");

  const { data, error } = await supabase
    .from("parent_sessions")
    .select("token, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (error) throw new HttpError(500, "Datenbankfehler bei der Sitzungsprüfung.");
  if (!data) throw new HttpError(401, "Sitzung abgelaufen. Bitte erneut mit PIN anmelden.");

  if (new Date(data.expires_at).getTime() < Date.now()) {
    await supabase.from("parent_sessions").delete().eq("token", token);
    throw new HttpError(401, "Sitzung abgelaufen. Bitte erneut mit PIN anmelden.");
  }
}

// ---------------------------------------------------------------------------
// Request-Handler
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    if (req.method !== "POST") {
      throw new HttpError(405, "Methode nicht erlaubt.");
    }

    const body = await req.json().catch(() => {
      throw new HttpError(400, "Ungültiger Request-Body.");
    });
    const { action } = body;
    const supabase = getServiceClient();

    switch (action) {
      case "login": {
        const pin = String(body.pin ?? "");
        const expectedPin = Deno.env.get("PARENT_PIN");
        if (!expectedPin) {
          throw new HttpError(500, "PARENT_PIN ist auf dem Server nicht konfiguriert.");
        }
        if (pin !== expectedPin) {
          throw new HttpError(401, "Falsche PIN.");
        }

        const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString();
        const { data, error } = await supabase
          .from("parent_sessions")
          .insert({ expires_at: expiresAt })
          .select("token, expires_at")
          .single();
        if (error) throw new HttpError(500, "Anmeldung fehlgeschlagen.");

        return jsonResponse({ token: data.token, expires_at: data.expires_at });
      }

      case "verify": {
        await requireValidToken(supabase, body.token);
        return jsonResponse({ ok: true });
      }

      case "logout": {
        if (body.token) {
          await supabase.from("parent_sessions").delete().eq("token", body.token);
        }
        return jsonResponse({ ok: true });
      }

      case "add_time": {
        await requireValidToken(supabase, body.token);

        const amountSeconds = Number(body.amount_seconds);
        if (!Number.isFinite(amountSeconds) || amountSeconds <= 0 || amountSeconds > 24 * 60 * 60) {
          throw new HttpError(400, "Ungültige Zeitangabe.");
        }

        const weekStart = berlinDateKey(currentWeekStartUtc());
        const note = body.note ? String(body.note).slice(0, 200) : null;

        const { error } = await supabase.from("time_adjustments").insert({
          week_start: weekStart,
          amount_seconds: Math.round(amountSeconds),
          note,
        });
        if (error) throw new HttpError(500, "Die Änderung konnte nicht gespeichert werden.");

        return jsonResponse({ ok: true });
      }

      case "edit_session": {
        await requireValidToken(supabase, body.token);

        const sessionId = body.session_id;
        const patch = body.patch ?? {};
        if (!sessionId || !patch.started_at || !patch.ended_at) {
          throw new HttpError(400, "Ungültige Eingabe.");
        }

        const startedAt = new Date(patch.started_at);
        const endedAt = new Date(patch.ended_at);
        if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
          throw new HttpError(400, "Ungültiges Datum.");
        }
        if (!(endedAt > startedAt)) {
          throw new HttpError(400, "Die Endzeit muss nach der Startzeit liegen.");
        }

        // duration_seconds wird durch den DB-Trigger neu berechnet -
        // ein hier übergebener Wert würde ohnehin überschrieben.
        const { error } = await supabase
          .from("sessions")
          .update({ started_at: startedAt.toISOString(), ended_at: endedAt.toISOString() })
          .eq("id", sessionId);
        if (error) throw new HttpError(500, "Die Änderung konnte nicht gespeichert werden.");

        return jsonResponse({ ok: true });
      }

      case "delete_session": {
        await requireValidToken(supabase, body.token);

        const sessionId = body.session_id;
        if (!sessionId) throw new HttpError(400, "Ungültige Eingabe.");

        const { error } = await supabase.from("sessions").delete().eq("id", sessionId);
        if (error) throw new HttpError(500, "Löschen fehlgeschlagen.");

        return jsonResponse({ ok: true });
      }

      default:
        throw new HttpError(400, "Unbekannte Aktion.");
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : "Interner Fehler.";
    return jsonResponse({ error: message }, status);
  }
});
