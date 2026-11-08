// Agent plan usage in Herdr's bottom bar.
//
// Each provider has a small Python helper; quota-axi covers Codex,
// Antigravity, Kimi and Command Code in one call. The bar shows one primary
// window per enabled provider and opens the detail dialog for the rest.
// Credentials stay in the helpers; only normalized numbers are published.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  appHome,
  exec,
  nextCommand,
  notify,
  openOverlay,
  readTextFile,
  setShared,
  shared,
  theme,
  writeTextFile,
} from "herdr";
import {
  BUSY_KEY,
  SELECTED_KEY,
  SNAPSHOT,
  alertsSettings,
  barColor,
  barSettings,
  barWindow,
  countdown,
  duration,
  historyFile,
  isUnconfigured,
  keysFile,
  meterPercent,
  orderedProviders,
  pace,
  percentLabel,
  providerMinutes,
  providers,
  refreshSettings,
  share,
  snapshot,
  tint,
  usageColor,
  windowLabel,
} from "./format.js";

const TICK_MS = 60000;
const SOURCE_TIMEOUT_MS = 25000;
const HOSTS = ["python", "python3", "py"];
const TITLE = "Runway";
const ENABLED_KEY = "runway.enabled";
const MOD_DIR = "runway";
// svg() resolves against the app config dir, so the `mods/` prefix is required.
const MOD_PATH = `mods/${MOD_DIR}`;
const DETAIL_MOD = "runway-detail";
const ALERT_STATE_KEY = "runway.alert_state";

// The order here is the order in the bar. Each helper answers with its own JSON
// and may also answer with a readable error; both are normalized below. `logo`
// is the file in this folder drawn in place of the provider name.
const SOURCES = [
  { id: "claude", name: "Claude", helper: "collect_claude.py", logo: "claude.svg", keys: true },
  { id: "opencode-go", name: "OpenCode", helper: "collect.py", logo: "opencode.svg", keys: true },
  { id: "kenari", name: "Kenari", helper: "collect_kenari.py", logo: "kenari.svg", keys: true },
  {
    id: "quota-axi",
    name: "Quota AXI",
    helper: "collect_quota_axi.py",
    multiple: true,
    providers: [
      { id: "codex", name: "Codex" },
      { id: "agy", name: "Antigravity" },
      { id: "kimi", name: "Kimi" },
      { id: "commandcode", name: "Command Code" },
    ],
    logos: {
      codex: "codex.svg",
      agy: "antigravity.svg",
      kimi: "kimi.svg",
      commandcode: "commandcode.svg",
    },
  },
];

function enabledSet() {
  // One-time carry-over from the mod's old name, so renaming kept the choices.
  const value = shared(ENABLED_KEY) ?? shared("usage-unified.enabled");
  return Array.isArray(value) ? new Set(value.map(String)) : null;
}

function knownProviders() {
  const known = [];
  for (const source of SOURCES) {
    if (Array.isArray(source.providers)) known.push(...source.providers);
    else known.push({ id: source.id, name: source.name });
  }
  return known;
}

function logoFor(id) {
  const source = SOURCES.find((candidate) => candidate.id === id);
  if (source?.logo) return source.logo;
  for (const candidate of SOURCES) {
    if (candidate.logos?.[id]) return candidate.logos[id];
  }
  return null;
}

function failed(source, error, code, action, detail, extra = {}) {
  return {
    id: source.id,
    name: source.name,
    plan: null,
    windows: [],
    money: null,
    period_ends_at: null,
    error: String(error),
    code: code ? String(code) : null,
    action: action ? String(action) : null,
    failure: detail ? String(detail).slice(0, 400) : null,
    source: typeof extra.source === "string" ? extra.source : null,
    http_status: typeof extra.http_status === "number" ? extra.http_status : null,
  };
}

// Everything the bar cannot say in 28 pixels, one hover away.
function hintFor(provider) {
  const head = [provider.name, provider.plan].filter(Boolean).join(" · ");
  if (provider.error) return [head, provider.error, provider.action].filter(Boolean).join("\n");
  const windows = Array.isArray(provider.windows) ? provider.windows : [];
  const lines = windows.map(
    (meter) =>
      `${meter.label ?? "usage"} ${windowLabel(meter)}${
        meter.resets_at ? ` · resets in ${countdown(meter.resets_at)}` : ""
      }`,
  );
  return [head, ...lines].join("\n");
}

