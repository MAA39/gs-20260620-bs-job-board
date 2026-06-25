import type {
  AiGenerationContext,
  AiRunEventRow,
  AiRunRow,
  AiRunStatus,
  CompleteRunAtomicInput,
  CompleteRunAtomicResult,
  CompleteRunUsageInput,
  CreateQueuedRunInput,
  D1BatchResultLike,
  D1DatabaseClient,
  D1PreparedStatementLike,
  FailRunInput,
  MarkRunGeneratingInput,
  TransitionRunInput,
} from './types.ts';
import { DbConflictError, InvalidTransitionError } from './types.ts';

// ── SQL fragments ───────────────────────────────────────

const AI_RUN_COLUMNS = [
  'id', 'thread_id', 'source_post_id', 'idempotency_key',
  'stage', 'status', 'model', 'prompt_version',
  'flue_run_id', 'provider_request_id', 'attempt_count',
  'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'estimated_cost_micros', 'result_hash',
  'error_code', 'error_message',
  'created_at', 'admitted_at', 'started_at', 'completed_at', 'updated_at',
].join(', ');

const selectAiRunByIdSql =
  `SELECT ${AI_RUN_COLUMNS} FROM ai_runs WHERE id = ?`;

const selectAiRunByIdempotencyKeySql =
  `SELECT ${AI_RUN_COLUMNS} FROM ai_runs WHERE idempotency_key = ?`;

const LEGACY_THINKING_AUTHOR = '🤔 AIの思考';
const RECENT_POSTS_LIMIT = 8;

// ── Helpers ─────────────────────────────────────────────

const now = () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const jsonData = (value: unknown): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('Cannot encode event data as JSON');
  }
  return encoded;
};

const firstBatchRow = <T>(
  result: D1BatchResultLike<unknown> | undefined,
  label: string,
): T => {
  const row = result?.results?.[0] as T | undefined;
  if (row === undefined) {
    throw new Error(`D1 batch did not return created ${label}`);
  }
  return row;
};

const isUniqueConstraintError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed');
};

const withConflictMapping = async <T>(
  action: () => Promise<T>,
  message: string,
): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new DbConflictError(message);
    }
    throw error;
  }
};

// ── Queued run creation ─────────────────────────────────

/**
 * ADR-004: queued run と queued event を同じ batch で作成する。
 * Phase 2A-2 (#10) で human post も同じ batch に組み込む。
 */
export const createQueuedRun = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  input: CreateQueuedRunInput<TStatement>,
): Promise<AiRunRow> => {
  const results = await withConflictMapping(
    () =>
      input.db.batch([
        input.db
          .prepare(
            [
              'INSERT INTO ai_runs',
              '(id, thread_id, source_post_id, idempotency_key,',
              'stage, status, model, prompt_version)',
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ].join(' '),
          )
          .bind(
            input.id,
            input.threadId,
            input.sourcePostId,
            input.idempotencyKey,
            input.stage,
            'queued',
            input.model,
            input.promptVersion,
          ),
        input.db
          .prepare(
            [
              'INSERT INTO ai_run_events',
              '(id, ai_run_id, sequence, event_type, data_json)',
              'VALUES (?, ?, 1, ?, ?)',
            ].join(' '),
          )
          .bind(
            input.queuedEventId,
            input.id,
            'status',
            jsonData({ status: 'queued' }),
          ),
        input.db.prepare(selectAiRunByIdSql).bind(input.id),
      ]),
    'ai_run idempotency key conflicts with an existing run',
  );

  return firstBatchRow<AiRunRow>(results[2], 'queued ai run');
};

// ── Read operations ─────────────────────────────────────

export const getAiRunById = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  db: D1DatabaseClient<TStatement>,
  aiRunId: string,
): Promise<AiRunRow | null> =>
  db.prepare(selectAiRunByIdSql).bind(aiRunId).first<AiRunRow>();

export const getAiRunByIdempotencyKey = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  db: D1DatabaseClient<TStatement>,
  idempotencyKey: string,
): Promise<AiRunRow | null> =>
  db
    .prepare(selectAiRunByIdempotencyKeySql)
    .bind(idempotencyKey)
    .first<AiRunRow>();

// ── Compare-and-set state transitions ───────────────────
//
// ADR-004: 前状態を SQL WHERE 条件で縛る。
// changes() > 0 で UPDATE 成功時のみ event INSERT する。
// 無効遷移では run row も event も変更しない。

/**
 * 状態遷移の共通パターン。
 * UPDATE が 0 行（前状態不一致）なら InvalidTransitionError を投げる。
 */
