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

/** 公開境界で許可する error code。runtime 配列から型を導出。 */
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

/** Setは非公開。type guardだけ公開する。 */
const publicAiErrorCodeSet = new Set<PublicAiErrorCode>(PUBLIC_AI_ERROR_CODES);

export function isPublicAiErrorCode(value: unknown): value is PublicAiErrorCode {
  return typeof value === 'string' && publicAiErrorCodeSet.has(value as PublicAiErrorCode);
}

/** ADR-003: 公開SSEで配信する allow-list 済みイベント */
export type PublicAiRunEvent =
  | { status: 'queued' | 'admitted' | 'generating' | 'repairing' }
  | { status: 'completed'; post_ids: readonly string[] }
  | { status: 'failed'; error_code: PublicAiErrorCode };

/** useAiRunProgress の状態。connection_failed は Web 専用。 */
export type AiRunProgress =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'reconnecting' }
  | { status: 'connection_failed' }
  | { status: 'queued' | 'admitted' | 'generating' | 'repairing' }
  | { status: 'completed'; postIds: readonly string[] }
  | { status: 'failed'; errorCode: PublicAiErrorCode };
