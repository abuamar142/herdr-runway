// The usage detail dialog, opened from the bar.
//
// Tabs pick a provider. Each window is a card with its meter, its reset and,
// where the window length is known, a tick for how much of it has passed.
// The sliders button opens settings: which providers are read, and how often.
// Keys: ←/→ or 1-9 switch provider, R refreshes, S toggles settings.
// It reads the same shared snapshot as the bar.

import { View, div, svg } from "gpui-kit";
import { Input, InputState, h_flex, v_flex } from "gpui-base";
import * as fs from "fs/promises";
import {
  appHome,
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
  accountsFor,
  accountsSettings,
  alertsSettings,
  barColor,
  barSettings,
  barWindow,
  baseProvider,
  clockTime,
  countdown,
  duration,
  isBusy,
  keysFile,
  meterPercent,
  moneyMeter,
  moneyPair,
  historyFile,
  nextRefreshMs,
  orderedProviders,
  pace,
  percentLabel,
  primaryWindow,
  providerMinutes,
  providers,
  refreshSettings,
  selectedProvider,
  setAccounts,
  setAlertsSettings,
  setBarSettings,
  setProviderMinutes,
  setProviderOrder,
  setRefreshSettings,
  share,
  snapshot,
  stamp,
  tint,
  usageColor,
  windowLabel,
} from "./format.js";

const TICK_MS = 60000;
const HISTORY_TICK_MS = 300000;
const BAR_MOD = "runway";
// svg() resolves against the app config dir; the marks live with the bar.
const ASSETS = "mods/runway";
const ENABLED_KEY = "runway.enabled";
const REFRESH_CHOICES = [5, 10, 15, 30, 60];
const INTERVAL_CHOICES = [0, 5, 10, 15, 30, 60];
const HELPERS = {
  claude: "collect_claude.py",
  "opencode-go": "collect.py",
  kenari: "collect_kenari.py",
};
const PYTHON_HOSTS = ["python", "python3", "py"];
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
const CREDENTIAL_BASES = [
  {
    base: "claude",
    name: "Claude Code",
    hint: "OAuth token, not an Anthropic API key",
    placeholder: "Paste Claude Code OAuth token",
  },
  {
    base: "opencode-go",
    name: "OpenCode Go",
    hint: "API key (oc_sk_... or sk-...)",
    placeholder: "Paste OpenCode Go API key",
  },
  {
    base: "kenari",
    name: "Kenari",
    hint: "API key",
    placeholder: "Paste Kenari API key",
  },
];

function credentialInstances() {
  return CREDENTIAL_BASES.flatMap((base) =>
    accountsFor(base.base, base.name).map((account) => ({
      ...base,
      id: account.id,
      label: account.label,
      extra: account.id !== base.base,
    })),
  );
}
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
  const all = orderedProviders();
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
  return (provider.base ?? provider.id) === "opencode-go" ? `plan ${plan}` : plan;
}

