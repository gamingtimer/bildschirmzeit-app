// ---------------------------------------------------------------------------
// Elternbereich: PIN-Login, Dashboard, Zeit hinzufügen, Einträge verwalten
// ---------------------------------------------------------------------------
// Alle Aktionen hier, die Berechtigungen erfordern (Zeit hinzufügen, Eintrag
// bearbeiten/löschen), laufen über die Edge Function "parent-api" und ein
// serverseitig ausgestelltes Sitzungstoken. Der PIN selbst wird nirgends im
// Frontend-Code verglichen.
// ---------------------------------------------------------------------------

import {
  parentLogin,
  parentVerifyToken,
  parentLogout,
  parentAddTime,
  parentEditSession,
  parentDeleteSession,
  fetchAvailableWeeks,
  computeWeekSummary,
  ApiError,
} from "./api.js";
import { PARENT_TOKEN_STORAGE_KEY } from "./config.js";
import {
  formatHMS,
  formatHoursShort,
  formatDurationHuman,
  formatClock,
  formatRelativeDay,
  getZonedParts,
  zonedTimeToUtc,
  getWeekStartUtc,
  weekStartKey,
} from "./time.js";

const el = {
  childView: document.getElementById("child-view"),
  parentView: document.getElementById("parent-view"),
  openParentAreaBtn: document.getElementById("elternbereich-btn"),
  backToChildBtn: document.getElementById("parent-back-btn"),
  logoutBtn: document.getElementById("parent-logout-btn"),

  pinModal: document.getElementById("parent-pin-modal"),
  pinForm: document.getElementById("parent-pin-form"),
  pinInput: document.getElementById("parent-pin-input"),
  pinError: document.getElementById("parent-pin-error"),
  pinCancelBtn: document.getElementById("parent-pin-cancel"),

  remaining: document.getElementById("parent-remaining"),
  used: document.getElementById("parent-used"),
  budget: document.getElementById("parent-budget"),
  timerStatus: document.getElementById("parent-timer-status"),

  weekSelect: document.getElementById("parent-week-select"),
  historyList: document.getElementById("parent-history-list"),
  adjustmentsList: document.getElementById("parent-adjustments-list"),

  addTimeBtn: document.getElementById("parent-add-time-btn"),
  addTimeModal: document.getElementById("add-time-modal"),
  addTimeForm: document.getElementById("add-time-form"),
  addTimeHours: document.getElementById("add-time-hours"),
  addTimeMinutes: document.getElementById("add-time-minutes"),
  addTimeNote: document.getElementById("add-time-note"),
  addTimeError: document.getElementById("add-time-error"),
  addTimeCancelBtn: document.getElementById("add-time-cancel"),

  editModal: document.getElementById("edit-session-modal"),
  editForm: document.getElementById("edit-session-form"),
  editDate: document.getElementById("edit-date"),
  editStart: document.getElementById("edit-start"),
  editEnd: document.getElementById("edit-end"),
  editError: document.getElementById("edit-session-error"),
  editCancelBtn: document.getElementById("edit-session-cancel"),
};

let token = null;
let currentWeekStartUtc = null;
let onDataChanged = null; // von main.js: () => void, um nach Aktionen neu zu laden
let getActiveSession = () => null; // von main.js: () => Session|null
let editingSessionId = null;

export function isLoggedIn() {
  return Boolean(token);
}

export async function init(handlers) {
  onDataChanged = handlers.onDataChanged;
  getActiveSession = handlers.getActiveSession ?? getActiveSession;

  el.openParentAreaBtn.addEventListener("click", openPinModal);
  el.pinCancelBtn.addEventListener("click", closePinModal);
  el.pinModal.addEventListener("click", (e) => {
    if (e.target === el.pinModal) closePinModal();
  });
  el.pinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitPin();
  });

  el.backToChildBtn.addEventListener("click", showChildView);
  el.logoutBtn.addEventListener("click", logout);

  el.weekSelect.addEventListener("change", () => loadWeek(el.weekSelect.value));

  el.addTimeBtn.addEventListener("click", openAddTimeModal);
  el.addTimeCancelBtn.addEventListener("click", closeAddTimeModal);
  el.addTimeModal.addEventListener("click", (e) => {
    if (e.target === el.addTimeModal) closeAddTimeModal();
  });
  el.addTimeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitAddTime();
  });

  el.editCancelBtn.addEventListener("click", closeEditModal);
  el.editModal.addEventListener("click", (e) => {
    if (e.target === el.editModal) closeEditModal();
  });
  el.editForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitEdit();
  });

  // Vorhandenes Token aus vorherigem Besuch prüfen.
  const savedToken = localStorage.getItem(PARENT_TOKEN_STORAGE_KEY);
  if (savedToken) {
    try {
      await parentVerifyToken(savedToken);
      token = savedToken;
    } catch (_) {
      localStorage.removeItem(PARENT_TOKEN_STORAGE_KEY);
    }
  }
}

