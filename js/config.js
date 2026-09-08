// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------
// Trage hier die Zugangsdaten deines Supabase-Projekts ein.
// Beide Werte findest du im Supabase-Dashboard unter:
//   Project Settings -> API
//
// WICHTIG: Hier gehört ausschließlich der "anon public" Key hin.
// Der "service_role" Key darf HIER NIEMALS eingetragen werden, da diese
// Datei im Browser ausgeliefert wird und für jeden sichtbar ist.
// ---------------------------------------------------------------------------

export const SUPABASE_URL = "https://dsbhkyvssdqowpbyoraq.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_oIvu1HMbfs14ofo5r7zJNA_23KoSNpl";

// Name der Edge Function, die den Eltern-PIN-Login und alle
// eltern-geschützten Aktionen übernimmt (siehe supabase/functions/parent-api).
export const PARENT_API_FUNCTION = "parent-api";

// Zeitzone, in der sämtliche Wochen- und Tagesgrenzen berechnet werden.
export const TIME_ZONE = "Europe/Berlin";

// Standard-Wochenbudget in Sekunden (7 Stunden).
export const WEEKLY_BUDGET_SECONDS = 7 * 60 * 60;

// Lokaler Speicherort für das Eltern-Sitzungstoken (nur ein Zufallstoken,
// niemals der PIN selbst).
export const PARENT_TOKEN_STORAGE_KEY = "screentime_parent_token";
