import { useState, useEffect, useCallback, useRef } from 'react';
import type { AiRunProgress, PublicAiRunEvent } from '@bs-job-board/contracts';

// ── Public event parser ─────────────────────────────────

function parsePublicAiRunEvent(raw: string): PublicAiRunEvent | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.status !== 'string') return null;
    return parsed as PublicAiRunEvent;
  } catch {
    return null;
  }
}

// ── Hook ────────────────────────────────────────────────

/**
 * AI run の進捗を購読する hook。
 *
 * - native EventSource で接続（自動再接続対応）
 * - completed → onCompleted コールバック → close
 * - failed → close
 * - component unmount → close
 * - **投稿 API を再実行しない**（SSE は購読専用）
 */
export function useAiRunProgress(
  aiRunId: string | null,
  apiBaseUrl: string,
  onCompleted: () => void,
): AiRunProgress {
  const [progress, setProgress] = useState<AiRunProgress>(
    aiRunId ? { status: 'connecting' } : { status: 'idle' },
  );
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  useEffect(() => {
    if (!aiRunId) {
      setProgress({ status: 'idle' });
      return;
    }

    setProgress({ status: 'connecting' });

    const url = `${apiBaseUrl}/api/v1/ai-runs/${encodeURIComponent(aiRunId)}/events?after=0`;
    const source = new EventSource(url);

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      const parsed = parsePublicAiRunEvent(message.data);
      if (!parsed) return;

      if (parsed.status === 'completed') {
        const postIds = 'post_ids' in parsed ? parsed.post_ids : undefined;
        setProgress({ status: 'completed', postIds });
        source.close();
        onCompletedRef.current();
      } else if (parsed.status === 'failed') {
        const errorCode = 'error_code' in parsed ? parsed.error_code : undefined;
        setProgress({ status: 'failed', errorCode });
        source.close();
      } else {
        setProgress({ status: parsed.status });
      }
    };

    source.addEventListener('ai-run', handleEvent);

    source.onerror = () => {
      // EventSource は切断時に自動再接続する。
      // readyState が CONNECTING なら再接続中。CLOSED ならもう戻らない。
      if (source.readyState === EventSource.CONNECTING) {
        setProgress((prev) => ({ ...prev, status: 'reconnecting' }));
      }
    };

    source.onopen = () => {
      // 再接続成功時、前回の status に戻す or connecting のまま
      setProgress((prev) =>
        prev.status === 'reconnecting' ? { ...prev, status: prev.status } : prev,
      );
    };

    return () => {
      source.close();
    };
  }, [aiRunId, apiBaseUrl]);

  return progress;
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
