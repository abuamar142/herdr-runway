import { div } from "gpui-kit";
import { h_flex, Input, v_flex } from "gpui-base";
import { notify, run } from "herdr";
import {
  accountsFor,
  barWindow,
  clockTime,
  duration,
  meterPercent,
  percentLabel,
  primaryWindow,
  providers,
  setAlertsSettings,
  setBarSettings,
  setProviderMinutes,
  setRefreshSettings,
  usageColor,
} from "./format.js";
import { chip, mark, subtitle, toggleSwitch } from "./cards.js";
import { CREDENTIAL_BASES, SHORT_NAMES } from "./metadata.js";

const BAR_MOD = "runway";
const REFRESH_CHOICES = [5, 10, 15, 30, 60];
const INTERVAL_CHOICES = [0, 5, 10, 15, 30, 60];

export function tab(view, provider, selected, bar, t) {
  const active = provider.id === selected;
  const percent = meterPercent(barWindow(provider, bar.window));
  const suffix = provider.error || provider.stale
    ? "!"
    : percent === null
    ? ""
    : percentLabel(percent);
  const name = String(
    SHORT_NAMES[provider.id] ?? provider.name ?? provider.id ?? "",
  );
  return v_flex()
    .id(`runway-tab-${provider.id}`)
    .cursor_pointer()
    .tooltip(String(provider.name ?? provider.id ?? ""))
    .on_click((_event, cx) => view.select(provider.id, cx))
    .child(
      h_flex()
        .items_center()
        .gap(6)
        .px(10)
        .py(8)
        .rounded(6)
        .hover((s) => s.bg(t.raised))
        .child(mark(provider, 14, active ? t.foreground : t.muted))
        .when(
          active,
          (el) =>
            el.child(
              div().text_color(t.foreground).font_semibold().child(name),
            ),
        )
        .when(suffix, (el) =>
          el.child(
            div()
              .text_color(
                provider.error
                  ? t.blocked
                  : provider.stale
                  ? t.working
                  : active
                  ? usageColor(percent, t)
                  : t.dim,
              )
              .child(suffix),
          )),
    )
    .child(
      div().w_full().h(2).rounded_full().when(active, (el) => el.bg(t.accent)),
    );
}

