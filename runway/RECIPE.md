# Runway

Plan usage, pace and reset for every coding-agent subscription, in one line at
the bottom of Herdr. Click a provider to open a dialog with every window, a
pace tick showing how much of the window has already passed, and a forecast
when the current pace runs out before the reset.

![Runway](preview.png)

## What you see

**The status bar** is a 28px strip across the bottom of the window, drawn on
`chrome` with a 1px `border` top edge. From left to right:

- A 12px refresh glyph in a 6×2px rounded button. It spins while a read is in
  flight.
- One item per enabled provider, separated by a 1×12px `border` divider. Each
  item is a 6×2px rounded hover target with a 13px provider mark, the primary
  selected bar window's percentage at 12px semibold, and a 28×4px mini meter.
  The meter's
  track is `foreground` at 16% opacity; its fill is `accent` below 75%,
  `working` from 75%, `blocked` from 95%.
- A blocked provider shows a `blocked` `!` instead of a meter. A provider whose
  last read is more than two refresh intervals old dims to 55% opacity.
- A dim `»` opens the dialog.
- The rest of the row is empty, so the bar can sit beside `workspace-status`.

The bar's empty state says `Runway ···`; clicking it opens the dialog.

**The dialog** is 520px wide and as tall as its content, on `popover` with
16px padding and 12px gaps. Top to bottom:

- Header: `Runway` at 15px semibold, a 28px settings button, and a 28px close
  button. In settings the title becomes `Settings` and the settings button
  becomes an accent `Done` chip.
- A tab row: each tab has a 14px mark, the short provider name only when
  active, and the primary percentage. The active tab has a 2px `accent`
  underline across the full tab width. A blocked provider shows `!`.
- Body: one provider. The provider header has an 18px mark, its name at 15px
  semibold, and a small `raised` plan badge. Each window is a `raised` card with
  a 1px `border`, 8px radius and 12px padding:
  - Top line: window name (`5-hour`, `Weekly`, `Monthly`, or the collector's
    label), the dollar pair when the window reports money, and the headline
    percentage or dollar amount at 18px semibold.
  - A 10px track holding a 6px bar. A 2px `foreground` tick marks how much of
    the window's time has passed.
  - A bottom line: `Resets in 3h 32m · 8:02 PM` on the left; on the right,
    either `29% of window passed` or `Limit in ~2h 25m at this pace` in
    `working` when the current rate runs out before the reset.
- A blocked provider replaces the cards with a `blocked` card tinted at 10%,
  carrying the error, the action, and the collector's failure detail.
- A provider with history adds a `History · <window>` card: `24h`/`7d` chips,
  a 56-bar sparkline, the point count, and `Burn +x.x%/h · projected N% by
  reset`. With fewer than two points it says `History builds as Runway
  refreshes.`
- Claude, Codex, OpenCode and Kimi add a `Tokens · API-equivalent` card when
  ccusage has data: `Today`/`7d`/`30d` token and cost rows, up to three top
  models, and Claude's latest `5h block` with active/ended. With multiple
  accounts it says `all accounts`.
- **OMP Stats** is a stats-only tab, not a quota provider. It reads OMP's local
  dashboard API for `24h`/`7d`/`30d` and shows Overview, Models, Folders, and
  Errors cards. `Open dashboard` launches
  `http://127.0.0.1:3847/#/overview`. The tab is hidden until the API returns
  at least one range.
- Footer: `Updated 4:30 PM · next in 4m` (or `manual refresh`) and a Refresh
  button with a 12px glyph that spins while busy.

**Settings** replaces the body with five tabs: `Providers`, `Credentials`,
`Refresh`, `Alerts` and `Bar`.

- `Providers`, with one row per known provider: mark, name, plan, current
  reading, `↑`/`↓` order chips, an interval chip, and a 34×20px switch. Off
  rows are dimmed.
- `Credentials`, grouped by Claude Code, OpenCode Go and Kenari. A group
  header has the mark, the provider name, the account count and `+ Account`.
  Each account row has the label, the last read's source and HTTP status, a
  `Saved`/`Not set` status, a 30px masked input, `Show`, `Test`, `Save`, and
  (when saved) `Clear`. Extra rows add a label input with `Rename` and a
  `Remove` chip. A test result appears under the input. A footnote says extra
  accounts need their own key, names `quota-axi` for the four non-key
  providers, and names the key file. The settings body scrolls when it grows.
