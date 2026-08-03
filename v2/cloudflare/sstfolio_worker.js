// ============================================================
// SSTfolio v2 Cloudflare Worker
// ============================================================
// 원칙
// - portfolio_data는 Python 수집기만 작성한다.
// - Worker는 가격 KV를 읽기만 하며 GAS 가격으로 fallback/덮어쓰기하지 않는다.
// - 보유종목 변경 후에는 캐시 삭제 대신 GitHub Actions sync를 요청한다.
// - 수동/긴급 수집은 KV 기반 전역 cooldown으로 중복 호출을 제한한다.
//
// KV binding
// - SSTFOLIO_KV -> sstfolio-v2-kv
//
// Variables
// - GAS_URL
// - GITHUB_REPO            예: owner/sstfolio-v2
// - GITHUB_WORKFLOW        기본 fetch-realtime.yml
// - ALLOWED_ORIGIN         예: https://owner.github.io 또는 *
//
// Secrets
// - GITHUB_TOKEN
// - SSTFOLIO_SECRET
// ============================================================

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const PORTFOLIO_KEY = 'portfolio_data';
const STATUS_KEY = 'collector_status';
const TRIGGER_KEY = 'trigger_state';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const cors = buildCorsHeaders(request, env);

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const json = (value, status = 200, extraHeaders = {}) => new Response(
      JSON.stringify(value),
      { status, headers: { ...cors, ...JSON_HEADERS, 'Cache-Control': 'no-store', ...extraHeaders } },
    );

    try {
      // ── 가격 포함 포트폴리오: KV read-only ──────────────────
      if (path === '/api/portfolio' && method === 'GET') {
        const cached = await env.SSTFOLIO_KV.get(PORTFOLIO_KEY);
        if (!cached) {
          return json({
            error: 'PRICE_DATA_NOT_READY',
            message: 'v2 가격 데이터가 아직 준비되지 않았습니다. GitHub Actions를 먼저 실행하세요.',
          }, 503, { 'X-Cache': 'MISS' });
        }
        return new Response(cached, {
          headers: {
            ...cors,
            ...JSON_HEADERS,
            'Cache-Control': 'no-store',
            'X-Cache': 'HIT',
            'X-SSTfolio-Version': '2.0',
          },
        });
      }

      // ── 검색 ────────────────────────────────────────────────
      if (path === '/api/search' && method === 'GET') {
        const q = url.searchParams.get('q') || '';
        return proxyGasGet(env, cors, `?action=search_ticker&q=${encodeURIComponent(q)}`);
      }

      // ── 종목/계좌 그룹: 성공 후 sync 요청, 가격 캐시 삭제 금지 ─
      if (path === '/api/holding' && method === 'POST') {
        const result = await proxyGasPost(request, env);
        const refresh = result.ok ? await requestCollector(env, 'sync', 'holding_change', true) : null;
        return json(attachRefresh(result, refresh), result.status);
      }

      if (path === '/api/account-group' && method === 'POST') {
        const result = await proxyGasPost(request, env);
        const refresh = result.ok ? await requestCollector(env, 'sync', 'account_group_change', true) : null;
        return json(attachRefresh(result, refresh), result.status);
      }

      // ── 스냅샷 ──────────────────────────────────────────────
      if (path === '/api/snapshot') {
        const cacheKey = 'snapshot_data';
        if (method === 'GET') {
          const reload = url.searchParams.get('reload') === '1';
          if (!reload) {
            const cached = await env.SSTFOLIO_KV.get(cacheKey);
            if (cached) {
              return new Response(cached, { headers: { ...cors, ...JSON_HEADERS, 'X-Cache': 'HIT' } });
            }
          }
          const data = await fetchGasText(env, '?action=snapshot');
          await env.SSTFOLIO_KV.put(cacheKey, data, { expirationTtl: 3600 });
          return new Response(data, { headers: { ...cors, ...JSON_HEADERS, 'X-Cache': 'MISS' } });
        }
        if (method === 'POST') {
          const result = await proxyGasPost(request, env);
          if (result.ok) await env.SSTFOLIO_KV.delete(cacheKey);
          return json(result.data, result.status);
        }
      }

      // ── 배당 ────────────────────────────────────────────────
      if (path === '/api/dividend') {
        if (method === 'GET') {
          const query = url.search ? url.search.replace('?', '&') : '';
          return proxyGasGet(env, cors, `?action=dividend${query}`);
        }
        if (method === 'POST') {
          const result = await proxyGasPost(request, env);
          return json(result.data, result.status);
        }
      }

      // ── 실현손익: 수량 변화 가능, 성공 후 sync ─────────────
      if (path === '/api/sale') {
        if (method === 'GET') {
          const query = url.search ? url.search.replace('?', '&') : '';
          return proxyGasGet(env, cors, `?action=sale${query}`);
        }
        if (method === 'POST') {
          const result = await proxyGasPost(request, env);
          const refresh = result.ok ? await requestCollector(env, 'sync', 'sale_change', true) : null;
          return json(attachRefresh(result, refresh), result.status);
        }
      }

      // ── 적립 관리 ───────────────────────────────────────────
      if (path === '/api/plan') {
        if (method === 'GET') return proxyGasGet(env, cors, '?action=plan');
        if (method === 'POST') {
          const result = await proxyGasPost(request, env);
          return json(result.data, result.status);
        }
      }

      // ── 입출금 ──────────────────────────────────────────────
      if (path === '/api/cashflow') {
        if (method === 'GET') {
          const query = url.search ? url.search.replace('?', '&') : '';
          return proxyGasGet(env, cors, `?action=cashflow${query}`);
        }
        if (method === 'POST') {
          const result = await proxyGasPost(request, env);
          return json(result.data, result.status);
        }
      }

      // ── 외부자산 ────────────────────────────────────────────
      if (path === '/api/external-asset') {
        if (method === 'GET') return proxyGasGet(env, cors, '?action=external_asset');
        if (method === 'POST') {
          const result = await proxyGasPost(request, env);
          return json(result.data, result.status);
        }
      }

      // ── 수집 요청 ────────────────────────────────────────────
      if (path === '/api/trigger-fetch' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const mode = body.mode === 'emergency_full' ? 'emergency_full' : 'auto';
        const result = await requestCollector(env, mode, body.reason || 'web_manual', false);
        return json(result.body, result.status);
      }

      // GAS/관리자용 갱신 요청: 가격 쓰기 대신 GitHub sync만 실행
      if (path === '/api/refresh' && method === 'POST') {
        if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
        const body = await request.json().catch(() => ({}));
        const mode = body.mode === 'emergency_full' ? 'emergency_full' : 'sync';
        const result = await requestCollector(env, mode, body.reason || 'gas_refresh', false);
        return json(result.body, result.status);
      }

      // 보조 캐시만 삭제한다. portfolio_data는 의도치 않은 GAS 오염을 막기 위해 삭제하지 않는다.
      if (path === '/api/cache-clear' && method === 'POST') {
        if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
        const keys = ['snapshot_data', 'dividend_data', 'sale_data'];
        await Promise.all(keys.map((key) => env.SSTFOLIO_KV.delete(key).catch(() => {})));
        return json({ success: true, cleared: keys, protected: [PORTFOLIO_KEY], at: new Date().toISOString() });
      }

      // ── 수집 진행 확인 ──────────────────────────────────────
      if (path === '/api/trigger-status' && method === 'GET') {
        const [trigger, portfolio, collector] = await Promise.all([
          readJsonKey(env, TRIGGER_KEY),
          readJsonKey(env, PORTFOLIO_KEY),
          readJsonKey(env, STATUS_KEY),
        ]);
        const baseline = trigger?.baseline_updated_at || null;
        const current = portfolio?.updated_at || null;
        const requestedAt = trigger?.requested_at || null;
        const collectorFinishedAt = collector?.finished_at || null;
        const collectorMatches = Boolean(
          requestedAt
          && collectorFinishedAt
          && Date.parse(collectorFinishedAt) >= Date.parse(requestedAt)
          && ['published', 'rejected', 'failed'].includes(collector?.status),
        );
        const portfolioAdvanced = Boolean(
          current
          && requestedAt
          && Date.parse(current) >= Date.parse(requestedAt)
          && (!baseline || current !== baseline || Date.parse(current) > Date.parse(baseline)),
        );
        const completed = portfolioAdvanced || (collectorMatches && collector?.status === 'published');
        return json({
          success: true,
          completed,
          terminal: collectorMatches,
          outcome: collectorMatches ? collector?.status : null,
          trigger,
          portfolio_updated_at: current,
          collector,
        });
      }

      // ── 헬스체크 ────────────────────────────────────────────
      if (path === '/api/health' && method === 'GET') {
        const [portfolio, collector, trigger] = await Promise.all([
          readJsonKey(env, PORTFOLIO_KEY),
          readJsonKey(env, STATUS_KEY),
          readJsonKey(env, TRIGGER_KEY),
        ]);
        const updatedAt = portfolio?.updated_at || null;
        const age = updatedAt ? Math.max(0, (Date.now() - Date.parse(updatedAt)) / 60000) : null;
        return json({
          status: portfolio ? 'ok' : 'not_ready',
          service: 'sstfolio-v2-worker',
          schema_version: '2.0',
          cache: portfolio ? 'hit' : 'miss',
          updated_at: updatedAt,
          last_good_at: portfolio?.last_good_at || null,
          data_age_minutes: age === null || Number.isNaN(age) ? null : Math.round(age * 10) / 10,
          freshness: portfolio?.freshness || null,
          fetch_stats: portfolio?.fetch_stats || null,
          collector,
          trigger,
          server_at: new Date().toISOString(),
        });
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error?.message || String(error) }, 500);
    }
  },
};

