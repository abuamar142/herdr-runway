# Runway

Plan usage, pace and reset for every coding-agent subscription, in one line at
the bottom of [Herdr](https://herdr.dev).

![Runway](runway/preview.png)

Runway is a Herdr mod. The bar shows one item per enabled provider; the dialog
shows every window, a pace tick, and a forecast when the current rate runs out
before the reset.

## Install

Ask your agent:

> Read `~/.config/herdr-app/AGENTS.md`, then add this mod:
> `herdr.dev/mods/abuamar142/herdr-runway/runway`

Or point it at the GitHub folder:

> Read `~/.config/herdr-app/AGENTS.md`, then add this mod:
> `https://github.com/abuamar142/herdr-runway/tree/main/runway`

The agent copies both `mods/runway/` and `mods/runway-detail/` into
`~/.config/herdr-app/mods/`, then adds the bar to the layout's bottom row:

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

Then:

```sh
herdr-app check ~/.config/herdr-app/mods/runway
herdr-app check ~/.config/herdr-app/mods/runway-detail
herdr-app status
```

## Providers

| Provider | Source | Needs |
|---|---|---|
| Claude | Claude Code's local OAuth credential | Claude Code signed in on this machine |
| OpenCode Go | OpenCode Console credential in OpenCode's SQLite database | OpenCode signed in |
| Kenari | `KENARI_API_KEY`, `~/.kenari/credentials.json`, or `~/.omp/agent/models.yml` | A Kenari key |
| Codex | `quota-axi` | `quota-axi` or `npx`; Codex signed in |
| Antigravity | `quota-axi` | `quota-axi` or `npx`; Antigravity running/installed |
| Kimi | `quota-axi` | `quota-axi` or `npx`; Kimi signed in |
| Command Code | `quota-axi` | `quota-axi` or `npx`; Command Code signed in |

Python 3 must be on `PATH` as `python3`, `python`, or `py`.

`quota-axi` is optional. Without it, the four `quota-axi` providers show their
install/sign-in errors and the other three still work.

## Use

- Click a provider in the bar to open the dialog on its tab. Click `»` for the
  last selected provider.
- In the dialog: `←`/`→` step providers, `1`–`9` pick one, `R` refreshes,
  `S` opens settings, `Esc` closes.
- The gear opens settings: switch providers on/off and choose auto refresh
  (5, 10, 15, 30, 60 minutes, or Manual).
- Off providers are not read at all. Their last record stays as a placeholder
  so you can switch them back on; switching one on runs one read.
- Auto refresh defaults to 5 minutes. A manual refresh postpones the next
  scheduled read.

## Privacy

The collectors read credentials that already exist on this machine and use
them only as `Authorization` headers. Tokens are never printed, logged, or
stored by Runway. Only normalized numbers are written to Herdr's shared state.

Network endpoints:

- `https://api.anthropic.com/api/oauth/usage`
- `https://opencode.ai/console/api/go/status`
- `https://kenari.id/v1` (or `KENARI_BASE_URL`)
- `quota-axi` through `npx` when it is not installed globally

The mod runs Python programs with `exec`. Install it only if you trust the
code in `runway/mods/`.

## Uninstall

Remove `~/.config/herdr-app/mods/runway/` and
`~/.config/herdr-app/mods/runway-detail/`, and remove the `runway` block from
the layout. Herdr keeps the `runway.*` shared keys; they are harmless.

## License and marks

MIT. See [LICENSE](LICENSE).

Provider marks belong to their owners. Claude and OpenCode marks come from
Simple Icons (CC0); Codex, Antigravity, Kimi, and Command Code marks come from
Lobe Icons; the Kenari mark is drawn for this mod. This project is not
affiliated with any of those providers.
