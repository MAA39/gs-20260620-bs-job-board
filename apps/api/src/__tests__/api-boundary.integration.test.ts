import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import app from '../index.ts';

const database = env.DB;
const ALLOWED_ORIGIN = 'https://bs-job-board-web.masa-nekoshinshi39.workers.dev';
const REJECTED_ORIGIN = 'https://evil.example.com';

// ── Helpers ─────────────────────────────────────────────

const makeEnv = (overrides?: Partial<Record<string, unknown>>) => ({
  DB: database,
  BETTER_AUTH_SECRET: 'test-secret-for-boundary',
  INTERNAL_CALLBACK_KEY: 'test-callback-key',
  AGENT: { fetch: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) },
  ...overrides,
});

const makeExecutionCtx = () => {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
    pending,
  };
};

const getAnonymousSessionCookie = async (): Promise<string> => {
  const { ctx, pending } = makeExecutionCtx();
  const res = await app.request(
    'http://localhost/api/auth/sign-in/anonymous',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    makeEnv() as Record<string, unknown>,
    ctx,
  );
  await Promise.allSettled(pending);
  if (res.status !== 200) throw new Error(`anonymous sign-in failed: ${res.status}`);
  const cookies: string[] = [];
  res.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') cookies.push(v); });
  if (!cookies.length) {
    const single = res.headers.get('set-cookie');
    if (single) cookies.push(single);
  }
  return cookies.map((c) => c.split(';')[0]).join('; ');
};

const oversizedBody = (sizeKB: number) => 'x'.repeat(sizeKB * 1024);

// ── CORS ────────────────────────────────────────────────

describe('ADR-006 CORS boundary (#28)', () => {
  test('OPTIONS /api/v1/threads allowed origin → CORS headers present', async () => {
    const { ctx, pending } = makeExecutionCtx();
    const res = await app.request(
      'http://localhost/api/v1/threads',
      { method: 'OPTIONS', headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' } },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
  });

  test('OPTIONS /api/auth/sign-in/anonymous allowed origin → CORS headers present', async () => {
    const { ctx, pending } = makeExecutionCtx();
    const res = await app.request(
      'http://localhost/api/auth/sign-in/anonymous',
      { method: 'OPTIONS', headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' } },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
  });

  test('rejected origin → Access-Control-Allow-Origin is not the rejected origin', async () => {
    const { ctx, pending } = makeExecutionCtx();
    const res = await app.request(
      'http://localhost/api/v1/threads',
      { method: 'OPTIONS', headers: { Origin: REJECTED_ORIGIN, 'Access-Control-Request-Method': 'GET' } },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe(REJECTED_ORIGIN);
  });

  test('/internal/v1/ai-runs → no CORS headers', async () => {
    const { ctx, pending } = makeExecutionCtx();
    const res = await app.request(
      'http://localhost/internal/v1/ai-runs/fake-run-id/generating',
      {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json', 'X-Callback-Key': 'test-callback-key' },
        body: '{}',
      },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('/health → no CORS headers', async () => {
    const { ctx, pending } = makeExecutionCtx();
    const res = await app.request(
      'http://localhost/health',
      { method: 'GET', headers: { Origin: ALLOWED_ORIGIN } },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

// ── bodyLimit ───────────────────────────────────────────

describe('ADR-006 bodyLimit (#28)', () => {
  test('POST /api/v1/threads oversized → 413 + no DB side effect', async () => {
    const cookie = await getAnonymousSessionCookie();
    const { ctx, pending } = makeExecutionCtx();
    const beforeCount = (await database.prepare('SELECT COUNT(*) as c FROM threads').first<{ c: number }>())?.c ?? 0;
    const res = await app.request(
      'http://localhost/api/v1/threads',
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': String(11 * 1024) },
        body: oversizedBody(11),
      },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.status).toBe(413);
    const afterCount = (await database.prepare('SELECT COUNT(*) as c FROM threads').first<{ c: number }>())?.c ?? 0;
    expect(afterCount).toBe(beforeCount);
  });

  test('POST /api/v1/threads/:id/posts oversized → 413', async () => {
    const cookie = await getAnonymousSessionCookie();
    const threadId = crypto.randomUUID();
    await database.prepare('INSERT INTO threads (id, title, body) VALUES (?, ?, ?)').bind(threadId, 't', 'b').run();
    const { ctx, pending } = makeExecutionCtx();
    const res = await app.request(
      `http://localhost/api/v1/threads/${threadId}/posts`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': String(11 * 1024) },
        body: oversizedBody(11),
      },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.status).toBe(413);
  });

  test('POST /api/v1/threads/:id/react oversized → 413', async () => {
    const cookie = await getAnonymousSessionCookie();
    const threadId = crypto.randomUUID();
    await database.prepare('INSERT INTO threads (id, title, body) VALUES (?, ?, ?)').bind(threadId, 't', 'b').run();
    const { ctx, pending } = makeExecutionCtx();
    const res = await app.request(
      `http://localhost/api/v1/threads/${threadId}/react`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024) },
        body: oversizedBody(2),
      },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.status).toBe(413);
  });

  test('PATCH /api/v1/threads/:id oversized → 413', async () => {
    const cookie = await getAnonymousSessionCookie();
    const threadId = crypto.randomUUID();
    await database.prepare('INSERT INTO threads (id, title, body) VALUES (?, ?, ?)').bind(threadId, 't', 'b').run();
    const { ctx, pending } = makeExecutionCtx();
    const res = await app.request(
      `http://localhost/api/v1/threads/${threadId}`,
      {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024) },
        body: oversizedBody(2),
      },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.status).toBe(413);
  });

  test('internal complete authorized oversized → 413', async () => {
    const { ctx, pending } = makeExecutionCtx();
    const res = await app.request(
      'http://localhost/internal/v1/ai-runs/fake-run-id/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Callback-Key': 'test-callback-key', 'Content-Length': String(25 * 1024) },
        body: oversizedBody(25),
      },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.status).toBe(413);
  });

  test('internal callback unauthorized oversized → 401 + no CORS', async () => {
    const { ctx, pending } = makeExecutionCtx();
    const res = await app.request(
      'http://localhost/internal/v1/ai-runs/fake-run-id/complete',
      {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json', 'X-Callback-Key': 'wrong-key', 'Content-Length': String(25 * 1024) },
        body: oversizedBody(25),
      },
      makeEnv() as Record<string, unknown>,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
