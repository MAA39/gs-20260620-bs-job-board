import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { internalCallbackRoutes, computeHash } from '../routes/internal-callbacks.ts';
import {
  createQueuedRun,
  markRunAdmitted,
  markRunGenerating,
  getAiRunById,
} from '@bs-job-board/db/ai-pipeline';

// ── Test constants ──────────────────────────────────────

const CALLBACK_KEY = 'test-callback-key-for-integration';
/** Same length as CALLBACK_KEY to exercise constant-time comparison loop */
const WRONG_KEY_SAME_LEN = 'XXXX-callback-key-for-integration';

// ── Test app ────────────────────────────────────────────

const app = new Hono();
app.route('/internal/v1/ai-runs', internalCallbackRoutes);

const database = env.DB;
type DbParam = Parameters<typeof createQueuedRun>[0]['db'];
const db = database as unknown as DbParam;

// ── Response helper ─────────────────────────────────────

type AnyJson = Record<string, unknown>;
const json = async (res: Response): Promise<AnyJson> => res.json() as Promise<AnyJson>;

// ── Hash helper (canonical, same as API) ────────────────

const canonicalHash = async (bodies: string[]): Promise<string> =>
  computeHash(JSON.stringify(bodies));

// ── Seed helpers ────────────────────────────────────────

const seedThread = async (threadId: string) => {
  await database
    .prepare('INSERT INTO threads (id, title, body) VALUES (?, ?, ?)')
    .bind(threadId, `title ${threadId}`, `body ${threadId}`)
    .run();
};

const seedHumanPost = async (postId: string, threadId: string, postNumber: number) => {
  await database
    .prepare(
      "INSERT INTO posts (id, thread_id, post_number, author_type, author_name, body) VALUES (?, ?, ?, 'human', '名無しさん', ?)",
    )
    .bind(postId, threadId, postNumber, `human post ${postId}`)
    .run();
};

const seedQueuedRun = async (suffix: string) => {
  const threadId = `thread-${suffix}`;
  const postId = `post-${suffix}`;
  await seedThread(threadId);
  await seedHumanPost(postId, threadId, 1);
  await createQueuedRun({
    db, id: `run-${suffix}`, threadId, sourcePostId: postId,
    idempotencyKey: `idem-${suffix}`, stage: 'initial',
    model: 'sakura-ai/gpt-oss-120b', promptVersion: 'initial-v1',
    queuedEventId: `event-queued-${suffix}`,
  });
  return `run-${suffix}`;
};

const seedGeneratingRun = async (suffix: string) => {
  const runId = await seedQueuedRun(suffix);
  await markRunAdmitted({ db, aiRunId: runId, eventId: `ev-adm-${suffix}` });
  await markRunGenerating({ db, aiRunId: runId, eventId: `ev-gen-${suffix}`, flueRunId: null });
  return runId;
};

/** Build a valid complete payload with canonical hash */
const validReplies = ['レス1のテスト本文です', 'レス2のテスト本文です', 'レス3のテスト本文です'];

const makeCompletePayload = async (runId: string, overrides?: AnyJson) => {
  const bodies = (overrides?.bodies as string[] | undefined) ?? validReplies;
  const hash = await canonicalHash(bodies);
  return {
    protocolVersion: '1',
    aiRunId: runId,
    resultHash: hash,
    replies: bodies.map((body) => ({ body })),
    usage: { inputTokens: 100, outputTokens: 50 },
    ...overrides,
    // re-apply computed fields after overrides
    ...(overrides?.resultHash === undefined && !overrides?.bodies ? {} : {}),
  };
};

// ── Request helper ──────────────────────────────────────

const callbackRequest = (
  path: string,
  options: { key?: string | null; body?: unknown } = {},
) => {
  const { key = CALLBACK_KEY, body } = options;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['X-Callback-Key'] = key;
  return app.request(
    `http://localhost/internal/v1/ai-runs${path}`,
    { method: 'POST', headers, body: body !== undefined ? JSON.stringify(body) : undefined },
    { DB: database, INTERNAL_CALLBACK_KEY: CALLBACK_KEY },
  );
};

const countRows = async (table: string, where?: string): Promise<number> => {
  const q = where ? `SELECT COUNT(*) as cnt FROM ${table} WHERE ${where}` : `SELECT COUNT(*) as cnt FROM ${table}`;
  const result = await database.prepare(q).first<{ cnt: number }>();
  return result?.cnt ?? 0;
};

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

