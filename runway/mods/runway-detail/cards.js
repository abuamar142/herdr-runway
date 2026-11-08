import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  accountsFor,
  barColor,
  baseProvider,
  clockTime,
  countdown,
  duration,
  meterPercent,
  money,
  moneyMeter,
  moneyPair,
  pace,
  primaryWindow,
  share,
  stamp,
  tint,
  usageColor,
  windowLabel,
  windowSpan,
} from "./format.js";
import { CCUSAGE_AGENTS, LOGOS } from "./metadata.js";

export const ASSETS = "mods/runway";
const WINDOW_NAMES = {
  five_hour: "5-hour",
  fiveHour: "5-hour",
  seven_day: "Weekly",
  week: "Weekly",
  month: "Monthly",
};

export function subtitle(provider) {
  const plan = provider?.plan;
  if (typeof plan !== "string" || !plan) return "";
  return (provider.base ?? provider.id) === "opencode-go"
    ? `plan ${plan}`
    : plan;
}

// The provider's mark, tinted by the caller; a letter when there is no logo.
export function mark(provider, size, color) {
  const file = LOGOS[provider.base ?? baseProvider(provider.id)] ??
    LOGOS[provider.id];
  if (!file) {
    const name = String(provider.name ?? provider.id ?? "?");
    return div().text_color(color).text_size(size - 2).font_semibold().child(
      name.slice(0, 1).toUpperCase(),
    );
  }
  return div().text_color(color).child(svg(`${ASSETS}/${file}`).size(size));
}

export function iconButton(t, id, file, hint, onClick, active = false) {
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

export function chip(t, id, label, active, onClick) {
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

export function toggleSwitch(on, t) {
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
  return v_flex().w_full().gap(8).p(12).rounded(8).bg(t.raised).border(1)
    .border_color(t.border);
}

function windowCard(meter, t) {
  const percent = meterPercent(meter);
  const fill = share(percent);
  const color = barColor(percent, t);
  const rate = pace(meter);
  const hasMoney = typeof meter.used_usd === "number" ||
    typeof meter.limit_usd === "number";
  const reset = meter.resets_at
    ? `Resets in ${countdown(meter.resets_at)} · ${stamp(meter.resets_at)}`
    : "No reset time";

  const track = div()
    .relative()
    .w_full()
    .h(10)
    .child(
      div().absolute().top(2).left(0).w_full().h(6).rounded_full().bg(t.hover),
    )
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
      ));

  const note = rate
    ? rate.runout !== null
      ? div().text_color(t.working).text_size(11).child(
        `Limit in ~${duration(rate.runout)} at this pace`,
      )
      : div().text_color(t.dim).text_size(11).child(
        `${Math.round(rate.elapsed)}% of window passed`,
      )
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
        .when(
          hasMoney,
          (el) =>
            el.child(
              div().text_color(t.dim).text_size(11).child(
                moneyPair(meter.used_usd, meter.limit_usd),
              ),
            ),
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
  if (typeof provider.http_status === "number") {
    parts.push(`HTTP ${provider.http_status}`);
  }
  if (provider.updated) parts.push(`Checked ${clockTime(provider.updated)}`);
  if (!parts.length) return null;
  return div().text_color(t.dim).text_size(10.5).child(parts.join(" · "));
}

function errorCard(provider, t) {
  const children = [
    div().text_color(t.blocked).font_semibold().child(String(provider.error)),
  ];
  if (provider.action) {
    children.push(
      div().text_color(t.muted).text_size(11.5).child(String(provider.action)),
    );
  }
  if (provider.failure) {
    children.push(
      div().text_color(t.dim).text_size(10.5).child(String(provider.failure)),
    );
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
    .filter((point) =>
      Number.isFinite(point.t) && Number.isFinite(point.p) &&
      point.t >= now - span
    )
    .sort((a, b) => a.t - b.t);
  const sample = downsample(points, 56);
  const title = `History · ${
    WINDOW_NAMES[primary.key] ?? primary.label ?? key
  }`;
  const rangeChips = h_flex()
    .gap(4)
    .child(
      chip(
        t,
        "runway-history-24h",
        "24h",
        range === "24h",
        (_event, cx) => onRange("24h", cx),
      ),
    )
    .child(
      chip(
        t,
        "runway-history-7d",
        "7d",
        range === "7d",
        (_event, cx) => onRange("7d", cx),
      ),
    );
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
          .child(
            all?.length
              ? "No points in this range yet."
              : "History builds as Runway refreshes.",
          ),
      );
  }

  const reset = primary.resets_at
    ? new Date(primary.resets_at).getTime()
    : null;
  const windowLength = windowSpan(primary.key);
  const windowStart = reset && windowLength ? reset - windowLength : null;
  const windowPoints = windowStart === null
    ? points
    : points.filter((point) => point.t >= windowStart);
  const first = windowPoints[0];
  const last = windowPoints[windowPoints.length - 1];
  const hours = first && last ? (last.t - first.t) / 3600000 : 0;
  const rate = hours > 0.05 ? (last.p - first.p) / hours : null;
  const left = reset && reset > now ? (reset - now) / 3600000 : null;
  const projected = rate !== null && left !== null
    ? Math.max(0, last.p + rate * left)
    : null;
  const projectedLabel = projected === null
    ? ""
    : projected > 100
    ? ">100%"
    : `${Math.round(projected)}%`;
  const note = [
    rate !== null ? `Burn ${rate >= 0 ? "+" : ""}${rate.toFixed(1)}%/h` : "",
    projected !== null ? `projected ${projectedLabel} by reset` : "",
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
              .h(
                Math.max(
                  2,
                  Math.round((Math.max(0, Math.min(100, point.p)) / 100) * 28),
                ),
              )
              .rounded(1)
              .bg(barColor(point.p, t))
          ),
        ),
    )
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(
          div().text_color(t.dim).text_size(10.5).child(
            `${points.length} points`,
          ),
        )
        .child(div().flex_1())
        .when(note, (el) =>
          el.child(
            div()
              .text_color(
                projected !== null && projected >= 100 ? t.working : t.dim,
              )
              .text_size(10.5)
              .child(note),
          )),
    );
}

function compactTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(0)}k`;
  return String(Math.round(number));
}

function ccusageCard(provider, t, data) {
  const base = provider.base ?? baseProvider(provider.id);
  const agentId = CCUSAGE_AGENTS[base];
  if (!agentId) return null;
  const agent = data?.agents?.[agentId];
  if (!agent) return null;
  const stats = [
    ["Today", agent.today],
    ["7d", agent.week],
    ["30d", agent.month],
  ].filter(([, bucket]) => bucket && typeof bucket === "object");
  if (!stats.length) return null;
  const multi = accountsFor(base, base).length > 1;
  const models = (Array.isArray(agent.models) ? agent.models : [])
    .slice(0, 3)
    .map((model) => `${model.model} ${compactTokens(model.tokens)}`)
    .join(" · ");
  const block = agent.block;
  const blockLine = block
    ? `5h block ${compactTokens(block.tokens)} · ~${money(block.cost_usd)} · ${
      block.is_active ? "active" : "ended"
    }`
    : null;
  return card(t)
    .gap(6)
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(
          div().text_color(t.foreground).font_semibold().child(
            "Tokens · API-equivalent",
          ),
        )
        .child(div().flex_1())
        .when(
          multi,
          (el) =>
            el.child(
              div().text_color(t.dim).text_size(10).child("all accounts"),
            ),
        ),
    )
    .child(
      v_flex()
        .w_full()
        .gap(3)
        .children(
          stats.map(([label, bucket]) =>
            h_flex()
              .items_center()
              .gap(8)
              .child(div().w(38).text_color(t.dim).text_size(10.5).child(label))
              .child(
                div().text_color(t.foreground).text_size(11).child(
                  `${compactTokens(bucket.tokens)} tokens`,
                ),
              )
              .child(div().flex_1())
              .child(
                div().text_color(t.dim).text_size(10.5).child(
                  `~${money(bucket.cost_usd)}`,
                ),
              )
          ),
        ),
    )
    .when(models, (el) =>
      el.child(
        div()
          .w_full()
          .truncate()
          .text_color(t.dim)
          .text_size(10)
          .tooltip(models)
          .child(`Top: ${models}`),
      ))
    .when(
      blockLine,
      (el) => el.child(div().text_color(t.dim).text_size(10).child(blockLine)),
    );
}

export function section(provider, t, history, range, onRange, usageData) {
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
        )),
  ];

  if (provider.error) {
    children.push(errorCard(provider, t));
    const usageView = ccusageCard(provider, t, usageData);
    if (usageView) children.push(usageView);
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
          `Paid period ends ${stamp(provider.period_ends_at)} · ${
            countdown(provider.period_ends_at)
          } left`,
        ),
    );
  }
  if (!cards.length && !provider.period_ends_at) {
    children.push(div().text_color(t.dim).child("No reading yet."));
  }
  const historyView = historyCard(provider, t, history, range, onRange);
  if (historyView) children.push(historyView);
  const usageView = ccusageCard(provider, t, usageData);
  if (usageView) children.push(usageView);
  const diagnostic = diagnosticLine(provider, t);
  if (diagnostic) children.push(diagnostic);
  return v_flex().w_full().gap(12).children(children);
}