function buildCorsHeaders(request, env) {
  const requestOrigin = request.headers.get('Origin') || '';
  const configured = String(env.ALLOWED_ORIGIN || '*').split(',').map((value) => value.trim()).filter(Boolean);
  const allowOrigin = configured.includes('*') || configured.includes(requestOrigin)
    ? (configured.includes('*') ? '*' : requestOrigin)
    : configured[0] || '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sstfolio-Secret',
    'Vary': 'Origin',
  };
}

function authorized(request, env) {
  const supplied = request.headers.get('X-Sstfolio-Secret') || '';
  return Boolean(env.SSTFOLIO_SECRET && supplied === env.SSTFOLIO_SECRET);
}

async function fetchGasText(env, query) {
  if (!env.GAS_URL) throw new Error('GAS_URL not configured');
  const response = await fetch(env.GAS_URL + query, {
    headers: { 'User-Agent': 'sstfolio-v2-worker/2.0' },
    redirect: 'follow',
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GAS HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text;
}

async function proxyGasGet(env, cors, query) {
  const text = await fetchGasText(env, query);
  return new Response(text, { headers: { ...cors, ...JSON_HEADERS, 'Cache-Control': 'no-store' } });
}

async function proxyGasPost(request, env) {
  if (!env.GAS_URL) return { ok: false, status: 500, data: { error: 'GAS_URL not configured' } };
  const body = await request.text();
  const response = await fetch(env.GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'sstfolio-v2-worker/2.0' },
    body,
    redirect: 'follow',
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: `GAS invalid JSON: ${text.slice(0, 200)}` }; }
  const ok = response.ok && !data.error;
  return { ok, status: ok ? 200 : (response.status || 500), data };
}

