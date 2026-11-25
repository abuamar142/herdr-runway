// Provider metadata shared by the bar and the dialog.
// This is the source of truth; scripts/sync-providers.sh copies it into both
// mod folders because a Herdr mod cannot import from outside its own folder.

export const PROVIDERS = [
  {
    id: "claude",
    name: "Claude",
    short: "Claude",
    helper: "collect_claude.py",
    logo: "claude.svg",
    keys: true,
    credential: {
      name: "Claude Code",
      hint: "OAuth token, not an Anthropic API key",
      placeholder: "Paste Claude Code OAuth token",
    },
  },
  {
    id: "opencode-go",
    name: "OpenCode",
    short: "OpenCode",
    helper: "collect.py",
    logo: "opencode.svg",
    keys: true,
    credential: {
      name: "OpenCode Go",
      hint: "API key (oc_sk_... or sk-...)",
      placeholder: "Paste OpenCode Go API key",
    },
  },
  {
    id: "kenari",
    name: "Kenari",
    short: "Kenari",
    helper: "collect_kenari.py",
    logo: "kenari.svg",
    keys: true,
    credential: {
      name: "Kenari",
      hint: "API key",
      placeholder: "Paste Kenari API key",
    },
  },
  {
    id: "kelontong",
    name: "Kelontong AI",
    short: "Kelontong",
    helper: "collect_kelontong.py",
    logo: "kelontong.svg",
    keys: true,
    credential: {
      name: "Kelontong AI",
      hint: "API key (sk-kelontong-…)",
      placeholder: "Paste Kelontong AI API key",
    },
  },
  {
    id: "quota-axi",
    name: "Quota AXI",
    helper: "collect_quota_axi.py",
    multiple: true,
    providers: [
      { id: "codex", name: "Codex", short: "Codex" },
      { id: "agy", name: "Antigravity", short: "Agy" },
      { id: "kimi", name: "Kimi", short: "Kimi" },
      { id: "commandcode", name: "Command Code", short: "Cmd" },
    ],
    logos: {
      codex: "codex.svg",
      agy: "antigravity.svg",
      kimi: "kimi.svg",
      commandcode: "commandcode.svg",
    },
  },
];