- `Refresh`, with chips `5m 10m 15m 30m 60m | Manual`. The active chip has an
  `accent` border and an 18% `accent` fill. The hint reads
  `Every 5 minutes · next in 3m` or `Reads only when you press Refresh.`
- `Alerts`, with rows for Notifications On/Off, Warn at 75/80/90, Critical at
  90/95/100, Forecast On/Off, Window reset On/Off, Snooze 1h, and Send test.
- `Bar`, with Window chips `Primary 5h Week Month Worst`, Show chips
  `All Critical Worst`, Hide unconfigured On/Off, and Token estimates On/Off.

## How it behaves

- Clicking a provider item in the bar stores that provider id and opens the
  dialog on its tab. Clicking `»` opens the last selected provider.
- Clicking a tab switches provider and remembers it. `←`/`→` step through the
  enabled providers; `1`–`9` select by position; `R` refreshes; `S` toggles
  settings. `Esc` closes the dialog through Herdr's own overlay handling.
- Hovering a provider item shows its name, plan, every window, and each reset.
  Hovering the pace tick says how much of the window has passed.
- The Refresh button runs the same read as the bar's refresh glyph. A read
  updates the snapshot, clears the busy flag, and re-renders every mod.
- Saving a credential writes `~/.config/herdr-app/runway-keys.json` with mode
  `600`, clears the input, marks the row `Saved`, and runs one refresh.
  Clearing deletes that account's entry and runs one refresh; the default
  account falls back to the tool's own sign-in, an extra account reports
  `missing_key`. **Test** does not save: it writes the pasted value to a
  short-lived `runway-test-*.json` (mode 600), runs the helper with
  `--key-id <instance> --only-key`, shows the helper's answer under the input,
  and deletes the file.
- **+ Account** creates an id `<base>:<random>` and a default label
  `Account N`, adds it to `runway.enabled`, and runs one refresh. An extra
  account has no fallback: its collector gets `--only-key`, so it shows
  `missing_key` until a key is saved. **Rename** updates the shared label and
  refreshes; **Remove** drops the account, its key entry, its enabled id and
  its dialog inputs, then refreshes so the bar prunes it.
- A saved key overrides every automatic source. With no saved key, Claude
  reads `CLAUDE_CODE_OAUTH_TOKEN`, then Claude Code's credential file, then
  OMP's latest enabled `anthropic` OAuth credential in
  `~/.omp/agent/agent.db`, then an OAuth `anthropic` entry in OpenCode's
  `auth.json`. OpenCode reads its SQLite
  OAuth login, then `auth.json`, then OMP's `models.yml`, then
  `OPENCODE_GO_API_KEY`. Kenari reads `KENARI_API_KEY`, then
  `~/.kenari/credentials.json`, then `models.yml`.
- OpenCode keys and `auth.json` entries use
  `https://opencode.ai/zen/go/v1/usage` and return percentages only. The SQLite
  OAuth login keeps using the Console endpoint, so its dollar figures stay.
- Saving a key for a provider that is off writes the key but skips the read;
  the row says `Saved` and the provider stays hidden.
- ccusage runs separately from the quota read: on start, after every quota
  refresh, and every 15 minutes. It never sets `runway.busy`, so a slow
  ccusage cannot hold the bar. Missing ccusage or a failed run is stored as
  `runway.ccusage.error` and hides the card; the quota numbers stay. Token
  estimates can be turned off in Bar.
- OMP stats runs separately every five minutes and on dialog open when no data
  exists. It reads `127.0.0.1:3847` only; a failed read keeps the previous
  ranges and marks them stale. The helper falls back to `omp stats --json` for
  the 24h range when the dashboard is not running.