function alertWindowName(meter) {
  return String(meter?.label ?? meter?.key ?? "window");
}

function miniMeter(percent, t) {
  const width = percent > 0 ? Math.max(share(percent), 8) : 0;
  return div()
    .relative()
    .w(28)
    .h(4)
    .rounded_full()
    .bg(tint(t.foreground, 0.16))
    .child(
      div()
        .absolute()
        .top(0)
        .left(0)
        .h(4)
        .w(`${Math.round(width * 10) / 10}%`)
        .rounded_full()
        .bg(barColor(percent, t)),
    );
}

function withTimeout(promise, ms, cx) {
  return Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    cx.sleep(ms).then(() => ({ timedOut: true })),
  ]);
}

function worstProvider(list, mode) {
  let best = null;
  let bestPercent = -1;
  for (const provider of list) {
    if (provider.error) continue;
    const percent = meterPercent(barWindow(provider, mode));
    if (percent !== null && percent > bestPercent) {
      best = provider;
      bestPercent = percent;
    }
  }
  return best ?? list[0] ?? null;
}

export default class AgentUsage extends View {
  init(_given, cx) {
    this.busy = false;
    this.host = null;
    this.lastSourceRefresh = new Map();
    this.alertState = this.readAlertState();
    // Always paint once on start; the schedule controls the next read.
    this.refresh(cx);
    cx.timer.every(TICK_MS, (cx) => {
      cx.notify();
      this.maybeRefresh(cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx);
        if (command === "notify") cx.notify();
        if (command === "details" || command === "toggle") this.openDetails();
      }
    });
  }

  readAlertState() {
    try {
      if (typeof localStorage === "undefined") return {};
      const text = localStorage.getItem(ALERT_STATE_KEY);
      const data = text ? JSON.parse(text) : null;
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (_) {
      return {};
    }
  }

  writeAlertState() {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(ALERT_STATE_KEY, JSON.stringify(this.alertState));
    } catch (_) {
      // A read-only storage only loses deduplication, not the notification.
    }
  }

  checkAlerts() {
    const settings = alertsSettings();
    if (!settings.enabled || settings.snoozeUntil > Date.now()) return;
    const state = this.alertState && typeof this.alertState === "object" ? this.alertState : {};
    const live = new Set();
    for (const provider of providers()) {
      if (!provider || provider.error) continue;
      const windows = Array.isArray(provider.windows) ? provider.windows : [];
      if (!windows.length) continue;
      live.add(provider.id);
      const perProvider =
        state[provider.id] && typeof state[provider.id] === "object" ? state[provider.id] : {};
      for (const meter of windows) {
        const key = String(meter?.key ?? meter?.label ?? "window");
        const reset = typeof meter?.resets_at === "string" ? meter.resets_at : "";
        let entry =
          perProvider[key] && typeof perProvider[key] === "object"
            ? perProvider[key]
            : { reset_at: reset, warn: false, critical: false, forecast: false };
        if (entry.reset_at && reset && entry.reset_at !== reset) {
          entry = { reset_at: reset, warn: false, critical: false, forecast: false };
          if (settings.reset) {
            notify({
              title: `${provider.name ?? provider.id} reset`,
              body: `${alertWindowName(meter)} is available again.`,
              level: "info",
            });
          }
        } else if (entry.reset_at !== reset) {
          entry.reset_at = reset;
        }

        const percent = meterPercent(meter);
        if (percent !== null) {
          const resetNote = reset ? ` · resets in ${countdown(reset)}` : "";
          if (percent >= settings.critical && !entry.critical) {
            notify({
              title: `${provider.name ?? provider.id} is almost out`,
              body: `${alertWindowName(meter)} at ${percentLabel(percent)}${resetNote}`,
              level: "error",
            });
            entry.critical = true;
            entry.warn = true;
          } else if (percent >= settings.warn && !entry.warn) {
            notify({
              title: `${provider.name ?? provider.id} at ${percentLabel(percent)}`,
              body: `${alertWindowName(meter)}${resetNote}`,
              level: "warning",
            });
            entry.warn = true;
          }
        }

        if (settings.forecast && !entry.forecast) {
          const rate = pace(meter);
          if (rate && rate.runout !== null) {
            notify({
              title: `${provider.name ?? provider.id} may run out`,
              body: `${alertWindowName(meter)}: limit in ~${duration(rate.runout)} at this pace.`,
              level: "warning",
            });
            entry.forecast = true;
          }
        }
        perProvider[key] = entry;
      }
      state[provider.id] = perProvider;
    }
    for (const id of Object.keys(state)) {
      if (!live.has(id)) delete state[id];
    }
    this.alertState = state;
    this.writeAlertState();
  }

  async recordHistory(records) {
    const path = historyFile();
    let current = null;
    try {
      current = await readTextFile(path);
    } catch (_) {
      current = null;
    }
    let data = null;
    try {
      data = current ? JSON.parse(current) : null;
    } catch (_) {
      data = null;
    }
    const history =
      data && typeof data === "object" && !Array.isArray(data)
        ? data
        : { version: 1, providers: {} };
    if (!history.providers || typeof history.providers !== "object" || Array.isArray(history.providers)) {
      history.providers = {};
    }
    const now = Date.now();
    for (const provider of records) {
      if (!provider || provider.error) continue;
      const point = { t: now, w: {} };
      for (const meter of Array.isArray(provider.windows) ? provider.windows : []) {
        const percent = meterPercent(meter);
        if (percent === null) continue;
        const key = String(meter.key ?? meter.label ?? "window");
        point.w[key] = Math.round(percent * 10) / 10;
      }
      if (provider.money) {
        const percent = meterPercent(provider.money);
        if (percent !== null) point.m = Math.round(percent * 10) / 10;
      }
      if (!Object.keys(point.w).length && point.m === undefined) continue;
      const list = Array.isArray(history.providers[provider.id])
        ? history.providers[provider.id]
        : [];
      const last = list[list.length - 1];
      if (
        last &&
        now - Number(last.t) < 90000 &&
        JSON.stringify(last.w) === JSON.stringify(point.w) &&
        last.m === point.m
      ) {
        continue;
      }
      list.push(point);
      history.providers[provider.id] = list;
    }
    const cutoff = now - 7 * 86400000;
    for (const [id, list] of Object.entries(history.providers)) {
      if (!Array.isArray(list)) {
        delete history.providers[id];
        continue;
      }
      history.providers[id] = list
        .filter((point) => point && Number(point.t) >= cutoff)
        .slice(-2016);
    }
    const next = `${JSON.stringify(history)}\n`;
    if (next === current) return;
    try {
      await writeTextFile(path, next, current);
    } catch (_) {
      // A read-only home keeps the live numbers; only the chart is lost.
    }
  }

  helper(source) {
    return `${appHome()}/mods/${MOD_DIR}/${source.helper}`;
  }

  async runHelper(source) {
    const args = [this.helper(source), "--json"];
    if (source.keys) args.push("--keys-file", keysFile());
    if (source.multiple) {
      const enabled = enabledSet();
      const ids = source.providers
        .map((provider) => provider.id)
        .filter((id) => !enabled || enabled.has(id));
      if (!ids.length) return null;
      args.push("--providers", ids.join(","));
    }
    const hosts = this.host ? [this.host] : HOSTS;
    let lastError = null;
    for (const host of hosts) {
      try {
        const result = await exec(host, args);
        this.host = host;
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("Python was not found.");
  }

  async readSource(source) {
    let result;
    try {
      result = await this.runHelper(source);
    } catch (error) {
      return failed(
        source,
        "Python could not be started from Herdr.",
        "no_python",
        "Install Python 3 and leave `python` or `python3` on PATH.",
        error?.message ?? error,
      );
    }
    if (!result) return null;

    const text = (result.stdout ?? "").trim();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        parsed = null;
      }
    }
    if (Array.isArray(parsed)) {
      if (!parsed.length) {
        return failed(source, "The usage helper returned no providers.", "reader_error");
      }
      return parsed.map((item) => this.normalizeSource(source, item));
    }
    if (!parsed || typeof parsed !== "object") {
      return failed(
        source,
        "The usage helper returned no readable JSON.",
        "reader_error",
        "Run the helper by hand to see the error it printed.",
        result.stderr ?? "",
      );
    }
    return this.normalizeSource(source, parsed);
  }

  async readSourceWithTimeout(source, cx) {
    const result = await withTimeout(this.readSource(source), SOURCE_TIMEOUT_MS, cx);
    if (result.timedOut) {
      return failed(
        source,
        "The usage helper took too long.",
        "timeout",
        "Check Python or quota-axi; the next scheduled read will try again.",
        `No answer within ${Math.round(SOURCE_TIMEOUT_MS / 1000)} seconds.`,
      );
    }
    if (result.error) {
      return failed(
        source,
        "The usage helper failed.",
        "reader_error",
        "Run the helper by hand to see the error it printed.",
        result.error?.message ?? result.error,
      );
    }
    return result.value;
  }

  normalizeSource(source, parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return failed(source, "The usage helper returned no readable JSON.", "reader_error");
    }
    const id = typeof parsed.id === "string" && parsed.id ? parsed.id : source.id;
    const name = typeof parsed.name === "string" && parsed.name ? parsed.name : source.name;
    if (parsed.error) {
      return failed({ id, name }, parsed.error, parsed.code, parsed.action, parsed.failure, {
        source: typeof parsed.source === "string" ? parsed.source : null,
        http_status: typeof parsed.http_status === "number" ? parsed.http_status : null,
      });
    }
    return {
      id,
      name,
      plan:
        typeof parsed.product === "string"
          ? parsed.product
          : typeof parsed.plan === "string"
            ? parsed.plan
            : null,
      windows: Array.isArray(parsed.windows) ? parsed.windows : [],
      money: parsed.money && typeof parsed.money === "object" ? parsed.money : null,
      period_ends_at: typeof parsed.period_ends_at === "string" ? parsed.period_ends_at : null,
      updated: typeof parsed.updated === "string" ? parsed.updated : null,
      error: null,
      code: null,
      action: null,
      failure: null,
      source: typeof parsed.source === "string" ? parsed.source : null,
      http_status: typeof parsed.http_status === "number" ? parsed.http_status : null,
    };
  }

  maybeRefresh(cx) {
    const settings = refreshSettings();
    if (settings.manual) return;
    const enabled = enabledSet();
    const now = Date.now();
    const due = [];
    for (const source of SOURCES) {
      if (!source.multiple && enabled && !enabled.has(source.id)) continue;
      const last = this.lastSourceRefresh.get(source.id) ?? 0;
      if (now - last >= providerMinutes(source.id) * 60000) due.push(source.id);
    }
    if (due.length) this.refresh(cx, due);
  }

  refresh(cx, onlySourceIds = null) {
    if (this.busy) return;
    this.busy = true;
    setShared(BUSY_KEY, true);
    cx.notify();
    cx.spawn(async (cx) => {
      const enabled = enabledSet();
      const active = SOURCES.filter((source) => {
        if (!source.multiple && enabled && !enabled.has(source.id)) return false;
        return !onlySourceIds || onlySourceIds.includes(source.id);
      });
      const byId = new Map(providers().map((provider) => [provider.id, provider]));
      const results = await Promise.all(
        active.map(async (source) => {
          try {
            return await this.readSourceWithTimeout(source, cx);
          } catch (error) {
            return failed(
              source,
              "The usage helper failed.",
              "reader_error",
              "Run the helper by hand to see the error it printed.",
              error?.message ?? error,
            );
          }
        }),
      );
      active.forEach((source, index) => {
        this.lastSourceRefresh.set(source.id, Date.now());
        const result = results[index];
        if (!result) return;
        const records = Array.isArray(result) ? result : [result];
        for (const record of records) byId.set(record.id, record);
      });
      // Keep disabled providers in the snapshot so Providers can turn them
      // back on; a provider that has never been read gets a harmless placeholder.
      for (const known of knownProviders()) {
        if (!byId.has(known.id)) {
          byId.set(known.id, {
            id: known.id,
            name: known.name,
            plan: null,
            windows: [],
            money: null,
            error: null,
            code: null,
            action: null,
            failure: null,
            source: null,
            http_status: null,
          });
        }
      }
      this.busy = false;
      setShared(BUSY_KEY, false);
      setShared(SNAPSHOT, { fetched_at: new Date().toISOString(), providers: [...byId.values()] });
      this.checkAlerts();
      await this.recordHistory([...byId.values()]);
      cx.notify();
    });
  }

  openDetails() {
    openOverlay({ mod: DETAIL_MOD, kind: "dialog", width: 520 });
  }

  render(cx) {
    const t = theme();
    const enabled = enabledSet();
    const ui = barSettings();
    let list = orderedProviders(providers());
    if (enabled) list = list.filter((provider) => enabled.has(provider.id));
    if (ui.hideUnconfigured) list = list.filter((provider) => !isUnconfigured(provider));
    if (ui.mode === "critical") {
      const warn = alertsSettings().warn;
      const hot = list.filter(
        (provider) => provider.error || (meterPercent(barWindow(provider, ui.window)) ?? -1) >= warn,
      );
      if (hot.length) list = hot;
      else if (list.length) list = [worstProvider(list, ui.window)];
    } else if (ui.mode === "worst" && list.length) {
      list = [worstProvider(list, ui.window)];
    }
    const settings = refreshSettings();
    const fetched = snapshot()?.fetched_at;
    // A read that is long overdue dims the numbers instead of passing them off as current.
    const stale =
      !settings.manual &&
      fetched &&
      Date.now() - new Date(fetched).getTime() > (settings.minutes * 2 + 1) * 60000;

    const providerItem = (provider) => {
      const logo = logoFor(provider.id);
      const primary = provider.error ? null : barWindow(provider, ui.window);
      const percent = meterPercent(primary);
      return h_flex()
        .id(`runway-p-${provider.id}`)
        .items_center()
        .gap(6)
        .px(6)
        .py(2)
        .rounded(5)
        .cursor_pointer()
        .when(stale, (el) => el.opacity(0.55))
        .hover((s) => s.bg(t.raised))
        .tooltip(hintFor(provider))
        .accessibility_label(String(provider.name ?? provider.id ?? ""))
        .on_click(() => {
          setShared(SELECTED_KEY, provider.id);
          this.openDetails();
        })
        .child(
          logo
            ? div().text_color(provider.error ? t.dim : t.foreground).child(svg(`${MOD_PATH}/${logo}`).size(13))
            : div()
                .text_color(t.foreground)
                .font_semibold()
                .child(String(provider.name ?? provider.id ?? "")),
        )
        .when(provider.error, (el) => el.child(div().text_color(t.blocked).font_semibold().child("!")))
        .when(primary, (el) =>
          el
            .child(
              div()
                .text_size(12)
                .text_color(usageColor(percent, t))
                .font_semibold()
                .child(windowLabel(primary)),
            )
            .when(percent !== null, (row) => row.child(miniMeter(percent, t))),
        );
    };

    const body = [];
    if (!list.length) {
      body.push(
        h_flex()
          .id("runway-empty")
          .gap(6)
          .px(6)
          .py(2)
          .rounded(5)
          .cursor_pointer()
          .hover((s) => s.bg(t.raised))
          .on_click(() => this.openDetails())
          .child(div().text_color(t.foreground).font_semibold().child(TITLE))
          .child(div().text_color(t.dim).child("···")),
      );
    } else {
      list.forEach((provider, index) => {
        if (index) body.push(div().w(1).h(12).bg(t.border));
        body.push(providerItem(provider));
      });
    }

    const icon = svg(`${MOD_PATH}/refresh.svg`).size(12);
    const button = (id, child, hint, handler) =>
      h_flex()
        .id(id)
        .px(6)
        .py(2)
        .gap(4)
        .items_center()
        .rounded(5)
        .bg(t.raised)
        .border(1)
        .border_color(t.border)
        .cursor_pointer()
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover))
        .tooltip(hint)
        .on_click(handler)
        .child(child);

    return h_flex()
      .id("runway-bar")
      .size_full()
      .px(12)
      .gap(8)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.5)
      .text_color(t.muted)
      .child(
        button(
          "runway-refresh",
          this.busy ? icon.spin(900) : icon,
          "Refresh now",
          (_event, cx) => this.refresh(cx),
        ),
      )
      .children(body)
      .child(
        div()
          .id("runway-toggle")
          .px(4)
          .cursor_pointer()
          .text_color(t.dim)
          .tooltip("Open usage details")
          .on_click(() => this.openDetails())
          .child("»"),
      )
      .child(div().flex_1());
  }
}