const assertTransitioned = (
  runAfter: AiRunRow,
  expectedStatus: AiRunStatus,
  aiRunId: string,
): void => {
  if (runAfter.status !== expectedStatus) {
    throw new InvalidTransitionError(aiRunId, expectedStatus);
  }
};

/** queued → admitted */
export const markRunAdmitted = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  input: TransitionRunInput<TStatement>,
): Promise<AiRunRow> => {
  const results = await input.db.batch([
    input.db
      .prepare(
        [
          'UPDATE ai_runs',
          `SET status = 'admitted',`,
          `admitted_at = COALESCE(admitted_at, ${now()}),`,
          `updated_at = ${now()}`,
          `WHERE id = ? AND status = 'queued'`,
        ].join(' '),
      )
      .bind(input.aiRunId),
    input.db
      .prepare(
        [
          'INSERT INTO ai_run_events',
          '(id, ai_run_id, sequence, event_type, data_json)',
          'SELECT ?, ?,',
          '(SELECT COALESCE(MAX(sequence), 0) + 1 FROM ai_run_events WHERE ai_run_id = ?),',
          '?, ?',
          'WHERE changes() > 0',
        ].join(' '),
      )
      .bind(
        input.eventId,
        input.aiRunId,
        input.aiRunId,
        'status',
        jsonData({ status: 'admitted' }),
      ),
    input.db.prepare(selectAiRunByIdSql).bind(input.aiRunId),
  ]);

  const run = firstBatchRow<AiRunRow>(results[2], 'ai run');
  assertTransitioned(run, 'admitted', input.aiRunId);
  return run;
};

/** admitted → generating */
export const markRunGenerating = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  input: MarkRunGeneratingInput<TStatement>,
): Promise<AiRunRow> => {
  const results = await input.db.batch([
    input.db
      .prepare(
        [
          'UPDATE ai_runs',
          `SET status = 'generating',`,
          'flue_run_id = COALESCE(?, flue_run_id),',
          `started_at = COALESCE(started_at, ${now()}),`,
          'attempt_count = CASE WHEN attempt_count = 0 THEN 1 ELSE attempt_count END,',
          `updated_at = ${now()}`,
          `WHERE id = ? AND status = 'admitted'`,
        ].join(' '),
      )
      .bind(input.flueRunId, input.aiRunId),
    input.db
      .prepare(
        [
          'INSERT INTO ai_run_events',
          '(id, ai_run_id, sequence, event_type, data_json)',
          'SELECT ?, ?,',
          '(SELECT COALESCE(MAX(sequence), 0) + 1 FROM ai_run_events WHERE ai_run_id = ?),',
          '?, ?',
          'WHERE changes() > 0',
        ].join(' '),
      )
      .bind(
        input.eventId,
        input.aiRunId,
        input.aiRunId,
        'status',
        jsonData({ status: 'generating' }),
      ),
    input.db.prepare(selectAiRunByIdSql).bind(input.aiRunId),
  ]);

  const run = firstBatchRow<AiRunRow>(results[2], 'ai run');
  assertTransitioned(run, 'generating', input.aiRunId);
  return run;
};

/** generating → repairing */
export const markRunRepairing = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  input: TransitionRunInput<TStatement>,
): Promise<AiRunRow> => {
  const results = await input.db.batch([
    input.db
      .prepare(
        [
          'UPDATE ai_runs',
          `SET status = 'repairing',`,
          'attempt_count = attempt_count + 1,',
          `updated_at = ${now()}`,
          `WHERE id = ? AND status = 'generating'`,
        ].join(' '),
      )
      .bind(input.aiRunId),
    input.db
      .prepare(
        [
          'INSERT INTO ai_run_events',
          '(id, ai_run_id, sequence, event_type, data_json)',
          'SELECT ?, ?,',
          '(SELECT COALESCE(MAX(sequence), 0) + 1 FROM ai_run_events WHERE ai_run_id = ?),',
          '?, ?',
          'WHERE changes() > 0',
        ].join(' '),
      )
      .bind(
        input.eventId,
        input.aiRunId,
        input.aiRunId,
        'status',
        jsonData({ status: 'repairing' }),
      ),
    input.db.prepare(selectAiRunByIdSql).bind(input.aiRunId),
  ]);

  const run = firstBatchRow<AiRunRow>(results[2], 'ai run');
  assertTransitioned(run, 'repairing', input.aiRunId);
  return run;
};

// ── Terminal transitions ────────────────────────────────

/**
 * queued | admitted | generating | repairing → failed
 * ADR-004: completed → failed は禁止。
 */
