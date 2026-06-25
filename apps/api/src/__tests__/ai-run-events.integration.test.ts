import { env } from 'cloudflare:workers';
import { describe, expect, test, beforeEach } from 'vitest';
import app from '../index.ts';

const database = env.DB;

// ── Helpers ─────────────────────────────────────────────

const makeEnv = () => ({
  DB: database,
  BETTER_AUTH_SECRET: 'test-secret',
  INTERNAL_CALLBACK_KEY: 'test-key',
  AGENT: { fetch: () => new Response('{}', { status: 200 }) },
});

const sseRequest = (
  aiRunId: string,
  options?: { after?: string; lastEventId?: string },
) => {
  const query = options?.after !== undefined ? `?after=${options.after}` : '';
  const headers: Record<string, string> = {};
  if (options?.lastEventId !== undefined) {
    headers['Last-Event-ID'] = options.lastEventId;
  }
  return app.request(
    `http://localhost/api/v1/ai-runs/${aiRunId}/events${query}`,
    { method: 'GET', headers },
    makeEnv(),
  );
};

/** SSE text をパースしてイベント配列にする */
function parseSSEEvents(text: string): Array<{ event?: string; data?: string; id?: string }> {
  const events: Array<{ event?: string; data?: string; id?: string }> = [];
  const blocks = text.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    if (block.startsWith(':')) continue; // コメント行（heartbeat等）
    const entry: { event?: string; data?: string; id?: string } = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) entry.event = line.slice(7);
      else if (line.startsWith('data: ')) entry.data = line.slice(6);
      else if (line.startsWith('id: ')) entry.id = line.slice(4);
    }
    if (entry.event || entry.data || entry.id) events.push(entry);
  }
  return events;
}

// ── Seed ────────────────────────────────────────────────

const TEST_THREAD_ID = 'test-thread-sse-001';
const TEST_POST_ID = 'test-post-sse-001';
const TEST_RUN_ID = 'test-run-sse-001';
const TEST_RUN_COMPLETED_ID = 'test-run-sse-completed';
const TEST_RUN_FAILED_ID = 'test-run-sse-failed';

beforeEach(async () => {
  // テーブルをクリア
  await database.batch([
    database.prepare('DELETE FROM ai_run_events'),
    database.prepare('DELETE FROM ai_run_posts'),
    database.prepare('DELETE FROM ai_runs'),
    database.prepare('DELETE FROM posts'),
    database.prepare('DELETE FROM threads'),
  ]);

  // seed: thread + post
  await database
    .prepare('INSERT INTO threads (id, title, body) VALUES (?, ?, ?)')
    .bind(TEST_THREAD_ID, 'SSE test thread', 'test body')
    .run();
  await database
    .prepare('INSERT INTO posts (id, thread_id, post_number, author_type, author_name, body) VALUES (?, ?, 1, ?, ?, ?)')
    .bind(TEST_POST_ID, TEST_THREAD_ID, 'human', '名無しさん', 'test post')
    .run();

  // seed: generating run with events
  await database
    .prepare(
      `INSERT INTO ai_runs (id, thread_id, source_post_id, idempotency_key, stage, status, model, prompt_version)
       VALUES (?, ?, ?, ?, 'initial', 'generating', 'test-model', 'v1')`,
    )
    .bind(TEST_RUN_ID, TEST_THREAD_ID, TEST_POST_ID, 'idem-sse-001')
    .run();
  await database.batch([
    database.prepare(
      `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json)
       VALUES (?, ?, 1, 'status', ?)`,
    ).bind('evt-1', TEST_RUN_ID, JSON.stringify({ status: 'queued' })),
    database.prepare(
      `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json)
       VALUES (?, ?, 2, 'status', ?)`,
    ).bind('evt-2', TEST_RUN_ID, JSON.stringify({ status: 'admitted' })),
    database.prepare(
      `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json)
       VALUES (?, ?, 3, 'status', ?)`,
    ).bind('evt-3', TEST_RUN_ID, JSON.stringify({ status: 'generating' })),
  ]);

  // seed: completed run
  await database
    .prepare(
      `INSERT INTO ai_runs (id, thread_id, source_post_id, idempotency_key, stage, status, model, prompt_version)
       VALUES (?, ?, ?, ?, 'initial', 'completed', 'test-model', 'v1')`,
    )
    .bind(TEST_RUN_COMPLETED_ID, TEST_THREAD_ID, TEST_POST_ID, 'idem-sse-completed')
    .run();
  await database.batch([
    database.prepare(
      `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json)
       VALUES (?, ?, 1, 'status', ?)`,
    ).bind('evt-c1', TEST_RUN_COMPLETED_ID, JSON.stringify({ status: 'queued' })),
    database.prepare(
      `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json)
       VALUES (?, ?, 2, 'completed', ?)`,
    ).bind('evt-c2', TEST_RUN_COMPLETED_ID, JSON.stringify({ status: 'completed', post_ids: ['p1', 'p2', 'p3'] })),
  ]);

  // seed: failed run
  await database
    .prepare(
      `INSERT INTO ai_runs (id, thread_id, source_post_id, idempotency_key, stage, status, model, prompt_version)
       VALUES (?, ?, ?, ?, 'initial', 'failed', 'test-model', 'v1')`,
    )
    .bind(TEST_RUN_FAILED_ID, TEST_THREAD_ID, TEST_POST_ID, 'idem-sse-failed')
    .run();
  await database.batch([
    database.prepare(
      `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json)
       VALUES (?, ?, 1, 'status', ?)`,
    ).bind('evt-f1', TEST_RUN_FAILED_ID, JSON.stringify({ status: 'queued' })),
    database.prepare(
      `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json)
       VALUES (?, ?, 2, 'failed', ?)`,
    ).bind('evt-f2', TEST_RUN_FAILED_ID, JSON.stringify({ status: 'failed', error_code: 'AI_PROVIDER_TIMEOUT' })),
  ]);
});

