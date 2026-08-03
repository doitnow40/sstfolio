"""
SSTfolio v2 현재가 수집기
========================

핵심 원칙
1. Cloudflare KV의 portfolio_data는 이 Python 수집기만 작성한다.
2. GAS는 계좌/보유수량/평단가 등 마스터 데이터만 제공한다.
3. 종목 수집 실패 시 GAS 가격이 아니라 기존 KV의 마지막 정상 가격을 유지한다.
4. 종목마다 price_updated_at, price_status, price_source를 기록한다.
5. emergency_full은 전체 재수집 성공률이 기준값 이상일 때만 portfolio_data를 교체한다.
6. 403/429 발생 시 해당 소스의 추가 호출을 중단하여 차단 위험을 낮춘다.

필수 GitHub Secrets
- GAS_WEBAPP_URL
- CF_ACCOUNT_ID
- CF_API_TOKEN
- CF_KV_NAMESPACE_ID

선택 환경변수
- FETCH_MODE: auto | sync | kr | us | emergency_full (기본 auto)
- PUBLISH_MIN_SUCCESS_RATE: emergency_full 반영 기준, 기본 95
- STALE_MINUTES: 장중 stale 기준, 기본 15
- CLOSED_STALE_DAYS: 장 마감값도 stale로 전환할 최대 경과일, 기본 10
- KR_CONCURRENCY: 기본 8
- US_CONCURRENCY: 기본 6
"""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import json
import os
import random
import re
import sys
import time
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp
import requests


GAS_URL = os.environ["GAS_WEBAPP_URL"].strip()
CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"].strip()
CF_API_TOKEN = os.environ["CF_API_TOKEN"].strip()
CF_KV_NS_ID = os.environ["CF_KV_NAMESPACE_ID"].strip()

FETCH_MODE = os.environ.get("FETCH_MODE", "auto").strip().lower() or "auto"
MIN_SUCCESS_RATE = float(os.environ.get("PUBLISH_MIN_SUCCESS_RATE", "95"))
STALE_MINUTES = int(os.environ.get("STALE_MINUTES", "15"))
CLOSED_STALE_DAYS = max(1, int(os.environ.get("CLOSED_STALE_DAYS", "10")))
KR_CONCURRENCY = max(1, min(int(os.environ.get("KR_CONCURRENCY", "8")), 12))
US_CONCURRENCY = max(1, min(int(os.environ.get("US_CONCURRENCY", "6")), 10))
KV_TTL_SECONDS = 7 * 86400

NAVER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    "Referer": "https://m.stock.naver.com/",
    "Accept": "application/json,text/plain,*/*",
}
YAHOO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
}

KV_VALUE_URL = (
    "https://api.cloudflare.com/client/v4/accounts/"
    f"{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_KV_NS_ID}/values/{{key}}"
)

UTC = dt.timezone.utc
KST = ZoneInfo("Asia/Seoul")
NY = ZoneInfo("America/New_York")


class CollectorError(RuntimeError):
    """수집 전체를 실패 처리해야 하는 오류."""


@dataclass
class PriceResult:
    ticker: str
    market: str
    price: float
    change_rate: str | None
    price_updated_at: str
    market_state: str
    source: str


@dataclass
class FetchFailure:
    ticker: str
    market: str
    reason: str


def utc_now() -> dt.datetime:
    return dt.datetime.now(UTC)


def iso_utc(value: dt.datetime | None = None) -> str:
    value = value or utc_now()
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: Any) -> dt.datetime | None:
    if not value:
        return None
    try:
        text = str(value).strip().replace("Z", "+00:00")
        parsed = dt.datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)
    except Exception:
        return None


def normalize_ticker(ticker: Any, market: str) -> str:
    text = str(ticker or "").strip().upper()
    if market == "KR" and text.isdigit():
        return text.zfill(6)
    return text


def holding_key(market: Any, ticker: Any) -> str:
    market_text = str(market or "KR").upper()
    return f"{market_text}:{normalize_ticker(ticker, market_text)}"


