// ---------------------------------------------------------------------------
// App-Einstiegspunkt: hält den zentralen Zustand, startet den Live-Timer
// und verbindet Kind- und Elternansicht mit der Datenschicht.
// ---------------------------------------------------------------------------

import { fetchActiveSession, computeWeekSummary, stopSession, subscribeRealtime, ApiError } from "./api.js";
import { getWeekStartUtc } from "./time.js";
import * as childView from "./child.js";
import * as parentView from "./parent.js";

const connectionBanner = document.getElementById("connection-banner");
const saveErrorBanner = document.getElementById("save-error-banner");

const state = {
  activeSession: null,
  weekStartUtc: getWeekStartUtc(),
  summary: null,
  online: true,
};

let refreshInFlight = null;
let autoStopInFlight = false;

async function refresh() {
  // Verhindert überlappende parallele Refreshes (z.B. durch Realtime-Events).
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      state.weekStartUtc = getWeekStartUtc();
      state.activeSession = await fetchActiveSession();
      state.summary = await computeWeekSummary(state.weekStartUtc, state.activeSession);
      setOnline(true);
      childView.renderWeek(state.summary, state.weekStartUtc);
      childView.renderHistory(state.summary);
      parentView.refreshIfVisible();
      tick(); // Timeranzeige sofort mit frischen Daten aktualisieren
    } catch (err) {
      setOnline(false);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function setOnline(isOnline) {
  state.online = isOnline;
  connectionBanner.classList.toggle("is-visible", !isOnline);
}

function showSaveError(message) {
  saveErrorBanner.textContent = message;
  saveErrorBanner.classList.add("is-visible");
  window.clearTimeout(showSaveError._t);
  showSaveError._t = window.setTimeout(() => saveErrorBanner.classList.remove("is-visible"), 5000);
}

/** Berechnet den aktuellen Live-Reststand (nur Client-Anzeige, DB ist Quelle der Wahrheit). */
function computeLiveRemaining() {
  if (!state.summary) return { remainingSeconds: 0, isActive: false, isExhausted: false };

  const baseRemaining = state.summary.remainingAtLoadSeconds; // ohne laufende Session
  if (!state.summary.activeSession) {
    return {
      remainingSeconds: Math.max(0, baseRemaining),
      isActive: false,
      isExhausted: baseRemaining <= 0,
    };
  }

  const elapsed = (Date.now() - new Date(state.summary.activeSession.started_at).getTime()) / 1000;
  const remaining = baseRemaining - elapsed;
  return {
    remainingSeconds: Math.max(0, remaining),
    isActive: true,
    isExhausted: remaining <= 0,
  };
}

async function tick() {
  const live = computeLiveRemaining();
  childView.renderTimer(live);

  if (live.isActive && live.isExhausted && !autoStopInFlight) {
    autoStopInFlight = true;
    try {
      const startedAt = new Date(state.summary.activeSession.started_at);
      const cappedEndedAt = new Date(startedAt.getTime() + Math.max(0, state.summary.remainingAtLoadSeconds) * 1000);
      await stopSession(state.summary.activeSession.id, cappedEndedAt);
      await refresh();
    } catch (_) {
      // Beim nächsten Tick erneut versuchen.
    } finally {
      autoStopInFlight = false;
    }
  }
}

/**
 * Führt eine Kind-Aktion (Start/Stopp/Nachtragen) aus und aktualisiert
 * danach den Zustand. Fehler werden als Speicherfehler-Banner angezeigt
 * und an den Aufrufer weitergegeben, damit z.B. ein Modal offen bleibt.
 */
async function handleChildAction(action) {
  try {
    await action(state);
    await refresh();
  } catch (err) {
    if (!(err instanceof ApiError)) {
      showSaveError("Die Änderung konnte nicht gespeichert werden. Bitte versuche es erneut.");
    }
    throw err;
  }
}

async function init() {
  childView.init({ onAction: handleChildAction });
  await parentView.init({
    onDataChanged: refresh,
    getActiveSession: () => state.activeSession,
  });

  await refresh();
  setInterval(tick, 1000);
  subscribeRealtime(() => refresh());

  window.addEventListener("online", () => refresh());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}

init();
