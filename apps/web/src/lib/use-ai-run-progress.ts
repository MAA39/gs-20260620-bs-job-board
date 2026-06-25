import { useState, useEffect, useRef } from 'react';
import type { AiRunProgress, PublicAiRunEvent } from '@bs-job-board/contracts';

// ── Public event parser ─────────────────────────────────

function parsePublicAiRunEvent(raw: string): PublicAiRunEvent | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.status !== 'string') return null;
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

  // 前 run の domain status を次 run の再接続時に復元しないよう、
  // aiRunId 変更時に必ず reset する。
  const lastRunStatusRef = useRef<AiRunProgress['status']>('connecting');

  useEffect(() => {
    if (!aiRunId) {
      // aiRunId が null なら idle。ただし terminal 状態を上書きしない。
      setProgress((prev) => {
        if (prev.status === 'completed' || prev.status === 'failed') return prev;
        return { status: 'idle' };
      });
      return;
    }

    // run 変更時: ref を reset
    lastRunStatusRef.current = 'connecting';
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
        lastRunStatusRef.current = parsed.status;
        setProgress({ status: parsed.status });
      }
    };

    source.addEventListener('ai-run', handleEvent);

    source.onerror = () => {
      if (source.readyState === EventSource.CONNECTING) {
        setProgress({ status: 'reconnecting' });
      }
    };

    source.onopen = () => {
      // 再接続成功時: 最後の domain status を復元
      setProgress((prev) =>
        prev.status === 'reconnecting'
          ? { status: lastRunStatusRef.current }
          : prev,
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
