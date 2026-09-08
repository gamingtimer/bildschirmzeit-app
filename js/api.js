// ---------------------------------------------------------------------------
// Datenzugriffsschicht: kapselt sämtliche Supabase-Zugriffe.
// ---------------------------------------------------------------------------
// Kind-Aktionen (Timer starten/stoppen, Zeit nachtragen) laufen direkt über
// den öffentlichen anon Key + Row Level Security.
// Eltern-Aktionen (Zeit hinzufügen, Einträge bearbeiten/löschen, PIN-Login)
// laufen ausschließlich über die Edge Function "parent-api", die serverseitig
// mit dem service_role Key arbeitet. Der service_role Key taucht an keiner
// Stelle in diesem Code oder im Frontend auf.
// ---------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  PARENT_API_FUNCTION,
  WEEKLY_BUDGET_SECONDS,
} from "./config.js";
import { getWeekStartUtc, getWeekEndUtc, weekStartKey } from "./time.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

class ApiError extends Error {}

function assertConfigured() {
  if (!SUPABASE_URL || SUPABASE_URL.includes("DEIN-PROJEKT")) {
    throw new ApiError(
      "Supabase ist noch nicht konfiguriert. Bitte trage SUPABASE_URL und SUPABASE_ANON_KEY in js/config.js ein."
    );
  }
}

// ---------------------------------------------------------------------------
// Sessions (Zockzeiten)
// ---------------------------------------------------------------------------

/** Liefert die aktuell laufende Session (ended_at IS NULL) oder null. */
export async function fetchActiveSession() {
  assertConfigured();
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new ApiError(error.message);
  return data;
}

/** Startet eine neue Session mit echtem Zeitstempel. */
export async function startSession() {
  assertConfigured();
  const startedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("sessions")
    .insert({ started_at: startedAt, ended_at: null, is_manual: false })
    .select()
    .single();
  if (error) {
    // Unique-Constraint verletzt -> es läuft bereits eine Session.
    if (error.code === "23505") {
      throw new ApiError("Es läuft bereits eine Session.");
    }
    throw new ApiError(error.message);
  }
  return data;
}

/** Beendet eine laufende Session anhand echter Zeitstempel. */
export async function stopSession(sessionId, endedAtDate) {
  assertConfigured();
  const endedAt = endedAtDate instanceof Date ? endedAtDate : new Date(endedAtDate);

  // duration_seconds wird bewusst NICHT mitgeschickt: die Datenbank berechnet
  // ihn per Trigger selbst aus started_at/ended_at. Die App hat für die
  // Spalte duration_seconds ohnehin kein Schreibrecht (siehe schema.sql).
  const { data, error } = await supabase
    .from("sessions")
    .update({ ended_at: endedAt.toISOString() })
    .eq("id", sessionId)
    .is("ended_at", null)
    .select()
    .single();
  if (error) throw new ApiError(error.message);
  return data;
}

/** Trägt eine vergangene Nutzungszeit manuell nach ("Zeit nachtragen"). */
export async function insertManualSession(startedAtDate, endedAtDate) {
  assertConfigured();
  const durationSeconds = Math.round((endedAtDate.getTime() - startedAtDate.getTime()) / 1000);
  if (durationSeconds <= 0) {
    throw new ApiError("Die Endzeit muss nach der Startzeit liegen.");
  }
  const { data, error } = await supabase
    .from("sessions")
    .insert({
      started_at: startedAtDate.toISOString(),
      ended_at: endedAtDate.toISOString(),
      duration_seconds: durationSeconds,
      is_manual: true,
    })
    .select()
    .single();
  if (error) throw new ApiError(error.message);
  return data;
}

/** Alle (abgeschlossenen und laufenden) Sessions einer Kalenderwoche. */
export async function fetchSessionsForWeek(weekStartUtc) {
  assertConfigured();
  const weekEndUtc = getWeekEndUtc(weekStartUtc);
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .gte("started_at", weekStartUtc.toISOString())
    .lt("started_at", weekEndUtc.toISOString())
    .order("started_at", { ascending: false });
  if (error) throw new ApiError(error.message);
  return data ?? [];
}

