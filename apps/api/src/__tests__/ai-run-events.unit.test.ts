import { describe, expect, test, vi } from 'vitest';
import { mapToPublicEvent } from '../routes/ai-run-events.ts';
import { pumpAiRunEvents, type StreamPort, type AiRunEventRow, type PumpOptions } from '../routes/pump-ai-run-events.ts';
import type { PublicAiRunEvent } from '@bs-job-board/contracts';

// ── mapper unit tests ───────────────────────────────────

describe('mapToPublicEvent', () => {
  test.each(['unknown', '__proto__', 'constructor'])('rejects unknown event type: %s', (t) => {
    expect(mapToPublicEvent(t, JSON.stringify({ status: 'queued' }))).toBeNull();
  });
  test('rejects null JSON', () => { expect(mapToPublicEvent('status', 'null')).toBeNull(); });
  test('rejects number JSON', () => { expect(mapToPublicEvent('status', '42')).toBeNull(); });
  test('rejects string JSON', () => { expect(mapToPublicEvent('status', '"hello"')).toBeNull(); });
  test('rejects invalid JSON', () => { expect(mapToPublicEvent('status', '{broken')).toBeNull(); });
  test('accepts valid status event', () => {
    expect(mapToPublicEvent('status', JSON.stringify({ status: 'generating' }))).toEqual({ status: 'generating' });
  });
  test('rejects eventType=status with status=completed', () => {
    expect(mapToPublicEvent('status', JSON.stringify({ status: 'completed', post_ids: ['x'] }))).toBeNull();
  });
  test('completed requires valid post_ids', () => {
    expect(mapToPublicEvent('completed', JSON.stringify({ status: 'completed' }))).toBeNull();
    expect(mapToPublicEvent('completed', JSON.stringify({ status: 'completed', post_ids: [1] }))).toBeNull();
  });
  test('failed with unknown error_code falls back to AI_RUN_FAILED', () => {
    expect(mapToPublicEvent('failed', JSON.stringify({ status: 'failed', error_code: 'ARBITRARY' })))
      .toEqual({ status: 'failed', error_code: 'AI_RUN_FAILED' });
  });
  test('failed exact shape: only status and error_code', () => {
    const result = mapToPublicEvent('failed', JSON.stringify({ status: 'failed', error_code: 'AI_PROVIDER_TIMEOUT', error_message: 'secret', stack: 'line 42' }));
    expect(Object.keys(result!).sort()).toEqual(['error_code', 'status']);
  });
});

// ── fake stream ─────────────────────────────────────────

function createFakeStream(): StreamPort & { output: string[]; triggerAbort: () => void } {
  let aborted = false;
  const abortListeners: Array<() => void> = [];
  const output: string[] = [];
  return {
    get aborted() { return aborted; },
    onAbort(listener) { abortListeners.push(listener); if (aborted) listener(); },
    async write(chunk) { output.push(chunk); },
    async writeSSE(msg) {
      let frame = '';
      if (msg.event) frame += `event: ${msg.event}\n`;
      frame += `data: ${msg.data}\n`;
      if (msg.id) frame += `id: ${msg.id}\n`;
      frame += '\n';
      output.push(frame);
    },
    output,
    triggerAbort() { aborted = true; for (const l of abortListeners) l(); },
  };
}

function basePumpOptions(overrides: Partial<PumpOptions> = {}): PumpOptions {
  return {
    aiRunId: 'run-1',
    startCursor: 0,
    pollMs: 100,
    heartbeatMs: 15_000,
    maxPolls: 1,
    now: () => 0,
    sleep: vi.fn(async () => undefined),
    listEventsAfter: vi.fn(async () => []),
    mapToPublicEvent,
    isTerminalEvent: (et) => et === 'completed' || et === 'failed',
    logStreamError: vi.fn(),
    ...overrides,
  };
}

// ── pump unit tests ─────────────────────────────────────

describe('pumpAiRunEvents', () => {
  test('abort後にlistEventsが増えない', async () => {
    const stream = createFakeStream();
    const listEventsAfter = vi.fn(async () => [] as AiRunEventRow[]);
    const opts = basePumpOptions({ maxPolls: 10, listEventsAfter });

    // 1回目のsleep中にabort
    (opts.sleep as ReturnType<typeof vi.fn>).mockImplementation(async (_ms: number, signal: AbortSignal) => {
      stream.triggerAbort();
      // signal.aborted should be true after triggerAbort → onAbort → ac.abort()
    });

    await pumpAiRunEvents(stream, opts);
    expect(listEventsAfter).toHaveBeenCalledTimes(1);
  });

  test('heartbeatをコメント行で送信する', async () => {
    const stream = createFakeStream();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(15_001);
    const opts = basePumpOptions({ maxPolls: 1, heartbeatMs: 15_000, now });

    await pumpAiRunEvents(stream, opts);
    expect(stream.output.join('')).toContain(': heartbeat\n\n');
  });

  test('maxPolls到達後に正常closeする', async () => {
    const stream = createFakeStream();
    const listEventsAfter = vi.fn(async () => [] as AiRunEventRow[]);
    const sleep = vi.fn(async () => undefined);
    const opts = basePumpOptions({ maxPolls: 3, listEventsAfter, sleep });

    await pumpAiRunEvents(stream, opts);
    expect(listEventsAfter).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('D1 errorがSSEに出ない', async () => {
    const stream = createFakeStream();
    const logStreamError = vi.fn();
    const opts = basePumpOptions({
      listEventsAfter: vi.fn(async () => { throw new Error('SECRET_DB_DETAIL'); }),
      logStreamError,
    });

    await pumpAiRunEvents(stream, opts);
    const allOutput = stream.output.join('');
    expect(allOutput).not.toContain('SECRET_DB_DETAIL');
    expect(allOutput).not.toContain('event: error');
    expect(logStreamError).toHaveBeenCalledWith({ aiRunId: 'run-1', name: 'Error' });
  });

  test('malformed row後もcursorを進める', async () => {
    const stream = createFakeStream();
    const listEventsAfter = vi.fn()
      .mockResolvedValueOnce([{ id: 'e1', ai_run_id: 'run-1', sequence: 1, event_type: 'status', data_json: 'null', created_at: '' } as AiRunEventRow])
      .mockResolvedValueOnce([{ id: 'e2', ai_run_id: 'run-1', sequence: 2, event_type: 'completed', data_json: JSON.stringify({ status: 'completed', post_ids: ['p1'] }), created_at: '' } as AiRunEventRow]);
    const opts = basePumpOptions({ maxPolls: 2, listEventsAfter });

    await pumpAiRunEvents(stream, opts);
    const allOutput = stream.output.join('');
    expect(allOutput).toContain('id: 1\n\n');
    expect(allOutput).toContain('id: 2');
    expect(listEventsAfter.mock.calls.map((c: unknown[]) => c[1])).toEqual([0, 1]);
  });

  test('terminal後にreturnする', async () => {
    const stream = createFakeStream();
    const listEventsAfter = vi.fn().mockResolvedValueOnce([
      { id: 'e1', ai_run_id: 'run-1', sequence: 1, event_type: 'completed', data_json: JSON.stringify({ status: 'completed', post_ids: ['p1'] }), created_at: '' } as AiRunEventRow,
    ]);
    const opts = basePumpOptions({ maxPolls: 10, listEventsAfter });

    await pumpAiRunEvents(stream, opts);
    expect(listEventsAfter).toHaveBeenCalledTimes(1);
    expect(opts.sleep).not.toHaveBeenCalled();
  });
});