// The provider's mark, tinted by the caller; a letter when there is no logo.
function mark(provider, size, color) {
  const file = LOGOS[provider.base ?? baseProvider(provider.id)] ?? LOGOS[provider.id];
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

function diagnosticLine(provider, t) {
  const parts = [];
  if (provider.source) parts.push(`Credential: ${provider.source}`);
  if (typeof provider.http_status === "number") parts.push(`HTTP ${provider.http_status}`);
  if (provider.updated) parts.push(`Checked ${clockTime(provider.updated)}`);
  if (!parts.length) return null;
  return div().text_color(t.dim).text_size(10.5).child(parts.join(" · "));
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
  const diagnostic = diagnosticLine(provider, t);
  if (diagnostic) children.push(diagnostic);
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

function downsample(points, limit) {
  if (points.length <= limit) return points;
  const result = [];
  const step = (points.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) {
    result.push(points[Math.round(index * step)]);
  }
  return result;
}

function historyCard(provider, t, history, range, onRange) {
  const primary = primaryWindow(provider);
  if (!primary) return null;
  const key = String(primary.key ?? primary.label ?? "window");
  const all = history?.providers?.[provider.id];
  const now = Date.now();
  const span = range === "7d" ? 7 * 86400000 : 24 * 3600000;
  const points = (Array.isArray(all) ? all : [])
    .map((point) => ({ t: Number(point.t), p: Number(point.w?.[key]) }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p) && point.t >= now - span)
    .sort((a, b) => a.t - b.t);
  const sample = downsample(points, 56);
  const title = `History · ${WINDOW_NAMES[primary.key] ?? primary.label ?? key}`;
  const rangeChips = h_flex()
    .gap(4)
    .child(chip(t, "runway-history-24h", "24h", range === "24h", (_event, cx) => onRange("24h", cx)))
    .child(chip(t, "runway-history-7d", "7d", range === "7d", (_event, cx) => onRange("7d", cx)));
  const header = h_flex()
    .items_center()
    .gap(8)
    .child(div().text_color(t.foreground).font_semibold().child(title))
    .child(div().flex_1())
    .children([rangeChips]);

  if (points.length < 2) {
    return card(t)
      .gap(6)
      .child(header)
      .child(
        div()
          .text_color(t.dim)
          .text_size(11)
          .child(all?.length ? "No points in this range yet." : "History builds as Runway refreshes."),
      );
  }

  const first = points[0];
  const last = points[points.length - 1];
  const hours = (last.t - first.t) / 3600000;
  const rate = hours > 0.05 ? (last.p - first.p) / hours : null;
  const reset = primary.resets_at ? new Date(primary.resets_at).getTime() : null;
  const left = reset && reset > now ? (reset - now) / 3600000 : null;
  const projected = rate !== null && left !== null ? last.p + rate * left : null;
  const note = [
    rate !== null ? `Burn ${rate >= 0 ? "+" : ""}${rate.toFixed(1)}%/h` : "",
    projected !== null ? `projected ${Math.round(projected)}% by reset` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return card(t)
    .gap(6)
    .child(header)
    .child(
      h_flex()
        .items_end()
        .gap(1)
        .h(30)
        .children(
          sample.map((point) =>
            div()
              .w(3)
              .h(Math.max(2, Math.round((Math.max(0, Math.min(100, point.p)) / 100) * 28)))
              .rounded(1)
              .bg(barColor(point.p, t)),
          ),
        ),
    )
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(div().text_color(t.dim).text_size(10.5).child(`${points.length} points`))
        .child(div().flex_1())
        .when(note, (el) =>
          el.child(
            div()
              .text_color(projected !== null && projected >= 100 ? t.working : t.dim)
              .text_size(10.5)
              .child(note),
          ),
        ),
    );
}

function section(provider, t, history, range, onRange) {
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
  const historyView = historyCard(provider, t, history, range, onRange);
  if (historyView) children.push(historyView);
  const diagnostic = diagnosticLine(provider, t);
  if (diagnostic) children.push(diagnostic);
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
    this.testing = {};
    this.testResult = {};
    this.history = { version: 1, providers: {} };
    this.historyRange = "24h";
    this.labelInputs = {};
    this.ensureInputs();
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
    this.loadHistory(cx);
    cx.timer.every(HISTORY_TICK_MS, (cx) => this.loadHistory(cx));
    // The keys below only arrive once the dialog holds the keyboard.
    cx.timer.after(80, () => this.focus.focus());
  }

  ensureInputs() {
    for (const item of credentialInstances()) {
      if (!this.keyInputs[item.id]) {
        const input = InputState.new({ placeholder: item.placeholder });
        input.set_masked(true);
        input.on("submit", (_event, cx) => this.saveKey(item.id, cx));
        input.on("change", (_event, cx) => cx.notify());
        this.keyInputs[item.id] = input;
        this.keyVisible[item.id] = false;
      }
      if (item.extra && !this.labelInputs[item.id]) {
        const label = InputState.new({ placeholder: "Account label" });
        label.replace(item.label);
        label.on("submit", (_event, cx) => this.renameAccount(item.id, label.value(), cx));
        label.on("change", (_event, cx) => cx.notify());
        this.labelInputs[item.id] = label;
      }
    }
  }

  renameAccount(id, value, cx) {
    const label = String(value ?? "").trim();
    if (!label) return;
    const base = baseProvider(id);
    const accounts = accountsSettings();
    const list = accounts[base] ?? [];
    if (!list.some((account) => account.id === id)) return;
    setAccounts({
      ...accounts,
      [base]: list.map((account) => (account.id === id ? { ...account, label } : account)),
    });
    run(`${BAR_MOD}.refresh`);
    cx.notify();
  }

  addAccount(baseId, cx) {
    const base = CREDENTIAL_BASES.find((item) => item.base === baseId);
    if (!base) return;
    const accounts = accountsSettings();
    const list = accounts[baseId] ?? [];
    let id = `${baseId}:${Date.now().toString(36)}`;
    while (list.some((account) => account.id === id)) id += "x";
    const label = `Account ${list.length + 2}`;
    setAccounts({ ...accounts, [baseId]: [...list, { id, label }] });
    const enabled = enabledSet();
    const next = enabled ? new Set(enabled) : new Set(providers().map((provider) => provider.id));
    next.add(id);
    setShared(ENABLED_KEY, [...next]);
    this.ensureInputs();
    run(`${BAR_MOD}.refresh`);
    cx.notify();
  }

  removeAccount(id, cx) {
    const base = baseProvider(id);
    const accounts = accountsSettings();
    const list = accounts[base] ?? [];
    if (!list.some((account) => account.id === id)) return;
    const next = list.filter((account) => account.id !== id);
    const copy = { ...accounts };
    if (next.length) copy[base] = next;
    else delete copy[base];
    setAccounts(copy);
    const enabled = enabledSet();
    if (enabled) {
      enabled.delete(id);
      setShared(ENABLED_KEY, [...enabled]);
    }
    delete this.keyInputs[id];
    delete this.labelInputs[id];
    delete this.keyVisible[id];
    delete this.testing[id];
    delete this.testResult[id];
    cx.spawn(async (cx) => {
      try {
        const path = keysFile();
        const current = await readTextFile(path);
        const data = parseKeys(current);
        delete data[id];
        await writeKeys(data, current);
      } catch (_) {
        // No saved key, or the file is not writable; the account still goes away.
      } finally {
        run(`${BAR_MOD}.refresh`);
        cx.notify();
      }
    });
  }

  async loadHistory(cx) {
    let text = null;
    try {
      text = await readTextFile(historyFile());
    } catch (_) {
      text = null;
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    this.history =
      data && typeof data === "object" && data.providers && typeof data.providers === "object"
        ? data
        : { version: 1, providers: {} };
    cx.notify();
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

  testKey(id, cx) {
    const input = this.keyInputs[id];
    const value = (input.value() ?? "").trim();
    if (!value) {
      notify({ title: "Key is empty", body: "Paste a key first.", level: "warning" });
      return;
    }
    const helper = HELPERS[baseProvider(id)];
    if (!helper || this.testing[id]) return;
    this.testing[id] = true;
    this.testResult[id] = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const safe = String(id).replace(/[^a-z0-9-]/gi, "_");
      const path = `${appHome()}/runway-test-${safe}-${Date.now()}.json`;
      try {
        await writeTextFile(path, `${JSON.stringify({ [id]: value })}\n`, null);
        try {
          await exec("chmod", ["600", path]);
        } catch (_) {
          // The file is short-lived; chmod is a best-effort POSIX hint.
        }
        let result = null;
        let lastError = null;
        for (const host of PYTHON_HOSTS) {
          try {
            result = await exec(host, [
              `${appHome()}/mods/runway/${helper}`,
              "--json",
              "--keys-file",
              path,
              "--key-id",
              id,
              "--only-key",
            ]);
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!result) throw lastError ?? new Error("Python was not found.");
        const text = (result.stdout ?? "").trim();
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (_) {
          parsed = null;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error((result.stderr ?? "").trim() || "The helper returned no readable JSON.");
        }
        if (parsed.error) {
          this.testResult[id] = {
            ok: false,
            text: `${parsed.error}${parsed.code ? ` (${parsed.code})` : ""}`,
          };
        } else {
          const plan = typeof parsed.plan === "string" && parsed.plan ? ` · ${parsed.plan}` : "";
          this.testResult[id] = { ok: true, text: `Valid${plan}` };
        }
      } catch (error) {
        this.testResult[id] = { ok: false, text: String(error?.message ?? error) };
      } finally {
        try {
          await fs.unlink(path);
        } catch (_) {
          // Already gone or never created.
        }
        this.testing[id] = false;
        cx.notify();
      }
    });
  }

  toggleKeyVisibility(id, cx) {
    this.keyVisible[id] = !this.keyVisible[id];
    this.keyInputs[id].set_masked(!this.keyVisible[id]);
    cx.notify();
  }

  moveProvider(id, delta, cx) {
    const ids = orderedProviders().map((provider) => provider.id);
    const at = ids.indexOf(id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    setProviderOrder(ids);
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
    const all = orderedProviders();
    const list = visibleProviders();
    const bar = barSettings();
    const selected = pick(list);
    const current = list.find((provider) => provider.id === selected) ?? null;
    const settings = refreshSettings();
    const alerts = alertsSettings();
    const fetched = snapshot()?.fetched_at;
    const busy = isBusy();
    const next = nextRefreshMs(settings, fetched);

    const tab = (provider) => {
      const active = provider.id === selected;
      const percent = meterPercent(barWindow(provider, bar.window));
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
          chip(t, `runway-up-${provider.id}`, "↑", false, (_event, cx) => {
            cx.stop_propagation();
            this.moveProvider(provider.id, -1, cx);
          }).tooltip("Move up"),
        )
        .child(
          chip(t, `runway-down-${provider.id}`, "↓", false, (_event, cx) => {
            cx.stop_propagation();
            this.moveProvider(provider.id, 1, cx);
          }).tooltip("Move down"),
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
      if (!input) {
        return div()
          .w_full()
          .p(12)
          .text_color(t.dim)
          .text_size(11)
          .child("Reload the dialog to edit this account.");
      }
      const canSave = (input.value() ?? "").trim().length > 0;
      const title = item.extra ? item.label : item.name;
      const hint = item.extra ? `${item.name} · ${item.hint}` : item.hint;
      const live = providers().find((provider) => provider.id === item.id);
      const diagnostic = [
        live?.source ? `via ${live.source}` : "",
        typeof live?.http_status === "number" ? `HTTP ${live.http_status}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const result = this.testResult[item.id];
      return v_flex()
        .w_full()
        .gap(7)
        .p(12)
        .when(index > 0, (el) => el.border_t(1).border_color(t.border))
        .child(
          h_flex()
            .items_center()
            .gap(8)
            .child(mark({ id: item.base, name: item.name }, 16, t.foreground))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(1)
                .child(div().text_color(t.foreground).font_semibold().child(title))
                .child(div().text_color(t.dim).text_size(10.5).child(hint))
                .when(diagnostic, (el) =>
                  el.child(div().text_color(t.dim).text_size(10).child(diagnostic)),
                ),
            )
            .child(
              div()
                .text_color(saved ? t.accent : t.dim)
                .text_size(10.5)
                .child(saved ? "Saved" : "Not set"),
            )
            .when(item.extra, (el) =>
              el.child(
                chip(
                  t,
                  `runway-remove-${item.id}`,
                  "Remove",
                  false,
                  (_event, cx) => this.removeAccount(item.id, cx),
                ),
              ),
            ),
        )
        .when(item.extra, (el) =>
          el.child(
            h_flex()
              .items_center()
              .gap(6)
              .child(div().text_color(t.dim).text_size(10.5).child("Label"))
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .h(26)
                  .flex()
                  .items_center()
                  .rounded(6)
                  .border(1)
                  .border_color(t.border)
                  .bg(t.popover)
                  .px(8)
                  .child(
                    this.labelInputs[item.id]
                      ? Input.new(this.labelInputs[item.id])
                          .w_full()
                          .text_size(11)
                          .text_color(t.foreground)
                      : div().text_color(t.dim).child(item.label),
                  ),
              )
              .child(
                chip(
                  t,
                  `runway-rename-${item.id}`,
                  "Rename",
                  false,
                  (_event, cx) =>
                    this.renameAccount(item.id, this.labelInputs[item.id]?.value(), cx),
                ),
              ),
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
                `runway-key-test-${item.id}`,
                this.testing[item.id] ? "Testing…" : "Test",
                false,
                (_event, cx) => this.testKey(item.id, cx),
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
        )
        .when(result, (el) =>
          el.child(
            div()
              .text_color(result.ok ? t.accent : t.blocked)
              .text_size(10.5)
              .child(result.text),
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
      .children(
        CREDENTIAL_BASES.flatMap((base, groupIndex) => {
          const instances = accountsFor(base.base, base.name);
          const header = h_flex()
            .w_full()
            .items_center()
            .gap(8)
            .px(12)
            .py(8)
            .when(groupIndex > 0, (el) => el.border_t(1).border_color(t.border))
            .child(mark({ id: base.base, name: base.name }, 16, t.foreground))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(1)
                .child(div().text_color(t.foreground).font_semibold().child(base.name))
                .child(
                  div()
                    .text_color(t.dim)
                    .text_size(10.5)
                    .child(`${instances.length} ${instances.length === 1 ? "account" : "accounts"}`),
                ),
            )
            .child(
              chip(t, `runway-add-${base.base}`, "+ Account", false, (_event, cx) =>
                this.addAccount(base.base, cx),
              ),
            );
          return [
            header,
            ...instances.map((account, index) =>
              credentialRow(
                {
                  ...base,
                  id: account.id,
                  label: account.label,
                  extra: account.id !== base.base,
                },
                index,
              ),
            ),
          ];
        }),
      );

    const credentialsNote = div()
      .text_color(t.dim)
      .text_size(10.5)
      .child(
        "Extra accounts use their own saved key. Codex, Antigravity, Kimi and Command Code use quota-axi sign-in. Keys live in ~/.config/herdr-app/runway-keys.json (mode 600).",
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

    const barSection = (() => {
      const windowChoices = [
        ["primary", "Primary"],
        ["five_hour", "5h"],
        ["week", "Week"],
        ["month", "Month"],
        ["worst", "Worst"],
      ];
      const modeChoices = [
        ["all", "All"],
        ["critical", "Critical"],
        ["worst", "Worst"],
      ];
      const row = (id, title, hint, content) =>
        h_flex()
          .id(`runway-bar-${id}`)
          .w_full()
          .items_center()
          .gap(10)
          .px(12)
          .py(9)
          .when(id !== "window", (el) => el.border_t(1).border_color(t.border))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(1)
              .child(div().text_color(t.foreground).font_semibold().child(title))
              .child(div().text_color(t.dim).text_size(10.5).child(hint)),
          )
          .child(content);
      return setting(
        "Bar",
        "What the bottom bar shows.",
        v_flex()
          .w_full()
          .rounded(8)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .overflow_hidden()
          .child(
            row(
              "window",
              "Window",
              "Which window the bar reads for each provider.",
              h_flex()
                .gap(5)
                .children(windowChoices.map(([value, label]) =>
                  chip(t, `runway-bar-window-${value}`, label, bar.window === value, (_event, cx) => {
                    setBarSettings({ window: value });
                    cx.notify();
                  }),
                )),
            ),
          )
          .child(
            row(
              "mode",
              "Show",
              "Critical uses the warn threshold; Worst keeps one provider.",
              h_flex()
                .gap(5)
                .children(modeChoices.map(([value, label]) =>
                  chip(t, `runway-bar-mode-${value}`, label, bar.mode === value, (_event, cx) => {
                    setBarSettings({ mode: value });
                    cx.notify();
                  }),
                )),
            ),
          )
          .child(
            row(
              "unconfigured",
              "Hide unconfigured",
              "Hide providers with no credential instead of an error item.",
              h_flex()
                .gap(6)
                .child(chip(t, "runway-bar-hide-on", "On", bar.hideUnconfigured, (_event, cx) => {
                  setBarSettings({ hideUnconfigured: true });
                  cx.notify();
                }))
                .child(chip(t, "runway-bar-hide-off", "Off", !bar.hideUnconfigured, (_event, cx) => {
                  setBarSettings({ hideUnconfigured: false });
                  cx.notify();
                })),
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
            : this.settingsTab === "bar"
              ? barSection
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

    const body = this.managing
      ? manage
      : current
        ? section(current, t, this.history, this.historyRange, (value, cx) => {
            this.historyRange = value;
            cx.notify();
          })
        : empty;

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
              chip(t, "runway-settings-bar", "Bar", this.settingsTab === "bar", (_event, cx) =>
                this.setSettingsTab("bar", cx),
              ),
            ]),
        ),
      )
      .when(!this.managing && list.length > 0, (el) =>
        el.child(
          h_flex().w_full().min_w(0).flex_none().gap(2).border_b(1).border_color(t.border).children(list.map(tab)),
        ),
      )
      .child(
        v_flex()
          .id("runway-detail-body")
          .w_full()
          .flex_1()
          .min_h(0)
          .when(this.managing, (el) => el.h(560))
          .overflow_y_scroll()
          .child(body),
      )
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
