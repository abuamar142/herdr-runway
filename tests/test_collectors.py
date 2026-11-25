import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / "runway" / "mods" / "runway"
sys.path.insert(0, str(MOD))

import collect_claude  # noqa: E402
import collect_kelontong  # noqa: E402
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


class KelontongTests(unittest.TestCase):
    def test_normalize_reads_the_coin_balance(self):
        record = collect_kelontong.normalize(
            {
                "object": "balance",
                "unit": "coin",
                "available": "12.003236",
                "balance_status": "available",
                "message": "Saldo tersedia.",
                "access_status": "active",
                "access_expires_at": "2026-12-03T06:38:37.178Z",
            }
        )
        self.assertEqual(record["provider"], "kelontong")
        self.assertEqual(record["windows"], [])
        self.assertEqual(record["balance"]["amount"], 12.003236)
        self.assertEqual(record["balance"]["unit"], "coin")
        self.assertEqual(record["balance"]["status"], "available")
        self.assertEqual(record["balance"]["access_status"], "active")
        self.assertEqual(record["balance"]["expires_at"], "2026-12-03T06:38:37.178Z")
        self.assertNotIn("period_ends_at", record)

    def test_normalize_keeps_a_zero_balance(self):
        record = collect_kelontong.normalize({"available": "0", "unit": "coin"})
        self.assertEqual(record["balance"]["amount"], 0)
        self.assertIsNone(record["balance"]["status"])

    def test_normalize_rejects_a_missing_balance(self):
        with self.assertRaises(collect_kelontong.Unavailable) as raised:
            collect_kelontong.normalize({"object": "balance"})
        self.assertEqual(raised.exception.code, "no_balance")

    def test_normalize_rejects_a_negative_balance(self):
        with self.assertRaises(collect_kelontong.Unavailable):
            collect_kelontong.normalize({"available": "-1"})

    def test_key_comes_from_models_yml(self):
        with tempfile.TemporaryDirectory() as folder:
            models = Path(folder) / "models.yml"
            models.write_text(
                "providers:\n"
                "  kelontong:\n"
                "    baseUrl: https://api.kelontongai.id/v1\n"
                "    apiKey: \"sk-kelontong-test\"\n"
                "    api: openai-completions\n"
                "  kenari:\n"
                "    apiKey: \"kn-other\"\n"
            )
            with mock.patch.dict(
                os.environ, {"PI_CODING_AGENT_DIR": folder, "KELONTONG_API_KEY": ""}
            ):
                key, source = collect_kelontong.read_key()
        self.assertEqual(key, "sk-kelontong-test")
        self.assertEqual(source, "OMP models.yml")

    def test_environment_key_wins_over_models_yml(self):
        with mock.patch.dict(os.environ, {"KELONTONG_API_KEY": "env-key"}):
            key, source = collect_kelontong.read_key()
        self.assertEqual(key, "env-key")
        self.assertEqual(source, "KELONTONG_API_KEY")

    def test_saved_key_wins_over_the_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            keys = Path(folder) / "keys.json"
            keys.write_text(json.dumps({"kelontong": "saved-key"}))
            with mock.patch.dict(os.environ, {"KELONTONG_API_KEY": "env-key"}):
                key, source = collect_kelontong.read_key(keys)
        self.assertEqual(key, "saved-key")
        self.assertEqual(source, "saved key")

    def test_only_key_refuses_to_fall_back(self):
        with tempfile.TemporaryDirectory() as folder:
            keys = Path(folder) / "keys.json"
            keys.write_text("{}")
            with mock.patch.dict(os.environ, {"KELONTONG_API_KEY": "env-key"}):
                with self.assertRaises(collect_kelontong.Unavailable) as raised:
                    collect_kelontong.read_key(keys, only_key=True)
        self.assertEqual(raised.exception.code, "missing_key")


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