// ── 1. Authentication ────────────────────────────────────

describe('authentication', () => {
  test('missing X-Callback-Key → 401', async () => {
    const runId = await seedQueuedRun('auth-none');
    const res = await callbackRequest(`/${runId}/generating`, { key: null });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('unauthorized');
  });

  test('same-length wrong key → 401 (exercises constant-time loop)', async () => {
    const runId = await seedQueuedRun('auth-ct');
    const res = await callbackRequest(`/${runId}/generating`, { key: WRONG_KEY_SAME_LEN });
    expect(res.status).toBe(401);
  });

  test('unauthorized callback creates no events or posts', async () => {
    const runId = await seedQueuedRun('auth-side');
    const evBefore = await countRows('ai_run_events');
    await callbackRequest(`/${runId}/generating`, { key: WRONG_KEY_SAME_LEN });
    expect(await countRows('ai_run_events')).toBe(evBefore);
  });
});

// ── 2. Invalid payload ───────────────────────────────────

describe('invalid payload', () => {
  test('non-JSON body → 400', async () => {
    const runId = await seedGeneratingRun('bad-json');
    const res = await app.request(
      `http://localhost/internal/v1/ai-runs/${runId}/complete`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Callback-Key': CALLBACK_KEY }, body: 'not json' },
      { DB: database, INTERNAL_CALLBACK_KEY: CALLBACK_KEY },
    );
    expect(res.status).toBe(400);
  });

  test('missing protocolVersion → 400', async () => {
    const runId = await seedGeneratingRun('no-pv');
    const payload = await makeCompletePayload(runId);
    delete (payload as AnyJson).protocolVersion;
    const res = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('protocolVersion');
  });

  test('wrong protocolVersion → 400', async () => {
    const runId = await seedGeneratingRun('bad-pv');
    const payload = await makeCompletePayload(runId);
    (payload as AnyJson).protocolVersion = '999';
    const res = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('protocolVersion');
  });

  test('missing aiRunId in body → 400', async () => {
    const runId = await seedGeneratingRun('no-id');
    const payload = await makeCompletePayload(runId);
    delete (payload as AnyJson).aiRunId;
    const res = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('aiRunId');
  });

  test('aiRunId mismatch → 400', async () => {
    const runId = await seedGeneratingRun('id-mm');
    const payload = await makeCompletePayload(runId);
    (payload as AnyJson).aiRunId = 'wrong-id';
    const res = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res.status).toBe(400);
  });

  test('non-hex resultHash → 400', async () => {
    const runId = await seedGeneratingRun('bad-hash');
    const payload = await makeCompletePayload(runId);
    (payload as AnyJson).resultHash = 'not-a-hex';
    const res = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('64-char hex');
  });

  test('wrong reply count (2 instead of 3) → 400', async () => {
    const runId = await seedGeneratingRun('2-rep');
    const bodies = ['テスト本文レスです', 'もう一つのレスです'];
    const hash = await canonicalHash(bodies);
    const res = await callbackRequest(`/${runId}/complete`, {
      body: { protocolVersion: '1', aiRunId: runId, resultHash: hash, replies: bodies.map((b) => ({ body: b })) },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('3');
  });

  test('reply body < 5 chars → 400', async () => {
    const runId = await seedGeneratingRun('short');
    const bodies = ['ab', 'テスト本文レスです', 'もう一つのレスだよ'];
    const hash = await canonicalHash(bodies);
    const res = await callbackRequest(`/${runId}/complete`, {
      body: { protocolVersion: '1', aiRunId: runId, resultHash: hash, replies: bodies.map((b) => ({ body: b })) },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('5-200');
  });

  test('reply body > 200 chars → 400', async () => {
    const runId = await seedGeneratingRun('long');
    const bodies = ['あ'.repeat(201), 'テスト本文レスです', 'もう一つのレスだよ'];
    const hash = await canonicalHash(bodies);
    const res = await callbackRequest(`/${runId}/complete`, {
      body: { protocolVersion: '1', aiRunId: runId, resultHash: hash, replies: bodies.map((b) => ({ body: b })) },
    });
    expect(res.status).toBe(400);
  });

  test('hash does not match reply content → 400', async () => {
    const runId = await seedGeneratingRun('bad-hmatch');
    const payload = await makeCompletePayload(runId);
    (payload as AnyJson).resultHash = 'a'.repeat(64); // valid hex but wrong
    const res = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('does not match');
  });

  test('negative usage value → 400', async () => {
    const runId = await seedGeneratingRun('neg-use');
    const payload = await makeCompletePayload(runId);
    (payload as AnyJson).usage = { inputTokens: -1, outputTokens: 50 };
    const res = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('usage');
  });

  test('float usage value → 400', async () => {
    const runId = await seedGeneratingRun('float-use');
    const payload = await makeCompletePayload(runId);
    (payload as AnyJson).usage = { inputTokens: 3.7, outputTokens: 50 };
    const res = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res.status).toBe(400);
  });
});

// ── 3. Complete success ──────────────────────────────────

describe('complete success', () => {
  test('returns postIds, stores posts + ai_run_posts + completed event, saves trimmed body', async () => {
    const runId = await seedGeneratingRun('ok');
    const rawBodies = ['  レス1のテスト本文です  ', 'レス2のテスト本文です', 'レス3のテスト本文です'];
    const trimmedBodies = rawBodies.map((b) => b.trim());
    const hash = await canonicalHash(trimmedBodies);
    const payload = {
      protocolVersion: '1', aiRunId: runId, resultHash: hash,
      replies: rawBodies.map((body) => ({ body })),
      usage: { inputTokens: 100, outputTokens: 50 },
    };

    const postsBefore = await countRows('posts');
    const linksBefore = await countRows('ai_run_posts');

    const res = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(false);
    expect(body.postIds).toHaveLength(3);

    // verify run completed
    const run = await getAiRunById(db, runId);
    expect(run?.status).toBe('completed');
    expect(run?.result_hash).toBe(hash);
    expect(run?.input_tokens).toBe(100);

    // verify posts created (trimmed)
    expect(await countRows('posts')).toBe(postsBefore + 3);
    const savedPost = await database
      .prepare('SELECT body FROM posts WHERE id = ?')
      .bind((body.postIds as string[])[0])
      .first<{ body: string }>();
    expect(savedPost?.body).toBe(trimmedBodies[0]);

    // verify ai_run_posts links created
    expect(await countRows('ai_run_posts')).toBe(linksBefore + 3);

    // verify completed event exists
    const completedEvents = await countRows(
      'ai_run_events',
      `ai_run_id = '${runId}' AND event_type = 'completed'`,
    );
    expect(completedEvents).toBe(1);
  });
});

// ── 4. Duplicate detection ───────────────────────────────

describe('duplicate detection', () => {
  test('same replies + same hash → duplicate:true, no new posts/links/events', async () => {
    const runId = await seedGeneratingRun('dup');
    const payload = await makeCompletePayload(runId);

    const res1 = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res1.status).toBe(200);
    const firstPostIds = (await json(res1)).postIds as string[];

    const postsBefore = await countRows('posts');
    const linksBefore = await countRows('ai_run_posts');
    const eventsBefore = await countRows('ai_run_events');

    const res2 = await callbackRequest(`/${runId}/complete`, { body: payload });
    expect(res2.status).toBe(200);
    const body2 = await json(res2);
    expect(body2.duplicate).toBe(true);
    expect(body2.postIds).toEqual(firstPostIds);

    // no new side effects
    expect(await countRows('posts')).toBe(postsBefore);
    expect(await countRows('ai_run_posts')).toBe(linksBefore);
    expect(await countRows('ai_run_events')).toBe(eventsBefore);
  });

  test('different replies with their correct hash → 409 conflict', async () => {
    const runId = await seedGeneratingRun('conflict');
    const payload1 = await makeCompletePayload(runId);
    await callbackRequest(`/${runId}/complete`, { body: payload1 });

    // different replies → different canonical hash
    const altBodies = ['異なるレス1です。', '異なるレス2ですね。', '異なるレス3だよ。'];
    const altHash = await canonicalHash(altBodies);
    const payload2 = {
      protocolVersion: '1', aiRunId: runId, resultHash: altHash,
      replies: altBodies.map((body) => ({ body })),
    };
    const res = await callbackRequest(`/${runId}/complete`, { body: payload2 });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe('conflict');
  });
});

// ── 5. Fail callback ────────────────────────────────────

describe('fail callback', () => {
  test('stores safe message, discards raw errorMessage from payload', async () => {
    const runId = await seedGeneratingRun('fail-raw');
    const res = await callbackRequest(`/${runId}/fail`, {
      body: {
        errorCode: 'AI_PROVIDER_TIMEOUT',
        errorMessage: 'SENSITIVE: internal stack trace details here',
      },
    });
    expect(res.status).toBe(200);
    const run = await getAiRunById(db, runId);
    expect(run?.status).toBe('failed');
    expect(run?.error_code).toBe('AI_PROVIDER_TIMEOUT');
    expect(run?.error_message).toBe('AI provider did not respond within time limit');
    expect(run?.error_message).not.toContain('SENSITIVE');
  });

  test('unknown errorCode → AI_RUN_FAILED', async () => {
    const runId = await seedGeneratingRun('fail-unk');
    await callbackRequest(`/${runId}/fail`, { body: { errorCode: 'INVENTED' } });
    const run = await getAiRunById(db, runId);
    expect(run?.error_code).toBe('AI_RUN_FAILED');
  });

  test('missing errorCode → 400', async () => {
    const runId = await seedGeneratingRun('fail-no');
    const res = await callbackRequest(`/${runId}/fail`, { body: {} });
    expect(res.status).toBe(400);
  });
});

// ── 6. Terminal run (no side effects) ────────────────────

describe('terminal run', () => {
  test('generating on completed run → 409, no new events', async () => {
    const runId = await seedGeneratingRun('t-gen');
    await callbackRequest(`/${runId}/complete`, { body: await makeCompletePayload(runId) });
    const evBefore = await countRows('ai_run_events');
    const res = await callbackRequest(`/${runId}/generating`);
    expect(res.status).toBe(409);
    expect(await countRows('ai_run_events')).toBe(evBefore);
  });

  test('fail on completed run → 409, no new posts', async () => {
    const runId = await seedGeneratingRun('t-fail');
    await callbackRequest(`/${runId}/complete`, { body: await makeCompletePayload(runId) });
    const postsBefore = await countRows('posts');
    const res = await callbackRequest(`/${runId}/fail`, { body: { errorCode: 'AI_RUN_FAILED' } });
    expect(res.status).toBe(409);
    expect(await countRows('posts')).toBe(postsBefore);
  });

  test('complete on failed run → 409', async () => {
    const runId = await seedGeneratingRun('t-re');
    await callbackRequest(`/${runId}/fail`, { body: { errorCode: 'AI_RUN_FAILED' } });
    const res = await callbackRequest(`/${runId}/complete`, { body: await makeCompletePayload(runId) });
    expect(res.status).toBe(409);
  });
});

// ── 7. Agent D1 isolation ────────────────────────────────
// Structural verification covered by CI AI route guard step
// (grep checks for disallowed patterns in apps/api and apps/agent).
// Agent wrangler.jsonc: no d1_databases, workers_dev: false.
// Agent source: no env.DB reference.
// Cannot run inside miniflare sandbox (file:// not supported).
// Adding d1_databases to agent wrangler would break CI before tests.

// ── 8. Public post route: human-only (ADR-004) ──────────

describe('public post route is human-only', () => {
  test('server-owned fields in request body are ignored, post is always human', async () => {
    // Seed a thread
    const threadId = 'thread-human-only';
    await database
      .prepare('INSERT INTO threads (id, title, body) VALUES (?, ?, ?)')
      .bind(threadId, 'test thread', 'test body')
      .run();

    // Import full app (not just callback routes)
    const { default: fullApp } = await import('../index.ts');

    // POST with spoofed server-owned fields
    const res = await fullApp.request(
      `http://localhost/api/v1/threads/${threadId}/posts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: 'テスト投稿です',
          author_type: 'ai',
          role: 'thinking',
          source_post_number: 1,
        }),
      },
      {
        DB: database,
        BETTER_AUTH_SECRET: 'test-secret',
        INTERNAL_CALLBACK_KEY: CALLBACK_KEY,
        AGENT: { fetch: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) },
      } as Record<string, unknown>,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(201);

    // Verify: the saved post is ALWAYS human, never ai
    const posts = await database
      .prepare('SELECT author_type, role FROM posts WHERE thread_id = ? ORDER BY post_number DESC LIMIT 1')
      .bind(threadId)
      .first<{ author_type: string; role: string | null }>();
    expect(posts?.author_type).toBe('human');
    expect(posts?.role).toBeNull();
  });
});
