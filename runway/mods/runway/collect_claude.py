"""Claude usage from a Claude Code session or a pasted OAuth token.

Reads, in order: a token saved in Runway, ``CLAUDE_CODE_OAUTH_TOKEN``, Claude
Code's own credential file, then an OAuth ``anthropic`` entry in OpenCode's
``auth.json``. It asks the same usage endpoint Claude Code's ``/usage`` view
uses, then reports the plan windows and, when the account reports money instead
of percentages, the dollars.

Usage:
    python collect_claude.py                  # text
    python collect_claude.py --json           # normalized JSON (mod contract)
    python collect_claude.py --config <dir>   # override the Claude config dir
    python collect_claude.py --keys-file <path>  # Runway's saved credentials

Exit codes: 0 success, 2 a known/unavailable condition, 1 unexpected failure.

The token is only ever used as an Authorization header. It is never printed,
logged, stored or included in any output. The refresh token is never touched:
re-authenticating is Claude Code's job.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from runway_keys import read_key as read_runway_key

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
OAUTH_BETA = "oauth-2025-04-20"
PROVIDER = "claude"
TITLE = "Claude"
MAX_BYTES = 1 << 20
TIMEOUT = 10

# The account reports usage either as a `limits` array (current shape, with a
# severity per bucket) or as named buckets (older shape). Both are accepted; the
# array wins when it is present.
LIMIT_LABELS = {
    "session": "5h",
    "weekly_all": "week",
    "weekly_opus": "opus",
    "weekly_sonnet": "sonnet",
    "weekly_oauth_apps": "apps",
}

LIMIT_KEYS = {
    "session": "five_hour",
    "weekly_all": "seven_day",
    "weekly_opus": "seven_day_opus",
    "weekly_sonnet": "seven_day_sonnet",
    "weekly_oauth_apps": "seven_day_oauth_apps",
}

BUCKETS = (
    ("five_hour", "5h"),
    ("seven_day", "week"),
    ("seven_day_opus", "opus"),
    ("seven_day_sonnet", "sonnet"),
    ("seven_day_oauth_apps", "apps"),
)


class Unavailable(Exception):
    """A condition the person can understand and usually act on."""

    def __init__(
        self,
        message: str,
        code: str = "unavailable",
        action: str | None = None,
        status: int | None = None,
        source: str | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.code = code
        self.action = action
        self.status = status
        self.source = source


# --------------------------------------------------------------------------- #
# Formatting helpers
# --------------------------------------------------------------------------- #


def _number(value) -> float | None:
    """A finite, non-negative float, or None. Booleans are not numbers here."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number != number or number < 0 or number > 1e15:  # NaN or absurd
        return None
    return number


