"""OpenCode Go plan usage from the local Console login.

Reads the active Console OAuth credential that opencode stores in its own
SQLite database (table ``credential``, ``integration_id = 'opencode'``), calls
the same status endpoint the Console Go page uses, and prints the three plan
windows.

Usage:
    python collect.py                 # text
    python collect.py --json          # normalized JSON (contract for the mod)
    python collect.py --db <path>     # override the opencode database

Exit codes: 0 success, 2 a known/unavailable condition, 1 unexpected failure.

The credential is only ever used as an Authorization header. It is never
printed, logged, stored or included in any output.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

STATUS_URL = "https://opencode.ai/console/api/go/status"
PROVIDER = "opencode-go"
TITLE = "OpenCode Go"
WINDOW_ORDER = (("fiveHour", "5h"), ("week", "week"), ("month", "month"))
MAX_BYTES = 1 << 20
TIMEOUT = 10

# microCents: 1e6 microCents == 1 cent, so 1e8 == 1 USD.
MICRO_CENTS_PER_USD = 100_000_000


class Unavailable(Exception):
    """A condition the person can understand and usually act on."""

    def __init__(self, message: str, code: str = "unavailable", action: str | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.action = action


# --------------------------------------------------------------------------- #
# Formatting helpers
# --------------------------------------------------------------------------- #


def _usd(micro_cents) -> float | None:
    try:
        value = float(micro_cents)
    except (TypeError, ValueError):
        return None
    if value != value or value < 0 or value > 1e18:  # NaN or absurd
        return None
    return value / MICRO_CENTS_PER_USD


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


def normalize(payload) -> dict:
    """Turn a status payload into the normalized record the bar consumes."""
    if not isinstance(payload, dict):
        raise Unavailable("The status response was not an object.", "reader_error")
    access = payload.get("access")
    meters = access.get("meters") if isinstance(access, dict) else None
    if not isinstance(meters, dict) or not meters:
        raise Unavailable(
            "The status response carried no usage meters.",
            "no_quota",
            "The endpoint shape may have changed; check /console/api/go/status.",
        )

    windows = []
    for key, label in WINDOW_ORDER:
        meter = meters.get(key)
        if not isinstance(meter, dict):
            continue
        used_usd = _usd(meter.get("usedMicroCents"))
        limit_usd = _usd(meter.get("limitMicroCents"))
        if not limit_usd:  # a reported zero limit is not a usable limit
            limit_usd = None
        percent = None
        if used_usd is not None and limit_usd:
            percent = used_usd / limit_usd * 100
        windows.append(
            {
                "key": key,
                "label": label,
                "used_usd": used_usd,
                "limit_usd": limit_usd,
                "percent": percent,
                "resets_at": meter.get("resetsAt"),
            }
        )
    if not windows:
        raise Unavailable("The response named no known window.", "no_quota")

    period_end = access.get("endsAt") if isinstance(access, dict) else None
    return {
        "provider": PROVIDER,
        "product": payload.get("product") if isinstance(payload.get("product"), str) else None,
        "period_ends_at": period_end,
        "windows": windows,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def render_text(record: dict, now: datetime | None = None) -> str:
    reference = now or datetime.now(timezone.utc)
    lines = [f"{TITLE} · plan {record.get('product') or 'unknown'}"]
    if record.get("period_ends_at"):
        lines.append(
            f"paid period ends {_stamp(record['period_ends_at'])} "
            f"({countdown(record['period_ends_at'], reference)} left)"
        )
    lines.append("")
    for window in record["windows"]:
        percent = window.get("percent")
        share = f"{percent:.1f}%" if percent is not None else "  n/a"
        limit = f"${window['limit_usd']:.2f}" if window.get("limit_usd") is not None else "no limit"
        used = f"${window['used_usd']:.2f}" if window.get("used_usd") is not None else "n/a"
        lines.append(
            f"{window['label']:<5} {_bar(percent)} {share:>6}  "
            f"used {used} of {limit}  "
            f"resets in {countdown(window.get('resets_at'), reference)} "
            f"({_stamp(window.get('resets_at'))})"
        )
    errors = record.get("windows_without_data") or []
    if errors:
        lines.append("")
        lines.append("missing windows: " + ", ".join(errors))
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Credential
# --------------------------------------------------------------------------- #


def default_db_path() -> Path:
    override = os.environ.get("OPENCODE_GO_DB")
    if override:
        return Path(override).expanduser()
    base = os.environ.get("XDG_DATA_HOME")
    root = Path(base).expanduser() if base else Path.home() / ".local" / "share"
    return root / "opencode" / "opencode.db"


def read_access_token(db_path=None) -> str:
    """Return the active Console OAuth access token. Never writes to the DB."""
    path = Path(db_path) if db_path else default_db_path()
    if not path.is_file():
        raise Unavailable(
            f"No opencode database at {path}.",
            "no_database",
            "Run opencode once, or set OPENCODE_GO_DB to the database path.",
        )
    uri = "file:" + path.as_posix() + "?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=5)
    except sqlite3.Error as error:
        raise Unavailable(
            f"The opencode database could not be opened read-only: {error}",
            "database_locked",
            "Close opencode, or set OPENCODE_GO_DB to a copy of opencode.db.",
        ) from None
    try:
        # rowid keeps the query independent of optional columns such as
        # time_updated, which older builds do not have.
        rows = connection.execute(
            "select value from credential "
            "where integration_id = 'opencode' and active = 1 "
            "order by rowid desc"
        ).fetchall()
    except sqlite3.Error as error:
        raise Unavailable(
            f"The credential table is not readable: {error}",
            "no_credential_table",
            "Update opencode; v2 keeps account connections in this table.",
        ) from None
    finally:
        connection.close()

    for (raw,) in rows:
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(value, dict) or value.get("type") != "oauth":
            continue
        token = value.get("access")
        if isinstance(token, str) and token.strip():
            return token.strip()

    raise Unavailable(
        "No OpenCode Console login is stored on this machine.",
        "not_signed_in",
        "In opencode run /connect, choose OpenCode Console account, then retry.",
    )


# --------------------------------------------------------------------------- #
# Network
# --------------------------------------------------------------------------- #


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_status(token: str) -> dict:
    request = urllib.request.Request(
        STATUS_URL,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
            "User-Agent": "herdr-opencode-usage/0.1",
        },
    )
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            raw = response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise Unavailable(
                "The OpenCode Console session is not valid anymore.",
                "expired",
                "In opencode run /connect and reconnect the Console account.",
            ) from None
        if error.code == 403:
            raise Unavailable("The Console refused access to Go usage.", "forbidden")
        if error.code == 429:
            raise Unavailable("Rate limited by opencode.ai.", "rate_limited", "Try again later.")
        raise Unavailable(f"opencode.ai answered HTTP {error.code}.", "http_error") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        raise Unavailable(f"Could not reach opencode.ai: {reason}", "offline") from None

    if len(raw) > MAX_BYTES:
        raise Unavailable("The status response was too large.", "reader_error")
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise Unavailable("The status response was not JSON.", "reader_error") from None


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def collect(db_path=None) -> dict:
    token = read_access_token(db_path)
    return normalize(fetch_status(token))


def main(argv) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    as_json = "--json" in argv
    db_path = None
    if "--db" in argv:
        index = argv.index("--db")
        if index + 1 < len(argv):
            db_path = argv[index + 1]

    try:
        record = collect(db_path)
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