- Every successful read appends one normalized point per provider to
  `~/.config/herdr-app/runway-history.json`: timestamp plus each window's
  percentage (and the money pool's percentage). Points older than seven days
  are dropped and each provider keeps at most 2016. Identical points within 90
  seconds are skipped. The dialog reloads the file on open and every five
  minutes.
- Alerts fire once per provider, window and threshold until that window resets.
  A window that crosses 95% sends the critical toast only; the warn threshold
  is marked as already sent. Forecast alerts fire once per window when the
  current pace reaches 100% before reset. Reset alerts fire when `resets_at`
  changes. Snooze mutes all Runway toasts for an hour; the alert state is kept
  in the bar's `localStorage`, not shared state.
- Auto refresh is 5 minutes by default and never below 5. Each provider can
  override it from the Providers tab: the interval chip cycles
  Auto/5/10/15/30/60 minutes, and Auto follows the global setting. Reads run
  in parallel, so one slow provider does not hold the others. `Manual`
  disables periodic reads; the dialog still refreshes on demand.
- Turning a provider off hides it from the bar and tabs and **skips its
  collector entirely**. Its last record stays in the snapshot as a placeholder
  so the row can be turned back on; turning it on triggers one immediate read.
- The `↑`/`↓` chips in Providers move a provider in the bar and tabs. The
  order is shared, so the dialog and bar agree.
- `Bar` chooses the window used by the bar and tab suffixes, and the density
  mode. `Worst` picks the highest usage and ignores error records unless every
  provider is erroring. `Hide unconfigured` removes `not_signed_in` and
  `auth_required` records.
- A failed read replaces that provider's data with an error record; other
  providers keep their data. The bar shows `!`; the dialog shows the error card.
  When a previous reading exists, the old numbers stay and the failure moves to
  a stale notice with last success and next retry.
- A `rate_limited` source backs off: 15m, then 30m, then 60m, and is skipped by
  scheduled reads until the deadline. Manual Refresh bypasses it once. A success
  clears the backoff. The stale record carries `stale_retry_at`.
- Claude records also carry `credential_expires_at` from the selected source
  (Claude Code file or OMP `agent.db`). The provider card and credential row
  show it, so an expiring OMP token is visible before it fails.
- Claude's `limits` array uses `percent` (older buckets use `utilization`).
  `weekly_scoped` entries name their model in `scope.model.display_name`; each
  becomes `seven_day_<slug>` with that display name as its label (for example
  `seven_day_fable`, "Fable"). New scoped names appear automatically.
- Windows with no reset time show `No reset time`. Providers with no reading
  show `No reading yet.` A provider that reports dollars but no percentage gets
  its percentage from `used_usd / limit_usd`.

## Built from

Two mods, installed together:

- `mods/runway/` — the status-bar mod. `main.js` owns the snapshot, the
  schedule, the collectors, and the bar. `merge.js` keeps the last good
  reading when an update fails. `format.js` holds the shared formatting,
  pace math, and settings helpers. `mod.json` is
  `{ "place": "none", "size": 28 }`.
- `mods/runway-detail/` — the dialog. `main.js` owns state, keyboard handling
  and composition; `cards.js` draws window/history/token cards; `settings.js`
  draws Providers/Credentials/Refresh/Alerts/Bar; `metadata.js` derives lookup
  tables from `providers.js`. Its own `format.js` copy must stay identical to
  the bar's. `mod.json` is
  `{ "place": "none", "size": 28, "overlay": { "width": 520 } }`.

`format.js` lives at `runway/shared/format.js`; `scripts/sync-format.sh`
copies it into both mod folders because a mod cannot import from outside its
own folder. Keep the two copies byte-identical. `scripts/check.sh` verifies
both shared copies, runs `py_compile`, `unittest`, `node --check` and
`node --test`; CI runs it on every push.

Provider ids, names, logos, helpers, credential hints and ccusage agents live
in `runway/shared/providers.js`. `scripts/sync-providers.sh` copies it into
both mod folders because a Herdr mod cannot import outside its own folder; the
two copies must stay byte-identical. The dialog derives `LOGOS`,
`SHORT_NAMES`, `HELPERS`, `CREDENTIAL_BASES` and `CCUSAGE_AGENTS` from that
file in `metadata.js`.

The bar reads providers with `exec` on `python`/`python3`/`py`, one helper per
provider account (and one quota-axi call for its four providers):

- `runway_keys.py` — reads one provider's entry, or one account entry by
  `--key-id`, from Runway's key file; a missing or malformed file is not an
  error.
- `collect_claude.py` — reads a saved token, `CLAUDE_CODE_OAUTH_TOKEN`, Claude
  Code's `.credentials.json`, OMP's enabled `anthropic` OAuth credential in
  `~/.omp/agent/agent.db`, or an OAuth `anthropic` entry in OpenCode's
  `auth.json`; calls `https://api.anthropic.com/api/oauth/usage`.
- `collect.py` — reads a saved key, OpenCode's SQLite `credential` table,
  `~/.local/share/opencode/auth.json`, `~/.omp/agent/models.yml`, or
  `OPENCODE_GO_API_KEY`. API keys call
  `https://opencode.ai/zen/go/v1/usage`; the SQLite OAuth login calls
  `https://opencode.ai/console/api/go/status`.
- `collect_ccusage.py` — runs `ccusage daily --json --offline --by-agent
  --since <30d>` and `ccusage blocks --json --offline`, then prints per-agent
  totals and Claude's latest block. It is optional; a missing binary is a
  readable error, not a quota failure.
- `collect_omp_stats.py` — reads OMP's local dashboard API for
  `overview`, `model-dashboard`, `folders`, and `errors` at 24h/7d/30d. It
  strips session paths and messages from error rows. If the dashboard is down,
  it falls back to `omp stats --json` for 24h.
- `collect_kenari.py` — reads a saved key, `KENARI_API_KEY`,
  `~/.kenari/credentials.json`, or the `kenari` block in
  `~/.omp/agent/models.yml`; calls `https://kenari.id/v1` (or
  `KENARI_BASE_URL`).
- `collect_quota_axi.py` — runs `quota-axi`, `QUOTA_AXI_BIN`, or a pinned `npx -y quota-axi@0.1.69` with
  `--provider codex,agy,kimi,commandcode --json`, filtered to the enabled
  providers.

Every helper answers `--json` with
`{ provider|id, name|title, plan, windows[], money, period_ends_at, error,
code, action, failure, source, http_status }`. `source` names the credential
route used (`saved key`, `Claude Code credentials`, `OpenCode Console login`,
`OMP models.yml`, `quota-axi`, and so on); `http_status` is the last HTTP code
when there was one. The bar normalizes that to
`{ id, name, plan, windows, money, period_ends_at, updated, error, code, action,
failure, source, http_status }`.

Herdr functions used: `shared`, `setShared`, `exec`, `appHome`, `openOverlay`,
`closeOverlay`, `props`, `run`, `nextCommand`, `theme`, `readTextFile`,
`writeTextFile`, `notify`. GPUI pieces: `View`, `div`, `svg`, `h_flex`,
`v_flex`, `Input`, `InputState`, `cx.timer`, `cx.spawn`, `cx.focus_handle`,
`track_focus`, `on_key_down`.

The credential file is:

```json
{
  "claude": "eyJ...",
  "claude:work": "eyJ...",
  "opencode-go": "oc_sk_...",
  "kenari": "sk-..."
}
```

It lives outside the mod folders, so a mod update never overwrites it. The bar
passes `--keys-file <path>` to the three helpers that accept it; keys never
appear in argv or shared state.

Shared state:

- `runway.snapshot` — `{ fetched_at, providers[] }`
- `runway.settings` — `{ refresh_minutes, manual_only, provider_minutes }`;
  `provider_minutes` is a map from provider id to minutes, absent means global.
- `runway.alerts` — `{ enabled, warn, critical, forecast, reset, snooze_until }`.
- `runway.bar` — `{ window, mode, hide_unconfigured }`.
- `runway.order` — provider ids in bar/tab order; absent means snapshot order.
`backoff.js` holds the 15m/30m/60m cap used by the bar.
- `runway.ccusage` — `{ fetched_at, agents, error?, code?, failure? }`.
  `agents` is keyed by ccusage agent (`claude`, `codex`, `opencode`, `kimi`,
  ...); each has `today`, `week`, `month` (`tokens`, `cost_usd`), `models[]`,
  and Claude may have `block`. Shared state therefore also carries agent and
  model names, not only numbers.
- `runway.ompstats` — `{ fetched_at, source, ranges, error?, code?, action?,
  failure?, stale? }`. `ranges` is keyed by `24h`/`7d`/`30d`; each has
  `overview`, `models[]`, `folders[]`, and `errors`. It contains aggregate
  numbers only, never prompts, session files, or error messages.
- `runway.accounts` — extra accounts keyed by base provider:
  `{ claude: [{ id: "claude:work", label: "Work" }] }`. The default account
  (`claude`) is implicit. Snapshot records carry `base` and `account`.

History is not shared state; it is a JSON file at
`~/.config/herdr-app/runway-history.json`:
`{ version: 1, providers: { id: [{ t, w: { window: percent }, m? }] } }`.
- `runway.busy` — boolean
- `runway.detail.selected` — provider id
- `runway.enabled` — array of provider ids; absent means all

The mod carries a one-time fallback for the enabled list from
`usage-unified.enabled`, the name it used
before it was called Runway.

The status bar belongs in the layout's bottom row. The shape used here:

```json
{
  "id": "footer",
  "type": "row",
  "size": { "px": 28 },
  "children": [
    {
      "id": "usage",
      "type": "block",
      "size": { "weight": 1.35 },
      "min": 340,
      "content": { "mod": "runway" }
    },
    {
      "id": "status",
      "type": "block",
      "size": { "weight": 1 },
      "content": { "mod": "workspace-status" }
    }
  ]
}
```

If the layout has no footer row, add one at the end of the root column with a
28px height and put the `runway` block in it. The detail mod is never placed in
a layout; the bar opens it with `openOverlay`.

## Watch out

- **Both folders are required.** `runway-detail` is not optional: the bar's
  `openOverlay` names it.
- The folder names are load-bearing. `runway` appears in the layout's
  `content.mod`, `MOD_DIR`, `MOD_PATH`, `DETAIL_MOD`, `ASSETS`, the overlay
  name, and the shared keys. Renaming one without the others breaks the bar.
- The bar must be a block in a layout; it is not a floating overlay. Its
  `mod.json` only declares `place` and `size`.
- `format.js` exists twice. Edit one, copy it to the other.
- The app rewrites `gpui-kit.d.ts` and `jsconfig.json` on start; they are not
  shipped.
- The dialog's keys need the dialog to hold focus. The mod creates a focus
  handle in `init`, tracks it on the root, and focuses it after 80ms. Older
  app versions without `track_focus`/`on_key_down` will still draw and click,
  but the keys may do nothing. `Esc` is Herdr's, not the mod's.
- The pace tick only appears for known window keys: `five_hour`, `fiveHour`,
  `seven_day`, `week`, `month`. `month` is treated as 30 days. Unknown keys
  still get a bar and reset line, just no pace tick.
- The runout forecast is suppressed until 10% of the window has passed, and
  only shows when 100% would be reached before the reset.
- Claude's usage endpoint can rate-limit repeated reads. The 5-minute default
  and `Manual` exist for that. A rate-limited read is an error card, not stale
  numbers.
- The collectors read local credentials. They never print tokens, but they do
  reach the network: Anthropic, OpenCode, Kenari, and pinned `npx` for `quota-axi`.
  Say so before installing.
- A saved key is plaintext on disk with mode `600`, like
  `~/.kenari/credentials.json`. Anyone who can read the user's home can read
  it. `chmod` is skipped on Windows, where the profile ACL applies. The Test
  temp file is mode `600` and is deleted in `finally`, even when the helper
  fails.
- A manual Refresh ignores backoff by design; repeated manual presses during a
  429 can extend the next delay. The bar's scheduled reads stay skipped.
- OMP's stats API is internal and unauthenticated. Runway hardcodes
  `127.0.0.1:3847`; do not expose that port through a proxy or tunnel. The
  fallback `omp stats --json` syncs session files and is slower than the API.
- ccusage cost is an API-price estimate, not the subscription bill. `--offline`
  uses cached pricing, so unknown models can show `$0.00`. ccusage knows
  agents, not Runway account instances; multi-account cards say `all accounts`.
- `ccusage opencode` can be empty even when the OpenCode quota API has data;
  the card is hidden for that provider. Kenari, Antigravity and Command Code
  have no ccusage agent.
- Extra accounts are only for the three key providers. `quota-axi` owns the
  other four sign-ins, so they have no `+ Account`; adding a fake account
  would only duplicate one result.
- `runway.accounts` is shared state, so the bar and dialog agree. Removing an
  account prunes its snapshot record on the next refresh; its old history
  points stay in the history file until the seven-day cutoff.
- Claude's field is an **OAuth token**, not an Anthropic API key. The collector
  rejects `sk-ant-api...` before a request; subscription usage cannot be read
  with an API key. OMP's `agent.db` is opened read-only; a disabled or expired
  OMP credential is skipped, and an expired one asks the user to open OMP once
  so OMP refreshes it.
- OpenCode's `auth.json` can hold an expired key while the SQLite OAuth login
  still works. The collector tries SQLite first, then `auth.json`, so an
  expired saved key does not hide a working login. A saved Runway key is
  explicit and wins; if it is expired the row shows `api_key_expired`.
- Codex, Antigravity, Kimi and Command Code have no key field because
  `quota-axi` owns their auth. A raw key pasted for them would not be used.
- `quota-axi` is optional. Without it, Codex, Antigravity, Kimi and Command Code
  show their sign-in/install errors; Claude, OpenCode and Kenari still work.
- The busy flag lives in shared state. If the bar is killed mid-read, the next
  start's first read clears it; a killed process can leave `Refreshing…` until
  then.
- A helper gets 25 seconds; a timeout becomes an error card and the other
  providers still publish. The underlying process may keep running, but its
  result is ignored.
- The preview is composed from two real screenshots (the dialog and the bar)
  on a clean background; it is not drawn by the mod.
- History is an honest 0–100% scale, so a 12% window looks nearly flat. It is
  not auto-scaled to the range. A malformed or unreadable history file is
  replaced on the next read; the live numbers are unaffected.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/runway` and
  `herdr-app check ~/.config/herdr-app/mods/runway-detail` both pass.
- `herdr-app status` reports no mod errors after adding the block.
- The layout shows a 28px bar with the refresh glyph, one item per enabled
  provider, a percentage, a mini meter, and `»`.
- Clicking a provider opens the dialog on that provider; the tab underline and
  header match.
- The dialog shows one card per window, a reset line without seconds, and a
  pace tick; a window on track to run out shows `Limit in ~… at this pace`.
- Settings opens from the gear, switches a provider off, and the bar loses that
  item. A read while it is off does not run that provider's collector.
- Credentials shows three groups with one default account each; saving a key marks it `Saved`, writes
  `~/.config/herdr-app/runway-keys.json` with mode `600`, and refreshes that
  provider. Clearing removes the entry and returns to automatic detection.
- A Claude `sk-ant-api...` value is rejected as the wrong credential type. An
  expired OpenCode key reports `api_key_expired` with the Console action.
- Each credential row shows the source and HTTP status of the last read.
  **Test** with a valid key says `Valid`; a bad key shows the helper error and
  code, and leaves no `runway-test-*.json` behind.
- `+ Account` adds a labelled row and a second tab/bar item. Saving the same
  Kenari key under `kenari:test` shows `source: saved key` and a second `K`
  item; Remove deletes the key entry, the snapshot record and the enabled id.
- Turning it back on runs one read and restores the item.
- Changing Auto refresh to `Manual` stops periodic reads; Refresh still works.
- The interval chip on a provider row cycles Auto/5/10/15/30/60 and the choice
  survives a restart.
- Settings shows the five tabs and the Send test toast appears. Crossing a
  threshold writes `warn`/`critical` into `data/runway/store.json` and does not
  repeat on the next refresh.
- Bar changes the window and density; `Worst` shows one provider and `Critical`
  falls back to the highest when nothing crosses the warn threshold.
- After two refreshes the History card shows a sparkline and a burn/projection
  line; `7d` switches the range and the point count changes.
- With ccusage installed, Claude/Codex shows a Tokens card with Today/7d/30d,
  top models, and Claude's 5h block. Token estimates Off hides it and stops
  the scheduled ccusage read.
- The `↑`/`↓` chips reorder the bar and survive a restart.
- A provider with a bad credential shows `!` in the bar and an error card in
  the dialog, while the other providers still show their numbers.
