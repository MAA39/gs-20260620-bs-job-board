export type AiRunStage = 'initial' | 'deep_dive';

export type AiRunStatus =
  | 'queued'
  | 'admitted'
  | 'generating'
  | 'repairing'
  | 'completing'
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

export class AiRunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiRunConflictError';
  }
}

const runColumns = [
  'id',
  'thread_id',
  'source_post_id',
  'idempotency_key',
  'stage',
  'status',
  'model',
  'prompt_version',
  'flue_run_id',
  'provider_request_id',
  'attempt_count',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'result_hash',
  'error_code',
  'error_message',
  'created_at',
  'admitted_at',
  'started_at',
  'completed_at',
  'updated_at',
].join(', ');

export async function getAiRunById(
  db: D1Database,
  aiRunId: string,
): Promise<AiRunRow | null> {
  return db
    .prepare(`SELECT ${runColumns} FROM ai_runs WHERE id = ?`)
    .bind(aiRunId)
    .first<AiRunRow>();
}

export async function getAiRunByIdempotencyKey(
  db: D1Database,
  idempotencyKey: string,
): Promise<AiRunRow | null> {
  return db
    .prepare(`SELECT ${runColumns} FROM ai_runs WHERE idempotency_key = ?`)
    .bind(idempotencyKey)
    .first<AiRunRow>();
}

export async function markRunAdmitted(
  db: D1Database,
  aiRunId: string,
): Promise<AiRunRow> {
  return transitionRun(db, aiRunId, 'admitted', ['queued'], {
    attemptIncrement: true,
    admittedAt: true,
  });
}

export async function markRunGenerating(
  db: D1Database,
  aiRunId: string,
  flueRunId: string,
): Promise<AiRunRow> {
  return transitionRun(db, aiRunId, 'generating', ['queued', 'admitted'], {
    flueRunId,
    startedAt: true,
  });
}

export async function markRunRepairing(
  db: D1Database,
  aiRunId: string,
): Promise<AiRunRow> {
  return transitionRun(db, aiRunId, 'repairing', ['generating']);
}

export async function failRun(
  db: D1Database,
  aiRunId: string,
  input: { errorCode: string; errorMessage: string },
): Promise<AiRunRow> {
  const current = await requireRun(db, aiRunId);
  if (current.status === 'completed' || current.status === 'failed') return current;

  const message = input.errorMessage.slice(0, 500);
  await db.batch([
    db
      .prepare(
        `UPDATE ai_runs
         SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND status != 'completed'`,
      )
      .bind(input.errorCode, message, now(), now(), aiRunId),
    eventStatement(db, aiRunId, 'failed', {
      status: 'failed',
      error_code: input.errorCode,
    }),
  ]);
  return requireRun(db, aiRunId);
}

export async function listAiRunEventsAfter(
  db: D1Database,
  aiRunId: string,
  afterSequence: number,
): Promise<AiRunEventRow[]> {
  const result = await db
    .prepare(
      `SELECT id, ai_run_id, sequence, event_type, data_json, created_at
       FROM ai_run_events
       WHERE ai_run_id = ? AND sequence > ?
       ORDER BY sequence ASC`,
    )
    .bind(aiRunId, afterSequence)
    .all<AiRunEventRow>();
  return result.results;
}