// ── Tests ───────────────────────────────────────────────

describe('GET /api/v1/ai-runs/:aiRunId/events', () => {
  test('unknown run → 404', async () => {
    const res = await sseRequest('nonexistent-run-id');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('ai_run not found');
  });

  test('invalid after (negative) → 400', async () => {
    const res = await sseRequest(TEST_RUN_ID, { after: '-1' });
    expect(res.status).toBe(400);
  });

  test('invalid after (non-integer) → 400', async () => {
    const res = await sseRequest(TEST_RUN_ID, { after: 'abc' });
    expect(res.status).toBe(400);
  });

  test('invalid after (float) → 400', async () => {
    const res = await sseRequest(TEST_RUN_ID, { after: '1.5' });
    expect(res.status).toBe(400);
  });

  test('completed run with no pending events → 204', async () => {
    // after=2: sequence 2 まで読んだ → 後続なし
    const res = await sseRequest(TEST_RUN_COMPLETED_ID, { after: '2' });
    expect(res.status).toBe(204);
  });

  test('failed run with no pending events → 204', async () => {
    const res = await sseRequest(TEST_RUN_FAILED_ID, { after: '2' });
    expect(res.status).toBe(204);
  });

  test('completed run with pending events → streams completed event', async () => {
    const res = await sseRequest(TEST_RUN_COMPLETED_ID, { after: '0' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    const events = parseSSEEvents(text);

    // completed event が含まれる
    const completedEvent = events.find(e => {
      if (!e.data) return false;
      const d = JSON.parse(e.data);
      return d.status === 'completed';
    });
    expect(completedEvent).toBeDefined();
    expect(JSON.parse(completedEvent!.data!).post_ids).toEqual(['p1', 'p2', 'p3']);
  });

  test('failed run streams failed event with error_code', async () => {
    const res = await sseRequest(TEST_RUN_FAILED_ID, { after: '0' });
    expect(res.status).toBe(200);

    const text = await res.text();
    const events = parseSSEEvents(text);

    const failedEvent = events.find(e => {
      if (!e.data) return false;
      const d = JSON.parse(e.data);
      return d.status === 'failed';
    });
    expect(failedEvent).toBeDefined();
    expect(JSON.parse(failedEvent!.data!).error_code).toBe('AI_PROVIDER_TIMEOUT');
  });

  test('resume with Last-Event-ID: receives only events after that sequence', async () => {
    // completed run: events at seq 1 (queued), 2 (completed)
    // Last-Event-ID: 1 → seq 2 (completed) のみ返す
    const res = await sseRequest(TEST_RUN_COMPLETED_ID, { lastEventId: '1' });
    expect(res.status).toBe(200);

    const text = await res.text();
    const events = parseSSEEvents(text).filter(e => e.event === 'ai-run' && e.data);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse(events[0].data!);
    expect(first.status).toBe('completed');
    expect(events[0].id).toBe('2');
  });

  test('Last-Event-ID takes precedence over ?after query', async () => {
    // after=0 だけど Last-Event-ID=1 → seq 1 以降のみ
    const res = await sseRequest(TEST_RUN_COMPLETED_ID, { after: '0', lastEventId: '1' });
    expect(res.status).toBe(200);

    const text = await res.text();
    const events = parseSSEEvents(text).filter(e => e.event === 'ai-run' && e.data);

    // Last-Event-ID=1 が優先されて seq 2 (completed) から
    expect(events.length).toBeGreaterThan(0);
    expect(Number(events[0].id)).toBeGreaterThan(1);
  });

  test('event: ai-run — allow-list方式で公開データのみ', async () => {
    const res = await sseRequest(TEST_RUN_COMPLETED_ID, { after: '0' });
    const text = await res.text();
    const events = parseSSEEvents(text).filter(e => e.event === 'ai-run' && e.data);

    for (const e of events) {
      const data = JSON.parse(e.data!);
      // 公開フィールドのみ
      expect(data.status).toBeDefined();
      // 非公開フィールドは含まない
      expect(data.prompt).toBeUndefined();
      expect(data.completion).toBeUndefined();
      expect(data.thinking).toBeUndefined();
      expect(data.stack).toBeUndefined();
      expect(data.result_hash).toBeUndefined();
      expect(data.error_message).toBeUndefined();
    }
  });

  test('SSE does not create or modify runs', async () => {
    const beforeCount = await database
      .prepare('SELECT COUNT(*) as cnt FROM ai_runs')
      .first<{ cnt: number }>();
    const beforeRun = await database
      .prepare('SELECT status FROM ai_runs WHERE id = ?')
      .bind(TEST_RUN_COMPLETED_ID)
      .first<{ status: string }>();

    await sseRequest(TEST_RUN_COMPLETED_ID, { after: '0' });

    const afterCount = await database
      .prepare('SELECT COUNT(*) as cnt FROM ai_runs')
      .first<{ cnt: number }>();
    const afterRun = await database
      .prepare('SELECT status FROM ai_runs WHERE id = ?')
      .bind(TEST_RUN_COMPLETED_ID)
      .first<{ status: string }>();

    expect(afterCount!.cnt).toBe(beforeCount!.cnt);
    expect(afterRun!.status).toBe(beforeRun!.status);
  });

  // ── 回帰テスト ──────────────────────────────────────

  test('malformed non-terminal row: skip and continue to next event', async () => {
    const RUN = 'test-run-malformed-nonterminal';
    await database.prepare(
      `INSERT INTO ai_runs (id, thread_id, source_post_id, idempotency_key, stage, status, model, prompt_version)
       VALUES (?, ?, ?, ?, 'initial', 'completed', 'test-model', 'v1')`,
    ).bind(RUN, TEST_THREAD_ID, TEST_POST_ID, 'idem-mf-nt').run();
    await database.batch([
      database.prepare(
        `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json) VALUES (?, ?, 1, 'status', 'null')`,
      ).bind('mf-nt-1', RUN),
      database.prepare(
        `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json) VALUES (?, ?, 2, 'completed', ?)`,
      ).bind('mf-nt-2', RUN, JSON.stringify({ status: 'completed', post_ids: ['x'] })),
    ]);

    const res = await sseRequest(RUN, { after: '0' });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSSEEvents(text).filter(e => e.event === 'ai-run' && e.data);

    // malformed seq 1 はskip、seq 2 (completed) が届く
    expect(events.length).toBe(1);
    expect(JSON.parse(events[0].data!).status).toBe('completed');
    expect(events[0].id).toBe('2');
  });

  test('malformed terminal row: returns AI_EVENT_INVALID', async () => {
    const RUN = 'test-run-malformed-terminal';
    await database.prepare(
      `INSERT INTO ai_runs (id, thread_id, source_post_id, idempotency_key, stage, status, model, prompt_version)
       VALUES (?, ?, ?, ?, 'initial', 'completed', 'test-model', 'v1')`,
    ).bind(RUN, TEST_THREAD_ID, TEST_POST_ID, 'idem-mf-t').run();
    await database.batch([
      database.prepare(
        `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json) VALUES (?, ?, 1, 'status', ?)`,
      ).bind('mf-t-1', RUN, JSON.stringify({ status: 'queued' })),
      database.prepare(
        `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json) VALUES (?, ?, 2, 'completed', 'null')`,
      ).bind('mf-t-2', RUN),
    ]);

    const res = await sseRequest(RUN, { after: '0' });
    const text = await res.text();
    const events = parseSSEEvents(text).filter(e => e.event === 'ai-run' && e.data);

    const last = events[events.length - 1];
    const data = JSON.parse(last.data!);
    expect(data.status).toBe('failed');
    expect(data.error_code).toBe('AI_EVENT_INVALID');
  });

  test('eventType=status with status=completed: treated as terminal and returns AI_EVENT_INVALID', async () => {
    const RUN = 'test-run-type-status-mismatch';
    await database.prepare(
      `INSERT INTO ai_runs (id, thread_id, source_post_id, idempotency_key, stage, status, model, prompt_version)
       VALUES (?, ?, ?, ?, 'initial', 'completed', 'test-model', 'v1')`,
    ).bind(RUN, TEST_THREAD_ID, TEST_POST_ID, 'idem-mismatch').run();
    await database.batch([
      database.prepare(
        `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json) VALUES (?, ?, 1, 'status', ?)`,
      ).bind('mm-1', RUN, JSON.stringify({ status: 'completed', post_ids: ['x'] })),
    ]);

    const res = await sseRequest(RUN, { after: '0' });
    const text = await res.text();
    const events = parseSSEEvents(text).filter(e => e.event === 'ai-run' && e.data);

    // eventType=status で status=completed → mapToPublicEvent returns null
    // isTerminalEvent returns true → AI_EVENT_INVALID
    expect(events.length).toBe(1);
    const data = JSON.parse(events[0].data!);
    expect(data.status).toBe('failed');
    expect(data.error_code).toBe('AI_EVENT_INVALID');
  });

  test('sensitive fields are stripped even when present in data_json', async () => {
    const RUN = 'test-run-sensitive';
    await database.prepare(
      `INSERT INTO ai_runs (id, thread_id, source_post_id, idempotency_key, stage, status, model, prompt_version)
       VALUES (?, ?, ?, ?, 'initial', 'completed', 'test-model', 'v1')`,
    ).bind(RUN, TEST_THREAD_ID, TEST_POST_ID, 'idem-sensitive').run();
    await database.batch([
      database.prepare(
        `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json) VALUES (?, ?, 1, 'status', ?)`,
      ).bind('sens-1', RUN, JSON.stringify({
        status: 'generating',
        prompt: 'secret system prompt',
        completion: 'raw model output',
        thinking: 'internal reasoning',
        error_message: 'internal error detail',
        result_hash: 'abc123',
      })),
      database.prepare(
        `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json) VALUES (?, ?, 2, 'completed', ?)`,
      ).bind('sens-2', RUN, JSON.stringify({
        status: 'completed',
        post_ids: ['p1'],
        prompt: 'leaked prompt',
        stack: 'Error at line 42',
      })),
    ]);

    const res = await sseRequest(RUN, { after: '0' });
    const text = await res.text();
    const events = parseSSEEvents(text).filter(e => e.event === 'ai-run' && e.data);

    for (const e of events) {
      const data = JSON.parse(e.data!);
      expect(data.prompt).toBeUndefined();
      expect(data.completion).toBeUndefined();
      expect(data.thinking).toBeUndefined();
      expect(data.error_message).toBeUndefined();
      expect(data.result_hash).toBeUndefined();
      expect(data.stack).toBeUndefined();
    }
  });

  test('failed event with unknown error_code falls back to AI_RUN_FAILED', async () => {
    const RUN = 'test-run-unknown-code';
    await database.prepare(
      `INSERT INTO ai_runs (id, thread_id, source_post_id, idempotency_key, stage, status, model, prompt_version)
       VALUES (?, ?, ?, ?, 'initial', 'failed', 'test-model', 'v1')`,
    ).bind(RUN, TEST_THREAD_ID, TEST_POST_ID, 'idem-unk').run();
    await database.batch([
      database.prepare(
        `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json) VALUES (?, ?, 1, 'failed', ?)`,
      ).bind('unk-1', RUN, JSON.stringify({ status: 'failed', error_code: 'ARBITRARY_STRING' })),
    ]);

    const res = await sseRequest(RUN, { after: '0' });
    const text = await res.text();
    const events = parseSSEEvents(text).filter(e => e.event === 'ai-run' && e.data);

    expect(events.length).toBe(1);
    const data = JSON.parse(events[0].data!);
    expect(data.error_code).toBe('AI_RUN_FAILED');
  });

  // 注: 未知eventTypeはD1 CHECK制約 (event_type IN ('status','completed','failed')) で
  // 保存自体が拒否される。Map fail-closedはD1制約を通過した場合の二重保護。
  // Unit testでroute factory mockを使って検証する（PR B）。
});