def cloudflare_headers(content_type: str | None = None) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {CF_API_TOKEN}"}
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def read_kv_json(key: str) -> dict[str, Any] | None:
    """KV 값을 직접 읽는다. 값이 없으면 None."""
    response = requests.get(
        KV_VALUE_URL.format(key=key),
        headers=cloudflare_headers(),
        timeout=20,
    )
    if response.status_code == 404:
        return None
    if not response.ok:
        raise CollectorError(f"KV 읽기 실패({key}): HTTP {response.status_code} {response.text[:300]}")
    try:
        value = response.json()
    except Exception as exc:
        raise CollectorError(f"KV JSON 파싱 실패({key}): {exc}") from exc
    return value if isinstance(value, dict) else None


def write_kv_json(key: str, value: dict[str, Any], ttl: int = KV_TTL_SECONDS) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    response = requests.put(
        KV_VALUE_URL.format(key=key),
        headers=cloudflare_headers("application/json"),
        params={"expiration_ttl": ttl},
        data=payload,
        timeout=30,
    )
    if not response.ok:
        raise CollectorError(f"KV 저장 실패({key}): HTTP {response.status_code} {response.text[:300]}")
    try:
        envelope = response.json()
        if isinstance(envelope, dict) and envelope.get("success") is False:
            raise CollectorError(f"KV 저장 실패({key}): {envelope}")
    except ValueError:
        # 일부 환경은 빈 본문을 반환할 수 있으므로 HTTP 성공이면 허용한다.
        pass
    print(f"[KV] {key} 저장 완료 ({len(payload):,} bytes, TTL={ttl}s)")


