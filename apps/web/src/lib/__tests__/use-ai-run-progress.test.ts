import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAiRunProgress } from '../use-ai-run-progress';

// ── EventSource mock ────────────────────────────────────

type EventHandler = (event: Event) => void;

class MockEventSource {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSED = 2 as const;

  readyState: number = MockEventSource.OPEN;
  url: string;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  private listeners = new Map<string, EventHandler[]>();
  private closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: EventHandler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: EventHandler) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter(h => h !== handler));
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  // ── テスト用ヘルパー ────────────────

  /** ai-run イベントを発火 */
  emitAiRunEvent(data: string) {
    const event = new MessageEvent('ai-run', { data });
    const handlers = this.listeners.get('ai-run') || [];
    for (const h of handlers) h(event);
  }

  /** onerror を発火（再接続シミュレーション） */
  simulateError() {
    this.readyState = MockEventSource.CONNECTING;
    this.onerror?.(new Event('error'));
  }

  /** onopen を発火（再接続成功） */
  simulateReconnect() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  get isClosed() { return this.closed; }

  // ── 全インスタンス追跡 ─────────────
  static instances: MockEventSource[] = [];
  static reset() { MockEventSource.instances = []; }
  static latest(): MockEventSource | undefined {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
}

// ── Setup ───────────────────────────────────────────────

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

// ── Tests ───────────────────────────────────────────────