/** Liefert alle Wochen, für die es überhaupt Daten gibt (für den Eltern-Rückblick). */
export async function fetchAvailableWeeks() {
  assertConfigured();
  const { data, error } = await supabase
    .from("sessions")
    .select("started_at")
    .order("started_at", { ascending: false })
    .limit(500);
  if (error) throw new ApiError(error.message);
  const keys = new Set();
  for (const row of data ?? []) {
    keys.add(weekStartKey(getWeekStartUtc(new Date(row.started_at))));
  }
  return Array.from(keys).sort().reverse();
}

// ---------------------------------------------------------------------------
// Zusätzliche Elternzeit (time_adjustments)
// ---------------------------------------------------------------------------

/** Summe der von Eltern gewährten Bonuszeit einer Kalenderwoche (Sekunden). */
export async function fetchAdjustmentsForWeek(weekStartUtc) {
  assertConfigured();
  const key = weekStartKey(weekStartUtc);
  const { data, error } = await supabase
    .from("time_adjustments")
    .select("*")
    .eq("week_start", key)
    .order("created_at", { ascending: false });
  if (error) throw new ApiError(error.message);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Zusammengefasste Wochen-Berechnung
// ---------------------------------------------------------------------------

/**
 * Berechnet alle abgeleiteten Werte für eine Woche:
 * verbrauchte Zeit (abgeschlossen), Bonuszeit, Budget, verbleibende Zeit,
 * Tagesaufteilung Montag-Sonntag sowie die aktive Session (falls vorhanden
 * und Teil dieser Woche).
 */
export async function computeWeekSummary(weekStartUtc, activeSession) {
  const [sessions, adjustments] = await Promise.all([
    fetchSessionsForWeek(weekStartUtc),
    fetchAdjustmentsForWeek(weekStartUtc),
  ]);

  const completed = sessions.filter((s) => s.ended_at !== null);
  const usedSeconds = completed.reduce((sum, s) => sum + (s.duration_seconds ?? 0), 0);
  const bonusSeconds = adjustments.reduce((sum, a) => sum + a.amount_seconds, 0);
  const budgetSeconds = WEEKLY_BUDGET_SECONDS + bonusSeconds;

  const activeBelongsToWeek =
    activeSession && new Date(activeSession.started_at) >= weekStartUtc && new Date(activeSession.started_at) < getWeekEndUtc(weekStartUtc);

  return {
    sessions,
    completed,
    adjustments,
    usedSeconds,
    bonusSeconds,
    budgetSeconds,
    remainingAtLoadSeconds: budgetSeconds - usedSeconds,
    activeSession: activeBelongsToWeek ? activeSession : null,
  };
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/** Abonniert Änderungen an sessions & time_adjustments und ruft onChange() auf. */
export function subscribeRealtime(onChange) {
  const channel = supabase
    .channel("screentime-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "time_adjustments" }, onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---------------------------------------------------------------------------
// Eltern-Aktionen (über die geschützte Edge Function)
// ---------------------------------------------------------------------------

async function callParentApi(payload) {
  assertConfigured();
  const { data, error } = await supabase.functions.invoke(PARENT_API_FUNCTION, {
    body: payload,
  });
  if (error) {
    let message = error.message || "Aktion fehlgeschlagen.";
    // Supabase liefert Fehlertext des Function-Response oft im "context"-Body.
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) message = ctx.error;
    } catch (_) {
      /* ignore */
    }
    throw new ApiError(message);
  }
  if (data?.error) throw new ApiError(data.error);
  return data;
}

export function parentLogin(pin) {
  return callParentApi({ action: "login", pin });
}

export function parentVerifyToken(token) {
  return callParentApi({ action: "verify", token });
}

export function parentLogout(token) {
  return callParentApi({ action: "logout", token });
}

export function parentAddTime(token, amountSeconds, note) {
  return callParentApi({ action: "add_time", token, amount_seconds: amountSeconds, note });
}

export function parentEditSession(token, sessionId, patch) {
  return callParentApi({ action: "edit_session", token, session_id: sessionId, patch });
}

export function parentDeleteSession(token, sessionId) {
  return callParentApi({ action: "delete_session", token, session_id: sessionId });
}

export { ApiError };
