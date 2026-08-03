"""외부 API를 호출하지 않는 SSTfolio v2 병합 로직 단위 테스트."""
from __future__ import annotations

import datetime as dt
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.update({
    "GAS_WEBAPP_URL": "https://example.invalid/gas",
    "CF_ACCOUNT_ID": "test",
    "CF_API_TOKEN": "test",
    "CF_KV_NAMESPACE_ID": "test",
})

spec = importlib.util.spec_from_file_location("sstfolio_collector", ROOT / "scripts" / "fetch_naver.py")
assert spec and spec.loader
collector = importlib.util.module_from_spec(spec)
sys.modules["sstfolio_collector"] = collector
spec.loader.exec_module(collector)

now = dt.datetime(2026, 8, 3, 1, 0, tzinfo=dt.timezone.utc)  # KR 10:00
master = {
    "holdings": [
        {"ticker": "005930", "market": "KR", "name": "삼성", "quantity": 10, "avg_price": 70000, "current_price": 111, "price_updated": "2026-01-01"},
        {"ticker": "AAPL", "market": "US", "name": "Apple", "quantity": 2, "avg_price": 200, "usd_krw": 1350, "current_price": 1},
        {"ticker": "D95610", "market": "KR", "name": "Fund", "quantity": 1, "avg_price": 10000, "current_price": 12000, "price_updated": "2026-07-01"},
    ],
    "prices": [],
    "config": {"USD_KRW": 1350},
}
previous = {
    "holdings": [
        {"ticker": "005930", "market": "KR", "current_price": 80000, "change_rate": "+1.00%", "price_updated_at": "2026-08-03T00:55:00Z", "price_source": "naver"},
        {"ticker": "AAPL", "market": "US", "current_price": 220, "change_rate": "-1.00%", "price_updated_at": "2026-08-01T20:00:00Z", "price_source": "yahoo"},
    ],
    "prices": [],
}
fresh = {
    collector.holding_key("KR", "005930"): collector.PriceResult(
        "005930", "KR", 81000, "+2.00%", "2026-08-03T01:00:00Z", "open", "naver_mobile"
    )
}
failures = [collector.FetchFailure("AAPL", "US", "http_429_circuit_open")]

out, stats = collector.apply_prices(master, previous, fresh, failures, {"KR", "US"}, now)
holdings = {item["ticker"]: item for item in out["holdings"]}
assert holdings["005930"]["current_price"] == 81000
assert holdings["005930"]["price_status"] == "fresh"
assert holdings["AAPL"]["current_price"] == 220
assert holdings["AAPL"]["price_status"] == "closed"
assert holdings["D95610"]["price_status"] == "unsupported"
assert stats["target_total"] == 2 and stats["target_ok"] == 1 and stats["success_rate"] == 50
assert holdings["005930"]["eval_amount"] == 810000
assert holdings["AAPL"]["eval_amount"] == 594000

# 최초 실행에서 수집이 실패하면 GAS 가격은 최신값이 아닌 비검증 stale로 남아야 한다.
out2, _ = collector.apply_prices(
    master,
    None,
    {},
    [collector.FetchFailure("005930", "KR", "timeout")],
    {"KR"},
    now,
)
holdings2 = {item["ticker"]: item for item in out2["holdings"]}
assert holdings2["005930"]["current_price"] == 111
assert holdings2["005930"]["price_status"] == "stale"
assert holdings2["005930"]["price_source"] == "gas_unverified"


# 장이 닫혀 있어도 수개월 된 값은 closed가 아니라 stale이어야 한다.
assert collector.status_for_previous("US", "2026-01-01T00:00:00Z", now) == "stale"

print("fetch_naver v2 unit tests passed")