function openPinModal() {
  el.pinError.textContent = "";
  el.pinForm.reset();
  el.pinModal.classList.add("is-open");
  el.pinInput.focus();
}

function closePinModal() {
  el.pinModal.classList.remove("is-open");
}

async function submitPin() {
  el.pinError.textContent = "";
  const pin = el.pinInput.value.trim();
  if (!pin) {
    el.pinError.textContent = "Bitte PIN eingeben.";
    return;
  }
  const submitBtn = el.pinForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    const result = await parentLogin(pin);
    token = result.token;
    localStorage.setItem(PARENT_TOKEN_STORAGE_KEY, token);
    closePinModal();
    await showParentView();
  } catch (err) {
    el.pinError.textContent = err instanceof ApiError ? err.message : "Anmeldung fehlgeschlagen.";
  } finally {
    submitBtn.disabled = false;
  }
}

async function logout() {
  if (token) {
    try {
      await parentLogout(token);
    } catch (_) {
      /* Token ggf. schon abgelaufen - trotzdem lokal ausloggen. */
    }
  }
  token = null;
  localStorage.removeItem(PARENT_TOKEN_STORAGE_KEY);
  showChildView();
}

function showChildView() {
  el.parentView.classList.remove("is-visible");
  el.childView.classList.add("is-visible");
}

export async function showParentView() {
  el.childView.classList.remove("is-visible");
  el.parentView.classList.add("is-visible");

  const weeks = await fetchAvailableWeeks();
  const thisWeekKey = weeks[0];
  el.weekSelect.innerHTML = "";
  const weekKeys = thisWeekKey ? weeks : [weekKeyForToday()];
  for (const key of weekKeys.length ? weekKeys : [weekKeyForToday()]) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `Woche ab ${formatDateDe(key)}`;
    el.weekSelect.appendChild(opt);
  }
  await loadWeek(el.weekSelect.value || weekKeyForToday());
}

function weekKeyForToday() {
  const start = getWeekStartUtc(new Date());
  return weekStartKey(start);
}

function formatDateDe(isoDateKey) {
  const [y, m, d] = isoDateKey.split("-");
  return `${d}.${m}.${y}`;
}

async function loadWeek(weekKey) {
  if (!weekKey) return;
  const [y, m, d] = weekKey.split("-").map(Number);
  currentWeekStartUtc = zonedTimeToUtc(y, m, d, 0, 0, 0);

  const activeSession = getActiveSession();
  const summary = await computeWeekSummary(currentWeekStartUtc, activeSession);
  renderDashboard(summary, activeSession);
}

function renderDashboard(summary, activeSession) {
  el.used.textContent = formatHoursShort(summary.usedSeconds);
  el.budget.textContent = formatHoursShort(summary.budgetSeconds);
  el.remaining.textContent = formatHMS(Math.max(0, summary.remainingAtLoadSeconds));
  el.timerStatus.textContent = activeSession ? "Timer läuft" : "Timer gestoppt";
  el.timerStatus.classList.toggle("is-running", Boolean(activeSession));

  el.historyList.innerHTML = "";
  if (summary.sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = "Keine Einträge in dieser Woche.";
    el.historyList.appendChild(empty);
  }
  for (const session of summary.sessions) {
    el.historyList.appendChild(renderHistoryRow(session));
  }

  el.adjustmentsList.innerHTML = "";
  if (summary.adjustments.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = "Keine zusätzliche Zeit vergeben.";
    el.adjustmentsList.appendChild(empty);
  }
  for (const adj of summary.adjustments) {
    const row = document.createElement("div");
    row.className = "adjustment-item";
    const date = document.createElement("span");
    date.textContent = formatRelativeDay(new Date(adj.created_at));
    const amount = document.createElement("span");
    amount.className = "adjustment-amount";
    amount.textContent = `+${formatDurationHuman(adj.amount_seconds)}`;
    const note = document.createElement("span");
    note.className = "adjustment-note";
    note.textContent = adj.note ?? "";
    row.append(date, amount, note);
    el.adjustmentsList.appendChild(row);
  }
}

