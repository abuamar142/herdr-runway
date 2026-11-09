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
  barSettings,
  barWindow,
  baseProvider,
  ccusage,
  clockTime,
  duration,
  isBusy,
  keysFile,
  meterPercent,
  historyFile,
  nextRefreshMs,
  orderedProviders,
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
  snapshot,
  usageColor,
} from "./format.js";
import { ASSETS, chip, iconButton, section } from "./cards.js";
import { alertsSection, barSection, credentialsSection, providersSection, refreshSection, tab } from "./settings.js";
import { CREDENTIAL_BASES, HELPERS, credentialInstances } from "./metadata.js";

const TICK_MS = 60000;
const HISTORY_TICK_MS = 300000;
const BAR_MOD = "runway";
const ENABLED_KEY = "runway.enabled";
const PYTHON_HOSTS = ["python", "python3", "py"];

function enabledSet() {
  // One-time carry-over from the mod's old name, so renaming kept the choices.
  const value = shared(ENABLED_KEY) ?? shared("usage-unified.enabled");
  return Array.isArray(value) ? new Set(value.map(String)) : null;
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
    if (barSettings().showTokens) run(`${BAR_MOD}.ccusage`);
    // The keys below only arrive once the dialog holds the keyboard.
    cx.timer.after(80, () => this.focus.focus());
  }

  ensureInputs() {
    for (const item of credentialInstances()) {
      if (!this.keyInputs[item.id]) {
        const input = InputState.new({ placeholder: item.placeholder });
        input.set_masked(true);
        input.on("submit", (_event, cx) => this.saveKey(item.id, cx));
        input.on("change", (_event, cx) => {
          delete this.testResult[item.id];
          cx.notify();
        });
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
    const ids = new Set(credentialInstances().map((item) => item.id));
    for (const id of Object.keys(this.keyInputs)) {
      if (!ids.has(id)) {
        delete this.keyInputs[id];
        delete this.labelInputs[id];
        delete this.keyVisible[id];
        delete this.testing[id];
        delete this.testResult[id];
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
    this.ensureInputs();
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
    this.ensureInputs();
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
    this.ensureInputs();
    this.managing = !this.managing;
    cx.notify();
  }

  setSettingsTab(tab, cx) {
    this.ensureInputs();
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
        delete this.testResult[id];
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
    const usageData = bar.showTokens ? ccusage() : null;
    const snap = snapshot();
    const fetched = snap?.fetched_at;
    const failedCount =
      list.filter((provider) => provider.stale || provider.error).length +
      (usageData?.stale ? 1 : 0);
    const busy = isBusy();
    const next = nextRefreshMs(settings, fetched);

    const enabled = enabledSet();
    const manageBody =
      this.settingsTab === "credentials"
        ? credentialsSection(this, t)
        : this.settingsTab === "refresh"
          ? refreshSection(t, settings, next)
          : this.settingsTab === "alerts"
            ? alertsSection(t, alerts)
            : this.settingsTab === "bar"
              ? barSection(t, bar, usageData)
              : providersSection(this, t, all, settings, enabled);

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
          }, usageData)
        : empty;

    const status = busy
      ? "Refreshing…"
      : fetched
        ? [
            `${failedCount ? "Checked" : "Updated"} ${clockTime(fetched)}`,
            failedCount ? `${failedCount} update${failedCount === 1 ? "" : "s"} failed` : null,
            settings.manual ? "manual refresh" : next === null ? null : `next in ${duration(next)}`,
          ]
            .filter(Boolean)
            .join(" · ")
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
          h_flex().w_full().min_w(0).flex_none().gap(2).border_b(1).border_color(t.border).children(list.map((provider) => tab(this, provider, selected, bar, t))),
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
          .when(this.managing, (el) =>
            el.child(div().text_color(t.dim).text_size(10).tooltip("Scroll for more").child("↕ scroll")),
          )
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
