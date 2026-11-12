import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / "runway" / "mods" / "runway"
sys.path.insert(0, str(MOD))

import collect_omp_stats  # noqa: E402


def overview(requests=10, failed=1, cost=1.5):
    return {
        "overall": {
            "totalRequests": requests,
            "failedRequests": failed,
            "errorRate": failed / requests if requests else 0,
            "totalInputTokens": 1000,
            "totalOutputTokens": 200,
            "totalCacheReadTokens": 5000,
            "totalCacheWriteTokens": 50,
            "totalCost": cost,
            "cacheRate": 0.9,
            "avgDuration": 1200,
            "avgTtft": 300,
            "avgTokensPerSecond": 40,
        }
    }


class OmpStatsTests(unittest.TestCase):
    def test_overview_normalizes_numbers(self):
        result = collect_omp_stats._overview(overview())
        self.assertEqual(result["requests"], 10)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["input_tokens"], 1000)
        self.assertEqual(result["output_tokens"], 200)
        self.assertEqual(result["cache_read"], 5000)
        self.assertEqual(result["cost_usd"], 1.5)
        self.assertAlmostEqual(result["error_rate"], 0.1)

    def test_models_are_sorted_by_cost_and_capped(self):
        payload = {
            "byModel": [
                {"model": "a", "totalRequests": 1, "totalInputTokens": 10, "totalOutputTokens": 1, "totalCost": 0.1},
                {"model": "b", "totalRequests": 2, "totalInputTokens": 20, "totalOutputTokens": 2, "totalCost": 2.0},
                {"model": "c", "totalRequests": 3, "totalInputTokens": 30, "totalOutputTokens": 3, "totalCost": 1.0},
                {"model": "d", "totalRequests": 4, "totalInputTokens": 40, "totalOutputTokens": 4, "totalCost": 0.5},
            ]
        }
        models = collect_omp_stats._models(payload)
        self.assertEqual([model["model"] for model in models], ["b", "c", "d"])
        self.assertEqual(models[0]["tokens"], 22)

    def test_folders_are_sorted_by_cost_and_capped(self):
        payload = [
            {"folder": "a", "totalRequests": 1, "totalInputTokens": 10, "totalOutputTokens": 1, "totalCost": 0.1},
            {"folder": "b", "totalRequests": 2, "totalInputTokens": 20, "totalOutputTokens": 2, "totalCost": 2.0},
            {"folder": "c", "totalRequests": 3, "totalInputTokens": 30, "totalOutputTokens": 3, "totalCost": 1.0},
            {"folder": "d", "totalRequests": 4, "totalInputTokens": 40, "totalOutputTokens": 4, "totalCost": 0.5},
        ]
        folders = collect_omp_stats._folders(payload)
        self.assertEqual([folder["folder"] for folder in folders], ["b", "c", "d"])

    def test_errors_aggregate_models_without_paths(self):
        rows = [
            {"model": "a", "sessionFile": "/secret/a.jsonl"},
            {"model": "a", "sessionFile": "/secret/b.jsonl"},
            {"model": "b", "sessionFile": "/secret/c.jsonl"},
        ]
        result = collect_omp_stats._errors(rows, collect_omp_stats._overview(overview()))
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["recent"], 3)
        self.assertEqual(result["models"], [{"model": "a", "count": 2}, {"model": "b", "count": 1}])
        self.assertNotIn("sessionFile", str(result))

    def test_range_keeps_overview_when_models_fail(self):
        def fake_fetch(path):
            if path.startswith("/api/stats/overview"):
                return overview()
            raise collect_omp_stats.Unavailable("missing")

        with mock.patch.object(collect_omp_stats, "_fetch", side_effect=fake_fetch):
            result = collect_omp_stats._range("24h")
        self.assertEqual(result["overview"]["requests"], 10)
        self.assertEqual(result["models"], [])
        self.assertEqual(result["folders"], [])
        self.assertEqual(result["errors"]["failed"], 1)

    def test_collect_falls_back_to_omp_stats_json(self):
        fallback = {
            "overview": collect_omp_stats._overview(overview()),
            "models": [],
            "folders": [],
            "errors": collect_omp_stats._errors([], collect_omp_stats._overview(overview())),
        }
        with mock.patch.object(collect_omp_stats, "_range", side_effect=collect_omp_stats.Unavailable("down")):
            with mock.patch.object(collect_omp_stats, "_fallback", return_value=fallback):
                record = collect_omp_stats.collect()
        self.assertEqual(list(record["ranges"]), ["24h"])
        self.assertEqual(record["source"], "omp stats --json")


if __name__ == "__main__":
    unittest.main()