function attachRefresh(result, refresh) {
  if (!result.data || typeof result.data !== 'object') return result.data;
  return {
    ...result.data,
    refresh_requested: Boolean(refresh?.body?.success),
    refresh_status: refresh?.body || null,
  };
}

async function readJsonKey(env, key) {
  const text = await env.SSTFOLIO_KV.get(key);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function requestCollector(env, mode, reason, bypassCooldown) {
  if (!env.GITHUB_TOKEN) {
    return { status: 500, body: { success: false, error: 'GITHUB_TOKEN not configured' } };
  }
  if (!env.GITHUB_REPO) {
    return { status: 500, body: { success: false, error: 'GITHUB_REPO not configured' } };
  }

  const now = Date.now();
  const cooldownSeconds = mode === 'emergency_full' ? 15 * 60 : 3 * 60;
  const previousTrigger = await readJsonKey(env, TRIGGER_KEY);
  const previousAt = previousTrigger?.requested_at ? Date.parse(previousTrigger.requested_at) : 0;
  if (!bypassCooldown && previousAt && now - previousAt < cooldownSeconds * 1000) {
    const retryAfter = Math.ceil((cooldownSeconds * 1000 - (now - previousAt)) / 1000);
    return {
      status: 429,
      body: {
        success: false,
        error: 'FETCH_COOLDOWN',
        message: `중복 수집 방지를 위해 ${retryAfter}초 후 다시 시도하세요.`,
        retry_after_sec: retryAfter,
        trigger: previousTrigger,
      },
    };
  }

  const portfolio = await readJsonKey(env, PORTFOLIO_KEY);
  const workflow = env.GITHUB_WORKFLOW || 'fetch-realtime.yml';
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sstfolio-v2-worker/2.0',
      },
      body: JSON.stringify({ ref: 'main', inputs: { mode } }),
    },
  );

  if (response.status !== 204) {
    const text = await response.text();
    return {
      status: 502,
      body: { success: false, error: `GitHub API ${response.status}: ${text.slice(0, 500)}` },
    };
  }

  const triggerState = {
    requested_at: new Date(now).toISOString(),
    mode,
    reason,
    baseline_updated_at: portfolio?.updated_at || null,
    requested_by: 'worker',
  };
  await env.SSTFOLIO_KV.put(TRIGGER_KEY, JSON.stringify(triggerState), { expirationTtl: 86400 });
  return {
    status: 202,
    body: {
      success: true,
      message: mode === 'emergency_full' ? '긴급 전체 최신화 요청 완료' : '현재가 수집 요청 완료',
      trigger: triggerState,
    },
  };
}
