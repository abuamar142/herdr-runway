import json
import os
import sqlite3
import sys
import tempfile
import time
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

    def test_omp_sessions_point_ccusage_at_dot_omp(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            (home / ".omp" / "agent" / "sessions").mkdir(parents=True)
            with mock.patch.object(Path, "home", return_value=home):
                with mock.patch.dict(os.environ, {}, clear=True):
                    env = collect_ccusage._omp_env()
        self.assertEqual(env, {"PI_AGENT_DIR": str(home / ".omp")})

    def test_explicit_pi_agent_dir_wins(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            (home / ".omp" / "agent" / "sessions").mkdir(parents=True)
            with mock.patch.object(Path, "home", return_value=home):
                with mock.patch.dict(
                    os.environ, {"PI_AGENT_DIR": "/custom/pi"}, clear=True
                ):
                    env = collect_ccusage._omp_env()
        self.assertEqual(env, {})

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


class OmpCredentialTests(unittest.TestCase):
    def make_db(self, folder, data, disabled=None):
        path = Path(folder) / "agent.db"
        connection = sqlite3.connect(path)
        connection.execute(
            "create table auth_credentials ("
            "provider text, credential_type text, data text, disabled_cause text, updated_at integer)"
        )
        connection.execute(
            "insert into auth_credentials values (?, ?, ?, ?, ?)",
            ("anthropic", "oauth", json.dumps(data), disabled, 1),
        )
        connection.commit()
        connection.close()
        return path

    def test_valid_credential(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.make_db(
                folder,
                {"access": "oauth-token", "expires": int(time.time() * 1000) + 3600000},
            )
            credential = collect_claude.read_omp_credential(path)
        self.assertEqual(credential["token"], "oauth-token")
        self.assertFalse(credential["expired"])
        self.assertIsNotNone(credential["expires_at"])

    def test_expired_credential(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.make_db(
                folder,
                {"access": "old", "expires": int(time.time() * 1000) - 1000},
            )
            credential = collect_claude.read_omp_credential(path)
        self.assertTrue(credential["expired"])

    def test_disabled_credential_is_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.make_db(
                folder,
                {"access": "old", "expires": int(time.time() * 1000) + 3600000},
                "oauth refresh failed",
            )
            self.assertIsNone(collect_claude.read_omp_credential(path))

    def test_credentials_prefer_omp_over_opencode(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.make_db(
                folder,
                {"access": "omp-token", "expires": int(time.time() * 1000) + 3600000},
            )
            with mock.patch.dict(os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": ""}):
                token, plan, source = collect_claude.read_credentials(
                    config_dir=folder, omp_db=path
                )
        self.assertEqual(token, "omp-token")
        self.assertIsNone(plan)
        self.assertEqual(source, "OMP agent.db")


class ClaudeWindowTests(unittest.TestCase):
    def test_limits_include_scoped_fable_window(self):
        payload = {
            "limits": [
                {"kind": "session", "percent": 0, "resets_at": "2026-11-12T08:00:00Z"},
                {"kind": "weekly_all", "percent": 78, "resets_at": "2026-11-16T06:00:00Z"},
                {
                    "kind": "weekly_scoped",
                    "percent": 53,
                    "resets_at": "2026-11-16T06:00:00Z",
                    "scope": {"model": {"display_name": "Fable"}},
                },
            ]
        }
        record = collect_claude.normalize(payload)
        windows = {window["key"]: window for window in record["windows"]}
        self.assertEqual(list(windows), ["five_hour", "seven_day", "seven_day_fable"])
        self.assertEqual(windows["seven_day_fable"]["percent"], 53)
        self.assertEqual(windows["seven_day_fable"]["label"], "Fable")
        self.assertEqual(
            windows["seven_day_fable"]["resets_at"], "2026-11-16T06:00:00Z"
        )

    def test_unknown_scoped_name_becomes_its_own_window(self):
        payload = {
            "limits": [
                {
                    "kind": "weekly_scoped",
                    "percent": 12,
                    "scope": {"model": {"display_name": "Nova Pro"}},
                }
            ]
        }
        record = collect_claude.normalize(payload)
        self.assertEqual(record["windows"][0]["key"], "seven_day_nova_pro")
        self.assertEqual(record["windows"][0]["label"], "Nova Pro")

    def test_direct_buckets_still_parse(self):
        record = collect_claude.normalize(
            {
                "five_hour": {"utilization": 0, "resets_at": "2026-11-12T08:00:00Z"},
                "seven_day": {"utilization": 78, "resets_at": "2026-11-16T06:00:00Z"},
            }
        )
        self.assertEqual([window["key"] for window in record["windows"]], ["five_hour", "seven_day"])


class ClaudeFallbackTests(unittest.TestCase):
    def test_collect_falls_back_to_omp_after_token_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "claude"
            config.mkdir()
            (config / ".credentials.json").write_text(
                json.dumps(
                    {
                        "claudeAiOauth": {
                            "accessToken": "claude-token",
                            "expiresAt": int(time.time() * 1000) + 3600000,
                            "subscriptionType": "pro",
                        }
                    }
                )
            )
            omp = Path(folder) / "agent.db"
            connection = sqlite3.connect(omp)
            connection.execute(
                "create table auth_credentials ("
                "provider text, credential_type text, data text, disabled_cause text, updated_at integer)"
            )
            connection.execute(
                "insert into auth_credentials values (?, ?, ?, ?, ?)",
                (
                    "anthropic",
                    "oauth",
                    json.dumps(
                        {"access": "omp-token", "expires": int(time.time() * 1000) + 3600000}
                    ),
                    None,
                    1,
                ),
            )
            connection.commit()
            connection.close()

            calls = []

            def fetch(token):
                calls.append(token)
                if token == "claude-token":
                    raise collect_claude.Unavailable("rejected", "token_rejected")
                return {}

            with mock.patch.dict(os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": ""}):
                with mock.patch.object(collect_claude, "read_opencode_oauth_token", return_value=None):
                    with mock.patch.object(collect_claude, "fetch_usage", side_effect=fetch):
                        with mock.patch.object(
                            collect_claude,
                            "normalize",
                            return_value={"provider": "claude", "windows": []},
                        ):
                            record = collect_claude.collect(config_dir=config, omp_db=omp)
        self.assertEqual(record["source"], "OMP agent.db")
        self.assertIsNotNone(record["credential_expires_at"])
        self.assertEqual(calls, ["claude-token", "omp-token"])


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
