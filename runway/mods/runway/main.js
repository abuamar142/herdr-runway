// Agent plan usage in Herdr's bottom bar.
//
// Each provider has a small Python helper; quota-axi covers Codex,
// Antigravity, Kimi and Command Code in one call. The bar shows one primary
// window per enabled provider and opens the detail dialog for the rest.
// Credentials stay in the helpers; only normalized numbers are published.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appHome, exec, nextCommand, openOverlay, setShared, shared, theme } from "herdr";
import {
  BUSY_KEY,
  SELECTED_KEY,
  SNAPSHOT,
  barColor,
  countdown,
  meterPercent,
  primaryWindow,
  providers,
  refreshSettings,
  share,
  snapshot,
  tint,
  usageColor,
  windowLabel,
} from "./format.js";

const TICK_MS = 60000;
const HOSTS = ["python", "python3", "py"];
const TITLE = "Runway";
const ENABLED_KEY = "runway.enabled";
const MOD_DIR = "runway";
// svg() resolves against the app config dir, so the `mods/` prefix is required.
const MOD_PATH = `mods/${MOD_DIR}`;
const DETAIL_MOD = "runway-detail";

// The order here is the order in the bar. Each helper answers with its own JSON
// and may also answer with a readable error; both are normalized below. `logo`
// is the file in this folder drawn in place of the provider name.
const SOURCES = [
  { id: "claude", name: "Claude", helper: "collect_claude.py", logo: "claude.svg" },
  { id: "opencode-go", name: "OpenCode", helper: "collect.py", logo: "opencode.svg" },
  { id: "kenari", name: "Kenari", helper: "collect_kenari.py", logo: "kenari.svg" },
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

function failed(source, error, code, action, detail) {
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

export default class AgentUsage extends View {
  init(_given, cx) {
    this.busy = false;
    this.host = null;
    this.lastRefresh = 0;
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

  helper(source) {
    return `${appHome()}/mods/${MOD_DIR}/${source.helper}`;
  }

  async runHelper(source) {
    const args = [this.helper(source), "--json"];
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

  normalizeSource(source, parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return failed(source, "The usage helper returned no readable JSON.", "reader_error");
    }
    const id = typeof parsed.id === "string" && parsed.id ? parsed.id : source.id;
    const name = typeof parsed.name === "string" && parsed.name ? parsed.name : source.name;
    if (parsed.error) {
      return failed({ id, name }, parsed.error, parsed.code, parsed.action, parsed.failure);
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
    };
  }

  maybeRefresh(cx) {
    const settings = refreshSettings();
    if (settings.manual) return;
    if (Date.now() - this.lastRefresh >= settings.minutes * 60000) this.refresh(cx);
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    setShared(BUSY_KEY, true);
    this.lastRefresh = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      const enabled = enabledSet();
      const byId = new Map(providers().map((provider) => [provider.id, provider]));
      for (const source of SOURCES) {
        if (!source.multiple && enabled && !enabled.has(source.id)) continue;
        const result = await this.readSource(source);
        if (!result) continue;
        const records = Array.isArray(result) ? result : [result];
        for (const record of records) byId.set(record.id, record);
      }
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
          });
        }
      }
      this.busy = false;
      setShared(BUSY_KEY, false);
      setShared(SNAPSHOT, { fetched_at: new Date().toISOString(), providers: [...byId.values()] });
      cx.notify();
    });
  }

  openDetails() {
    openOverlay({ mod: DETAIL_MOD, kind: "dialog", width: 520 });
  }

  render(cx) {
    const t = theme();
    const enabled = enabledSet();
    const list = enabled ? providers().filter((provider) => enabled.has(provider.id)) : providers();
    const settings = refreshSettings();
    const fetched = snapshot()?.fetched_at;
    // A read that is long overdue dims the numbers instead of passing them off as current.
    const stale =
      !settings.manual &&
      fetched &&
      Date.now() - new Date(fetched).getTime() > (settings.minutes * 2 + 1) * 60000;

    const providerItem = (provider) => {
      const logo = logoFor(provider.id);
      const primary = provider.error ? null : primaryWindow(provider);
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
