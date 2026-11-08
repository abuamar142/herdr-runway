// Shared formatting for the usage bar and its dialog.
// Both mods read the same snapshot from Herdr's shared state. This file is
// duplicated in both mod folders because a mod cannot import from outside its
// own folder: keep the two copies identical.

import { appHome, setShared, shared } from "herdr";

// The credential file the dialog writes and the collectors read.
export function keysFile() {
  return `${appHome()}/runway-keys.json`;
}

export const SNAPSHOT = "runway.snapshot";
export const SETTINGS_KEY = "runway.settings";
export const BUSY_KEY = "runway.busy";
// The provider the dialog opens on; the bar writes it when a provider is clicked.
export const SELECTED_KEY = "runway.detail.selected";
const COMPACT_KEY = "runway.compact";
const MIN_REFRESH_MINUTES = 5;
const DEFAULT_REFRESH_MINUTES = 5;

export function snapshot() {
  const value = shared(SNAPSHOT);
  return value && typeof value === "object" ? value : null;
}

export function providers() {
  const value = snapshot();
  return value && Array.isArray(value.providers)
    ? value.providers.filter((provider) => provider && typeof provider === "object")
    : [];
}

export function isBusy() {
  return shared(BUSY_KEY) === true;
}

export function selectedProvider() {
  const value = shared(SELECTED_KEY);
  return typeof value === "string" ? value : null;
}

function cleanMinutes(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= MIN_REFRESH_MINUTES
    ? Math.round(minutes)
    : null;
}

function providerMinutesMap(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const result = {};
  for (const [id, value] of Object.entries(source)) {
    const minutes = cleanMinutes(value);
    if (minutes !== null) result[id] = minutes;
  }
  return result;
}

export function refreshSettings() {
  const value = shared(SETTINGS_KEY);
  const raw = value && typeof value === "object" ? value : {};
  const minutes = Number(raw.refresh_minutes);
  return {
    minutes: Number.isFinite(minutes)
      ? Math.max(MIN_REFRESH_MINUTES, Math.round(minutes))
      : DEFAULT_REFRESH_MINUTES,
    manual: raw.manual_only === true,
    providerMinutes: providerMinutesMap(raw.provider_minutes),
  };
}

export function setRefreshSettings(minutes, manual) {
  const current = refreshSettings();
  setShared(SETTINGS_KEY, {
    refresh_minutes: Math.max(MIN_REFRESH_MINUTES, Math.round(Number(minutes) || DEFAULT_REFRESH_MINUTES)),
    manual_only: manual === true,
    provider_minutes: current.providerMinutes,
  });
}

// The interval for one provider: its own override, else the global choice.
export function providerMinutes(id) {
  const settings = refreshSettings();
  return settings.providerMinutes[id] ?? settings.minutes;
}

// Zero clears the override, so the provider follows the global interval again.
export function setProviderMinutes(id, minutes) {
  const settings = refreshSettings();
  const next = { ...settings.providerMinutes };
  const clean = cleanMinutes(minutes);
  if (clean === null || clean === 0) delete next[id];
  else next[id] = clean;
  setShared(SETTINGS_KEY, {
    refresh_minutes: settings.minutes,
    manual_only: settings.manual,
    provider_minutes: next,
  });
}

// Compact is the default: one window per provider, the five-hour one.
export function compact() {
  try {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(COMPACT_KEY) !== "0";
  } catch (_) {
    return true;
  }
}

export function setCompact(value) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(COMPACT_KEY, value ? "1" : "0");
  } catch (_) {
    // A read-only storage keeps the bar usable; the mode just does not persist.
  }
}

// The window worth showing when there is room for only one: the rolling
// five-hour session, then whatever the account does report.
export function primaryWindow(provider) {
  const windows = provider && Array.isArray(provider.windows) ? provider.windows : [];
  const preferred = ["five_hour", "fiveHour", "week", "7d", "seven_day", "month", "30d"];
  for (const key of preferred) {
    const match = windows.find((meter) => meter.key === key);
    if (match) return match;
  }
  const withPercent = windows.find((meter) => typeof meter.percent === "number");
  return withPercent ?? windows[0] ?? null;
}

export function percentLabel(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  if (value > 0 && value < 1) return "<1%";
  if (value < 100 && value > 99) return ">99%";
  return `${Math.round(value)}%`;
}

// A window's share of its budget: the reported percentage, or the one implied
// by dollars for accounts that bill by use and report no percentage.
export function meterPercent(meter) {
  if (!meter) return null;
  if (typeof meter.percent === "number" && Number.isFinite(meter.percent)) return meter.percent;
  if (
    typeof meter.used_usd === "number" &&
    Number.isFinite(meter.used_usd) &&
    typeof meter.limit_usd === "number" &&
    Number.isFinite(meter.limit_usd) &&
    meter.limit_usd > 0
  ) {
    return (meter.used_usd / meter.limit_usd) * 100;
  }
  return null;
}

