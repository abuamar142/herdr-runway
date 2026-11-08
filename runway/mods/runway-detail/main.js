// The usage detail dialog, opened from the bar.
//
// Tabs pick a provider. Each window is a card with its meter, its reset and,
// where the window length is known, a tick for how much of it has passed.
// The sliders button opens settings: which providers are read, and how often.
// Keys: ←/→ or 1-9 switch provider, R refreshes, S toggles settings.
// It reads the same shared snapshot as the bar.

import { View, div, svg } from "gpui-kit";
import { Input, InputState, h_flex, v_flex } from "gpui-base";
import {
  closeOverlay,
  exec,
  notify,
  props,
  readTextFile,
  run,
  setShared,
  shared,
  theme,
  writeTextFile,
} from "herdr";
import {
  SELECTED_KEY,
  alertsSettings,
  barColor,
  clockTime,
  countdown,
  duration,
  isBusy,
  keysFile,
  meterPercent,
  moneyMeter,
  moneyPair,
  nextRefreshMs,
  pace,
  percentLabel,
  primaryWindow,
  providerMinutes,
  providers,
  refreshSettings,
  selectedProvider,
  setAlertsSettings,
  setProviderMinutes,
  setRefreshSettings,
  share,
  snapshot,
  stamp,
  tint,
  usageColor,
  windowLabel,
} from "./format.js";

const TICK_MS = 60000;
const BAR_MOD = "runway";
// svg() resolves against the app config dir; the marks live with the bar.
const ASSETS = "mods/runway";
const ENABLED_KEY = "runway.enabled";
const REFRESH_CHOICES = [5, 10, 15, 30, 60];
const INTERVAL_CHOICES = [0, 5, 10, 15, 30, 60];
const LOGOS = {
  claude: "claude.svg",
  "opencode-go": "opencode.svg",
  kenari: "kenari.svg",
  codex: "codex.svg",
  agy: "antigravity.svg",
  kimi: "kimi.svg",
  commandcode: "commandcode.svg",
};
const SHORT_NAMES = {
  claude: "Claude",
  "opencode-go": "OpenCode",
  kenari: "Kenari",
  codex: "Codex",
  agy: "Agy",
  kimi: "Kimi",
  commandcode: "Cmd",
};
const CREDENTIALS = [
  {
    id: "claude",
    name: "Claude Code",
    hint: "OAuth token, not an Anthropic API key",
    placeholder: "Paste Claude Code OAuth token",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    hint: "API key (oc_sk_... or sk-...)",
    placeholder: "Paste OpenCode Go API key",
  },
  {
    id: "kenari",
    name: "Kenari",
    hint: "API key",
    placeholder: "Paste Kenari API key",
  },
];
const WINDOW_NAMES = {
  five_hour: "5-hour",
  fiveHour: "5-hour",
  seven_day: "Weekly",
  week: "Weekly",
  month: "Monthly",
};

function enabledSet() {
  // One-time carry-over from the mod's old name, so renaming kept the choices.
  const value = shared(ENABLED_KEY) ?? shared("usage-unified.enabled");
  return Array.isArray(value) ? new Set(value.map(String)) : null;
}

function providerEnabled(id) {
  const enabled = enabledSet();
  return enabled ? enabled.has(id) : true;
}

function visibleProviders() {
  const enabled = enabledSet();
  const all = providers();
  return enabled ? all.filter((provider) => enabled.has(provider.id)) : all;
}

function pick(list) {
  const chosen = selectedProvider();
  return list.some((provider) => provider.id === chosen) ? chosen : list[0]?.id ?? null;
}

function parseKeys(text) {
  if (!text) return {};
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (_) {
    return {};
  }
}