def fetch_portfolio_from_gas() -> dict[str, Any]:
    print("[GAS] 포트폴리오 마스터 조회")
    response = requests.get(GAS_URL, params={"action": "portfolio"}, timeout=40)
    response.raise_for_status()
    try:
        data = response.json()
    except Exception as exc:
        raise CollectorError(f"GAS JSON 파싱 실패: {response.text[:500]}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("holdings"), list):
        raise CollectorError(f"GAS 응답 구조 이상: {str(data)[:500]}")
    if data.get("error"):
        raise CollectorError(f"GAS 오류: {data['error']}")
    print(f"[GAS] holdings {len(data['holdings'])}개")
    return data


def market_open(market: str, now: dt.datetime | None = None) -> bool:
    now = now or utc_now()
    if market == "KR":
        local = now.astimezone(KST)
        if local.weekday() >= 5:
            return False
        minute = local.hour * 60 + local.minute
        return 9 * 60 <= minute <= 16 * 60
    if market == "US":
        local = now.astimezone(NY)
        if local.weekday() >= 5:
            return False
        minute = local.hour * 60 + local.minute
        return 9 * 60 + 25 <= minute <= 16 * 60 + 30
    return False


def target_markets(mode: str, now: dt.datetime | None = None) -> set[str]:
    mode = mode.lower()
    if mode == "emergency_full":
        return {"KR", "US"}
    if mode == "sync":
        return set()
    if mode == "kr":
        return {"KR"}
    if mode == "us":
        return {"US"}
    markets = {market for market in ("KR", "US") if market_open(market, now)}
    return markets


def parse_kr_price(data: dict[str, Any]) -> float:
    # closePrice를 먼저 사용하면 일부 종목에서 과거 종가를 현재가로 오인할 수 있다.
    for field in ("nv", "currentPrice", "stockEndPrice", "closePrice", "price"):
        value = data.get(field)
        if value in (None, ""):
            continue
        try:
            price = float(str(value).replace(",", ""))
            if price > 0:
                return price
        except (TypeError, ValueError):
            continue
    return 0.0


def parse_kr_change(data: dict[str, Any]) -> str | None:
    for field in ("fluctuationsRatio", "changeRate", "rate"):
        try:
            rate = float(str(data.get(field, "")).replace("%", "").replace(",", ""))
            if abs(rate) <= 35:
                return f"{rate:+.2f}%"
        except (TypeError, ValueError):
            pass
    try:
        current = float(str(data.get("closePrice", "")).replace(",", ""))
        diff = float(str(data.get("compareToPreviousClosePrice", "")).replace(",", ""))
        previous = current - diff
        if current > 0 and previous > 0:
            rate = (current / previous - 1) * 100
            if abs(rate) <= 35:
                return f"{rate:+.2f}%"
    except (TypeError, ValueError):
        pass
    return None


def normalize_market_state(raw: Any, market: str, now: dt.datetime) -> str:
    text = str(raw or "").upper()
    if any(token in text for token in ("OPEN", "REGULAR", "TRADING")):
        return "open"
    if any(token in text for token in ("CLOSE", "CLOSED", "AFTER", "POST")):
        return "closed"
    return "open" if market_open(market, now) else "closed"


async def fetch_kr_one(
    session: aiohttp.ClientSession,
    semaphore: asyncio.Semaphore,
    code: str,
    breaker: asyncio.Event,
) -> PriceResult | FetchFailure:
    if breaker.is_set():
        return FetchFailure(code, "KR", "source_circuit_open")
    url = f"https://m.stock.naver.com/api/stock/{code}/basic"
    for attempt in range(2):
        if breaker.is_set():
            return FetchFailure(code, "KR", "source_circuit_open")
        try:
            async with semaphore:
                if breaker.is_set():
                    return FetchFailure(code, "KR", "source_circuit_open")
                await asyncio.sleep(random.uniform(0.03, 0.18))
                async with session.get(url, headers=NAVER_HEADERS) as response:
                    if response.status in (403, 429):
                        breaker.set()
                        return FetchFailure(code, "KR", f"http_{response.status}_circuit_open")
                    if response.status >= 500:
                        raise RuntimeError(f"http_{response.status}")
                    if response.status != 200:
                        return FetchFailure(code, "KR", f"http_{response.status}")
                    data = await response.json(content_type=None)
            price = parse_kr_price(data)
            if price <= 0:
                return FetchFailure(code, "KR", "price_missing")
            now = utc_now()
            state = normalize_market_state(
                data.get("marketStatus") or data.get("marketStatusType") or data.get("tradeStopType"),
                "KR",
                now,
            )
            return PriceResult(
                ticker=code,
                market="KR",
                price=price,
                change_rate=parse_kr_change(data),
                price_updated_at=iso_utc(now),
                market_state=state,
                source="naver_mobile",
            )
        except (asyncio.TimeoutError, aiohttp.ClientError, RuntimeError) as exc:
            if attempt == 0:
                await asyncio.sleep(random.uniform(0.8, 1.5))
                continue
            return FetchFailure(code, "KR", type(exc).__name__ + ":" + str(exc)[:80])
        except Exception as exc:  # 방어적 처리
            return FetchFailure(code, "KR", type(exc).__name__ + ":" + str(exc)[:80])
    return FetchFailure(code, "KR", "unknown")


async def fetch_us_one(
    session: aiohttp.ClientSession,
    semaphore: asyncio.Semaphore,
    ticker: str,
    breaker: asyncio.Event,
) -> PriceResult | FetchFailure:
    if breaker.is_set():
        return FetchFailure(ticker, "US", "source_circuit_open")
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=5d"
    for attempt in range(2):
        if breaker.is_set():
            return FetchFailure(ticker, "US", "source_circuit_open")
        try:
            async with semaphore:
                if breaker.is_set():
                    return FetchFailure(ticker, "US", "source_circuit_open")
                await asyncio.sleep(random.uniform(0.05, 0.25))
                async with session.get(url, headers=YAHOO_HEADERS) as response:
                    if response.status in (403, 429):
                        breaker.set()
                        return FetchFailure(ticker, "US", f"http_{response.status}_circuit_open")
                    if response.status >= 500:
                        raise RuntimeError(f"http_{response.status}")
                    if response.status != 200:
                        return FetchFailure(ticker, "US", f"http_{response.status}")
                    data = await response.json(content_type=None)
            result = ((data.get("chart") or {}).get("result") or [None])[0]
            if not result:
                return FetchFailure(ticker, "US", "result_missing")
            meta = result.get("meta") or {}
            price = float(meta.get("regularMarketPrice") or meta.get("previousClose") or 0)
            previous = float(meta.get("chartPreviousClose") or meta.get("previousClose") or 0)
            if price <= 0:
                return FetchFailure(ticker, "US", "price_missing")
            change = None
            if previous > 0:
                rate = (price - previous) / previous * 100
                change = f"{rate:+.2f}%"
            epoch = meta.get("regularMarketTime")
            observed_at = dt.datetime.fromtimestamp(epoch, UTC) if epoch else utc_now()
            state = normalize_market_state(meta.get("marketState"), "US", utc_now())
            return PriceResult(
                ticker=ticker,
                market="US",
                price=price,
                change_rate=change,
                price_updated_at=iso_utc(observed_at),
                market_state=state,
                source="yahoo_chart",
            )
        except (asyncio.TimeoutError, aiohttp.ClientError, RuntimeError, KeyError, TypeError, ValueError) as exc:
            if attempt == 0:
                await asyncio.sleep(random.uniform(0.9, 1.8))
                continue
            return FetchFailure(ticker, "US", type(exc).__name__ + ":" + str(exc)[:80])
        except Exception as exc:
            return FetchFailure(ticker, "US", type(exc).__name__ + ":" + str(exc)[:80])
    return FetchFailure(ticker, "US", "unknown")


async def fetch_market_prices(
    kr_tickers: list[str],
    us_tickers: list[str],
) -> tuple[dict[str, PriceResult], list[FetchFailure]]:
    timeout = aiohttp.ClientTimeout(total=14, connect=7)
    connector = aiohttp.TCPConnector(limit=max(KR_CONCURRENCY, US_CONCURRENCY) + 2, ttl_dns_cache=300)
    results: dict[str, PriceResult] = {}
    failures: list[FetchFailure] = []
    kr_breaker = asyncio.Event()
    us_breaker = asyncio.Event()
    kr_sem = asyncio.Semaphore(KR_CONCURRENCY)
    us_sem = asyncio.Semaphore(US_CONCURRENCY)

    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        tasks: list[asyncio.Task[PriceResult | FetchFailure]] = []
        tasks.extend(asyncio.create_task(fetch_kr_one(session, kr_sem, ticker, kr_breaker)) for ticker in kr_tickers)
        tasks.extend(asyncio.create_task(fetch_us_one(session, us_sem, ticker, us_breaker)) for ticker in us_tickers)
        for item in await asyncio.gather(*tasks):
            if isinstance(item, PriceResult):
                results[holding_key(item.market, item.ticker)] = item
            else:
                failures.append(item)
    return results, failures


def previous_price_map(previous: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    mapped: dict[str, dict[str, Any]] = {}
    if not previous:
        return mapped
    for holding in previous.get("holdings") or []:
        key = holding_key(holding.get("market"), holding.get("ticker"))
        if key.endswith(":"):
            continue
        if float(holding.get("current_price") or 0) > 0:
            mapped[key] = holding
    return mapped


def age_minutes(value: Any, now: dt.datetime) -> float | None:
    parsed = parse_iso(value)
    if not parsed:
        return None
    return max(0.0, (now - parsed).total_seconds() / 60)


def status_for_previous(market: str, updated_at: Any, now: dt.datetime) -> str:
    age = age_minutes(updated_at, now)
    if age is None:
        return "stale"
    if not market_open(market, now):
        # 장 마감 표시도 무기한 신뢰하지 않는다. 장기 미갱신 값은 stale로 승격한다.
        return "closed" if age <= CLOSED_STALE_DAYS * 1440 else "stale"
    return "previous" if age <= STALE_MINUTES else "stale"


def apply_prices(
    master: dict[str, Any],
    previous: dict[str, Any] | None,
    fresh: dict[str, PriceResult],
    failures: list[FetchFailure],
    target_set: set[str],
    now: dt.datetime,
) -> tuple[dict[str, Any], dict[str, Any]]:
    portfolio = copy.deepcopy(master)
    old_map = previous_price_map(previous)
    failure_map = {holding_key(f.market, f.ticker): f.reason for f in failures}

    fresh_count = previous_count = stale_count = closed_count = missing_count = unsupported_count = 0
    supported_target_keys: set[str] = set()
    successful_target_keys: set[str] = set()

    for holding in portfolio.get("holdings") or []:
        market = str(holding.get("market") or "KR").upper()
        ticker = normalize_ticker(holding.get("ticker"), market)
        holding["ticker"] = ticker
        holding["market"] = market
        if holding.get("is_cash"):
            holding["price_status"] = "cash"
            continue

        supported = bool(
            (market == "KR" and re.fullmatch(r"\d{6}", ticker))
            or (market == "US" and re.fullmatch(r"[A-Z0-9.\-]+", ticker))
        )
        key = holding_key(market, ticker)
        result = fresh.get(key)
        previous_holding = old_map.get(key)

        if market in target_set and supported:
            supported_target_keys.add(key)

        if result:
            holding["current_price"] = result.price
            if result.change_rate is not None:
                holding["change_rate"] = result.change_rate
            elif previous_holding:
                holding["change_rate"] = previous_holding.get("change_rate", holding.get("change_rate", ""))
            holding["price_updated_at"] = result.price_updated_at
            holding["price_status"] = "closed" if result.market_state == "closed" else "fresh"
            holding["price_source"] = result.source
            holding["price_error"] = ""
            if market in target_set:
                successful_target_keys.add(key)
            if holding["price_status"] == "closed":
                closed_count += 1
            else:
                fresh_count += 1
        elif previous_holding:
            holding["current_price"] = float(previous_holding.get("current_price") or 0)
            holding["change_rate"] = previous_holding.get("change_rate", "")
            holding["price_updated_at"] = previous_holding.get("price_updated_at") or previous_holding.get("price_updated") or ""
            holding["price_source"] = previous_holding.get("price_source") or "previous_kv"
            holding["price_status"] = status_for_previous(market, holding["price_updated_at"], now)
            holding["price_error"] = failure_map.get(key, "not_targeted" if market not in target_set else "fetch_failed")
            if holding["price_status"] == "stale":
                stale_count += 1
            elif holding["price_status"] == "closed":
                closed_count += 1
            else:
                previous_count += 1
        elif not supported:
            # 지원하지 않는 상품은 GAS 값을 표시용으로만 보존하되, 최신값으로 오인되지 않게 명시한다.
            gas_price = float(holding.get("current_price") or 0)
            holding["current_price"] = gas_price
            holding["price_updated_at"] = holding.get("price_updated") or ""
            holding["price_status"] = "unsupported"
            holding["price_source"] = "gas_unverified" if gas_price > 0 else "none"
            holding["price_error"] = "unsupported_ticker"
            unsupported_count += 1
        else:
            # 첫 v2 실행에서 소스 조회가 실패하면 GAS 값을 최신값으로 승격하지 않고 stale로 표시한다.
            gas_price = float(holding.get("current_price") or 0)
            holding["current_price"] = gas_price
            holding["price_updated_at"] = holding.get("price_updated") or ""
            holding["price_status"] = "stale" if gas_price > 0 else "missing"
            holding["price_source"] = "gas_unverified" if gas_price > 0 else "none"
            holding["price_error"] = failure_map.get(key, "no_previous_price")
            if gas_price > 0:
                stale_count += 1
            else:
                missing_count += 1

        holding["price_last_attempt_at"] = iso_utc(now) if market in target_set else (previous_holding or {}).get("price_last_attempt_at", "")

        price = float(holding.get("current_price") or 0)
        quantity = float(holding.get("quantity") or 0)
        avg_price = float(holding.get("avg_price") or 0)
        usd_krw = float(holding.get("usd_krw") or (portfolio.get("config") or {}).get("USD_KRW") or 1)
        multiplier = usd_krw if market == "US" else 1
        holding["eval_amount"] = round(price * quantity * multiplier)
        holding["cost_amount"] = round(avg_price * quantity * multiplier)
        holding["profit_amount"] = holding["eval_amount"] - holding["cost_amount"]
        holding["profit_pct"] = round(holding["profit_amount"] / holding["cost_amount"] * 100, 1) if holding["cost_amount"] > 0 else 0
        try:
            percent = float(str(holding.get("change_rate") or "0").replace("%", ""))
            holding["change_amount"] = round(holding["eval_amount"] * percent / 100)
        except (TypeError, ValueError):
            holding["change_amount"] = 0

    supported_target_count = len(supported_target_keys)
    successful_target_count = len(successful_target_keys)
    success_rate = round(successful_target_count / supported_target_count * 100) if supported_target_count else 100
    stats = {
        "target_markets": sorted(target_set),
        "target_total": supported_target_count,
        "target_ok": successful_target_count,
        "success_rate": success_rate,
        "kr_total": sum(1 for h in portfolio.get("holdings") or [] if h.get("market") == "KR" and h.get("price_status") not in ("cash", "unsupported")),
        "us_total": sum(1 for h in portfolio.get("holdings") or [] if h.get("market") == "US" and h.get("price_status") not in ("cash", "unsupported")),
        "kr_failed": sorted({f.ticker for f in failures if f.market == "KR"}),
        "us_failed": sorted({f.ticker for f in failures if f.market == "US"}),
        "failure_reasons": {holding_key(f.market, f.ticker): f.reason for f in failures},
        "fresh_count": fresh_count,
        "previous_count": previous_count,
        "stale_count": stale_count,
        "closed_count": closed_count,
        "missing_count": missing_count,
        "unsupported_count": unsupported_count,
        "fetched_at": iso_utc(now),
    }

    # prices 배열은 기존 화면의 완전매도 종목 조회 호환성을 위해 유지하되,
    # 보유 종목에 대해서는 검증된 holding 값을 최우선으로 덮어쓴다.
    price_map: dict[str, dict[str, Any]] = {}
    if previous:
        for price_row in previous.get("prices") or []:
            key = holding_key(price_row.get("market"), price_row.get("ticker"))
            price_map[key] = copy.deepcopy(price_row)
    for price_row in master.get("prices") or []:
        key = holding_key(price_row.get("market"), price_row.get("ticker"))
        price_map.setdefault(key, copy.deepcopy(price_row))
    for holding in portfolio.get("holdings") or []:
        if holding.get("is_cash") or not holding.get("ticker"):
            continue
        key = holding_key(holding.get("market"), holding.get("ticker"))
        price_map[key] = {
            "ticker": holding.get("ticker"),
            "market": holding.get("market"),
            "name": holding.get("name", ""),
            "price": holding.get("current_price", 0),
            "change_rate": holding.get("change_rate", ""),
            "price_updated_at": holding.get("price_updated_at", ""),
            "price_status": holding.get("price_status", "missing"),
            "price_source": holding.get("price_source", "none"),
        }
    portfolio["prices"] = list(price_map.values())
    return portfolio, stats


def collector_status_payload(
    status: str,
    started_at: str,
    message: str,
    stats: dict[str, Any] | None = None,
    published_at: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": "2.0",
        "collector": "github_actions_python_v2",
        "mode": FETCH_MODE,
        "status": status,
        "message": message,
        "started_at": started_at,
        "finished_at": iso_utc(),
        "published_at": published_at,
        "stats": stats or {},
    }


async def main() -> int:
    started = time.time()
    started_at = iso_utc()
    now = utc_now()
    print(f"=== SSTfolio v2 collector 시작: {now.astimezone(KST):%Y-%m-%d %H:%M:%S} KST / mode={FETCH_MODE} ===")

    try:
        previous = read_kv_json("portfolio_data")
        master = fetch_portfolio_from_gas()
        targets = target_markets(FETCH_MODE, now)
        sync_mode = FETCH_MODE == "sync"

        holdings = master.get("holdings") or []
        kr_tickers = sorted({
            normalize_ticker(h.get("ticker"), "KR")
            for h in holdings
            if str(h.get("market") or "KR").upper() == "KR"
            and not h.get("is_cash")
            and re.fullmatch(r"\d+", str(h.get("ticker") or "").strip())
        }) if "KR" in targets else []
        us_tickers = sorted({
            normalize_ticker(h.get("ticker"), "US")
            for h in holdings
            if str(h.get("market") or "KR").upper() == "US"
            and not h.get("is_cash")
            and re.fullmatch(r"[A-Za-z0-9.\-]+", str(h.get("ticker") or "").strip())
        }) if "US" in targets else []

        print(f"[대상] markets={sorted(targets)} KR={len(kr_tickers)} US={len(us_tickers)}")
        fresh: dict[str, PriceResult] = {}
        failures: list[FetchFailure] = []
        if kr_tickers or us_tickers:
            fresh, failures = await fetch_market_prices(kr_tickers, us_tickers)

        portfolio, stats = apply_prices(master, previous, fresh, failures, targets, now)
        rate = float(stats.get("success_rate", 100))
        target_total = int(stats.get("target_total", 0))
        target_ok = int(stats.get("target_ok", 0))

        should_publish = True
        reject_reason = ""
        if FETCH_MODE == "emergency_full" and target_total > 0 and rate < MIN_SUCCESS_RATE:
            should_publish = False
            reject_reason = f"긴급 전체 수집 성공률 {rate:.0f}%가 반영 기준 {MIN_SUCCESS_RATE:.0f}% 미만"
        elif target_total > 0 and target_ok == 0 and previous:
            should_publish = False
            reject_reason = "수집 대상 전 종목 실패 — 기존 정상 KV 보존"
        elif not targets and not sync_mode:
            should_publish = False
            reject_reason = "현재 수집 대상 시장이 열려 있지 않아 실행 생략"

        if should_publish:
            published_at = iso_utc(now)
            portfolio["schema_version"] = "2.0"
            portfolio["source"] = "github_actions_python_v2"
            portfolio["last_attempt_at"] = published_at
            portfolio["updated_at"] = published_at
            previous_good = (previous or {}).get("last_good_at")
            portfolio["last_good_at"] = published_at if rate >= MIN_SUCCESS_RATE else previous_good
            portfolio["fetch_mode"] = FETCH_MODE
            portfolio["fetch_stats"] = stats
            portfolio["freshness"] = {
                "fresh": stats["fresh_count"],
                "previous": stats["previous_count"],
                "stale": stats["stale_count"],
                "closed": stats["closed_count"],
                "missing": stats["missing_count"],
                "unsupported": stats["unsupported_count"],
            }
            write_kv_json("portfolio_data", portfolio)
            write_kv_json(
                "collector_status",
                collector_status_payload("published", started_at, "portfolio_data 반영 완료", stats, published_at),
            )
            print(f"[완료] 성공률={rate:.0f}% ({target_ok}/{target_total}), elapsed={time.time()-started:.1f}s")
            return 0

        write_kv_json(
            "collector_status",
            collector_status_payload("rejected" if targets else "skipped", started_at, reject_reason, stats),
        )
        print(f"[미반영] {reject_reason}")
        return 2 if FETCH_MODE == "emergency_full" or (target_total > 0 and target_ok == 0) else 0

    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        print(f"[FATAL] {message}", file=sys.stderr)
        try:
            write_kv_json("collector_status", collector_status_payload("failed", started_at, message))
        except Exception as status_exc:
            print(f"[WARN] collector_status 저장 실패: {status_exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
