/** API共通のエラーレスポンス */
export type ApiError = {
  error: string;
};

/** スレッド作成のレスポンス */
export type CreateThreadResponse = {
  id: string;
  title: string;
};

/** レス作成のレスポンス */
export type CreatePostResponse = {
  id: string;
  post_number: number;
};

// ── AI run SSE ──────────────────────────────────────────

/** ADR-003: 公開SSEで配信する allow-list 済みイベント */
export type PublicAiRunEvent =
  | { status: 'queued' | 'admitted' | 'generating' | 'repairing' }
  | { status: 'completed'; post_ids: string[] }
  | { status: 'failed'; error_code: string };

/** useAiRunProgress の状態 */
export type AiRunProgress = {
  status: PublicAiRunEvent['status'] | 'connecting' | 'reconnecting' | 'idle';
  postIds?: string[];
  errorCode?: string;
};
