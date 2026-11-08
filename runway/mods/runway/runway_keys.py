"""Read a provider credential from Runway's local key file.

The file is written by the Runway dialog at
``~/.config/herdr-app/runway-keys.json`` with mode 600. A missing, unreadable,
or malformed file is not an error here: the collector then falls back to the
provider's own credential store.
"""

from __future__ import annotations

import json
from pathlib import Path


def read_key(path, provider: str) -> str | None:
    if not path:
        return None
    try:
        data = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    value = data.get(provider)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
