"""Quota windows for several agents through quota-axi.

One helper for providers that quota-axi already knows: Codex, Antigravity,
Kimi and Command Code. It prints a JSON array in the same normalized shape as
the other usage helpers, so the bar and its dialog need no provider-specific
code.

quota-axi is optional: a global install is preferred, npx is the fallback.
No credential is printed or stored here; quota-axi reads the providers' own
local auth stores.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

PROVIDERS = [
    ("codex", "Codex"),
    ("agy", "Antigravity"),
    ("kimi", "Kimi"),
    ("commandcode", "Command Code"),
]
PROVIDER_NAMES = dict(PROVIDERS)
WINDOW_LABELS = {
    "five_hour": "5h",
    "fiveHour": "5h",
    "session": "5h",
    "weekly": "week",
    "seven_day": "week",
    "week": "week",
    "monthly": "month",
    "month": "month",
}
TIMEOUT = 35


def _text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and number >= 0 else None


def _window(raw):
    if not isinstance(raw, dict):
        return None
    remaining = _number(raw.get("percentRemaining"))
    used = _number(raw.get("percentUsed"))
    if used is None and remaining is not None:
        used = max(0.0, min(100.0, 100.0 - remaining))
    if used is None:
        return None
    key = _text(raw.get("id")) or _text(raw.get("key")) or "window"
    kind = _text(raw.get("kind")) or ""
    label = (
        WINDOW_LABELS.get(key)
        or WINDOW_LABELS.get(kind)
        or _text(raw.get("label"))
        or key.replace("_", " ")
    )
    return {
        "key": key,
        "label": label,
        "percent": used,
        "resets_at": _text(raw.get("resetsAt")) or _text(raw.get("resets_at")),
    }


def _error(provider, name, message, code="unavailable", action=None):
    return {
        "id": provider,
        "name": name,
        "plan": None,
        "windows": [],
        "money": None,
        "error": message,
        "code": code,
        "action": action,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def _normalize(provider, name, raw):
    if not isinstance(raw, dict):
        return _error(provider, name, "quota-axi returned no provider data.", "reader_error")
    windows = []
    for item in raw.get("windows") or []:
        window = _window(item)
        if window:
            windows.append(window)
    state = raw.get("state") if isinstance(raw.get("state"), dict) else {}
    error = _text(state.get("error"))
    status = _text(state.get("status")) or ""
    if not windows and (error or status in {"auth_required", "unavailable", "error"}):
        action = None
        if status == "auth_required":
            action = f"Sign in to {name}, then refresh."
        elif status == "unavailable":
            action = f"Start or install {name}, then refresh."
        return _error(provider, name, error or f"{name} has no quota data.", status or "unavailable", action)
    if not windows:
        return _error(provider, name, f"{name} reported no usage windows.", "no_quota")
    return {
        "id": provider,
        "name": name,
        "plan": _text(raw.get("plan")),
        "windows": windows,
        "money": None,
        "error": None,
        "code": None,
        "action": None,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def _command():
    if shutil.which("quota-axi"):
        return ["quota-axi"]
    if shutil.which("npx"):
        return ["npx", "-y", "quota-axi"]
    return None


def requested_providers():
    """Providers named by --providers a,b,c; None means all of them."""
    for index, arg in enumerate(sys.argv[1:]):
        if arg == "--providers":
            value = sys.argv[index + 2] if index + 2 < len(sys.argv) else ""
            return [item.strip() for item in value.split(",") if item.strip()]
        if arg.startswith("--providers="):
            return [item.strip() for item in arg.split("=", 1)[1].split(",") if item.strip()]
    return None


def _run(providers):
    if not providers:
        return []
    command = _command()
    if not command:
        message = "quota-axi is not installed."
        return [
            _error(provider, name, message, "no_quota_axi", "Install quota-axi or npx.")
            for provider, name in providers
        ]
    args = command + [
        "--provider",
        ",".join(provider for provider, _ in providers),
        "--json",
    ]
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            env=os.environ.copy(),
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return [
            _error(provider, name, f"quota-axi could not run: {error}.", "reader_error")
            for provider, name in providers
        ]
    text = (result.stdout or "").strip()
    try:
        payload = json.loads(text)
    except (TypeError, ValueError):
        detail = (result.stderr or "").strip().splitlines()
        message = detail[-1] if detail else "quota-axi returned no JSON."
        return [
            _error(provider, name, message[:240], "reader_error")
            for provider, name in providers
        ]
    entries = payload.get("providers") if isinstance(payload, dict) else None
    by_id = {
        str(item.get("provider")): item
        for item in entries or []
        if isinstance(item, dict) and item.get("provider")
    }
    return [
        _normalize(provider, name, by_id.get(provider))
        for provider, name in providers
    ]


def selected_providers():
    requested = requested_providers()
    if requested is None:
        return PROVIDERS
    wanted = set(requested)
    return [pair for pair in PROVIDERS if pair[0] in wanted]


def main():
    records = _run(selected_providers())
    print(json.dumps(records, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
