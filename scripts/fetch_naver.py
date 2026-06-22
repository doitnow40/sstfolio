"""
fetch_naver.py — SSTfolio 현재가 수집기
========================================
GitHub Actions에서 실행 (장중 5분 주기 cron)

역할:
  1. GAS API에서 투자현황 종목 목록 수신
  2. 네이버 m.stock API로 KR 종목 현재가+등락률 병렬 수집
  3. Yahoo Finance로 US 종목 현재가+등락률 병렬 수집
  4. Cloudflare KV portfolio_data 갱신 (GAS 포트폴리오 데이터에 현재가 덮어쓰기)

필요한 GitHub Secrets:
  GAS_WEBAPP_URL       : GAS 웹앱 URL
  CF_ACCOUNT_ID        : Cloudflare Account ID
  CF_API_TOKEN         : KV Storage 편집 권한 토큰
  CF_KV_NAMESPACE_ID   : sstfolio-kv namespace ID
  SSTFOLIO_SECRET      : Worker 인증 키
  WORKER_URL           : Cloudflare Worker URL
"""

import os, json, time, datetime, asyncio
import aiohttp, requests

GAS_URL       = os.environ['GAS_WEBAPP_URL']
CF_ACCOUNT_ID = os.environ['CF_ACCOUNT_ID']
CF_API_TOKEN  = os.environ['CF_API_TOKEN']
CF_KV_NS_ID   = os.environ['CF_KV_NAMESPACE_ID']
WORKER_URL    = os.environ.get('WORKER_URL', '').rstrip('/')
SECRET        = os.environ.get('SSTFOLIO_SECRET', '')

NAVER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)',
    'Referer': 'https://m.stock.naver.com/',
}
YAHOO_HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json',
}

KV_WRITE_URL = (
    f'https://api.cloudflare.com/client/v4/'
    f'accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_KV_NS_ID}/values/{{key}}'
)

# ── TTL 계산 ────────────────────────────────────────────────
def calc_ttl():
    """장중: 10분 / 장마감 후: 다음 영업일 10:00까지"""
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    hhmm = now.hour * 100 + now.minute
    if 900 <= hhmm <= 1540 and now.weekday() < 5:
        return 600
    candidate = now.replace(hour=10, minute=0, second=0, microsecond=0)
    if now >= candidate:
        candidate += datetime.timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate += datetime.timedelta(days=1)
    return max(int((candidate - now).total_seconds()), 600)

# ── 등락률 파싱 ─────────────────────────────────────────────
def parse_kr_chg(data):
    try:
        r = float(data.get('fluctuationsRatio', ''))
        if not (r != r) and abs(r) <= 35:
            return round(r, 2)
    except:
        pass
    try:
        c = float(str(data.get('closePrice', '')).replace(',', ''))
        d = float(str(data.get('compareToPreviousClosePrice', '')).replace(',', ''))
        if c > 0:
            p = c - d
            if p > 0:
                v = round((c / p - 1) * 100, 2)
                if abs(v) <= 35:
                    return v
    except:
        pass
    return None

def parse_price(data):
    for f in ['closePrice', 'currentPrice', 'nv', 'stockEndPrice', 'price']:
        v = data.get(f)
        if v:
            p = float(str(v).replace(',', ''))
            if p > 0:
                return p
    return 0

# ── KR 병렬 조회 ────────────────────────────────────────────
async def fetch_kr_one(session, code):
    url = f'https://m.stock.naver.com/api/stock/{code}/basic'
    try:
        async with session.get(url, headers=NAVER_HEADERS,
                               timeout=aiohttp.ClientTimeout(total=10)) as r:
            if r.status == 200:
                data = await r.json(content_type=None)
                price = parse_price(data)
                chg   = parse_kr_chg(data)
                if price > 0:
                    chg_str = (f'+{chg:.2f}%' if chg >= 0 else f'{chg:.2f}%') if chg is not None else ''
                    return code, price, chg_str
    except:
        pass
    return code, 0, ''

