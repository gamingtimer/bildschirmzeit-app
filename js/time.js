// ---------------------------------------------------------------------------
// Zeit- und Zeitzonen-Hilfsfunktionen
// ---------------------------------------------------------------------------
// Alle Berechnungen (Wochenbeginn, Tageszuordnung) laufen über die Zeitzone
// Europe/Berlin, unabhängig davon, in welcher Zeitzone das Gerät des
// Nutzers eingestellt ist. In der Datenbank werden ausschließlich UTC-
// Zeitstempel (timestamptz) gespeichert - die Umrechnung passiert nur hier
// im Client (bzw. spiegelbildlich in der Edge Function).
// ---------------------------------------------------------------------------

import { TIME_ZONE } from "./config.js";

const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const WEEKDAY_LABELS_DE = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
];

function getPartsFormatter() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
}

/** Zerlegt einen JS-Date/Zeitpunkt in seine lokalen Bestandteile in TIME_ZONE. */
export function getZonedParts(date) {
  const parts = getPartsFormatter().formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: map.weekday,
  };
}

/**
 * Rechnet eine "lokale Wanduhrzeit" in TIME_ZONE (z.B. 2026-09-07 00:00:00
 * in Berlin) in den passenden UTC-Zeitpunkt (JS Date) um. Nötig, da die
 * JS Date-API selbst keine "erzeuge Zeitpunkt in Zeitzone X" Funktion
 * kennt. Löst das iterativ über den tatsächlichen Offset der Zeitzone.
 */
export function zonedTimeToUtc(year, month, day, hour, minute, second) {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let i = 0; i < 3; i++) {
    const parts = getZonedParts(guess);
    const guessedUtcForThatLocal = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = wanted - guessedUtcForThatLocal;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

/** Datumsschlüssel "YYYY-MM-DD" für einen Zeitpunkt in TIME_ZONE. */
export function getBerlinDateKey(date) {
  const p = getZonedParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Liefert den Beginn der aktuellen Kalenderwoche (Montag 00:00 Uhr in
 * Europe/Berlin) als UTC-Date für einen beliebigen Referenzzeitpunkt.
 * Funktioniert unabhängig davon, an welchem Wochentag die Seite geöffnet
 * wird, und behandelt Zeitumstellungen korrekt, da der letzte Schritt aus
 * den lokalen Kalenderfeldern (Jahr/Monat/Tag) neu in UTC umgerechnet wird.
 */
export function getWeekStartUtc(reference = new Date()) {
  const parts = getZonedParts(reference);
  const isoWeekday = WEEKDAY_INDEX[parts.weekday]; // 0 = Montag ... 6 = Sonntag

  const todayMidnightUtc = zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0);
  const roughWeekStart = new Date(todayMidnightUtc.getTime() - isoWeekday * 24 * 60 * 60 * 1000);

  // Feinschliff: aus dem groben Zeitpunkt die tatsächlichen lokalen
  // Kalenderfelder lesen und daraus noch einmal exakt Mitternacht bauen
  // (wichtig rund um die Zeitumstellung, wenn ein Tag nicht genau 24h hat).
  const wsParts = getZonedParts(roughWeekStart);
  return zonedTimeToUtc(wsParts.year, wsParts.month, wsParts.day, 0, 0, 0);
}

/** Wochenende (exklusiv) = Wochenbeginn + 7 Tage. */
export function getWeekEndUtc(weekStartUtc) {
  return new Date(weekStartUtc.getTime() + 7 * 24 * 60 * 60 * 1000);
}

/** "YYYY-MM-DD" des Wochenbeginns - wird als week_start in der DB verwendet. */
export function weekStartKey(weekStartUtc) {
  return getBerlinDateKey(weekStartUtc);
}

/** Formatiert Sekunden als HH:MM:SS, niemals negativ. */
export function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Formatiert Sekunden menschenlesbar, z.B. "1 Stunde 45 Minuten". */
export function formatDurationHuman(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  const parts = [];
  if (h > 0) parts.push(`${h} ${h === 1 ? "Stunde" : "Stunden"}`);
  if (m > 0 || h === 0) parts.push(`${m} ${m === 1 ? "Minute" : "Minuten"}`);
  return parts.join(" ");
}

/** Kurzform "1:45 h" für die Wochenübersicht. */
export function formatHoursShort(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")} h`;
}

/** Formatiert eine Uhrzeit HH:MM in Europe/Berlin für einen Zeitpunkt. */
export function formatClock(date) {
  const p = getZonedParts(date);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "Heute" / "Gestern" / Datum, je nach Abstand zu jetzt (in Berlin-Kalendertagen). */
export function formatRelativeDay(date, now = new Date()) {
  const dayKey = getBerlinDateKey(date);
  const todayKey = getBerlinDateKey(now);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = getBerlinDateKey(yesterday);

  if (dayKey === todayKey) return "Heute";
  if (dayKey === yesterdayKey) return "Gestern";

  const p = getZonedParts(date);
  return `${String(p.day).padStart(2, "0")}.${String(p.month).padStart(2, "0")}.${p.year}`;
}

export function weekdayLabel(index) {
  return WEEKDAY_LABELS_DE[index];
}

export const WEEKDAYS_DE = WEEKDAY_LABELS_DE;