export async function completeRunAtomic(
  db: D1Database,
  input: {
    aiRunId: string;
    resultHash: string;
    replies: string[];
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
  },
): Promise<{ aiRunId: string; postIds: string[]; duplicate: boolean }> {
  const current = await requireRun(db, input.aiRunId);
  if (current.status === 'completed') {
    if (current.result_hash !== input.resultHash) {
      throw new AiRunConflictError('completed run result hash mismatch');
    }
    return {
      aiRunId: current.id,
      postIds: await getPostIdsForRun(db, current.id),
      duplicate: true,
    };
  }
  if (current.status === 'failed') {
    throw new AiRunConflictError('failed run cannot be completed');
  }

  const source = await db
    .prepare('SELECT post_number FROM posts WHERE id = ?')
    .bind(current.source_post_id)
    .first<{ post_number: number }>();
  if (!source) throw new Error('source post not found');

  for (let attempt = 0; attempt < 5; attempt++) {
    const max = await db
      .prepare('SELECT MAX(post_number) AS max_num FROM posts WHERE thread_id = ?')
      .bind(current.thread_id)
      .first<{ max_num: number | null }>();
    const firstPostNumber = (max?.max_num ?? 0) + 1;
    const postIds = input.replies.map(() => crypto.randomUUID());
    const statements: D1PreparedStatement[] = [];

    input.replies.forEach((body, ordinal) => {
      statements.push(
        db
          .prepare(
            `INSERT INTO posts
             (id, thread_id, post_number, author_type, author_name, role, body, source_post_number, user_id)
             VALUES (?, ?, ?, 'ai', '名無しさん', NULL, ?, ?, NULL)`,
          )
          .bind(
            postIds[ordinal],
            current.thread_id,
            firstPostNumber + ordinal,
            body,
            source.post_number,
          ),
        db
          .prepare('INSERT INTO ai_run_posts (ai_run_id, post_id, ordinal) VALUES (?, ?, ?)')
          .bind(current.id, postIds[ordinal], ordinal),
      );
    });

    statements.push(
      db
        .prepare(
          `UPDATE ai_runs
           SET status = 'completed', result_hash = ?, input_tokens = ?, output_tokens = ?,
               cache_read_tokens = ?, cache_write_tokens = ?, completed_at = ?, updated_at = ?
           WHERE id = ? AND status != 'completed'`,
        )
        .bind(
          input.resultHash,
          nonNegative(input.usage.inputTokens),
          nonNegative(input.usage.outputTokens),
          nonNegative(input.usage.cacheReadTokens),
          nonNegative(input.usage.cacheWriteTokens),
          now(),
          now(),
          current.id,
        ),
      eventStatement(db, current.id, 'completed', {
        status: 'completed',
        post_ids: postIds,
      }),
    );

    try {
      await db.batch(statements);
      return { aiRunId: current.id, postIds, duplicate: false };
    } catch (error) {
      if (!isPostNumberConflict(error) || attempt === 4) throw error;
    }
  }

  throw new Error('failed to allocate post numbers');
}

async function transitionRun(
  db: D1Database,
  aiRunId: string,
  target: AiRunStatus,
  allowed: AiRunStatus[],
  options: {
    attemptIncrement?: boolean;
    admittedAt?: boolean;
    startedAt?: boolean;
    flueRunId?: string;
  } = {},
): Promise<AiRunRow> {
  const current = await requireRun(db, aiRunId);
  if (current.status === target) return current;
  if (!allowed.includes(current.status)) {
    if (current.status === 'completed' || current.status === 'failed') return current;
    throw new AiRunConflictError(`cannot transition ${current.status} to ${target}`);
  }

  const timestamp = now();
  const updates = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [target, timestamp];
  if (options.attemptIncrement) updates.push('attempt_count = attempt_count + 1');
  if (options.admittedAt) {
    updates.push('admitted_at = COALESCE(admitted_at, ?)');
    values.push(timestamp);
  }
  if (options.startedAt) {
    updates.push('started_at = COALESCE(started_at, ?)');
    values.push(timestamp);
  }
  if (options.flueRunId) {
    updates.push('flue_run_id = COALESCE(flue_run_id, ?)');
    values.push(options.flueRunId);
  }
  values.push(aiRunId);

  await db.batch([
    db.prepare(`UPDATE ai_runs SET ${updates.join(', ')} WHERE id = ?`).bind(...values),
    eventStatement(db, aiRunId, 'status', { status: target }),
  ]);
  return requireRun(db, aiRunId);
}

function eventStatement(
  db: D1Database,
  aiRunId: string,
  eventType: AiRunEventRow['event_type'],
  data: Record<string, unknown>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ai_run_events (id, ai_run_id, sequence, event_type, data_json)
       VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM ai_run_events WHERE ai_run_id = ?), ?, ?)`,
    )
    .bind(crypto.randomUUID(), aiRunId, aiRunId, eventType, JSON.stringify(data));
}

async function requireRun(db: D1Database, aiRunId: string): Promise<AiRunRow> {
  const run = await getAiRunById(db, aiRunId);
  if (!run) throw new Error('AI run not found');
  return run;
}

async function getPostIdsForRun(db: D1Database, aiRunId: string): Promise<string[]> {
  const result = await db
    .prepare('SELECT post_id FROM ai_run_posts WHERE ai_run_id = ? ORDER BY ordinal ASC')
    .bind(aiRunId)
    .all<{ post_id: string }>();
  return result.results.map((row) => row.post_id);
}

function isPostNumberConflict(error: unknown): boolean {
  return error instanceof Error &&
    /UNIQUE constraint failed: posts\.thread_id, posts\.post_number/iu.test(error.message);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function now(): string {
  return new Date().toISOString();
}
