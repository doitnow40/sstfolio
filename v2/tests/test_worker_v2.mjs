/** 외부 서비스 없이 실행하는 SSTfolio v2 Worker 단위 테스트. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sourcePath = path.join(root, 'cloudflare', 'sstfolio_worker.js');
const tempPath = path.join(os.tmpdir(), `sstfolio_worker_v2_${process.pid}.mjs`);
await fs.copyFile(sourcePath, tempPath);
const { default: worker } = await import(pathToFileURL(tempPath).href + `?t=${Date.now()}`);

class KV {
  constructor() { this.m = new Map(); this.deleted = []; }
  async get(key) { return this.m.has(key) ? this.m.get(key) : null; }
  async put(key, value) { this.m.set(key, value); }
  async delete(key) { this.deleted.push(key); this.m.delete(key); }
}

function makeEnv(kv) {
  return {
    SSTFOLIO_KV: kv,
    GAS_URL: 'https://gas.example/exec',
    GITHUB_TOKEN: 'token',
    GITHUB_REPO: 'owner/repo',
    GITHUB_WORKFLOW: 'fetch-realtime.yml',
    SSTFOLIO_SECRET: 'secret',
    ALLOWED_ORIGIN: '*',
  };
}

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push([String(url), options]);
  if (String(url).includes('api.github.com')) return new Response(null, { status: 204 });
  if (String(url).startsWith('https://gas.example/exec')) {
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

try {
  const ctx = { waitUntil() {} };
  const kv = new KV();
  const env = makeEnv(kv);

  let response = await worker.fetch(new Request('https://worker.example/api/portfolio'), env, ctx);
  if (response.status !== 503) throw new Error('KV miss must return 503');

  await kv.put('portfolio_data', JSON.stringify({ updated_at: '2026-08-02T00:00:00Z', holdings: [] }));
  response = await worker.fetch(new Request('https://worker.example/api/portfolio'), env, ctx);
  if (response.status !== 200 || !(await response.text()).includes('updated_at')) throw new Error('KV hit failed');

  response = await worker.fetch(new Request('https://worker.example/api/trigger-fetch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'auto' }),
  }), env, ctx);
  if (response.status !== 202) throw new Error(`trigger not accepted: ${response.status} ${await response.text()}`);

  response = await worker.fetch(new Request('https://worker.example/api/trigger-fetch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'auto' }),
  }), env, ctx);
  if (response.status !== 429) throw new Error('cooldown not enforced');

  kv.deleted = [];
  response = await worker.fetch(new Request('https://worker.example/api/holding', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add_holding' }),
  }), env, ctx);
  if (kv.deleted.includes('portfolio_data')) throw new Error('holding mutation deleted portfolio_data');

  // 최초 실행(baseline 없음)도 새 portfolio 또는 같은 요청의 published collector로 완료되어야 한다.
  const kv2 = new KV();
  const env2 = makeEnv(kv2);
  response = await worker.fetch(new Request('https://worker.example/api/trigger-fetch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'emergency_full' }),
  }), env2, ctx);
  const triggerBody = await response.json();
  if (response.status !== 202) throw new Error('first trigger not accepted');
  const requestedAt = triggerBody.trigger.requested_at;
  const publishedAt = new Date(Date.parse(requestedAt) + 1000).toISOString();
  await kv2.put('portfolio_data', JSON.stringify({ updated_at: publishedAt, holdings: [] }));
  await kv2.put('collector_status', JSON.stringify({ status: 'published', finished_at: publishedAt }));
  response = await worker.fetch(new Request('https://worker.example/api/trigger-status'), env2, ctx);
  const status = await response.json();
  if (!status.completed || !status.terminal || status.outcome !== 'published') {
    throw new Error(`first-run completion detection failed: ${JSON.stringify(status)}`);
  }

  console.log('worker v2 unit tests passed');
} finally {
  globalThis.fetch = originalFetch;
  await fs.unlink(tempPath).catch(() => {});
}
