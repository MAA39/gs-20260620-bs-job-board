import { useState, useEffect, useRef } from 'react';
import type { AiRunProgress, PublicAiRunEvent, PublicAiErrorCode } from '@bs-job-board/contracts';
import { isPublicAiErrorCode } from '@bs-job-board/contracts';

// ── Public event parser (runtime検証) ───────────────────

function parsePublicAiRunEvent(raw: string): PublicAiRunEvent | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  switch (record.status) {
    case 'queued':
    case 'admitted':
    case 'generating':
    case 'repairing':
      return { status: record.status };

    case 'completed':
      if (!Array.isArray(record.post_ids) || !record.post_ids.every((id): id is string => typeof id === 'string')) {
        return { status: 'failed', error_code: 'AI_EVENT_INVALID' };
      }
      return { status: 'completed', post_ids: record.post_ids };

    case 'failed': {
      const errorCode: PublicAiErrorCode = isPublicAiErrorCode(record.error_code)
        ? record.error_code
        : 'AI_RUN_FAILED';
      return { status: 'failed', error_code: errorCode };
    }

    default:
      return null;
  }
}

// ── Run-scoped state ────────────────────────────────────

type ScopedProgress = { runId: string | null; value: AiRunProgress };

function initialProgress(runId: string | null): AiRunProgress {
  return runId ? { status: 'connecting' } : { status: 'idle' };
}

// ── Hook ────────────────────────────────────────────────

export function useAiRunProgress(
  aiRunId: string | null,
  onCompleted: () => void,
): AiRunProgress {
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  const currentRunIdRef = useRef(aiRunId);
  currentRunIdRef.current = aiRunId;

  const lastRunStatusRef = useRef<AiRunProgress['status']>('connecting');

  const [state, setState] = useState<ScopedProgress>(() => ({
    runId: aiRunId,
    value: initialProgress(aiRunId),
  }));

  const visibleProgress = state.runId === aiRunId ? state.value : initialProgress(aiRunId);

  useEffect(() => {
    const runId = aiRunId;
    lastRunStatusRef.current = 'connecting';
    setState({ runId, value: initialProgress(runId) });

    if (!runId) return;

    let disposed = false;
    let terminalHandled = false;

    const source = new EventSource(
      `/api/v1/ai-runs/${encodeURIComponent(runId)}/events?after=0`,
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
      if (disposed || terminalHandled) return;
      if (source.readyState === EventSource.CONNECTING) {
        publish({ status: 'reconnecting' });
        return;
      }
      // CLOSED: 404, CORS, 致命的接続失敗
      terminalHandled = true;
      source.close();
      publish({ status: 'connection_failed' });
    };

    source.onopen = () => {
      if (disposed || currentRunIdRef.current !== runId) return;
      setState((prev) => {
        if (prev.runId !== runId || prev.value.status !== 'reconnecting') return prev;
        const s = lastRunStatusRef.current;
        return { runId, value: { status: s } as AiRunProgress };
      });
    };

    return () => {
      disposed = true;
      source.removeEventListener('ai-run', handleEvent);
      source.close();
    };
  }, [aiRunId]);

  return visibleProgress;
}

// ── Progress label (exhaustive) ─────────────────────────

const STATUS_LABELS = {
  idle: '',
  connecting: '接続中...',
  reconnecting: '再接続中...',
  connection_failed: '進捗へ接続できませんでした',
  queued: '受付済み',
  admitted: 'AI受付完了',
  generating: 'AIがレスを考えています...',
  repairing: '形式を整えています...',
  completed: '完了',
  failed: 'エラーが発生しました',
} satisfies Record<AiRunProgress['status'], string>;

export function getProgressLabel(progress: AiRunProgress): string {
  return STATUS_LABELS[progress.status];
}
