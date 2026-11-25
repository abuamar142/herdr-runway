"""Kelontong AI balance for the unified Herdr usage bar.

Kelontong AI bills from a prepaid coin balance instead of plan windows, so this
helper reports the balance and the access expiry, not percentages. It reads the
key from Runway's key file, KELONTONG_API_KEY, or the `kelontong` block in
~/.omp/agent/models.yml (PI_CODING_AGENT_DIR is honoured too).

Usage:
    python collect_kelontong.py            # text
    python collect_kelontong.py --json     # normalized JSON

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

BASE_URL = (os.environ.get("KELONTONG_BASE_URL") or "https://api.kelontongai.id/v1").rstrip("/")
PROVIDER = "kelontong"
TITLE = "Kelontong AI"
TIMEOUT = 10
MAX_BYTES = 1 << 20


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
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            value = float(value.strip())
        except ValueError:
            return None
    if not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and number >= 0 and number <= 1e15 else None


def _stamp(value) -> str:
    if not isinstance(value, str) or not value:
        return "unknown"
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return value
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%MZ")


def read_key(keys_file=None, only_key=False, key_id=None) -> tuple[str, str]:
    key = read_runway_key(keys_file, PROVIDER, key_id)
    if key:
        return key, "saved key"
    if only_key:
        raise Unavailable(
            "No key saved for this account.",
            "missing_key",
            "Paste a Kelontong AI API key in Runway Settings → Credentials.",
            source="saved key",
        )

    key = _text(os.environ.get("KELONTONG_API_KEY"))
    if key:
        return key, "KELONTONG_API_KEY"

    candidates = []
    if os.environ.get("PI_CODING_AGENT_DIR"):
        candidates.append(Path(os.environ["PI_CODING_AGENT_DIR"]).expanduser() / "models.yml")
    candidates.append(Path.home() / ".omp" / "agent" / "models.yml")

    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        block = re.search(r"^  kelontong:\n([\s\S]*?)(?=^  \S|(?![\s\S]))", text, re.M)
        match = re.search(r'^\s+apiKey:\s*"?([^"\s#]+)"?', block.group(1), re.M) if block else None
        if match:
            return match.group(1), "OMP models.yml"

    raise Unavailable(
        "No Kelontong AI API key was found.",
        "not_signed_in",
        "Paste a key in Runway Settings → Credentials, or set KELONTONG_API_KEY / the kelontong apiKey in ~/.omp/agent/models.yml.",
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
                "Kelontong AI rejected the API key.",
                "unauthorized",
                "Paste a new key in Runway Settings → Credentials.",
                status=error.code,
            ) from None
        if error.code == 403:
            raise Unavailable(
                "This Kelontong AI key cannot read the balance.",
                "forbidden",
                "Use the account's own key from the Kelontong dashboard.",
                status=error.code,
            ) from None
        if error.code == 429:
            raise Unavailable(
                "Kelontong AI rate-limited the balance request.",
                "rate_limited",
                "Wait a minute and retry.",
                status=error.code,
            ) from None
        raise Unavailable(
            f"Kelontong AI returned HTTP {error.code}.",
            "http_error",
            status=error.code,
        ) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise Unavailable(
            f"Could not reach Kelontong AI: {error}.", "offline", "Check the network and retry."
        ) from None
    if len(raw) > MAX_BYTES:
        raise Unavailable("Kelontong AI returned an oversized response.", "reader_error")
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise Unavailable("Kelontong AI returned no readable JSON.", "reader_error") from None
    if not isinstance(value, dict):
        raise Unavailable("Kelontong AI returned an unexpected response.", "reader_error")
    return value


def normalize(payload: dict) -> dict:
    amount = _number(payload.get("available"))
    if amount is None:
        raise Unavailable(
            "Kelontong AI reported no coin balance.",
            "no_balance",
            "Check the Kelontong dashboard; the key may belong to an account without a wallet.",
        )
    expires_at = _text(payload.get("access_expires_at"))
    return {
        "provider": PROVIDER,
        "title": TITLE,
        "plan": None,
        "windows": [],
        "money": None,
        "balance": {
            "amount": amount,
            "unit": _text(payload.get("unit")) or "coin",
            "status": _text(payload.get("balance_status")),
            "access_status": _text(payload.get("access_status")),
            "expires_at": expires_at,
            "message": _text(payload.get("message")),
        },
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def render_text(record: dict) -> str:
    balance = record.get("balance") or {}
    amount = balance.get("amount")
    share = f"{amount:.2f}" if isinstance(amount, (int, float)) else "n/a"
    lines = [f"{TITLE} · {share} {balance.get('unit') or 'coin'}"]
    if balance.get("status"):
        lines.append(f"balance {balance['status']}")
    if balance.get("access_status"):
        lines.append(f"access {balance['access_status']}")
    if balance.get("expires_at"):
        lines.append(f"access ends {_stamp(balance['expires_at'])}")
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
        payload = request_json(f"{BASE_URL}/balance", key)
        record = normalize(payload)
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
            "error": "The Kelontong AI balance helper failed.",
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
