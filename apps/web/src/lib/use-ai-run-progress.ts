import { useState, useEffect, useRef } from 'react';
import type { AiRunProgress, PublicAiRunEvent, PublicAiErrorCode } from '@bs-job-board/contracts';
import { PUBLIC_AI_ERROR_CODE_SET } from '@bs-job-board/contracts';

// ── Public event parser (runtime検証) ───────────────────

function parsePublicAiRunEvent(raw: string): PublicAiRunEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  switch (record.status) {
    case 'queued':
    case 'admitted':
    case 'generating':
    case 'repairing':
      return { status: record.status };

    case 'completed':
      if (
        !Array.isArray(record.post_ids) ||
        !record.post_ids.every((id): id is string => typeof id === 'string')
      ) {
        return null;
      }
      return { status: 'completed', post_ids: record.post_ids };

    case 'failed':
      if (
        typeof record.error_code !== 'string' ||
        !PUBLIC_AI_ERROR_CODE_SET.has(record.error_code)
      ) {
        return null;
      }
      return { status: 'failed', error_code: record.error_code as PublicAiErrorCode };

    default:
      return null;
  }
}

// ── Run-scoped state ────────────────────────────────────

type ScopedProgress = {
  runId: string | null;
  value: AiRunProgress;
};

function initialProgress(runId: string | null): AiRunProgress {
  return runId ? { status: 'connecting' } : { status: 'idle' };
}

// ── Hook ────────────────────────────────────────────────

/**
 * AI run の進捗を購読する hook。
 *
 * - run-scoped: runId が変わった最初の render から正しい状態を返す
 * - currentRunIdRef で旧 EventSource の遅延 event を拒否
 * - completed → onCompleted コールバック → close
 * - failed → close
 * - component unmount → close
 * - 投稿 API を再実行しない（SSE は購読専用）
 */
export function useAiRunProgress(
  aiRunId: string | null,
  apiBaseUrl: string,
  onCompleted: () => void,
): AiRunProgress {
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  // render 時点の最新 run。旧 EventSource の遅延 event を拒否する。
  const currentRunIdRef = useRef(aiRunId);
  currentRunIdRef.current = aiRunId;

  const lastRunStatusRef = useRef<AiRunProgress['status']>('connecting');

  const [state, setState] = useState<ScopedProgress>(() => ({
    runId: aiRunId,
    value: initialProgress(aiRunId),
  }));

  // effect を待たず、新 run の最初の render から正しい状態を返す。
  const visibleProgress =
    state.runId === aiRunId ? state.value : initialProgress(aiRunId);

  useEffect(() => {
    const runId = aiRunId;
    lastRunStatusRef.current = 'connecting';
    setState({ runId, value: initialProgress(runId) });

    if (!runId) return;

    let disposed = false;
    let terminalHandled = false;

    const source = new EventSource(
      `${apiBaseUrl}/api/v1/ai-runs/${encodeURIComponent(runId)}/events?after=0`,
    );

    const publish = (value: AiRunProgress): boolean => {
      if (disposed || currentRunIdRef.current !== runId) return false;
      setState({ runId, value });
      return true;
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      const parsed = parsePublicAiRunEvent(message.data);
      if (!parsed) return;

      if (parsed.status === 'completed') {
        if (terminalHandled) return;
        terminalHandled = true;
        if (!publish({ status: 'completed', postIds: parsed.post_ids })) return;
        source.close();
        onCompletedRef.current();
        return;
      }

      if (parsed.status === 'failed') {
        if (terminalHandled) return;
        terminalHandled = true;
        if (!publish({ status: 'failed', errorCode: parsed.error_code })) return;
        source.close();
        return;
      }

      lastRunStatusRef.current = parsed.status;
      publish({ status: parsed.status });
    };

    source.addEventListener('ai-run', handleEvent);

    source.onerror = () => {
      if (source.readyState === EventSource.CONNECTING) {
        publish({ status: 'reconnecting' });
      }
    };

    source.onopen = () => {
      if (disposed || currentRunIdRef.current !== runId) return;
      setState((prev) => {
        if (prev.runId !== runId || prev.value.status !== 'reconnecting') return prev;
        return { runId, value: { status: lastRunStatusRef.current } };
      });
    };

    return () => {
      disposed = true;
      source.removeEventListener('ai-run', handleEvent);
      source.close();
    };
  }, [aiRunId, apiBaseUrl]);

  return visibleProgress;
}

// ── Progress label ──────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  idle: '',
  connecting: '接続中...',
  reconnecting: '再接続中...',
  queued: '受付済み',
  admitted: 'AI受付完了',
  generating: 'AIがレスを考えています...',
  repairing: '形式を整えています...',
  completed: '完了',
  failed: 'エラーが発生しました',
};

export function getProgressLabel(progress: AiRunProgress): string {
  return STATUS_LABELS[progress.status] ?? '';
}