export const failRun = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  input: FailRunInput<TStatement>,
): Promise<AiRunRow> => {
  const truncatedMessage = input.errorMessage.slice(0, 500);
  const results = await input.db.batch([
    input.db
      .prepare(
        [
          'UPDATE ai_runs',
          `SET status = 'failed',`,
          'error_code = ?,',
          'error_message = ?,',
          `updated_at = ${now()}`,
          `WHERE id = ? AND status IN ('queued', 'admitted', 'generating', 'repairing')`,
        ].join(' '),
      )
      .bind(input.errorCode, truncatedMessage, input.aiRunId),
    input.db
      .prepare(
        [
          'INSERT INTO ai_run_events',
          '(id, ai_run_id, sequence, event_type, data_json)',
          'SELECT ?, ?,',
          '(SELECT COALESCE(MAX(sequence), 0) + 1 FROM ai_run_events WHERE ai_run_id = ?),',
          '?, ?',
          'WHERE changes() > 0',
        ].join(' '),
      )
      .bind(
        input.eventId,
        input.aiRunId,
        input.aiRunId,
        'failed',
        jsonData({ status: 'failed', error_code: input.errorCode }),
      ),
    input.db.prepare(selectAiRunByIdSql).bind(input.aiRunId),
  ]);

  const run = firstBatchRow<AiRunRow>(results[2], 'ai run');
  assertTransitioned(run, 'failed', input.aiRunId);
  return run;
};

/**
 * generating | repairing → completed
 *
 * ADR-004:
 * - caller 入力は postId + body のみ
 * - author_type='ai', author_name='名無しさん', role=NULL は固定
 * - parent_post_id = ai_runs.source_post_id, source_post_number は導出
 * - completed run + same hash → duplicate success
 * - completed run + different hash → DbConflictError
 */
export const completeRunAtomic = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  input: CompleteRunAtomicInput<TStatement>,
): Promise<CompleteRunAtomicResult> => {
  const run = await input.db
    .prepare(selectAiRunByIdSql)
    .bind(input.aiRunId)
    .first<AiRunRow>();

  if (run === null) {
    throw new Error('AI run not found');
  }

  // completed + same hash → duplicate success
  if (run.status === 'completed') {
    if (run.result_hash !== input.resultHash) {
      throw new DbConflictError('completed ai_run result hash conflict');
    }
    const existingPostIds = await selectPostIdsForRun(input.db, input.aiRunId);
    return { aiRunId: input.aiRunId, postIds: existingPostIds, duplicate: true };
  }

  // terminal 以外 && generating|repairing 以外 → 不正遷移
  if (run.status !== 'generating' && run.status !== 'repairing') {
    throw new InvalidTransitionError(input.aiRunId, 'completed');
  }

  const postIds = input.replies.map((reply) => reply.postId);

  // posts INSERT: V1 カラム構成 + ADR-004 dual-write
  const insertPostStatements = input.replies.map((reply) =>
    input.db
      .prepare(
        [
          'INSERT INTO posts',
          '(id, thread_id, post_number, author_type, author_name,',
          'role, body, source_post_number, parent_post_id, user_id)',
          'VALUES (?, ?,',
          '(SELECT COALESCE(MAX(post_number), 0) + 1 FROM posts WHERE thread_id = ?),',
          // ADR-004: 固定値。caller から受け取らない
          "'ai', '名無しさん', NULL, ?,",
          // dual-write: source_post_number は SQL サブクエリで導出
          '(SELECT post_number FROM posts WHERE id = ?),',
          '?, NULL)',
        ].join(' '),
      )
      .bind(
        reply.postId,
        run.thread_id,
        run.thread_id,
        reply.body,
        run.source_post_id, // source_post_number 導出用
        run.source_post_id, // parent_post_id
      ),
  );

  const linkStatements = input.replies.map((reply, index) =>
    input.db
      .prepare(
        'INSERT INTO ai_run_posts (ai_run_id, post_id, ordinal) VALUES (?, ?, ?)',
      )
      .bind(input.aiRunId, reply.postId, index),
  );

  const usage: CompleteRunUsageInput = input.usage ?? {};

  await withConflictMapping(
    () =>
      input.db.batch([
        ...insertPostStatements,
        ...linkStatements,
        input.db
          .prepare(
            [
              'UPDATE ai_runs',
              `SET status = 'completed',`,
              'result_hash = ?,',
              'input_tokens = ?,',
              'output_tokens = ?,',
              'cache_read_tokens = ?,',
              'cache_write_tokens = ?,',
              'estimated_cost_micros = ?,',
              `completed_at = COALESCE(completed_at, ${now()}),`,
              `updated_at = ${now()}`,
              `WHERE id = ? AND status IN ('generating', 'repairing')`,
            ].join(' '),
          )
          .bind(
            input.resultHash,
            usage.inputTokens ?? null,
            usage.outputTokens ?? null,
            usage.cacheReadTokens ?? null,
            usage.cacheWriteTokens ?? null,
            usage.estimatedCostMicros ?? null,
            input.aiRunId,
          ),
        input.db
          .prepare(
            [
              'INSERT INTO ai_run_events',
              '(id, ai_run_id, sequence, event_type, data_json)',
              'SELECT ?, ?,',
              '(SELECT COALESCE(MAX(sequence), 0) + 1 FROM ai_run_events WHERE ai_run_id = ?),',
              '?, ?',
              'WHERE changes() > 0',
            ].join(' '),
          )
          .bind(
            input.completedEventId,
            input.aiRunId,
            input.aiRunId,
            'completed',
            jsonData({ status: 'completed', post_ids: postIds }),
          ),
      ]),
    'ai_run completion conflicts with existing data',
  );

  return { aiRunId: input.aiRunId, postIds, duplicate: false };
};

