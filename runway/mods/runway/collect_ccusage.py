"""Token totals and API-equivalent cost from ccusage.

ccusage reads the local logs of coding agents and prints JSON. This helper
turns the last 30 days into per-agent today/week/month totals and, for Claude,
the latest 5-hour billing block. It never asks for credentials and never
prints prompts or responses.

Usage:
    python collect_ccusage.py --json

Exit codes: 0 success (including "no data"), 2 ccusage is missing or failed.

Cost is an API-price estimate. For a flat-rate plan it is not the amount
billed. ccusage only knows agents, not Runway account instances, so totals
are for all accounts of that agent.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

PROVIDER = "ccusage"
TITLE = "ccusage"
TIMEOUT = 30
DAYS = 30
TOP_MODELS = 3


class Unavailable(Exception):
    def __init__(self, message: str, code: str = "unavailable", action: str | None = None, failure: str | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.action = action
        self.failure = failure


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _empty() -> dict:
    return {"tokens": 0, "cost_usd": 0.0}


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and number >= 0 else None


def _tokens(entry: dict) -> int:
    total = _number(entry.get("totalTokens"))
    if total is not None:
        return int(total)
    parts = (
        entry.get("inputTokens"),
        entry.get("outputTokens"),
        entry.get("cacheCreationTokens"),
        entry.get("cacheReadTokens"),
        entry.get("reasoningOutputTokens"),
    )
    return int(sum(_number(part) or 0 for part in parts))


def _cost(entry: dict) -> float:
    for key in ("totalCost", "costUSD", "cost"):
        value = _number(entry.get(key))
        if value is not None:
            return value
    return sum(
        _number(model.get("cost")) or 0
        for model in entry.get("modelBreakdowns") or []
        if isinstance(model, dict)
    )


def _command() -> str | None:
    found = shutil.which("ccusage")
    if found:
        return found
    for candidate in (Path.home() / ".bun" / "bin" / "ccusage", Path.home() / ".local" / "bin" / "ccusage"):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _run(args: list[str]) -> dict:
    command = _command()
    if not command:
        raise Unavailable(
            "ccusage is not installed.",
            "no_ccusage",
            "Install ccusage, then press Refresh in Runway Settings → Bar.",
        )
    try:
        result = subprocess.run(
            [command, *args],
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired:
        raise Unavailable(
            "ccusage took too long.",
            "ccusage_timeout",
            "Try again, or run ccusage by hand to see why it is slow.",
        ) from None
    except OSError as error:
        raise Unavailable(
            "ccusage could not run.",
            "ccusage_error",
            "Check the ccusage install.",
            str(error),
        ) from None
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        raise Unavailable(
            f"ccusage exited with code {result.returncode}.",
            "ccusage_error",
            "Run ccusage by hand to see the error.",
            detail[-1][:400] if detail else None,
        )
    try:
        payload = json.loads((result.stdout or "").strip())
    except (TypeError, ValueError):
        raise Unavailable(
            "ccusage returned no readable JSON.",
            "ccusage_error",
            "Update ccusage, then try again.",
        ) from None
    if not isinstance(payload, dict):
        raise Unavailable("ccusage returned an unexpected response.", "ccusage_error")
    return payload


def _add(bucket: dict, entry: dict) -> None:
    bucket["tokens"] += _tokens(entry)
    bucket["cost_usd"] += _cost(entry)


def _models(entry: dict, totals: dict) -> None:
    for model in entry.get("modelBreakdowns") or []:
        if not isinstance(model, dict):
            continue
        name = model.get("modelName")
        if not isinstance(name, str) or not name:
            continue
        current = totals.setdefault(name, {"tokens": 0, "cost_usd": 0.0})
        current["tokens"] += _tokens(model)
        current["cost_usd"] += _cost(model)


def _round_agent(bucket: dict, models: dict) -> dict:
    top = sorted(
        (
            {"model": name, "tokens": int(value["tokens"]), "cost_usd": round(value["cost_usd"], 6)}
            for name, value in models.items()
        ),
        key=lambda item: item["tokens"],
        reverse=True,
    )[:TOP_MODELS]
    for key in ("today", "week", "month"):
        bucket[key]["cost_usd"] = round(bucket[key]["cost_usd"], 6)
    bucket["models"] = top
    return bucket


def daily_totals() -> dict:
    today = date.today()
    since = today - timedelta(days=DAYS - 1)
    payload = _run(
        [
            "daily",
            "--json",
            "--offline",
            "--by-agent",
            "--since",
            since.isoformat(),
        ]
    )
    rows = payload.get("daily")
    if not isinstance(rows, list):
        return {}

    agents: dict[str, dict] = {}
    model_totals: dict[str, dict[str, dict]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        period = row.get("period")
        if not isinstance(period, str):
            continue
        try:
            day = date.fromisoformat(period)
        except ValueError:
            continue
        if day < since:
            continue
        entries = row.get("agents") if isinstance(row.get("agents"), list) else [row]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            agent = entry.get("agent")
            if not isinstance(agent, str) or agent == "all":
                continue
            bucket = agents.setdefault(
                agent,
                {"today": _empty(), "week": _empty(), "month": _empty()},
            )
            _add(bucket["month"], entry)
            _models(entry, model_totals.setdefault(agent, {}))
            if day >= today - timedelta(days=6):
                _add(bucket["week"], entry)
            if day == today:
                _add(bucket["today"], entry)

    for agent, bucket in agents.items():
        _round_agent(bucket, model_totals.get(agent, {}))
    return agents


def claude_block() -> dict | None:
    try:
        payload = _run(["blocks", "--json", "--offline", "--recent"])
    except Unavailable:
        return None
    blocks = payload.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return None
    chosen = next(
        (block for block in reversed(blocks) if isinstance(block, dict) and block.get("isActive")),
        None,
    )
    if chosen is None:
        chosen = next((block for block in reversed(blocks) if isinstance(block, dict)), None)
    if not isinstance(chosen, dict):
        return None
    counts = chosen.get("tokenCounts") if isinstance(chosen.get("tokenCounts"), dict) else {}
    tokens = _number(chosen.get("totalTokens"))
    if tokens is None:
        tokens = sum(_number(value) or 0 for value in counts.values())
    return {
        "tokens": int(tokens),
        "cost_usd": round(_cost(chosen), 6),
        "is_active": chosen.get("isActive") is True,
        "start": chosen.get("startTime"),
        "end": chosen.get("endTime"),
    }


def collect() -> dict:
    agents = daily_totals()
    block = claude_block()
    if block:
        if "claude" not in agents:
            agents["claude"] = {
                "today": _empty(),
                "week": _empty(),
                "month": _empty(),
                "models": [],
            }
        agents["claude"]["block"] = block
    return {"provider": PROVIDER, "generated_at": _now(), "agents": agents}


def main(argv: list[str]) -> int:
    want_json = "--json" in argv
    try:
        record = collect()
    except Unavailable as error:
        record = {
            "provider": PROVIDER,
            "generated_at": _now(),
            "agents": {},
            "error": error.message,
            "code": error.code,
            "action": error.action,
            "failure": error.failure,
        }
        if want_json:
            print(json.dumps(record, indent=2))
        else:
            print(f"{TITLE}: {error.message}")
            if error.action:
                print(f"Next step: {error.action}")
        return 2
    except Exception as error:  # noqa: BLE001 - the mod needs a readable failure
        record = {
            "provider": PROVIDER,
            "generated_at": _now(),
            "agents": {},
            "error": "The ccusage helper failed.",
            "code": "reader_error",
            "failure": str(error)[:400],
        }
        if want_json:
            print(json.dumps(record, indent=2))
        else:
            print(f"{TITLE}: {error}")
        return 1

    if want_json:
        print(json.dumps(record, indent=2))
    else:
        for agent, bucket in record["agents"].items():
            print(f"{agent}: today {bucket['today']['tokens']} tokens")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
