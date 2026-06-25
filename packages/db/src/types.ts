// ── D1 database abstraction ─────────────────────────────
// V2 由来。unit test で FakeDb を差し込めるようにする。

export type D1ResultLike<T = unknown> = {
  results: T[];
};

export type D1BatchResultLike<T = unknown> = {
  results?: T[];
};

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): this;
  first: {
    <T = unknown>(colName: string): Promise<T | null>;
    <T = unknown>(): Promise<T | null>;
  };
  all: <T = unknown>() => Promise<D1ResultLike<T>>;
  run: () => Promise<unknown>;
  raw: {
    <T = unknown>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
    <T = unknown>(options?: { columnNames?: false }): Promise<T[]>;
  };
}

export type D1DatabaseClient<
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike
> = {
  prepare: (query: string) => TStatement;
  batch: <T = unknown>(
    statements: TStatement[],
  ) => Promise<D1BatchResultLike<T>[]>;
};

// ── AI run domain types ─────────────────────────────────

/** AI 生成フェーズ。initial = スレッド作成時、deep_dive = 返信時 */
export type AiRunStage = 'initial' | 'deep_dive';

/**
 * ADR-004: completing は導入しない。
 * terminal 状態 = completed | failed（他状態へ戻さない）
 */
export type AiRunStatus =
  | 'queued'
  | 'admitted'
  | 'generating'
  | 'repairing'
  | 'completed'
  | 'failed';

export type AiRunRow = {
  id: string;
  thread_id: string;
  source_post_id: string;
  idempotency_key: string;
  stage: AiRunStage;
  status: AiRunStatus;
  model: string;
  prompt_version: string;
  flue_run_id: string | null;
  provider_request_id: string | null;
  attempt_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  estimated_cost_micros: number | null;
  result_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  admitted_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type AiRunEventRow = {
  id: string;
  ai_run_id: string;
  sequence: number;
  event_type: 'status' | 'completed' | 'failed';
  data_json: string;
  created_at: string;
};

export type AiRunPostRow = {
  ai_run_id: string;
  post_id: string;
  ordinal: number;
};

// ── Error types ─────────────────────────────────────────

export class DbConflictError extends Error {
  readonly code = 'db_conflict';
  constructor(message: string) {
    super(message);
    this.name = 'DbConflictError';
  }
}

export class InvalidTransitionError extends Error {
  readonly code = 'invalid_transition';
  constructor(
    readonly aiRunId: string,
    readonly attemptedStatus: AiRunStatus,
  ) {
    super(
      `Invalid transition to '${attemptedStatus}' for ai_run '${aiRunId}'`,
    );
    this.name = 'InvalidTransitionError';
  }
}

// ── Command input/result types ──────────────────────────

export type CreateQueuedRunInput<
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
> = {
  db: D1DatabaseClient<TStatement>;
  id: string;
  threadId: string;
  sourcePostId: string;
  idempotencyKey: string;
  stage: AiRunStage;
  model: string;
  promptVersion: string;
  queuedEventId: string;
};

export type TransitionRunInput<
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
> = {
  db: D1DatabaseClient<TStatement>;
  aiRunId: string;
  eventId: string;
};

export type MarkRunGeneratingInput<
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
> = TransitionRunInput<TStatement> & {
  flueRunId: string | null;
};

/**
 * ADR-004: caller 入力は postId と body のみ。
 * author_type='ai'、author_name='名無しさん'、role=NULL は DB command 側で固定。
 * parent_post_id と source_post_number は ai_runs.source_post_id から導出。
 */
export type CompleteRunReplyInput = {
  postId: string;
  body: string;
};

export type CompleteRunUsageInput = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  estimatedCostMicros?: number | null;
};

export type CompleteRunAtomicInput<
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
> = {
  db: D1DatabaseClient<TStatement>;
  aiRunId: string;
  resultHash: string;
  completedEventId: string;
  replies: readonly CompleteRunReplyInput[];
  usage?: CompleteRunUsageInput;
};

export type CompleteRunAtomicResult = {
  aiRunId: string;
  postIds: string[];
  duplicate: boolean;
};

export type FailRunInput<
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
> = {
  db: D1DatabaseClient<TStatement>;
  aiRunId: string;
  eventId: string;
  errorCode: string;
  errorMessage: string;
};

/**
 * generation context: #9 では fallback としての基本取得。
 * #11 で context assembler を別関数に切り出す。
 * ADR-004: prior posts は source post より前の直近 8 件、thinking 除外。
 */
export type AiGenerationContext = {
  aiRun: AiRunRow;
  thread: { id: string; title: string; body: string };
  sourcePost: { id: string; post_number: number; body: string };
  recentPosts: Array<{
    id: string;
    post_number: number;
    author_type: string;
    author_name: string;
    body: string;
    parent_post_id: string | null;
  }>;
};

// ── Phase 2A-2: Atomic thread/post + queued run ─────────

export type CreateThreadWithQueuedRunInput<
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
> = {
  db: D1DatabaseClient<TStatement>;
  thread: { id: string; title: string; body: string };
  post: { id: string; authorName: string; userId: string | null };
  aiRun: {
    id: string;
    idempotencyKey: string;
    model: string;
    promptVersion: string;
  };
  queuedEventId: string;
};

export type CreateThreadWithQueuedRunResult = {
  threadId: string;
  firstPostId: string;
  aiRunId: string;
};

export type InsertHumanPostWithQueuedRunInput<
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
> = {
  db: D1DatabaseClient<TStatement>;
  post: {
    id: string;
    threadId: string;
    authorName: string;
    body: string;
    userId: string | null;
  };
  aiRun: {
    id: string;
    idempotencyKey: string;
    model: string;
    promptVersion: string;
  };
  queuedEventId: string;
};

export type InsertHumanPostWithQueuedRunResult = {
  postId: string;
  postNumber: number;
  threadTitle: string;
  aiRunId: string;
};
