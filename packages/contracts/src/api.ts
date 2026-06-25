/** API共通のエラーレスポンス */
export type ApiError = {
  error: string;
};

/** スレッド作成のレスポンス */
export type CreateThreadResponse = {
  id: string;
  title: string;
  ai_run: { id: string };
};

/** レス作成のレスポンス */
export type CreatePostResponse = {
  id: string;
  post_number: number;
  ai_run: { id: string };
};

// ── AI run SSE ──────────────────────────────────────────

/** 公開境界で許可する error code。runtime 配列から型を導出する。 */
export const PUBLIC_AI_ERROR_CODES = [
  'AI_CONFIGURATION_ERROR',
  'AI_PROVIDER_TIMEOUT',
  'AI_OUTPUT_INVALID',
  'AI_INPUT_INVALID',
  'AI_RUN_FAILED',
  'AI_DISPATCH_FAILED',
  'AI_EVENT_INVALID',
] as const;

export type PublicAiErrorCode = (typeof PUBLIC_AI_ERROR_CODES)[number];

/** 公開 error code の Set。API/Web 両方で重複なく参照する。 */
export const PUBLIC_AI_ERROR_CODE_SET = new Set<string>(PUBLIC_AI_ERROR_CODES);

/** ADR-003: 公開SSEで配信する allow-list 済みイベント */
export type PublicAiRunEvent =
  | { status: 'queued' | 'admitted' | 'generating' | 'repairing' }
  | { status: 'completed'; post_ids: string[] }
  | { status: 'failed'; error_code: PublicAiErrorCode };

/** useAiRunProgress の状態 */
export type AiRunProgress = {
  status: PublicAiRunEvent['status'] | 'connecting' | 'reconnecting' | 'idle';
  postIds?: string[];
  errorCode?: string;
};