function manageRow(view, provider, index, t, settings, enabled) {
  const on = enabled ? enabled.has(provider.id) : true;
  const percent = meterPercent(primaryWindow(provider));
  const reading = !on
    ? ""
    : provider.error || provider.stale
    ? "!"
    : percent === null
    ? ""
    : percentLabel(percent);
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
    .on_click((_event, cx) => view.toggleProvider(provider.id, cx))
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
        .when(
          plan,
          (el) => el.child(div().text_color(t.dim).text_size(10.5).child(plan)),
        ),
    )
    .child(
      div()
        .text_color(
          provider.error ? t.blocked : provider.stale ? t.working : t.dim,
        )
        .child(reading),
    )
    .child(
      chip(t, `runway-up-${provider.id}`, "↑", false, (_event, cx) => {
        cx.stop_propagation();
        view.moveProvider(provider.id, -1, cx);
      }).tooltip("Move up"),
    )
    .child(
      chip(t, `runway-down-${provider.id}`, "↓", false, (_event, cx) => {
        cx.stop_propagation();
        view.moveProvider(provider.id, 1, cx);
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
}

function setting(t, title, hint, content) {
  return v_flex()
    .w_full()
    .gap(8)
    .child(
      v_flex()
        .gap(2)
        .child(div().text_color(t.foreground).font_semibold().child(title))
        .child(div().text_color(t.dim).text_size(11).child(hint)),
    )
    .child(content);
}

const pickRefresh = (minutes, manual) => (_event, cx) => {
  setRefreshSettings(minutes, manual);
  run(`${BAR_MOD}.notify`);
  cx.notify();
};

function credentialRow(view, item, index, t) {
  const saved = view.savedKeys.has(item.id);
  const input = view.keyInputs[item.id];
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
    live?.credential_expires_at
      ? `token until ${clockTime(live.credential_expires_at)}`
      : "",
    typeof live?.http_status === "number" ? `HTTP ${live.http_status}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const result = view.testResult[item.id];
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
            .when(
              diagnostic,
              (el) =>
                el.child(
                  div().text_color(t.dim).text_size(10).child(diagnostic),
                ),
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
              (_event, cx) => view.removeAccount(item.id, cx),
            ),
          )),
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
                view.labelInputs[item.id]
                  ? Input.new(view.labelInputs[item.id])
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
                view.renameAccount(
                  item.id,
                  view.labelInputs[item.id]?.value(),
                  cx,
                ),
            ),
          ),
      ))
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
            .child(
              Input.new(input).w_full().text_size(12).text_color(t.foreground),
            ),
        )
        .child(
          chip(
            t,
            `runway-key-show-${item.id}`,
            view.keyVisible[item.id] ? "Hide" : "Show",
            false,
            (_event, cx) => view.toggleKeyVisibility(item.id, cx),
          ),
        )
        .child(
          chip(
            t,
            `runway-key-test-${item.id}`,
            view.testing[item.id] ? "Testing…" : "Test",
            false,
            (_event, cx) => view.testKey(item.id, cx),
          ),
        )
        .child(
          chip(
            t,
            `runway-key-save-${item.id}`,
            "Save",
            canSave,
            (_event, cx) => view.saveKey(item.id, cx),
          ),
        )
        .when(saved, (el) =>
          el.child(
            chip(
              t,
              `runway-key-clear-${item.id}`,
              "Clear",
              false,
              (_event, cx) => view.clearKey(item.id, cx),
            ),
          )),
    )
    .when(result, (el) =>
      el.child(
        div()
          .text_color(result.ok ? t.accent : t.blocked)
          .text_size(10.5)
          .child(result.text),
      ));
}

export function providersSection(view, t, all, settings, enabled) {
  return setting(
    t,
    "Providers",
    "Off providers are hidden and never read. The chip cycles one provider's refresh interval; Auto follows the global setting.",
    v_flex()
      .w_full()
      .rounded(8)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .overflow_hidden()
      .children(
        all.map((provider, index) =>
          manageRow(view, provider, index, t, settings, enabled)
        ),
      ),
  );
}

export function credentialsSection(view, t) {
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
              .child(
                div().text_color(t.foreground).font_semibold().child(base.name),
              )
              .child(
                div()
                  .text_color(t.dim)
                  .text_size(10.5)
                  .child(
                    `${instances.length} ${
                      instances.length === 1 ? "account" : "accounts"
                    }`,
                  ),
              ),
          )
          .child(
            chip(
              t,
              `runway-add-${base.base}`,
              "+ Account",
              false,
              (_event, cx) => view.addAccount(base.base, cx),
            ),
          );
        return [
          header,
          ...instances.map((account, index) =>
            credentialRow(
              view,
              {
                ...base,
                id: account.id,
                label: account.label,
                extra: account.id !== base.base,
              },
              index,
              t,
            )
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
  return setting(
    t,
    "Credentials",
    "Saved keys override the tool's own sign-in.",
    v_flex().gap(6).child(credentials).child(credentialsNote),
  );
}

export function refreshSection(t, settings, next) {
  return setting(
    t,
    "Auto refresh",
    settings.manual
      ? "Reads only when you press Refresh."
      : `Every ${settings.minutes} minutes${
        next === null ? "" : ` · next in ${duration(next)}`
      }`,
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
          )
        ),
      )
      .child(div().w(1).h(16).bg(t.border))
      .child(
        chip(
          t,
          "runway-refresh-manual",
          "Manual",
          settings.manual,
          pickRefresh(settings.minutes, true),
        ),
      ),
  );
}

export function alertsSection(t, alerts) {
  const snoozed = alerts.snoozeUntil > Date.now();
  const rows = [
    {
      id: "enabled",
      title: "Notifications",
      hint: "Off stops every Runway toast.",
      content: h_flex()
        .gap(6)
        .child(
          chip(t, "runway-alert-on", "On", alerts.enabled, (_event, cx) => {
            setAlertsSettings({ enabled: true });
            cx.notify();
          }),
        )
        .child(
          chip(t, "runway-alert-off", "Off", !alerts.enabled, (_event, cx) => {
            setAlertsSettings({ enabled: false });
            cx.notify();
          }),
        ),
    },
    {
      id: "warn",
      title: "Warn at",
      hint: "One warning per window.",
      content: h_flex()
        .gap(6)
        .children(
          [75, 80, 90].map((value) =>
            chip(
              t,
              `runway-alert-warn-${value}`,
              `${value}%`,
              alerts.warn === value,
              (_event, cx) => {
                setAlertsSettings({ warn: value });
                cx.notify();
              },
            )
          ),
        ),
    },
    {
      id: "critical",
      title: "Critical at",
      hint: "One error toast per window.",
      content: h_flex()
        .gap(6)
        .children(
          [90, 95, 100].map((value) =>
            chip(
              t,
              `runway-alert-critical-${value}`,
              `${value}%`,
              alerts.critical === value,
              (_event, cx) => {
                setAlertsSettings({ critical: value });
                cx.notify();
              },
            )
          ),
        ),
    },
    {
      id: "forecast",
      title: "Forecast",
      hint: "Warn when the current pace reaches 100% before reset.",
      content: h_flex()
        .gap(6)
        .child(
          chip(
            t,
            "runway-alert-forecast-on",
            "On",
            alerts.forecast,
            (_event, cx) => {
              setAlertsSettings({ forecast: true });
              cx.notify();
            },
          ),
        )
        .child(
          chip(
            t,
            "runway-alert-forecast-off",
            "Off",
            !alerts.forecast,
            (_event, cx) => {
              setAlertsSettings({ forecast: false });
              cx.notify();
            },
          ),
        ),
    },
    {
      id: "reset",
      title: "Window reset",
      hint: "Tell me when a window becomes available again.",
      content: h_flex()
        .gap(6)
        .child(
          chip(t, "runway-alert-reset-on", "On", alerts.reset, (_event, cx) => {
            setAlertsSettings({ reset: true });
            cx.notify();
          }),
        )
        .child(
          chip(
            t,
            "runway-alert-reset-off",
            "Off",
            !alerts.reset,
            (_event, cx) => {
              setAlertsSettings({ reset: false });
              cx.notify();
            },
          ),
        ),
    },
    {
      id: "snooze",
      title: "Snooze",
      hint: snoozed
        ? `Quiet until ${
          clockTime(new Date(alerts.snoozeUntil).toISOString())
        }.`
        : "Mute every alert for one hour.",
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
      content: chip(
        t,
        "runway-alert-test",
        "Send test",
        false,
        () =>
          notify({
            title: "Runway test",
            body: "Notifications are working.",
            level: "info",
          }),
      ),
    },
  ];
  return setting(
    t,
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
                .child(
                  div().text_color(t.foreground).font_semibold().child(
                    row.title,
                  ),
                )
                .child(div().text_color(t.dim).text_size(10.5).child(row.hint)),
            )
            .child(row.content)
        ),
      ),
  );
}

export function barSection(t, bar, usageData) {
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
    t,
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
            .children(
              windowChoices.map(([value, label]) =>
                chip(
                  t,
                  `runway-bar-window-${value}`,
                  label,
                  bar.window === value,
                  (_event, cx) => {
                    setBarSettings({ window: value });
                    cx.notify();
                  },
                )
              ),
            ),
        ),
      )
      .child(
        row(
          "mode",
          "Show",
          "Critical uses the warn threshold; Worst keeps one provider.",
          h_flex()
            .gap(5)
            .children(
              modeChoices.map(([value, label]) =>
                chip(
                  t,
                  `runway-bar-mode-${value}`,
                  label,
                  bar.mode === value,
                  (_event, cx) => {
                    setBarSettings({ mode: value });
                    cx.notify();
                  },
                )
              ),
            ),
        ),
      )
      .child(
        row(
          "unconfigured",
          "Hide unconfigured",
          "Hide providers with no credential instead of an error item.",
          h_flex()
            .gap(6)
            .child(
              chip(
                t,
                "runway-bar-hide-on",
                "On",
                bar.hideUnconfigured,
                (_event, cx) => {
                  setBarSettings({ hideUnconfigured: true });
                  cx.notify();
                },
              ),
            )
            .child(
              chip(
                t,
                "runway-bar-hide-off",
                "Off",
                !bar.hideUnconfigured,
                (_event, cx) => {
                  setBarSettings({ hideUnconfigured: false });
                  cx.notify();
                },
              ),
            ),
        ),
      )
      .child(
        row(
          "tokens",
          "Token estimates",
          usageData?.error
            ? String(usageData.error)
            : usageData?.stale
            ? `Token data is stale: ${usageData.stale_error ?? "update failed"}`
            : "ccusage tokens and API-equivalent cost; all accounts.",
          h_flex()
            .gap(6)
            .child(
              chip(
                t,
                "runway-bar-tokens-on",
                "On",
                bar.showTokens,
                (_event, cx) => {
                  setBarSettings({ showTokens: true });
                  run(`${BAR_MOD}.ccusage`);
                  cx.notify();
                },
              ),
            )
            .child(
              chip(
                t,
                "runway-bar-tokens-off",
                "Off",
                !bar.showTokens,
                (_event, cx) => {
                  setBarSettings({ showTokens: false });
                  cx.notify();
                },
              ),
            ),
        ),
      ),
  );
}
