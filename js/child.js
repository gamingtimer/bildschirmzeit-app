// ---------------------------------------------------------------------------
// Kind-Ansicht: Timer, Start/Stopp, Zeit nachtragen, Wochenübersicht, Verlauf
// ---------------------------------------------------------------------------

import { startSession, stopSession, insertManualSession, ApiError } from "./api.js";
import {
  formatHMS,
  formatHoursShort,
  formatDurationHuman,
  formatRelativeDay,
  formatClock,
  getBerlinDateKey,
  getZonedParts,
  zonedTimeToUtc,
  weekdayLabel,
} from "./time.js";

const el = {
  remainingTime: document.getElementById("remaining-time"),
  statusMessage: document.getElementById("timer-status-message"),
  startStopBtn: document.getElementById("start-stop-btn"),
  openManualEntry: document.getElementById("open-manual-entry"),
  weekOverviewList: document.getElementById("week-overview-list"),
  weekTotalUsed: document.getElementById("week-total-used"),
  weekTotalRemaining: document.getElementById("week-total-remaining"),
  historyList: document.getElementById("history-list"),
  manualEntryModal: document.getElementById("manual-entry-modal"),
  manualEntryForm: document.getElementById("manual-entry-form"),
  manualDate: document.getElementById("manual-date"),
  manualStart: document.getElementById("manual-start"),
  manualEnd: document.getElementById("manual-end"),
  manualDurationPreview: document.getElementById("manual-duration-preview"),
  manualEntryError: document.getElementById("manual-entry-error"),
  manualCancelBtn: document.getElementById("manual-entry-cancel"),
};

let onActionRequested = null; // wird von main.js gesetzt: async (fn) => void

export function init(handlers) {
  onActionRequested = handlers.onAction;

  el.startStopBtn.addEventListener("click", () => {
    onActionRequested(async (state) => {
      if (state.activeSession) {
        await stopSession(state.activeSession.id, new Date());
      } else {
        await startSession();
      }
    });
  });

  el.openManualEntry.addEventListener("click", openManualEntryModal);
  el.manualCancelBtn.addEventListener("click", closeManualEntryModal);
  el.manualEntryModal.addEventListener("click", (e) => {
    if (e.target === el.manualEntryModal) closeManualEntryModal();
  });

  [el.manualDate, el.manualStart, el.manualEnd].forEach((input) =>
    input.addEventListener("input", updateManualDurationPreview)
  );

  el.manualEntryForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitManualEntry();
  });
}

function openManualEntryModal() {
  el.manualEntryError.textContent = "";
  el.manualEntryForm.reset();
  const now = getZonedParts(new Date());
  el.manualDate.value = `${now.year}-${String(now.month).padStart(2, "0")}-${String(now.day).padStart(2, "0")}`;
  el.manualDate.max = el.manualDate.value;
  el.manualDurationPreview.textContent = "";
  el.manualEntryModal.classList.add("is-open");
  el.manualStart.focus();
}

function closeManualEntryModal() {
  el.manualEntryModal.classList.remove("is-open");
}

function parseManualDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  if ([y, m, d, hh, mm].some((n) => Number.isNaN(n))) return null;
  return zonedTimeToUtc(y, m, d, hh, mm, 0);
}

function updateManualDurationPreview() {
  const start = parseManualDateTime(el.manualDate.value, el.manualStart.value);
  const end = parseManualDateTime(el.manualDate.value, el.manualEnd.value);
  if (!start || !end || end <= start) {
    el.manualDurationPreview.textContent = "";
    return;
  }
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
  el.manualDurationPreview.textContent = `Dauer: ${formatDurationHuman(seconds)}`;
}