def _text(value) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _parse_time(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def countdown(resets_at, now: datetime | None = None) -> str:
    when = _parse_time(resets_at)
    if when is None:
        return "no reset time"
    reference = now or datetime.now(timezone.utc)
    seconds = int((when - reference).total_seconds())
    if seconds <= 0:
        return "reset pending"
    minutes = seconds // 60
    days, hours = minutes // 1440, (minutes // 60) % 24
    if days:
        return f"{days}d {hours}h"
    if minutes >= 60:
        return f"{minutes // 60}h {minutes % 60}m"
    return f"{minutes}m"


def _stamp(resets_at) -> str:
    when = _parse_time(resets_at)
    return when.strftime("%Y-%m-%d %H:%MZ") if when else "unknown"


def _bar(percent, width: int = 10) -> str:
    if percent is None:
        return "·" * width
    filled = max(0, min(width, int(round(percent / 100 * width))))
    full, empty = ("\u2588", "\u2591")
    return full * filled + empty * (width - filled)


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #


def _window(key: str, label: str, bucket) -> dict | None:
    """One window from either shape. None when it carries no usable number."""
    if not isinstance(bucket, dict):
        return None
    percent = _number(bucket.get("utilization"))
    used = _number(bucket.get("used_dollars"))
    limit = _number(bucket.get("limit_dollars"))
    if percent is None and used is None:
        return None
    return {
        "key": key,
        "label": label,
        "percent": percent,
        "resets_at": _text(bucket.get("resets_at")),
        "used_usd": used,
        "limit_usd": limit,
    }


def _minor_to_usd(block) -> float | None:
    """Money from a minor-unit block such as {amount_minor, exponent}."""
    if not isinstance(block, dict):
        return None
    minor = _number(block.get("amount_minor"))
    if minor is None:
        return None
    exponent = _number(block.get("exponent"))
    exponent = 2 if exponent is None else int(exponent)
    if exponent < 0 or exponent > 8:
        exponent = 2
    return minor / (10 ** exponent)


def _spend(payload) -> dict | None:
    """The month's usage-credit spend: what a usage-billed account reports."""
    block = payload.get("spend")
    if not isinstance(block, dict):
        return None
    used = _minor_to_usd(block.get("used"))
    limit = _minor_to_usd(block.get("limit"))
    if used is None and limit is None:
        return None
    return {
        "label": "month",
        "used_usd": used,
        "limit_usd": limit,
        "percent": _number(block.get("percent")),
        "severity": _text(block.get("severity")),
        "enabled": block.get("enabled") is not False,
    }


def _extra_usage(payload) -> dict | None:
    """The credit pool: minor units when the payload says so, dollars otherwise."""
    block = payload.get("extra_usage")
    if not isinstance(block, dict):
        return None
    exponent = _number(block.get("decimal_places"))
    scale = 10 ** int(exponent) if exponent is not None and 0 <= exponent <= 8 else None

    def amount(name):
        value = _number(block.get(name))
        if value is None:
            return None
        return value / scale if scale else value

    used = amount("used_credits")
    limit = amount("monthly_limit")
    if block.get("is_enabled") is not True and used is None:
        return None
    return {
        "label": "extra usage",
        "used_usd": used,
        "limit_usd": limit,
        "percent": _number(block.get("utilization")),
        "severity": None,
        "enabled": block.get("is_enabled") is True,
    }


def normalize(payload, plan: str | None = None) -> dict:
    """Turn a usage payload into the normalized record the bar consumes."""
    if not isinstance(payload, dict):
        raise Unavailable("The usage response was not an object.", "reader_error")

    windows = []
    limits = payload.get("limits")
    if isinstance(limits, list) and limits:
        for entry in limits:
            if not isinstance(entry, dict):
                continue
            kind = _text(entry.get("kind")) or "window"
            label = LIMIT_LABELS.get(kind) or kind.replace("_", " ")
            key = LIMIT_KEYS.get(kind, kind)
            window = _window(key, label, entry)
            if window:
                windows.append(window)
    if not windows:
        for key, label in BUCKETS:
            window = _window(key, label, payload.get(key))
            if window:
                windows.append(window)

    money = _spend(payload) or _extra_usage(payload)

    if not windows and money is None:
        raise Unavailable(
            "Claude reported no usage windows for this account.",
            "no_usage",
            "Open Claude Code and check /usage to confirm this account has usage data.",
        )

    return {
        "provider": PROVIDER,
        "title": TITLE,
        "plan": plan,
        "windows": windows,
        "money": money,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def render_text(record: dict, now: datetime | None = None) -> str:
    reference = now or datetime.now(timezone.utc)
    lines = [f"{TITLE} · {('plan ' + record['plan']) if record.get('plan') else 'account usage'}"]
    lines.append("")
    if not record["windows"]:
        lines.append("This account reports no plan windows; only dollars below.")
    for window in record["windows"]:
        percent = window.get("percent")
        share = f"{percent:.0f}%" if percent is not None else "  n/a"
        used = f"${window['used_usd']:.2f}" if window.get("used_usd") is not None else "n/a"
        limit = f"${window['limit_usd']:.2f}" if window.get("limit_usd") is not None else "no limit"
        lines.append(
            f"{window['label']:<5} {_bar(percent)} {share:>5}  "
            f"used {used} of {limit}  "
            f"resets in {countdown(window.get('resets_at'), reference)} "
            f"({_stamp(window.get('resets_at'))})"
        )
    money = record.get("money")
    if money:
        used = f"${money['used_usd']:,.2f}" if money.get("used_usd") is not None else "n/a"
        limit = (
            f"${money['limit_usd']:,.2f}" if money.get("limit_usd") is not None else "no limit"
        )
        percent = money.get("percent")
        share = f" ({percent:.0f}%)" if percent is not None else ""
        lines.append("")
        lines.append(f"{money['label']}: used {used} of {limit}{share}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Credential
# --------------------------------------------------------------------------- #


def default_config_dir() -> Path:
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".claude"


def _refresh_deadline(oauth) -> str | None:
    """The date the sign-in itself expires, from `refreshTokenExpiresAt`.

    Claude Code writes it as a millisecond stamp; it may also appear as text.
    """
    raw = oauth.get("refreshTokenExpiresAt")
    if isinstance(raw, str):
        raw = raw.strip()
        if not raw.isdigit():
            return None
        raw = int(raw)
    expires = _number(raw)
    if not expires:
        return None
    expires_ms = expires if expires >= 1e11 else expires * 1000
    return datetime.fromtimestamp(expires_ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def _stale_action(oauth) -> str:
    """What to do about a dead access token: nothing about signing in again."""
    action = "Open Claude Code once so it renews that token, then press refresh."
    deadline = _refresh_deadline(oauth)
    if deadline:
        return f"{action} The sign-in itself is good until {deadline}."
    return f"{action} The sign-in itself is still valid."


def default_opencode_auth_path() -> Path:
    base = os.environ.get("XDG_DATA_HOME")
    root = Path(base).expanduser() if base else Path.home() / ".local" / "share"
    return root / "opencode" / "auth.json"


def read_opencode_oauth_token() -> str | None:
    """Read an OAuth anthropic token from OpenCode's auth.json, never an API key."""
    try:
        data = json.loads(default_opencode_auth_path().read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, TypeError):
        return None
    entry = data.get("anthropic") if isinstance(data, dict) else None
    if not isinstance(entry, dict) or entry.get("type") != "oauth":
        return None
    token = _text(entry.get("access"))
    return token


def reject_api_key(token: str) -> None:
    if token.startswith("sk-ant-api"):
        raise Unavailable(
            "That is an Anthropic API key, not a Claude Code OAuth token.",
            "wrong_credential",
            "Paste the Claude Code OAuth token from `claude setup-token` or ~/.claude/.credentials.json.",
        )


def read_claude_file(config_dir=None):
    """Return Claude Code's token data, or None when it has no session."""
    path = (Path(config_dir) if config_dir else default_config_dir()) / ".credentials.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        raise Unavailable(
            "The Claude Code credential file is not readable JSON.",
            "credentials_unreadable",
            "Run `claude auth login` again; Claude Code rewrites that file.",
        ) from None

    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    token = _text(oauth.get("accessToken")) if isinstance(oauth, dict) else None
    if not token:
        return None

    plan = _text(oauth.get("subscriptionType"))
    expires = _number(oauth.get("expiresAt"))
    expired = False
    if expires:
        expires_ms = expires if expires >= 1e11 else expires * 1000
        expired = expires_ms <= time.time() * 1000
    return {"token": token, "plan": plan, "oauth": oauth, "expired": expired}


def read_credentials(
    config_dir=None, keys_file=None, only_key=False, key_id=None
) -> tuple[str, str | None, str]:
    """Return (access token, plan, source), preferring explicit credentials."""
    override = read_runway_key(keys_file, PROVIDER, key_id)
    if override:
        try:
            reject_api_key(override)
        except Unavailable as error:
            error.source = "saved key"
            raise
        return override, None, "saved key"
    if only_key:
        raise Unavailable(
            "No key saved for this account.",
            "missing_key",
            "Paste a Claude Code OAuth token in Runway Settings → Credentials.",
            source="saved key",
        )

    env_token = _text(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))
    if env_token:
        try:
            reject_api_key(env_token)
        except Unavailable as error:
            error.source = "CLAUDE_CODE_OAUTH_TOKEN"
            raise
        return env_token, None, "CLAUDE_CODE_OAUTH_TOKEN"

    claude = read_claude_file(config_dir)
    stale = None
    if claude and not claude["expired"]:
        return claude["token"], claude["plan"], "Claude Code credentials"
    if claude and claude["expired"]:
        stale = Unavailable(
            "The Claude Code access token expired; the sign-in is still valid.",
            "token_stale",
            _stale_action(claude["oauth"]),
            source="Claude Code credentials",
        )

    opencode = read_opencode_oauth_token()
    if opencode:
        return opencode, None, "OpenCode auth.json"

    if stale:
        raise stale
    raise Unavailable(
        "No Claude Code token was found on this machine.",
        "not_signed_in",
        "Paste a Claude Code OAuth token in Runway Settings → Credentials, or run `claude auth login`.",
    )


# --------------------------------------------------------------------------- #
# Network
# --------------------------------------------------------------------------- #


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_usage(token: str) -> dict:
    request = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": "Bearer " + token,
            "anthropic-beta": OAUTH_BETA,
            "Accept": "application/json",
            "User-Agent": "herdr-opencode-usage/0.2",
        },
    )
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            raw = response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            # A token this mod considered live was still refused, so signing in
            # again may be the answer — but only after checking it is needed.
            raise Unavailable(
                "api.anthropic.com rejected the Claude Code token.",
                "token_rejected",
                "Paste a fresh Claude Code OAuth token in Runway Settings → Credentials, "
                "or open Claude Code once and press refresh.",
                status=error.code,
            ) from None
        if error.code == 403:
            raise Unavailable("The account refused access to its usage.", "forbidden", status=error.code)
        if error.code == 404:
            raise Unavailable(
                "Anthropic no longer serves the usage endpoint this mod reads.",
                "endpoint_missing",
                "Check for a newer version of this mod.",
                status=error.code,
            )
        if error.code == 429:
            raise Unavailable(
                "Rate limited by api.anthropic.com.",
                "rate_limited",
                "Try again later.",
                status=error.code,
            )
        raise Unavailable(
            f"api.anthropic.com answered HTTP {error.code}.",
            "http_error",
            status=error.code,
        ) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        raise Unavailable(f"Could not reach api.anthropic.com: {reason}", "offline") from None

    if len(raw) > MAX_BYTES:
        raise Unavailable("The usage response was too large.", "reader_error")
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise Unavailable("The usage response was not JSON.", "reader_error") from None


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def collect(config_dir=None, keys_file=None, only_key=False, key_id=None) -> dict:
    token, plan, source = read_credentials(config_dir, keys_file, only_key, key_id)
    try:
        data = fetch_usage(token)
    except Unavailable as error:
        error.source = error.source or source
        raise
    record = normalize(data, plan)
    record["source"] = source
    record["http_status"] = 200
    return record


def main(argv) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    as_json = "--json" in argv
    config_dir = None
    if "--config" in argv:
        index = argv.index("--config")
        if index + 1 < len(argv):
            config_dir = argv[index + 1]
    keys_file = None
    if "--keys-file" in argv:
        index = argv.index("--keys-file")
        if index + 1 < len(argv):
            keys_file = argv[index + 1]
    only_key = "--only-key" in argv
    key_id = None
    if "--key-id" in argv:
        index = argv.index("--key-id")
        if index + 1 < len(argv):
            key_id = argv[index + 1]

    try:
        record = collect(config_dir, keys_file, only_key, key_id)
    except Unavailable as error:
        if as_json:
            print(
                json.dumps(
                    {
                        "provider": PROVIDER,
                        "windows": [],
                        "error": error.message,
                        "code": error.code,
                        "action": error.action,
                        "source": error.source,
                        "http_status": error.status,
                    },
                    indent=2,
                )
            )
        else:
            print(f"{TITLE}: {error.message}")
            if error.action:
                print(f"Next step: {error.action}")
        return 2

    if as_json:
        print(json.dumps(record, indent=2))
    else:
        print(render_text(record))
        print()
        print(f"updated {record['updated']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