describe('useAiRunProgress', () => {
  const API_BASE = 'http://test-api';

  test('高1回帰: completed後にaiRunIdがnullに変わるとidleに戻る（別スレッド移動）', () => {
    const onCompleted = vi.fn();
    const { result, rerender } = renderHook(
      ({ aiRunId }) => useAiRunProgress(aiRunId, API_BASE, onCompleted),
      { initialProps: { aiRunId: 'run-1' as string | null } },
    );

    const source = MockEventSource.latest()!;

    act(() => {
      source.emitAiRunEvent(JSON.stringify({ status: 'completed', post_ids: ['p1'] }));
    });

    expect(result.current.status).toBe('completed');
    expect(source.isClosed).toBe(true);
    expect(onCompleted).toHaveBeenCalledOnce();

    // 別スレッドへ移動: searchRunId=undefined → aiRunId=null
    rerender({ aiRunId: null });

    // idle に戻る（前スレッドの completed は残らない）
    expect(result.current.status).toBe('idle');
  });

  test('高1回帰: failed後にaiRunIdがnullに変わるとidleに戻る', () => {
    const onCompleted = vi.fn();
    const { result, rerender } = renderHook(
      ({ aiRunId }) => useAiRunProgress(aiRunId, API_BASE, onCompleted),
      { initialProps: { aiRunId: 'run-2' as string | null } },
    );

    const source = MockEventSource.latest()!;

    act(() => {
      source.emitAiRunEvent(JSON.stringify({ status: 'failed', error_code: 'AI_PROVIDER_TIMEOUT' }));
    });

    expect(result.current.status).toBe('failed');

    rerender({ aiRunId: null });

    expect(result.current.status).toBe('idle');
  });

  test('高1回帰: 同一スレッド内ではcompleted表示は残る（aiRunIdが変わらない限り）', () => {
    const onCompleted = vi.fn();
    const { result } = renderHook(
      () => useAiRunProgress('run-1b', API_BASE, onCompleted),
    );

    const source = MockEventSource.latest()!;

    act(() => {
      source.emitAiRunEvent(JSON.stringify({ status: 'completed', post_ids: ['p1'] }));
    });

    // aiRunIdが変わらない→completed表示は残る
    expect(result.current.status).toBe('completed');
  });

  test('高2回帰: onerror→onopen後にlastRunStatusへ復元される', () => {
    const onCompleted = vi.fn();
    const { result } = renderHook(
      () => useAiRunProgress('run-3', API_BASE, onCompleted),
    );

    const source = MockEventSource.latest()!;

    // generating まで進む
    act(() => {
      source.emitAiRunEvent(JSON.stringify({ status: 'generating' }));
    });
    expect(result.current.status).toBe('generating');

    // 切断 → reconnecting
    act(() => { source.simulateError(); });
    expect(result.current.status).toBe('reconnecting');

    // 再接続成功 → generating に復元（reconnecting のままにならない）
    act(() => { source.simulateReconnect(); });
    expect(result.current.status).toBe('generating');
  });

  test('高2回帰: run変更時にlastRunStatusRefがresetされる', () => {
    const onCompleted = vi.fn();
    const { result, rerender } = renderHook(
      ({ aiRunId }) => useAiRunProgress(aiRunId, API_BASE, onCompleted),
      { initialProps: { aiRunId: 'run-4a' as string | null } },
    );

    const source1 = MockEventSource.latest()!;

    // run-4a: generating まで
    act(() => {
      source1.emitAiRunEvent(JSON.stringify({ status: 'generating' }));
    });

    // run-4b に切り替え
    rerender({ aiRunId: 'run-4b' });
    const source2 = MockEventSource.latest()!;
    expect(source1.isClosed).toBe(true);

    // 新run で即切断 → reconnecting
    act(() => { source2.simulateError(); });
    expect(result.current.status).toBe('reconnecting');

    // 再接続成功 → connecting（前runのgeneratingではない）
    act(() => { source2.simulateReconnect(); });
    expect(result.current.status).toBe('connecting');
  });

  test('malformed data: parsePublicAiRunEventがnullを返しても壊れない', () => {
    const onCompleted = vi.fn();
    const { result } = renderHook(
      () => useAiRunProgress('run-5', API_BASE, onCompleted),
    );

    const source = MockEventSource.latest()!;

    // malformed event → 無視される
    act(() => {
      source.emitAiRunEvent('not-json');
      source.emitAiRunEvent('null');
      source.emitAiRunEvent('42');
      source.emitAiRunEvent('{"no_status": true}');
    });

    // connecting のまま（壊れない）
    expect(result.current.status).toBe('connecting');
    expect(source.isClosed).toBe(false);

    // 正常eventは受信できる
    act(() => {
      source.emitAiRunEvent(JSON.stringify({ status: 'generating' }));
    });
    expect(result.current.status).toBe('generating');
  });

  test('reconnect投稿非再実行: onCompletedはcompleted時の1回のみ', () => {
    const onCompleted = vi.fn();
    renderHook(
      () => useAiRunProgress('run-6', API_BASE, onCompleted),
    );

    const source = MockEventSource.latest()!;

    // generating → 切断 → 再接続 → completed
    act(() => { source.emitAiRunEvent(JSON.stringify({ status: 'generating' })); });
    act(() => { source.simulateError(); });
    act(() => { source.simulateReconnect(); });
    act(() => { source.emitAiRunEvent(JSON.stringify({ status: 'completed', post_ids: ['p1'] })); });

    // onCompleted は1回だけ呼ばれる
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  test('unmount時にEventSourceがcloseされる', () => {
    const onCompleted = vi.fn();
    const { unmount } = renderHook(
      () => useAiRunProgress('run-7', API_BASE, onCompleted),
    );

    const source = MockEventSource.latest()!;
    expect(source.isClosed).toBe(false);

    unmount();
    expect(source.isClosed).toBe(true);
  });
});

// ── B3: stale frame paint probe ─────────────────────────

import React, { useLayoutEffect } from 'react';
import { render } from '@testing-library/react';

function ProgressPaintProbe(props: {
  runId: string | null;
  onPaint: (status: string) => void;
}) {
  const progress = useAiRunProgress(props.runId, 'http://test-api', vi.fn());
  useLayoutEffect(() => {
    props.onPaint(progress.status);
  });
  return React.createElement('span', null, progress.status);
}

describe('stale frame paint', () => {
  test('run変更時に前runのterminal状態を1frameも描画しない', () => {
    const paints: string[] = [];
    const { rerender } = render(
      React.createElement(ProgressPaintProbe, {
        runId: 'run-paint-1',
        onPaint: (s: string) => paints.push(s),
      }),
    );

    act(() => {
      MockEventSource.latest()!.emitAiRunEvent(
        JSON.stringify({ status: 'completed', post_ids: ['post-1'] }),
      );
    });

    const start = paints.length;

    rerender(
      React.createElement(ProgressPaintProbe, {
        runId: 'run-paint-2',
        onPaint: (s: string) => paints.push(s),
      }),
    );

    const newRunPaints = paints.slice(start);
    expect(newRunPaints[0]).toBe('connecting');
    expect(newRunPaints).not.toContain('completed');
  });

  test('runId=null最初のcommitがidleで、failedが描画されない', () => {
    const paints: string[] = [];
    const { rerender } = render(
      React.createElement(ProgressPaintProbe, {
        runId: 'run-paint-3',
        onPaint: (s: string) => paints.push(s),
      }),
    );

    act(() => {
      MockEventSource.latest()!.emitAiRunEvent(
        JSON.stringify({ status: 'failed', error_code: 'AI_RUN_FAILED' }),
      );
    });

    const start = paints.length;

    rerender(
      React.createElement(ProgressPaintProbe, {
        runId: null,
        onPaint: (s: string) => paints.push(s),
      }),
    );

    const nullRunPaints = paints.slice(start);
    expect(nullRunPaints[0]).toBe('idle');
    expect(nullRunPaints).not.toContain('failed');
  });

  test('reconnect 中に投稿 API は再実行されない (onCompleted は completed 時のみ)', () => {
    const onCompleted = vi.fn();
    const { result } = renderHook(
      () => useAiRunProgress('run-recon', 'http://test-api', onCompleted),
    );

    const source = MockEventSource.latest()!;

    // generating → 切断 → 再接続 → generating → completed
    act(() => { source.emitAiRunEvent(JSON.stringify({ status: 'generating' })); });
    act(() => { source.simulateError(); });
    act(() => { source.simulateReconnect(); });
    act(() => { source.emitAiRunEvent(JSON.stringify({ status: 'generating' })); });
    act(() => { source.emitAiRunEvent(JSON.stringify({ status: 'completed', post_ids: ['p1'] })); });

    expect(onCompleted).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('completed');
  });

  test('全status遷移: queued→admitted→generating→repairing→completed', () => {
    const onCompleted = vi.fn();
    const { result } = renderHook(
      () => useAiRunProgress('run-all', 'http://test-api', onCompleted),
    );

    const source = MockEventSource.latest()!;
    const statuses = ['queued', 'admitted', 'generating', 'repairing'] as const;

    for (const s of statuses) {
      act(() => { source.emitAiRunEvent(JSON.stringify({ status: s })); });
      expect(result.current.status).toBe(s);
    }

    act(() => {
      source.emitAiRunEvent(JSON.stringify({ status: 'completed', post_ids: ['p1', 'p2'] }));
    });
    expect(result.current.status).toBe('completed');
    expect(result.current.postIds).toEqual(['p1', 'p2']);
    expect(onCompleted).toHaveBeenCalledOnce();
  });
});