async function writeKeys(data, expected) {
  const path = keysFile();
  await writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`, expected);
  // chmod is POSIX-only; a Windows profile ACL already limits the file.
  try {
    await exec("chmod", ["600", path]);
  } catch (_) {
    // The key is saved; only the mode hint failed.
  }
}

function subtitle(provider) {
  const plan = provider?.plan;
  if (typeof plan !== "string" || !plan) return "";
  return provider.id === "opencode-go" ? `plan ${plan}` : plan;
}

// The provider's mark, tinted by the caller; a letter when there is no logo.
function mark(provider, size, color) {
  const file = LOGOS[provider.id];
  if (!file) {
    const name = String(provider.name ?? provider.id ?? "?");
    return div().text_color(color).text_size(size - 2).font_semibold().child(name.slice(0, 1).toUpperCase());
  }
  return div().text_color(color).child(svg(`${ASSETS}/${file}`).size(size));
}

function iconButton(t, id, file, hint, onClick, active = false) {
  return h_flex()
    .id(id)
    .w(28)
    .h(28)
    .items_center()
    .justify_center()
    .rounded(6)
    .cursor_pointer()
    .text_color(active ? t.foreground : t.dim)
    .when(active, (el) => el.bg(t.raised))
    .hover((s) => s.bg(t.raised))
    .tooltip(hint)
    .on_click(onClick)
    .child(svg(`${ASSETS}/${file}`).size(14));
}

function chip(t, id, label, active, onClick) {
  return h_flex()
    .id(id)
    .items_center()
    .px(10)
    .py(5)
    .rounded(6)
    .cursor_pointer()
    .border(1)
    .border_color(active ? t.accent : t.border)
    .bg(active ? tint(t.accent, 0.18) : t.raised)
    .text_color(active ? t.foreground : t.muted)
    .hover((s) => s.bg(active ? tint(t.accent, 0.26) : t.hover))
    .on_click(onClick)
    .child(label);
}

function toggleSwitch(on, t) {
  return h_flex()
    .w(34)
    .h(20)
    .px(2)
    .items_center()
    .rounded_full()
    .bg(on ? t.accent : t.hover)
    .when(on, (el) => el.justify_end())
    .child(div().w(16).h(16).rounded_full().bg(on ? t.foreground : t.muted));
}

function card(t) {
  return v_flex().w_full().gap(8).p(12).rounded(8).bg(t.raised).border(1).border_color(t.border);
}

function windowCard(meter, t) {
  const percent = meterPercent(meter);
  const fill = share(percent);
  const color = barColor(percent, t);
  const rate = pace(meter);
  const hasMoney = typeof meter.used_usd === "number" || typeof meter.limit_usd === "number";
  const reset = meter.resets_at
    ? `Resets in ${countdown(meter.resets_at)} · ${stamp(meter.resets_at)}`
    : "No reset time";

  const track = div()
    .relative()
    .w_full()
    .h(10)
    .child(div().absolute().top(2).left(0).w_full().h(6).rounded_full().bg(t.hover))
    .child(
      div()
        .absolute()
        .top(2)
        .left(0)
        .h(6)
        .w(`${Math.round((percent > 0 ? Math.max(fill, 1.5) : 0) * 10) / 10}%`)
        .rounded_full()
        .bg(color),
    )
    .when(rate, (el) =>
      el.child(
        div()
          .absolute()
          .top(0)
          .left(`${Math.round(Math.min(rate.elapsed, 99) * 10) / 10}%`)
          .w(2)
          .h(10)
          .rounded_full()
          .bg(t.foreground)
          .tooltip(`${Math.round(rate.elapsed)}% of this window has passed`),
      ),
    );

  const note = rate
    ? rate.runout !== null
      ? div().text_color(t.working).text_size(11).child(`Limit in ~${duration(rate.runout)} at this pace`)
      : div().text_color(t.dim).text_size(11).child(`${Math.round(rate.elapsed)}% of window passed`)
    : null;

  return card(t)
    .gap(7)
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(
          div()
            .text_color(t.foreground)
            .font_semibold()
            .child(WINDOW_NAMES[meter.key] ?? String(meter.label ?? "")),
        )
        .when(hasMoney, (el) =>
          el.child(div().text_color(t.dim).text_size(11).child(moneyPair(meter.used_usd, meter.limit_usd))),
        )
        .child(div().flex_1())
        .child(
          div()
            .text_color(usageColor(percent, t))
            .text_size(18)
            .font_semibold()
            .child(windowLabel(meter)),
        ),
    )
    .child(track)
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(div().text_color(t.dim).text_size(11).child(reset))
        .child(div().flex_1())
        .when(note, (el) => el.child(note)),
    );
}

function errorCard(provider, t) {
  const children = [
    div().text_color(t.blocked).font_semibold().child(String(provider.error)),
  ];
  if (provider.action) {
    children.push(div().text_color(t.muted).text_size(11.5).child(String(provider.action)));
  }
  if (provider.failure) {
    children.push(div().text_color(t.dim).text_size(10.5).child(String(provider.failure)));
  }
  return v_flex()
    .w_full()
    .gap(6)
    .p(12)
    .rounded(8)
    .bg(tint(t.blocked, 0.1))
    .border(1)
    .border_color(tint(t.blocked, 0.4))
    .children(children);
}

function section(provider, t) {
  const plan = subtitle(provider);
  const children = [
    h_flex()
      .items_center()
      .gap(8)
      .child(mark(provider, 18, t.foreground))
      .child(
        div()
          .text_color(t.foreground)
          .text_size(15)
          .font_semibold()
          .child(String(provider.name ?? provider.id ?? "")),
      )
      .when(plan, (el) =>
        el.child(
          div()
            .px(6)
            .py(1)
            .rounded(4)
            .bg(t.raised)
            .border(1)
            .border_color(t.border)
            .text_color(t.muted)
            .text_size(10.5)
            .child(plan),
        ),
      ),
  ];

  if (provider.error) {
    children.push(errorCard(provider, t));
    return v_flex().w_full().gap(12).children(children);
  }

  const windows = Array.isArray(provider.windows) ? provider.windows : [];
  const cards = windows.map((meter) => windowCard(meter, t));
  // A money pool gets the same card as a window, so `$150.00` always sits under
  // a meter instead of only as a number in a line. A pool with no stated limit
  // is not actionable and is left out.
  const moneyLimit = provider.money?.limit_usd;
  if (
    provider.money &&
    Number.isFinite(moneyLimit) &&
    moneyLimit > 0 &&
    Number.isFinite(provider.money.used_usd)
  ) {
    cards.push(windowCard(moneyMeter(provider.money), t));
  }
  if (cards.length) children.push(v_flex().w_full().gap(8).children(cards));
  if (provider.period_ends_at) {
    children.push(
      div()
        .text_color(t.dim)
        .text_size(11)
        .child(
          `Paid period ends ${stamp(provider.period_ends_at)} · ${countdown(provider.period_ends_at)} left`,
        ),
    );
  }
  if (!cards.length && !provider.period_ends_at) {
    children.push(div().text_color(t.dim).child("No reading yet."));
  }
  return v_flex().w_full().gap(12).children(children);
}

export default class AgentUsageDetail extends View {
  init(_given, cx) {
    this.managing = false;
    this.settingsTab = "providers";
    this.focus = cx.focus_handle();
    this.savedKeys = new Set();
    this.keyVisible = {};
    this.keyInputs = {};
    for (const item of CREDENTIALS) {
      const input = InputState.new({ placeholder: item.placeholder });
      input.set_masked(true);
      input.on("submit", (_event, cx) => this.saveKey(item.id, cx));
      input.on("change", (_event, cx) => cx.notify());
      this.keyInputs[item.id] = input;
      this.keyVisible[item.id] = false;
    }
    cx.spawn(async (cx) => {
      const text = await readTextFile(keysFile()).catch(() => null);
      this.savedKeys = new Set(
        Object.entries(parseKeys(text))
          .filter(([, value]) => typeof value === "string" && value.trim())
          .map(([id]) => id),
      );
      cx.notify();
    });
    // Only the countdowns change by the minute; the numbers come from shared.
    cx.timer.every(TICK_MS, (cx) => cx.notify());
    // The keys below only arrive once the dialog holds the keyboard.
    cx.timer.after(80, () => this.focus.focus());
  }

  select(id, cx) {
    setShared(SELECTED_KEY, id);
    cx.notify();
  }

  step(delta, cx) {
    const list = visibleProviders();
    if (list.length < 2) return;
    const at = list.findIndex((provider) => provider.id === pick(list));
    this.select(list[(at + delta + list.length) % list.length].id, cx);
  }

  toggleManaging(cx) {
    this.managing = !this.managing;
    cx.notify();
  }

  setSettingsTab(tab, cx) {
    this.settingsTab = tab;
    cx.notify();
  }

  saveKey(id, cx) {
    const input = this.keyInputs[id];
    const value = (input.value() ?? "").trim();
    if (!value) {
      notify({ title: "Key is empty", body: "Paste a key first.", level: "warning" });
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const path = keysFile();
        const current = await readTextFile(path);
        const data = parseKeys(current);
        data[id] = value;
        await writeKeys(data, current);
        this.savedKeys.add(id);
        input.replace("");
        input.set_masked(true);
        this.keyVisible[id] = false;
        notify({
          title: "Key saved",
          body: "Runway will use it on the next refresh.",
          level: "success",
        });
        run(`${BAR_MOD}.refresh`);
        cx.notify();
      } catch (error) {
        notify({
          title: "Could not save the key",
          body: String(error?.message ?? error),
          level: "error",
        });
      }
    });
  }

  clearKey(id, cx) {
    cx.spawn(async (cx) => {
      try {
        const path = keysFile();
        const current = await readTextFile(path);
        const data = parseKeys(current);
        delete data[id];
        await writeKeys(data, current);
        this.savedKeys.delete(id);
        this.keyInputs[id].replace("");
        this.keyInputs[id].set_masked(true);
        this.keyVisible[id] = false;
        notify({
          title: "Key cleared",
          body: "Runway will use the tool's own sign-in again.",
          level: "info",
        });
        run(`${BAR_MOD}.refresh`);
        cx.notify();
      } catch (error) {
        notify({
          title: "Could not clear the key",
          body: String(error?.message ?? error),
          level: "error",
        });
      }
    });
  }

  toggleKeyVisibility(id, cx) {
    this.keyVisible[id] = !this.keyVisible[id];
    this.keyInputs[id].set_masked(!this.keyVisible[id]);
    cx.notify();
  }

  toggleProvider(id, cx) {
    const all = providers().map((provider) => provider.id);
    const enabled = enabledSet() ?? new Set(all);
    const wasEnabled = enabled.has(id);
    if (wasEnabled) enabled.delete(id);
    else enabled.add(id);
    setShared(ENABLED_KEY, [...enabled]);
    // Turning a provider on needs one read; turning it off only hides it.
    run(`${BAR_MOD}.${wasEnabled ? "notify" : "refresh"}`);
    cx.notify();
  }

  close() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
    else run("overlay.close");
  }

  onKey(event, cx) {
    const mod = event.modifiers;
    if (mod.control || mod.alt || mod.platform) return;
    const key = event.key;
    const list = visibleProviders();
    if (key === "r") run(`${BAR_MOD}.refresh`);
    else if (key === "s") this.toggleManaging(cx);
    else if (this.managing) return;
    else if (key === "right") this.step(1, cx);
    else if (key === "left") this.step(-1, cx);
    else if (/^[1-9]$/.test(key) && list[Number(key) - 1]) this.select(list[Number(key) - 1].id, cx);
    else return;
    cx.stop_propagation();
  }

  render(cx) {
    const t = theme();
    const all = providers();
    const list = visibleProviders();
    const selected = pick(list);
    const current = list.find((provider) => provider.id === selected) ?? null;
    const settings = refreshSettings();
    const alerts = alertsSettings();
    const fetched = snapshot()?.fetched_at;
    const busy = isBusy();
    const next = nextRefreshMs(settings, fetched);

    const tab = (provider) => {
      const active = provider.id === selected;
      const percent = meterPercent(primaryWindow(provider));
      const suffix = provider.error ? "!" : percent === null ? "" : percentLabel(percent);
      const name = String(SHORT_NAMES[provider.id] ?? provider.name ?? provider.id ?? "");
      return v_flex()
        .id(`runway-tab-${provider.id}`)
        .cursor_pointer()
        .tooltip(String(provider.name ?? provider.id ?? ""))
        .on_click((_event, cx) => this.select(provider.id, cx))
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .px(10)
            .py(8)
            .rounded(6)
            .hover((s) => s.bg(t.raised))
            .child(mark(provider, 14, active ? t.foreground : t.muted))
            .when(active, (el) =>
              el.child(div().text_color(t.foreground).font_semibold().child(name)),
            )
            .when(suffix, (el) =>
              el.child(
                div()
                  .text_color(provider.error ? t.blocked : active ? usageColor(percent, t) : t.dim)
                  .child(suffix),
              ),
            ),
        )
        .child(div().w_full().h(2).rounded_full().when(active, (el) => el.bg(t.accent)));
    };

    const manageRow = (provider, index) => {
      const on = providerEnabled(provider.id);
      const percent = meterPercent(primaryWindow(provider));
      const reading = !on ? "" : provider.error ? "!" : percent === null ? "" : percentLabel(percent);
      const plan = subtitle(provider);
      const override = settings.providerMinutes[provider.id] ?? 0;
      const interval = override || settings.minutes;
      return h_flex()
        .id(`runway-provider-${provider.id}`)
        .w_full()
        .items_center()
        .gap(10)
        .px(12)
        .py(9)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .when(index > 0, (el) => el.border_t(1).border_color(t.border))
        .on_click((_event, cx) => this.toggleProvider(provider.id, cx))
        .child(mark(provider, 16, on ? t.foreground : t.dim))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(
              div()
                .text_color(on ? t.foreground : t.dim)
                .font_semibold()
                .child(String(provider.name ?? provider.id ?? "")),
            )
            .when(plan, (el) => el.child(div().text_color(t.dim).text_size(10.5).child(plan))),
        )
        .child(
          div()
            .text_color(provider.error ? t.blocked : t.dim)
            .child(reading),
        )
        .child(
          chip(
            t,
            `runway-interval-${provider.id}`,
            override ? `${override}m` : "Auto",
            override > 0,
            (_event, cx) => {
              cx.stop_propagation();
              const at = INTERVAL_CHOICES.indexOf(override);
              const next = INTERVAL_CHOICES[(at + 1) % INTERVAL_CHOICES.length];
              setProviderMinutes(provider.id, next);
              cx.notify();
            },
          ).tooltip(`Refresh every ${interval} minutes; click to cycle`),
        )
        .child(toggleSwitch(on, t));
    };

    const setting = (title, hint, content) =>
      v_flex()
        .w_full()
        .gap(8)
        .child(
          v_flex()
            .gap(2)
            .child(div().text_color(t.foreground).font_semibold().child(title))
            .child(div().text_color(t.dim).text_size(11).child(hint)),
        )
        .child(content);

    const pickRefresh = (minutes, manual) => (_event, cx) => {
      setRefreshSettings(minutes, manual);
      run(`${BAR_MOD}.notify`);
      cx.notify();
    };

    const credentialRow = (item, index) => {
      const saved = this.savedKeys.has(item.id);
      const input = this.keyInputs[item.id];
      const canSave = (input.value() ?? "").trim().length > 0;
      return v_flex()
        .w_full()
        .gap(7)
        .p(12)
        .when(index > 0, (el) => el.border_t(1).border_color(t.border))
        .child(
          h_flex()
            .items_center()
            .gap(8)
            .child(mark({ id: item.id, name: item.name }, 16, t.foreground))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(1)
                .child(div().text_color(t.foreground).font_semibold().child(item.name))
                .child(div().text_color(t.dim).text_size(10.5).child(item.hint)),
            )
            .child(
              div()
                .text_color(saved ? t.accent : t.dim)
                .text_size(10.5)
                .child(saved ? "Saved" : "Not set"),
            ),
        )
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .h(30)
                .flex()
                .items_center()
                .rounded(6)
                .border(1)
                .border_color(t.border)
                .bg(t.popover)
                .px(8)
                .child(Input.new(input).w_full().text_size(12).text_color(t.foreground)),
            )
            .child(
              chip(
                t,
                `runway-key-show-${item.id}`,
                this.keyVisible[item.id] ? "Hide" : "Show",
                false,
                (_event, cx) => this.toggleKeyVisibility(item.id, cx),
              ),
            )
            .child(
              chip(
                t,
                `runway-key-save-${item.id}`,
                "Save",
                canSave,
                (_event, cx) => this.saveKey(item.id, cx),
              ),
            )
            .when(saved, (el) =>
              el.child(
                chip(
                  t,
                  `runway-key-clear-${item.id}`,
                  "Clear",
                  false,
                  (_event, cx) => this.clearKey(item.id, cx),
                ),
              ),
            ),
        );
    };

    const credentials = v_flex()
      .w_full()
      .rounded(8)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .overflow_hidden()
      .children(CREDENTIALS.map(credentialRow));

    const credentialsNote = div()
      .text_color(t.dim)
      .text_size(10.5)
      .child(
        "Codex, Antigravity, Kimi and Command Code use quota-axi sign-in. Keys live in ~/.config/herdr-app/runway-keys.json (mode 600).",
      );

    const providersSection = setting(
      "Providers",
      "Off providers are hidden and never read. The chip cycles one provider's refresh interval; Auto follows the global setting.",
      v_flex()
        .w_full()
        .rounded(8)
        .bg(t.raised)
        .border(1)
        .border_color(t.border)
        .overflow_hidden()
        .children(all.map(manageRow)),
    );

    const credentialsSection = setting(
      "Credentials",
      "Saved keys override the tool's own sign-in.",
      v_flex().gap(6).child(credentials).child(credentialsNote),
    );

    const refreshSection = setting(
      "Auto refresh",
      settings.manual
        ? "Reads only when you press Refresh."
        : `Every ${settings.minutes} minutes${next === null ? "" : ` · next in ${duration(next)}`}`,
      h_flex()
        .items_center()
        .gap(6)
        .children(
          REFRESH_CHOICES.map((minutes) =>
            chip(
              t,
              `runway-refresh-${minutes}`,
              `${minutes}m`,
              !settings.manual && settings.minutes === minutes,
              pickRefresh(minutes, false),
            ),
          ),
        )
        .child(div().w(1).h(16).bg(t.border))
        .child(chip(t, "runway-refresh-manual", "Manual", settings.manual, pickRefresh(settings.minutes, true))),
    );

    const alertsSection = (() => {
      const snoozed = alerts.snoozeUntil > Date.now();
      const rows = [
        {
          id: "enabled",
          title: "Notifications",
          hint: "Off stops every Runway toast.",
          content: h_flex()
            .gap(6)
            .child(chip(t, "runway-alert-on", "On", alerts.enabled, (_event, cx) => {
              setAlertsSettings({ enabled: true });
              cx.notify();
            }))
            .child(chip(t, "runway-alert-off", "Off", !alerts.enabled, (_event, cx) => {
              setAlertsSettings({ enabled: false });
              cx.notify();
            })),
        },
        {
          id: "warn",
          title: "Warn at",
          hint: "One warning per window.",
          content: h_flex()
            .gap(6)
            .children([75, 80, 90].map((value) =>
              chip(t, `runway-alert-warn-${value}`, `${value}%`, alerts.warn === value, (_event, cx) => {
                setAlertsSettings({ warn: value });
                cx.notify();
              }),
            )),
        },
        {
          id: "critical",
          title: "Critical at",
          hint: "One error toast per window.",
          content: h_flex()
            .gap(6)
            .children([90, 95, 100].map((value) =>
              chip(t, `runway-alert-critical-${value}`, `${value}%`, alerts.critical === value, (_event, cx) => {
                setAlertsSettings({ critical: value });
                cx.notify();
              }),
            )),
        },
        {
          id: "forecast",
          title: "Forecast",
          hint: "Warn when the current pace reaches 100% before reset.",
          content: h_flex()
            .gap(6)
            .child(chip(t, "runway-alert-forecast-on", "On", alerts.forecast, (_event, cx) => {
              setAlertsSettings({ forecast: true });
              cx.notify();
            }))
            .child(chip(t, "runway-alert-forecast-off", "Off", !alerts.forecast, (_event, cx) => {
              setAlertsSettings({ forecast: false });
              cx.notify();
            })),
        },
        {
          id: "reset",
          title: "Window reset",
          hint: "Tell me when a window becomes available again.",
          content: h_flex()
            .gap(6)
            .child(chip(t, "runway-alert-reset-on", "On", alerts.reset, (_event, cx) => {
              setAlertsSettings({ reset: true });
              cx.notify();
            }))
            .child(chip(t, "runway-alert-reset-off", "Off", !alerts.reset, (_event, cx) => {
              setAlertsSettings({ reset: false });
              cx.notify();
            })),
        },
        {
          id: "snooze",
          title: "Snooze",
          hint: snoozed ? `Quiet until ${clockTime(new Date(alerts.snoozeUntil).toISOString())}.` : "Mute every alert for one hour.",
          content: snoozed
            ? chip(t, "runway-alert-resume", "Resume", true, (_event, cx) => {
                setAlertsSettings({ snoozeUntil: 0 });
                cx.notify();
              })
            : chip(t, "runway-alert-snooze", "Snooze 1h", false, (_event, cx) => {
                setAlertsSettings({ snoozeUntil: Date.now() + 3600000 });
                cx.notify();
              }),
        },
        {
          id: "test",
          title: "Test",
          hint: "Post one toast so you can check the system settings.",
          content: chip(t, "runway-alert-test", "Send test", false, () =>
            notify({ title: "Runway test", body: "Notifications are working.", level: "info" }),
          ),
        },
      ];
      return setting(
        "Alerts",
        "One notification per window and threshold; snooze mutes all of them.",
        v_flex()
          .w_full()
          .rounded(8)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .overflow_hidden()
          .children(
            rows.map((row, index) =>
              h_flex()
                .id(`runway-alert-${row.id}`)
                .w_full()
                .items_center()
                .gap(10)
                .px(12)
                .py(9)
                .when(index > 0, (el) => el.border_t(1).border_color(t.border))
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(1)
                    .child(div().text_color(t.foreground).font_semibold().child(row.title))
                    .child(div().text_color(t.dim).text_size(10.5).child(row.hint)),
                )
                .child(row.content),
            ),
          ),
      );
    })();

    const manageBody =
      this.settingsTab === "credentials"
        ? credentialsSection
        : this.settingsTab === "refresh"
          ? refreshSection
          : this.settingsTab === "alerts"
            ? alertsSection
            : providersSection;
    const manage = v_flex().w_full().gap(0).child(manageBody);

    const empty = v_flex()
      .w_full()
      .items_center()
      .gap(10)
      .py(28)
      .child(
        div()
          .text_color(t.dim)
          .child(all.length ? "Every provider is off." : "No reading yet."),
      )
      .when(all.length, (el) =>
        el.child(chip(t, "runway-open-settings", "Choose providers", false, (_event, cx) => this.toggleManaging(cx))),
      );

    const body = this.managing ? manage : current ? section(current, t) : empty;

    const status = busy
      ? "Refreshing…"
      : fetched
        ? `Updated ${clockTime(fetched)}${
            settings.manual ? " · manual refresh" : next === null ? "" : ` · next in ${duration(next)}`
          }`
        : "No reading yet";
    const refreshIcon = svg(`${ASSETS}/refresh.svg`).size(12);

    return v_flex()
      .id("runway-detail")
      .size_full()
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_size(12.5)
      .text_color(t.muted)
      .track_focus(this.focus)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(
            div()
              .text_color(t.foreground)
              .text_size(15)
              .font_semibold()
              .child(this.managing ? "Settings" : "Runway"),
          )
          .child(div().flex_1())
          .child(
            this.managing
              ? chip(t, "runway-done", "Done", true, (_event, cx) => this.toggleManaging(cx))
              : iconButton(t, "runway-settings", "settings.svg", "Settings (S)", (_event, cx) =>
                  this.toggleManaging(cx),
                ),
          )
          .child(iconButton(t, "runway-detail-close", "close.svg", "Close (Esc)", () => this.close())),
      )
      .when(this.managing, (el) =>
        el.child(
          h_flex()
            .w_full()
            .gap(6)
            .children([
              chip(t, "runway-settings-providers", "Providers", this.settingsTab === "providers", (_event, cx) =>
                this.setSettingsTab("providers", cx),
              ),
              chip(t, "runway-settings-credentials", "Credentials", this.settingsTab === "credentials", (_event, cx) =>
                this.setSettingsTab("credentials", cx),
              ),
              chip(t, "runway-settings-refresh", "Refresh", this.settingsTab === "refresh", (_event, cx) =>
                this.setSettingsTab("refresh", cx),
              ),
              chip(t, "runway-settings-alerts", "Alerts", this.settingsTab === "alerts", (_event, cx) =>
                this.setSettingsTab("alerts", cx),
              ),
            ]),
        ),
      )
      .when(!this.managing && list.length > 0, (el) =>
        el.child(
          h_flex().w_full().min_w(0).flex_none().gap(2).border_b(1).border_color(t.border).children(list.map(tab)),
        ),
      )
      .child(v_flex().w_full().flex_1().min_h(0).child(body))
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .pt(12)
          .border_t(1)
          .border_color(t.border)
          .child(div().text_color(t.dim).text_size(11).child(status))
          .child(div().flex_1())
          .child(
            h_flex()
              .id("runway-detail-refresh")
              .items_center()
              .gap(6)
              .px(10)
              .py(5)
              .rounded(6)
              .bg(t.raised)
              .border(1)
              .border_color(t.border)
              .cursor_pointer()
              .text_color(t.foreground)
              .hover((s) => s.bg(t.hover))
              .tooltip("Refresh now (R)")
              .on_click(() => run(`${BAR_MOD}.refresh`))
              .child(busy ? refreshIcon.spin(900) : refreshIcon)
              .child("Refresh"),
          ),
      );
  }
}