async function submitManualEntry() {
  el.manualEntryError.textContent = "";
  const dateStr = el.manualDate.value;
  const startStr = el.manualStart.value;
  const endStr = el.manualEnd.value;

  if (!dateStr || !startStr || !endStr) {
    el.manualEntryError.textContent = "Bitte Datum, Startzeit und Endzeit angeben.";
    return;
  }

  const start = parseManualDateTime(dateStr, startStr);
  const end = parseManualDateTime(dateStr, endStr);

  if (!start || !end) {
    el.manualEntryError.textContent = "Ungültige Eingabe.";
    return;
  }
  if (end <= start) {
    el.manualEntryError.textContent = "Die Endzeit muss nach der Startzeit liegen.";
    return;
  }
  if (start > new Date()) {
    el.manualEntryError.textContent = "Der Zeitraum darf nicht in der Zukunft liegen.";
    return;
  }
  const maxDurationSeconds = 24 * 60 * 60;
  if ((end - start) / 1000 > maxDurationSeconds) {
    el.manualEntryError.textContent = "Ein einzelner Eintrag darf höchstens 24 Stunden umfassen.";
    return;
  }

  const submitBtn = el.manualEntryForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    await onActionRequested(async () => {
      await insertManualSession(start, end);
    });
    closeManualEntryModal();
  } catch (err) {
    el.manualEntryError.textContent =
      err instanceof ApiError ? err.message : "Die Änderung konnte nicht gespeichert werden. Bitte versuche es erneut.";
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Wird jede Sekunde mit dem aktuell live berechneten Restwert aufgerufen. */
export function renderTimer({ remainingSeconds, isActive, isExhausted }) {
  el.remainingTime.textContent = formatHMS(remainingSeconds);
  el.remainingTime.classList.toggle("is-exhausted", remainingSeconds <= 0);

  el.startStopBtn.textContent = isActive ? "■ STOPP" : "▶ START";
  el.startStopBtn.classList.toggle("is-running", isActive);
  el.startStopBtn.disabled = !isActive && isExhausted;

  el.statusMessage.textContent = isExhausted
    ? "Deine Bildschirmzeit für diese Woche ist aufgebraucht."
    : "";
  el.statusMessage.classList.toggle("is-visible", isExhausted);
}

/** Wird nach jedem vollständigen Datenabgleich aufgerufen (Woche, Verlauf). */
export function renderWeek(summary, weekStartUtc) {
  const byDay = new Map();
  for (let i = 0; i < 7; i++) byDay.set(i, 0);

  for (const session of summary.completed) {
    const started = new Date(session.started_at);
    const dayIndex = Math.floor((started.getTime() - weekStartUtc.getTime()) / (24 * 60 * 60 * 1000));
    if (dayIndex >= 0 && dayIndex < 7) {
      byDay.set(dayIndex, (byDay.get(dayIndex) ?? 0) + session.duration_seconds);
    }
  }

  el.weekOverviewList.innerHTML = "";
  for (let i = 0; i < 7; i++) {
    const seconds = byDay.get(i);
    const row = document.createElement("div");
    row.className = "week-row";

    const label = document.createElement("span");
    label.className = "week-row-label";
    label.textContent = weekdayLabel(i);

    const barTrack = document.createElement("span");
    barTrack.className = "week-row-track";
    const barFill = document.createElement("span");
    barFill.className = "week-row-fill";
    const pct = Math.min(100, (seconds / (60 * 60)) * 20); // grobe visuelle Skala
    barFill.style.width = `${pct}%`;
    barTrack.appendChild(barFill);

    const value = document.createElement("span");
    value.className = "week-row-value";
    value.textContent = formatHoursShort(seconds);

    row.append(label, barTrack, value);
    el.weekOverviewList.appendChild(row);
  }

  el.weekTotalUsed.textContent = formatHoursShort(summary.usedSeconds);
  el.weekTotalRemaining.textContent = formatHoursShort(Math.max(0, summary.remainingAtLoadSeconds));
}

export function renderHistory(summary) {
  el.historyList.innerHTML = "";

  if (summary.sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = "Noch keine Einträge in dieser Woche.";
    el.historyList.appendChild(empty);
    return;
  }

  for (const session of summary.sessions) {
    const item = document.createElement("div");
    item.className = "history-item";

    const day = document.createElement("span");
    day.className = "history-day";
    day.textContent = formatRelativeDay(new Date(session.started_at));

    const range = document.createElement("span");
    range.className = "history-range";
    const startLabel = formatClock(new Date(session.started_at));
    const endLabel = session.ended_at ? formatClock(new Date(session.ended_at)) : "läuft …";
    range.textContent = `${startLabel} – ${endLabel}`;

    const duration = document.createElement("span");
    duration.className = "history-duration";
    duration.textContent = session.ended_at ? formatDurationHuman(session.duration_seconds) : "";

    item.append(day, range, duration);
    el.historyList.appendChild(item);
  }
}
