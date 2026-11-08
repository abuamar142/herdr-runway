import json
import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / "runway" / "mods" / "runway"
sys.path.insert(0, str(MOD))

import collect_ccusage  # noqa: E402
import collect_claude  # noqa: E402
import collect_quota_axi  # noqa: E402
import runway_keys  # noqa: E402


class KeyFileTests(unittest.TestCase):
    def test_reads_default_and_account_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "keys.json"
            path.write_text(json.dumps({"claude": "base", "claude:work": "work"}))
            self.assertEqual(runway_keys.read_key(path, "claude"), "base")
            self.assertEqual(runway_keys.read_key(path, "claude", "claude:work"), "work")
            self.assertIsNone(runway_keys.read_key(path, "claude", "claude:missing"))

    def test_bad_file_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "keys.json"
            path.write_text("{not json")
            self.assertIsNone(runway_keys.read_key(path, "claude"))
        self.assertIsNone(runway_keys.read_key(None, "claude"))


class CcusageTests(unittest.TestCase):
    def test_token_and_cost_fields(self):
        self.assertEqual(collect_ccusage._tokens({"totalTokens": 42}), 42)
        self.assertEqual(
            collect_ccusage._tokens(
                {"inputTokens": 1, "outputTokens": 2, "cacheReadTokens": 3, "cacheCreationTokens": 4}
            ),
            10,
        )
        self.assertEqual(collect_ccusage._cost({"totalCost": 0.5}), 0.5)
        self.assertEqual(collect_ccusage._cost({"costUSD": 0.25}), 0.25)
        self.assertEqual(collect_ccusage._cost({"modelBreakdowns": [{"cost": 0.1}]}), 0.1)

    def test_daily_aggregation(self):
        today = date.today().isoformat()
        payload = {
            "daily": [
                {
                    "period": today,
                    "agents": [
                        {
                            "agent": "claude",
                            "totalTokens": 100,
                            "totalCost": 0.5,
                            "modelBreakdowns": [{"modelName": "m", "inputTokens": 100, "cost": 0.5}],
                        }
                    ],
                }
            ]
        }
        with mock.patch.object(collect_ccusage, "_run", return_value=payload):
            agents = collect_ccusage.daily_totals()
        self.assertEqual(agents["claude"]["today"]["tokens"], 100)
        self.assertEqual(agents["claude"]["week"]["cost_usd"], 0.5)
        self.assertEqual(agents["claude"]["models"][0]["model"], "m")

    def test_block(self):
        payload = {
            "blocks": [
                {"totalTokens": 7, "costUSD": 0.25, "isActive": True},
                {"totalTokens": 9, "costUSD": 0.5, "isActive": False},
            ]
        }
        with mock.patch.object(collect_ccusage, "_run", return_value=payload):
            block = collect_ccusage.claude_block()
        self.assertEqual(block["tokens"], 7)
        self.assertTrue(block["is_active"])


class QuotaWindowTests(unittest.TestCase):
    def test_percent_remaining(self):
        window = collect_quota_axi._window({"percentRemaining": 25})
        self.assertEqual(window["percent"], 75)

    def test_percent_used(self):
        window = collect_quota_axi._window({"percentUsed": 40})
        self.assertEqual(window["percent"], 40)


class ClaudeCredentialTests(unittest.TestCase):
    def test_rejects_anthropic_api_key(self):
        with self.assertRaises(collect_claude.Unavailable):
            collect_claude.reject_api_key("sk-ant-api03-test")

    def test_accepts_oauth_token(self):
        collect_claude.reject_api_key("sk-ant-oat01-test")


if __name__ == "__main__":
    unittest.main()
