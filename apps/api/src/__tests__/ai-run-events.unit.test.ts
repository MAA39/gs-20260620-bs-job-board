import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import {
  createAiRunEventRoutes,
  mapToPublicEvent,
  type AiRunRow,
  type AiRunEventRow,
  type SseRouteConfig,
} from '../routes/ai-run-events.ts';

// ── Test helpers ────────────────────────────────────────

function createTestApp(overrides: Partial<SseRouteConfig> = {}) {
  const routes = createAiRunEventRoutes(overrides);
  const app = new Hono();
  app.route('/api/v1/ai-runs', routes);
  return app;
}

const makeEnv = () => ({
  DB: {} as unknown as D1Database,
  BETTER_AUTH_SECRET: 'test-secret',
  INTERNAL_CALLBACK_KEY: 'test-key',
  AGENT: { fetch: () => new Response('{}', { status: 200 }) },
});

function parseSSEEvents(text: string): Array<{ event?: string; data?: string; id?: string }> {
  const events: Array<{ event?: string; data?: string; id?: string }> = [];
  const blocks = text.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    if (block.startsWith(':')) continue;
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

const generatingRun = { id: 'run-1', status: 'generating' } as AiRunRow;

// ── B2: mapper unit tests ───────────────────────────────

describe('mapToPublicEvent', () => {
  test.each(['unknown', '__proto__', 'constructor'])(
    'rejects unknown event type: %s',
    (eventType) => {
      expect(mapToPublicEvent(eventType, JSON.stringify({ status: 'queued' }))).toBeNull();
    },
  );

  test('rejects null JSON', () => {
    expect(mapToPublicEvent('status', 'null')).toBeNull();
  });

  test('rejects number JSON', () => {
    expect(mapToPublicEvent('status', '42')).toBeNull();
  });

  test('rejects string JSON', () => {
    expect(mapToPublicEvent('status', '"hello"')).toBeNull();
  });

  test('rejects invalid JSON', () => {
    expect(mapToPublicEvent('status', '{broken')).toBeNull();
  });

  test('accepts valid status event', () => {
    const result = mapToPublicEvent('status', JSON.stringify({ status: 'generating' }));
    expect(result).toEqual({ status: 'generating' });
  });

  test('rejects eventType=status with status=completed (fail-closed)', () => {
    expect(mapToPublicEvent('status', JSON.stringify({ status: 'completed', post_ids: ['x'] }))).toBeNull();
  });

  test('completed requires valid post_ids array', () => {
    expect(mapToPublicEvent('completed', JSON.stringify({ status: 'completed' }))).toBeNull();
    expect(mapToPublicEvent('completed', JSON.stringify({ status: 'completed', post_ids: [1] }))).toBeNull();
  });

  test('failed with unknown error_code falls back to AI_RUN_FAILED', () => {
    const result = mapToPublicEvent('failed', JSON.stringify({ status: 'failed', error_code: 'ARBITRARY' }));
    expect(result).toEqual({ status: 'failed', error_code: 'AI_RUN_FAILED' });
  });
});

// ── B2: route factory mock tests ────────────────────────

describe('SSE route (factory mock)', () => {
  test('heartbeat をコメント行で送信する', async () => {
    const listEvents = vi.fn(async () => [] as AiRunEventRow[]);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(15_001);
    const app = createTestApp({
      maxPolls: 1,
      heartbeatMs: 15_000,
      now,
      sleep: vi.fn(async () => undefined),
      listEvents: listEvents as unknown as SseRouteConfig["listEvents"],
      getRunById: vi.fn(async () => generatingRun),
    });
    const response = await app.request('http://localhost/api/v1/ai-runs/run-1/events', {}, makeEnv());
    expect(await response.text()).toContain(': heartbeat\n\n');
  });

  test('maxPolls 到達後に正常 close する', async () => {
    const listEvents = vi.fn(async () => [] as AiRunEventRow[]);
    const sleep = vi.fn(async () => undefined);
    const app = createTestApp({
      maxPolls: 3,
      listEvents: listEvents as unknown as SseRouteConfig["listEvents"],
      sleep,
      getRunById: vi.fn(async () => generatingRun),
    });
    const response = await app.request('http://localhost/api/v1/ai-runs/run-1/events', {}, makeEnv());
    await expect(response.text()).resolves.toBeDefined();
    expect(listEvents).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('stream 中の D1 error を公開しない', async () => {
    const logStreamError = vi.fn();
    const app = createTestApp({
      maxPolls: 1,
      getRunById: vi.fn(async () => generatingRun),
      listEvents: vi.fn(async () => { throw new Error('SECRET_DATABASE_DETAIL'); }),
      logStreamError,
      sleep: vi.fn(async () => undefined),
    });
    const response = await app.request('http://localhost/api/v1/ai-runs/run-1/events', {}, makeEnv());
    const text = await response.text();
    expect(text).not.toContain('SECRET_DATABASE_DETAIL');
    expect(text).not.toContain('event: error');
    expect(logStreamError).toHaveBeenCalledWith({ aiRunId: 'run-1', name: 'Error' });
  });

  test('malformed row 後も cursor を進める', async () => {
    const listEvents = vi.fn()
      .mockResolvedValueOnce([{
        id: 'event-1', ai_run_id: 'run-1', sequence: 1,
        event_type: 'status', data_json: 'null', created_at: '2026-06-25T00:00:00Z',
      } as AiRunEventRow])
      .mockResolvedValueOnce([{
        id: 'event-2', ai_run_id: 'run-1', sequence: 2,
        event_type: 'completed',
        data_json: JSON.stringify({ status: 'completed', post_ids: ['post-1'] }),
        created_at: '2026-06-25T00:00:01Z',
      } as AiRunEventRow]);
    const app = createTestApp({
      maxPolls: 2,
      sleep: vi.fn(async () => undefined),
      listEvents: listEvents as unknown as SseRouteConfig["listEvents"],
      getRunById: vi.fn(async () => generatingRun),
    });
    const response = await app.request('http://localhost/api/v1/ai-runs/run-1/events', {}, makeEnv());
    const text = await response.text();
    expect(text).toContain('id: 1\n\n');
    expect(text).toContain('id: 2');
    // 2回目の呼び出しで afterSequence=1 が渡される
    expect(listEvents.mock.calls.map((call) => call[2])).toEqual([0, 1]);
  });

  test('failed event の公開 shape は status と error_code のみ', async () => {
    const listEvents = vi.fn(async () => [{
      id: 'evt-1', ai_run_id: 'run-1', sequence: 1,
      event_type: 'failed',
      data_json: JSON.stringify({
        status: 'failed', error_code: 'AI_PROVIDER_TIMEOUT',
        error_message: 'secret detail', stack: 'Error at line 42',
      }),
      created_at: '2026-06-25T00:00:00Z',
    }] as AiRunEventRow[]);
    const app = createTestApp({
      maxPolls: 1,
      listEvents: listEvents as unknown as SseRouteConfig["listEvents"],
      getRunById: vi.fn(async () => generatingRun),
      sleep: vi.fn(async () => undefined),
    });
    const response = await app.request('http://localhost/api/v1/ai-runs/run-1/events', {}, makeEnv());
    const text = await response.text();
    const events = parseSSEEvents(text).filter(e => e.event === 'ai-run' && e.data);
    expect(events.length).toBe(1);
    const data = JSON.parse(events[0].data!);
    expect(Object.keys(data).sort()).toEqual(['error_code', 'status']);
  });
});