function renderHistoryRow(session) {
  const row = document.createElement("div");
  row.className = "history-item history-item--parent";

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

  const actions = document.createElement("span");
  actions.className = "history-actions";

  if (session.ended_at) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "icon-btn";
    editBtn.textContent = "Bearbeiten";
    editBtn.addEventListener("click", () => openEditModal(session));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "icon-btn icon-btn--danger";
    deleteBtn.textContent = "Löschen";
    deleteBtn.addEventListener("click", () => deleteEntry(session));

    actions.append(editBtn, deleteBtn);
  } else {
    actions.textContent = "aktiv";
  }

  row.append(day, range, duration, actions);
  return row;
}

// ---------------------------------------------------------------------------
// Zeit hinzufügen
// ---------------------------------------------------------------------------

function openAddTimeModal() {
  el.addTimeError.textContent = "";
  el.addTimeForm.reset();
  el.addTimeModal.classList.add("is-open");
  el.addTimeHours.focus();
}

function closeAddTimeModal() {
  el.addTimeModal.classList.remove("is-open");
}

async function submitAddTime() {
  el.addTimeError.textContent = "";
  const hours = Number(el.addTimeHours.value || 0);
  const minutes = Number(el.addTimeMinutes.value || 0);
  const totalSeconds = Math.round(hours * 3600 + minutes * 60);

  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    el.addTimeError.textContent = "Bitte eine Zeit größer als 0 angeben.";
    return;
  }

  const submitBtn = el.addTimeForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    await parentAddTime(token, totalSeconds, el.addTimeNote.value.trim() || null);
    closeAddTimeModal();
    await loadWeek(el.weekSelect.value);
    onDataChanged?.();
  } catch (err) {
    el.addTimeError.textContent =
      err instanceof ApiError ? err.message : "Die Änderung konnte nicht gespeichert werden. Bitte versuche es erneut.";
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Eintrag bearbeiten / löschen
// ---------------------------------------------------------------------------

function openEditModal(session) {
  editingSessionId = session.id;
  el.editError.textContent = "";
  const started = getZonedParts(new Date(session.started_at));
  const ended = getZonedParts(new Date(session.ended_at));
  el.editDate.value = `${started.year}-${String(started.month).padStart(2, "0")}-${String(started.day).padStart(2, "0")}`;
  el.editStart.value = `${String(started.hour).padStart(2, "0")}:${String(started.minute).padStart(2, "0")}`;
  el.editEnd.value = `${String(ended.hour).padStart(2, "0")}:${String(ended.minute).padStart(2, "0")}`;
  el.editModal.classList.add("is-open");
}

function closeEditModal() {
  editingSessionId = null;
  el.editModal.classList.remove("is-open");
}

async function submitEdit() {
  el.editError.textContent = "";
  const [y, m, d] = el.editDate.value.split("-").map(Number);
  const [sh, sm] = el.editStart.value.split(":").map(Number);
  const [eh, em] = el.editEnd.value.split(":").map(Number);

  if ([y, m, d, sh, sm, eh, em].some((n) => Number.isNaN(n))) {
    el.editError.textContent = "Bitte alle Felder ausfüllen.";
    return;
  }

  const start = zonedTimeToUtc(y, m, d, sh, sm, 0);
  const end = zonedTimeToUtc(y, m, d, eh, em, 0);

  if (end <= start) {
    el.editError.textContent = "Die Endzeit muss nach der Startzeit liegen.";
    return;
  }

  const submitBtn = el.editForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    await parentEditSession(token, editingSessionId, {
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      duration_seconds: Math.round((end.getTime() - start.getTime()) / 1000),
    });
    closeEditModal();
    await loadWeek(el.weekSelect.value);
    onDataChanged?.();
  } catch (err) {
    el.editError.textContent =
      err instanceof ApiError ? err.message : "Die Änderung konnte nicht gespeichert werden. Bitte versuche es erneut.";
  } finally {
    submitBtn.disabled = false;
  }
}

async function deleteEntry(session) {
  const confirmed = window.confirm("Diesen Eintrag wirklich löschen?");
  if (!confirmed) return;
  try {
    await parentDeleteSession(token, session.id);
    await loadWeek(el.weekSelect.value);
    onDataChanged?.();
  } catch (err) {
    window.alert(err instanceof ApiError ? err.message : "Löschen fehlgeschlagen. Bitte versuche es erneut.");
  }
}

export function refreshIfVisible() {
  if (isLoggedIn() && el.parentView.classList.contains("is-visible")) {
    loadWeek(el.weekSelect.value);
  }
}
