"""Kenari plan usage for the unified Herdr usage bar.

Reads the Kenari API key from the same places omp's Kenari extension uses:
KENARI_API_KEY, ~/.kenari/credentials.json, or the `kenari` block in
~/.omp/agent/models.yml (PI_CODING_AGENT_DIR is honoured too).

Usage:
    python collect_kenari.py            # text
    python collect_kenari.py --json     # normalized JSON

Exit codes: 0 success, 2 a known/unavailable condition, 1 unexpected failure.
The key is only used as an Authorization header and is never printed.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from runway_keys import read_key as read_runway_key

BASE_URL = (os.environ.get("KENARI_BASE_URL") or "https://kenari.id/v1").rstrip("/")
PROVIDER = "kenari"
TITLE = "Kenari"
TIMEOUT = 10
MAX_BYTES = 1 << 20
WINDOW_LABELS = {"five_hour": "5h", "week": "week", "month": "month"}


class Unavailable(Exception):
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


def _text(value) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and number >= 0 and number <= 1e15 else None


def _parse_time(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def countdown(resets_at, now: datetime | None = None) -> str:
    when = _parse_time(resets_at)
    if when is None:
        return "no reset time"
    seconds = int((when - (now or datetime.now(timezone.utc))).total_seconds())
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


def read_key(keys_file=None, only_key=False, key_id=None) -> tuple[str, str]:
    key = read_runway_key(keys_file, PROVIDER, key_id)
    if key:
        return key, "saved key"
    if only_key:
        raise Unavailable(
            "No key saved for this account.",
            "missing_key",
            "Paste a Kenari API key in Runway Settings → Credentials.",
            source="saved key",
        )

    key = _text(os.environ.get("KENARI_API_KEY"))
    if key:
        return key, "KENARI_API_KEY"

    home = Path(os.environ.get("KENARI_HOME") or (Path.home() / ".kenari")).expanduser()
    candidates = [home / "credentials.json"]
    if os.environ.get("PI_CODING_AGENT_DIR"):
        candidates.insert(0, Path(os.environ["PI_CODING_AGENT_DIR"]).expanduser() / "models.yml")
    candidates.append(Path.home() / ".omp" / "agent" / "models.yml")

    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        if path.name == "models.yml":
            block = re.search(r"^  kenari:\n([\s\S]*?)(?=^  \S|(?![\s\S]))", text, re.M)
            match = re.search(r'^\s+apiKey:\s*"?([^"\s#]+)"?', block.group(1), re.M) if block else None
            if match:
                return match.group(1), "OMP models.yml"
            continue
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            continue
        for name in ("apiKey", "api_key", "key", "token"):
            value = _text(data.get(name) if isinstance(data, dict) else None)
            if value:
                return value, "Kenari credentials.json"

    raise Unavailable(
        "No Kenari API key was found.",
        "not_signed_in",
        "Paste a key in Runway Settings → Credentials, run `kenari login`, or set KENARI_API_KEY / the kenari apiKey in ~/.omp/agent/models.yml.",
    )


def request_json(url: str, key: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": "herdr-runway/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            raw = response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise Unavailable(
                "Kenari rejected the API key.",
                "unauthorized",
                "Paste a new key in Runway Settings → Credentials, or run `kenari login` again.",
                status=error.code,
            ) from None
        if error.code == 403:
            raise Unavailable(
                "This Kenari key cannot read account quota.",
                "forbidden",
                "Use an unrestricted Owner/Admin key; restricted or shared keys cannot read quota.",
                status=error.code,
            ) from None
        if error.code == 429:
            raise Unavailable(
                "Kenari rate-limited the usage request.",
                "rate_limited",
                "Wait a minute and retry.",
                status=error.code,
            ) from None
        raise Unavailable(
            f"Kenari returned HTTP {error.code}.",
            "http_error",
            status=error.code,
        ) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise Unavailable(f"Could not reach Kenari: {error}.", "offline", "Check the network and retry.") from None
    if len(raw) > MAX_BYTES:
        raise Unavailable("Kenari returned an oversized response.", "reader_error")
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise Unavailable("Kenari returned no readable JSON.", "reader_error") from None
    if not isinstance(value, dict):
        raise Unavailable("Kenari returned an unexpected response.", "reader_error")
    return value


def normalize(quota: dict) -> dict:
    plan = quota.get("plan")
    if not isinstance(plan, dict):
        raise Unavailable(
            "No active Kenari plan quota was reported.",
            "no_quota",
            "This account is PAYG-only or has no active plan; check the Kenari dashboard.",
        )
    windows = plan.get("windows")
    if not isinstance(windows, dict) or not windows:
        raise Unavailable(
            "The Kenari plan reports no quota windows.",
            "no_quota",
            "Check the Kenari dashboard; the plan may have no ceilings.",
        )

    result = []
    ordered = [key for key in ("five_hour", "week", "month") if key in windows]
    ordered += [key for key in windows if key not in ordered]
    for key in ordered:
        raw = windows.get(key)
        if not isinstance(raw, dict):
            continue
        fraction = _number(raw.get("used_frac"))
        if fraction is None:
            used = _number(raw.get("used_rp"))
            budget = _number(raw.get("budget_rp"))
            if used is not None and budget:
                fraction = min(1.0, used / budget)
        if fraction is None:
            continue
        result.append(
            {
                "key": str(key),
                "label": WINDOW_LABELS.get(str(key), str(key).replace("_", " ")),
                "percent": fraction * 100,
                "resets_at": _text(raw.get("resets_at")),
            }
        )
    if not result:
        raise Unavailable(
            "The Kenari plan windows carried no usage figures.",
            "no_quota",
        )

    return {
        "provider": PROVIDER,
        "title": TITLE,
        "plan": _text(plan.get("name")),
        "windows": result,
        "money": None,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def render_text(record: dict) -> str:
    lines = [f"{TITLE} · plan {record.get('plan') or 'unknown'}"]
    for window in record["windows"]:
        percent = window.get("percent")
        share = f"{percent:.0f}%" if percent is not None else "n/a"
        lines.append(
            f"{window['label']:<5} {share:>5}  "
            f"resets in {countdown(window.get('resets_at'))} "
            f"({_stamp(window.get('resets_at'))})"
        )
    return "\n".join(lines)


def main() -> int:
    argv = sys.argv[1:]
    want_json = "--json" in argv
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
    source = None
    try:
        key, source = read_key(keys_file, only_key, key_id)
        quota = request_json(f"{BASE_URL}/account/quota", key)
        record = normalize(quota)
        record["source"] = source
        record["http_status"] = 200
    except Unavailable as error:
        record = {
            "provider": PROVIDER,
            "title": TITLE,
            "plan": None,
            "windows": [],
            "money": None,
            "error": error.message,
            "code": error.code,
            "action": error.action,
            "source": error.source or source,
            "http_status": error.status,
            "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        if want_json:
            print(json.dumps(record, ensure_ascii=False))
        else:
            print(f"{TITLE}: {error.message}")
        return 2
    except Exception as error:  # noqa: BLE001 - the mod needs a readable failure
        record = {
            "provider": PROVIDER,
            "title": TITLE,
            "plan": None,
            "windows": [],
            "money": None,
            "error": "The Kenari usage helper failed.",
            "code": "reader_error",
            "failure": str(error)[:400],
            "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        if want_json:
            print(json.dumps(record, ensure_ascii=False))
        else:
            print(f"{TITLE}: {error}")
        return 1

    if want_json:
        print(json.dumps(record, ensure_ascii=False))
    else:
        print(render_text(record))
    return 0


if __name__ == "__main__":
    sys.exit(main())