async def fetch_kr_all(codes):
    print(f'  [KR] {len(codes)}개 병렬 조회 중...')
    results = {}
    BATCH = 50
    async with aiohttp.ClientSession() as session:
        for i in range(0, len(codes), BATCH):
            batch = codes[i:i+BATCH]
            tasks = [fetch_kr_one(session, c) for c in batch]
            for code, price, chg in await asyncio.gather(*tasks):
                if price > 0:
                    results[code] = {'price': price, 'change_rate': chg}
            if i + BATCH < len(codes):
                await asyncio.sleep(0.2)
    ok = len(results)
    print(f'  [KR] {ok}/{len(codes)}개 성공')
    return results

# ── US 병렬 조회 (Yahoo Finance) ───────────────────────────
async def fetch_us_one(session, ticker):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1d'
    try:
        async with session.get(url, headers=YAHOO_HEADERS,
                               timeout=aiohttp.ClientTimeout(total=10)) as r:
            if r.status == 200:
                data = await r.json(content_type=None)
                meta  = data['chart']['result'][0]['meta']
                price = float(meta.get('regularMarketPrice') or meta.get('previousClose') or 0)
                prev  = float(meta.get('chartPreviousClose') or meta.get('previousClose') or 0)
                if price > 0 and prev > 0:
                    chg = round((price - prev) / prev * 100, 2)
                    chg_str = f'+{chg:.2f}%' if chg >= 0 else f'{chg:.2f}%'
                    return ticker, price, chg_str
    except:
        pass
    return ticker, 0, ''

async def fetch_us_all(tickers):
    print(f'  [US] {len(tickers)}개 병렬 조회 중...')
    results = {}
    BATCH = 20
    async with aiohttp.ClientSession() as session:
        for i in range(0, len(tickers), BATCH):
            batch = tickers[i:i+BATCH]
            tasks = [fetch_us_one(session, t) for t in batch]
            for ticker, price, chg in await asyncio.gather(*tasks):
                if price > 0:
                    results[ticker] = {'price': price, 'change_rate': chg}
            if i + BATCH < len(tickers):
                await asyncio.sleep(0.3)
    ok = len(results)
    print(f'  [US] {ok}/{len(tickers)}개 성공')
    return results

# ── GAS에서 포트폴리오 데이터 가져오기 ─────────────────────
def fetch_portfolio_from_gas():
    print('[1] GAS 포트폴리오 데이터 조회 중...')
    resp = requests.get(GAS_URL, params={'action': 'portfolio'}, timeout=30)
    resp.raise_for_status()
    return resp.json()

# ── KV에 저장 ───────────────────────────────────────────────
def write_to_kv(key, value, ttl):
    print(f'[KV] 저장: {key} (TTL={ttl}s)')
    resp = requests.put(
        KV_WRITE_URL.format(key=key),
        headers={
            'Authorization': f'Bearer {CF_API_TOKEN}',
            'Content-Type': 'application/json',
        },
        params={'expiration_ttl': ttl},
        data=json.dumps(value, ensure_ascii=False),
        timeout=15,
    )
    if not resp.ok:
        raise RuntimeError(f'KV 저장 실패: {resp.status_code} {resp.text[:200]}')
    print(f'  → KV 저장 완료')

