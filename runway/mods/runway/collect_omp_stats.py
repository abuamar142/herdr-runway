"""Aggregate OMP usage from its local stats dashboard.

OMP serves a read-only stats API on 127.0.0.1:3847. This helper reads the
overview, model, folder, and error aggregates for 24h, 7d, and 30d. It never
reads prompts, session files, or credentials. When the dashboard is not
running, it falls back to `omp stats --json` for the 24h range.

Usage:
    python collect_omp_stats.py --json

Exit codes: 0 success, 2 a known/unavailable condition, 1 unexpected failure.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PROVIDER = "omp-stats"
TITLE = "OMP Stats"
BASE = "http://127.0.0.1:3847"
RANGES = ("24h", "7d", "30d")
TIMEOUT = 1.5
FALLBACK_TIMEOUT = 20
MAX_BYTES = 2 << 20


class Unavailable(Exception):
    def __init__(
        self,
        message: str,
        code: str = "unavailable",
        action: str | None = None,
        failure: str | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.code = code
        self.action = action
        self.failure = failure


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and number >= 0 else None


def _text(value) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _fetch(path: str):
    url = f"{BASE}{path}"
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            if response.status != 200:
                raise Unavailable(
                    f"OMP stats returned HTTP {response.status}.",
                    "omp_stats_http",
                    "Open the OMP stats dashboard and try again.",
                )
            body = response.read(MAX_BYTES + 1)
    except Unavailable:
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise Unavailable(
            "OMP stats is not reachable.",
            "omp_stats_unavailable",
            "Run `omp stats` to start the local dashboard, then refresh.",
            str(error),
        ) from None
    if len(body) > MAX_BYTES:
        raise Unavailable("OMP stats returned too much data.", "omp_stats_large")
    try:
        return json.loads(body)
    except (TypeError, ValueError):
        raise Unavailable("OMP stats returned no readable JSON.", "omp_stats_json") from None


def _overview(payload) -> dict | None:
    block = payload.get("overall") if isinstance(payload, dict) else None
    if not isinstance(block, dict):
        return None
    return {
        "requests": int(_number(block.get("totalRequests")) or 0),
        "failed": int(_number(block.get("failedRequests")) or 0),
        "error_rate": _number(block.get("errorRate")) or 0.0,
        "input_tokens": int(_number(block.get("totalInputTokens")) or 0),
        "output_tokens": int(_number(block.get("totalOutputTokens")) or 0),
        "cache_read": int(_number(block.get("totalCacheReadTokens")) or 0),
        "cache_write": int(_number(block.get("totalCacheWriteTokens")) or 0),
        "cost_usd": _number(block.get("totalCost")) or 0.0,
        "cache_rate": _number(block.get("cacheRate")) or 0.0,
        "avg_duration_ms": _number(block.get("avgDuration")) or 0.0,
        "avg_ttft_ms": _number(block.get("avgTtft")) or 0.0,
        "avg_tps": _number(block.get("avgTokensPerSecond")) or 0.0,
    }


def _tokens(entry: dict) -> int:
    return int(
        (_number(entry.get("totalInputTokens")) or 0)
        + (_number(entry.get("totalOutputTokens")) or 0)
    )


def _models(payload) -> list[dict]:
    rows = payload.get("byModel") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return []
    models = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        model = _text(row.get("model"))
        if not model:
            continue
        models.append(
            {
                "model": model,
                "provider": _text(row.get("provider")),
                "requests": int(_number(row.get("totalRequests")) or 0),
                "tokens": _tokens(row),
                "cost_usd": _number(row.get("totalCost")) or 0.0,
                "cache_rate": _number(row.get("cacheRate")) or 0.0,
            }
        )
    models.sort(key=lambda item: (item["cost_usd"], item["tokens"]), reverse=True)
    return models[:3]


def _folders(payload) -> list[dict]:
    rows = payload if isinstance(payload, list) else []
    folders = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        folder = _text(row.get("folder"))
        if not folder:
            continue
        folders.append(
            {
                "folder": folder,
                "requests": int(_number(row.get("totalRequests")) or 0),
                "tokens": _tokens(row),
                "cost_usd": _number(row.get("totalCost")) or 0.0,
            }
        )
    folders.sort(key=lambda item: (item["cost_usd"], item["tokens"]), reverse=True)
    return folders[:3]


def _errors(rows, overview: dict) -> dict:
    counts: dict[str, int] = {}
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            model = _text(row.get("model")) or "unknown"
            counts[model] = counts.get(model, 0) + 1
    top = sorted(counts.items(), key=lambda item: item[1], reverse=True)[:3]
    return {
        "failed": overview["failed"],
        "rate": overview["error_rate"],
        "recent": len(rows) if isinstance(rows, list) else 0,
        "models": [{"model": model, "count": count} for model, count in top],
    }


def _range(name: str) -> dict:
    overview = _overview(_fetch(f"/api/stats/overview?range={name}"))
    if not overview:
        raise Unavailable(
            f"OMP stats returned no overview for {name}.",
            "omp_stats_empty",
        )
    try:
        models = _models(_fetch(f"/api/stats/model-dashboard?range={name}"))
    except Unavailable:
        models = []
    try:
        folders = _folders(_fetch(f"/api/stats/folders?range={name}"))
    except Unavailable:
        folders = []
    try:
        errors = _errors(_fetch(f"/api/stats/errors?range={name}&limit=50"), overview)
    except Unavailable:
        errors = _errors([], overview)
    return {
        "overview": overview,
        "models": models,
        "folders": folders,
        "errors": errors,
    }


def _omp_command() -> str | None:
    found = shutil.which("omp")
    if found:
        return found
    for candidate in (Path.home() / ".bun" / "bin" / "omp", Path.home() / ".local" / "bin" / "omp"):
        if candidate.is_file():
            return str(candidate)
    return None


def _fallback() -> dict | None:
    command = _omp_command()
    if not command:
        return None
    try:
        result = subprocess.run(
            [command, "stats", "--json"],
            capture_output=True,
            text=True,
            timeout=FALLBACK_TIMEOUT,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    try:
        payload = json.loads((result.stdout or "").strip())
    except (TypeError, ValueError):
        return None
    overview = _overview(payload)
    if not overview:
        return None
    return {
        "overview": overview,
        "models": _models(payload),
        "folders": _folders(payload),
        "errors": _errors([], overview),
    }


def collect() -> dict:
    ranges: dict[str, dict] = {}
    for name in RANGES:
        try:
            ranges[name] = _range(name)
        except Unavailable:
            continue
    source = BASE
    if not ranges:
        fallback = _fallback()
        if fallback:
            ranges["24h"] = fallback
            source = "omp stats --json"
        else:
            raise Unavailable(
                "OMP stats is not reachable.",
                "omp_stats_unavailable",
                "Run `omp stats` to start the local dashboard, then refresh.",
            )
    return {
        "provider": PROVIDER,
        "title": TITLE,
        "fetched_at": _now(),
        "source": source,
        "ranges": ranges,
    }


def render_text(record: dict) -> str:
    lines = [f"{TITLE} ({record['source']})"]
    for name, data in record["ranges"].items():
        overview = data["overview"]
        lines.append(
            f"{name}: {overview['requests']} requests, {overview['failed']} failed, "
            f"{overview['input_tokens'] + overview['output_tokens']} tokens, "
            f"~${overview['cost_usd']:.2f}"
        )
    return "\n".join(lines)


def main(argv) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    as_json = "--json" in argv
    try:
        record = collect()
    except Unavailable as error:
        if as_json:
            print(
                json.dumps(
                    {
                        "provider": PROVIDER,
                        "ranges": {},
                        "error": error.message,
                        "code": error.code,
                        "action": error.action,
                        "failure": error.failure,
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
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