// A window's headline number: a percentage when the account reports one, the
// dollars it spent when the account bills by use instead.
export function windowLabel(meter) {
  if (!meter) return "n/a";
  if (typeof meter.percent === "number" && Number.isFinite(meter.percent)) {
    return percentLabel(meter.percent);
  }
  if (typeof meter.used_usd === "number" && Number.isFinite(meter.used_usd)) {
    return money(meter.used_usd);
  }
  return "n/a";
}

export function usageColor(value, t) {
  if (typeof value !== "number" || !Number.isFinite(value)) return t.foreground;
  if (value >= 95) return t.blocked;
  if (value >= 75) return t.working;
  return t.foreground;
}

// Grouped thousands, two decimals: $15,000.00, never $15000.00.
export function money(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  const [whole, cents] = Math.abs(value).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${value < 0 ? "-" : ""}$${grouped}.${cents}`;
}

export function moneyPercent(pool) {
  if (!pool) return null;
  if (typeof pool.percent === "number" && Number.isFinite(pool.percent)) return pool.percent;
  const used = pool.used_usd;
  const limit = pool.limit_usd;
  if (
    typeof used === "number" &&
    Number.isFinite(used) &&
    typeof limit === "number" &&
    Number.isFinite(limit) &&
    limit > 0
  ) {
    return (used / limit) * 100;
  }
  return null;
}

// A money pool drawn like a window, so both providers share one row language.
export function moneyMeter(pool) {
  return {
    key: "spend",
    label: String(pool?.label ?? "spend"),
    percent: moneyPercent(pool),
    resets_at: null,
    used_usd: typeof pool?.used_usd === "number" ? pool.used_usd : null,
    limit_usd: typeof pool?.limit_usd === "number" ? pool.limit_usd : null,
  };
}

export function moneyPair(used, limit) {
  const left = money(used);
  const right = typeof limit === "number" && Number.isFinite(limit) ? money(limit) : "no limit";
  return `${left} of ${right}`;
}

// "3h 17m", "2d 4h", "12m": the shortest honest span.
export function duration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  if (days) return `${days}d ${hours}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export function countdown(iso, now = Date.now()) {
  if (!iso) return "no reset time";
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "no reset time";
  return at - now < 60000 ? "reset pending" : duration(at - now);
}

export function ago(iso, now = Date.now()) {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "";
  const ms = now - at;
  return ms < 60000 ? "just now" : `${duration(ms)} ago`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function hourMinute(at) {
  const hour = at.getHours();
  return `${hour % 12 || 12}:${String(at.getMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

// 7:30 PM, never 07:30:00 PM.
export function clockTime(iso) {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : hourMinute(at);
}

// Today shows the time; nearby days name the day; anything later names the date.
export function stamp(iso, now = Date.now()) {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(at) - midnight(new Date(now))) / 86400000);
  if (days === 0) return hourMinute(at);
  if (days === 1) return `Tomorrow ${hourMinute(at)}`;
  if (days > 1 && days < 7) return `${DAYS[at.getDay()]} ${hourMinute(at)}`;
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${hourMinute(at)}`;
}

// How long a window lasts, by the key the helpers report it under.
const SPANS = {
  five_hour: 5 * 3600000,
  fiveHour: 5 * 3600000,
  seven_day: 7 * 86400000,
  week: 7 * 86400000,
  month: 30 * 86400000,
};

// Where time stands in a window, against where usage stands. `elapsed` is a
// percentage; `runout` is how long until 100% at the current rate, only when
// that lands before the window resets. A month is taken as 30 days.
export function pace(meter, now = Date.now()) {
  const span = SPANS[meter?.key];
  const percent = meterPercent(meter);
  if (!span || percent === null || !meter.resets_at) return null;
  const left = new Date(meter.resets_at).getTime() - now;
  if (!Number.isFinite(left) || left <= 0 || left > span * 1.1) return null;
  const elapsed = Math.min(1, Math.max(0, 1 - left / span));
  let runout = null;
  if (elapsed >= 0.1 && percent > 0 && percent < 100) {
    const ms = ((100 - percent) / percent) * elapsed * span;
    if (ms < left) runout = ms;
  }
  return { elapsed: elapsed * 100, runout };
}

// A theme color at partial opacity, for quiet fills behind badges and errors.
export function tint(color, alpha) {
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return color;
  return color + Math.round(alpha * 255).toString(16).padStart(2, "0");
}

// Milliseconds until the next scheduled read, or null when reads are manual.
export function nextRefreshMs(settings, fetchedAt, now = Date.now()) {
  if (settings.manual) return null;
  const at = new Date(fetchedAt).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at + settings.minutes * 60000 - now);
}

export function share(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function barColor(value, t) {
  if (typeof value !== "number" || !Number.isFinite(value)) return t.accent;
  if (value >= 95) return t.blocked;
  if (value >= 75) return t.working;
  return t.accent;
}