# ── 포트폴리오 데이터에 현재가 덮어쓰기 ────────────────────
def apply_prices(portfolio, kr_map, us_map):
    """GAS 포트폴리오 데이터의 현재가/등락률을 Python 수집값으로 업데이트"""
    holdings = portfolio.get('holdings', [])
    updated = 0
    for h in holdings:
        ticker = h.get('ticker', '')
        market = h.get('market', 'KR').upper()
        if not ticker or h.get('is_cash'):
            continue
        if market == 'KR' and ticker in kr_map:
            p = kr_map[ticker]
            h['current_price']  = p['price']
            h['change_rate']    = p['change_rate']
            # 평가금액/손익 재계산
            qty  = float(h.get('quantity') or 0)
            avg  = float(h.get('avg_price') or 0)
            cost = qty * avg
            ev   = p['price'] * qty
            h['eval_amount']   = ev
            h['cost_amount']   = cost
            h['profit_amount'] = ev - cost
            h['profit_pct']    = round((ev / cost - 1) * 100, 2) if cost > 0 else 0
            updated += 1
        elif market == 'US' and ticker in us_map:
            p = us_map[ticker]
            h['current_price'] = p['price']
            h['change_rate']   = p['change_rate']
            qty  = float(h.get('quantity') or 0)
            avg  = float(h.get('avg_price') or 0)
            usd_krw = float(portfolio.get('usd_krw') or 1)
            cost = qty * avg * usd_krw
            ev   = p['price'] * qty * usd_krw
            h['eval_amount']   = ev
            h['cost_amount']   = cost
            h['profit_amount'] = ev - cost
            h['profit_pct']    = round((ev / cost - 1) * 100, 2) if cost > 0 else 0
            updated += 1
    print(f'  → {updated}/{len(holdings)}개 종목 현재가 업데이트')
    return portfolio

# ── 장중 여부 ───────────────────────────────────────────────
def is_kr_open():
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    if now.weekday() >= 5:
        return False
    hhmm = now.hour * 100 + now.minute
    return 900 <= hhmm <= 1540

def is_us_open():
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_et  = now_utc - datetime.timedelta(hours=4)
    if now_et.weekday() >= 5:
        return False
    hhmm = now_et.hour * 100 + now_et.minute
    return 930 <= hhmm <= 1700

# ── 메인 ────────────────────────────────────────────────────
async def main():
    start      = time.time()
    now_kst    = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    updated_at = now_kst.strftime('%Y-%m-%d %H:%M')
    print(f'=== SSTfolio fetch_naver.py 시작: {updated_at} KST ===')

    force = os.environ.get('FORCE_FETCH', '').lower() in ('1', 'true', 'yes')
    kr_open = force or is_kr_open()
    us_open = force or is_us_open()
    print(f'  KR장중: {kr_open}, US장중: {us_open}, FORCE: {force}')

    if not kr_open and not us_open:
        print('=== KR/US 모두 장외 — 스킵 ===')
        return

    # GAS에서 포트폴리오 데이터 가져오기
    try:
        portfolio = fetch_portfolio_from_gas()
    except Exception as e:
        print(f'GAS 조회 실패: {e}')
        return

    holdings = portfolio.get('holdings', [])
    kr_tickers = list(set(h['ticker'] for h in holdings
                          if h.get('market','KR').upper() == 'KR'
                          and h.get('ticker') and not h.get('is_cash')))
    us_tickers = list(set(h['ticker'] for h in holdings
                          if h.get('market','KR').upper() == 'US'
                          and h.get('ticker') and not h.get('is_cash')))

    print(f'  KR종목: {len(kr_tickers)}개, US종목: {len(us_tickers)}개')

    # 현재가 병렬 조회
    kr_map, us_map = {}, {}
    tasks = []
    if kr_open and kr_tickers:
        kr_map = await fetch_kr_all(kr_tickers)
    if us_open and us_tickers:
        us_map = await fetch_us_all(us_tickers)

    # 포트폴리오 데이터에 현재가 반영
    portfolio = apply_prices(portfolio, kr_map, us_map)
    portfolio['updated_at'] = updated_at
    portfolio['source']     = 'github_actions_python'

    # KV 저장
    ttl = calc_ttl()
    write_to_kv('portfolio_data', portfolio, ttl)

    elapsed = round(time.time() - start, 1)
    print(f'=== 완료: {elapsed}초 ===')

if __name__ == '__main__':
    asyncio.run(main())