// ── Event query ─────────────────────────────────────────

export const listAiRunEventsAfter = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  db: D1DatabaseClient<TStatement>,
  aiRunId: string,
  afterSequence: number,
): Promise<AiRunEventRow[]> => {
  const result = await db
    .prepare(
      [
        'SELECT id, ai_run_id, sequence, event_type, data_json, created_at',
        'FROM ai_run_events',
        'WHERE ai_run_id = ? AND sequence > ?',
        'ORDER BY sequence ASC',
      ].join(' '),
    )
    .bind(aiRunId, afterSequence)
    .all<AiRunEventRow>();

  return result.results;
};

// ── Generation context (fallback) ───────────────────────
//
// ADR-004: 直近 8 件は fallback。priorPosts で固定しない。
// #11 で context assembler（root / target / branch / recent /
// last-question-answer / covered-viewpoints / relevant-posts）に切り出す。
// thinking 除外: role='thinking' OR author_name=LEGACY_THINKING_AUTHOR

export const getAiGenerationContext = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  db: D1DatabaseClient<TStatement>,
  aiRunId: string,
): Promise<AiGenerationContext | null> => {
  const aiRun = await getAiRunById(db, aiRunId);
  if (aiRun === null) return null;

  const [thread, sourcePost] = await Promise.all([
    db
      .prepare('SELECT id, title, body FROM threads WHERE id = ?')
      .bind(aiRun.thread_id)
      .first<{ id: string; title: string; body: string }>(),
    db
      .prepare('SELECT id, post_number, body FROM posts WHERE id = ?')
      .bind(aiRun.source_post_id)
      .first<{ id: string; post_number: number; body: string }>(),
  ]);

  if (thread === null || sourcePost === null) return null;

  // ADR-004: source post より前の直近 RECENT_POSTS_LIMIT 件、昇順
  // thinking 除外: role='thinking' OR author_name=LEGACY_THINKING_AUTHOR
  const recentPostsResult = await db
    .prepare(
      [
        'SELECT id, post_number, author_type, author_name, body, parent_post_id',
        'FROM posts',
        'WHERE thread_id = ? AND post_number < ?',
        "AND (role IS NULL OR role != 'thinking')",
        'AND author_name != ?',
        'ORDER BY post_number DESC',
        'LIMIT ?',
      ].join(' '),
    )
    .bind(aiRun.thread_id, sourcePost.post_number, LEGACY_THINKING_AUTHOR, RECENT_POSTS_LIMIT)
    .all<{
      id: string;
      post_number: number;
      author_type: string;
      author_name: string;
      body: string;
      parent_post_id: string | null;
    }>();

  // DESC で取得した後、昇順に戻す
  const recentPosts = recentPostsResult.results.reverse();

  return { aiRun, thread, sourcePost, recentPosts };
};

// ── Internal helpers ────────────────────────────────────

const selectPostIdsForRun = async <
  TStatement extends D1PreparedStatementLike = D1PreparedStatementLike,
>(
  db: D1DatabaseClient<TStatement>,
  aiRunId: string,
): Promise<string[]> => {
  const result = await db
    .prepare(
      'SELECT post_id FROM ai_run_posts WHERE ai_run_id = ? ORDER BY ordinal ASC',
    )
    .bind(aiRunId)
    .all<{ post_id: string }>();

  return result.results.map((row) => row.post_id);
};
