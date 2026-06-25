import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

import {
  completeRunAtomic,
  createQueuedRun,
  failRun,
  getAiGenerationContext,
  getAiRunById,
  listAiRunEventsAfter,
  markRunAdmitted,
  markRunGenerating,
  markRunRepairing,
} from './ai-pipeline.ts';
import { DbConflictError, InvalidTransitionError } from './types.ts';

const database = env.DB;

// ── Test helpers ────────────────────────────────────────

const seedThread = async (threadId: string) => {
  await database
    .prepare('INSERT INTO threads (id, title, body) VALUES (?, ?, ?)')
    .bind(threadId, `title ${threadId}`, `body ${threadId}`)
    .run();
};

const seedHumanPost = async (
  postId: string,
  threadId: string,
  postNumber: number,
  body = `human post ${postId}`,
) => {
  await database
    .prepare(
      "INSERT INTO posts (id, thread_id, post_number, author_type, author_name, body) VALUES (?, ?, ?, 'human', '名無しさん', ?)",
    )
    .bind(postId, threadId, postNumber, body)
    .run();
};

const seedQueuedRun = async (suffix: string) => {
  const threadId = `thread-${suffix}`;
  const postId = `post-${suffix}`;
  await seedThread(threadId);
  await seedHumanPost(postId, threadId, 1);

  return createQueuedRun({
    db: database,
    id: `run-${suffix}`,
    threadId,
    sourcePostId: postId,
    idempotencyKey: `idem-${suffix}`,
    stage: 'initial',
    model: 'sakura-ai/gpt-oss-120b',
    promptVersion: 'initial-v1',
    queuedEventId: `event-queued-${suffix}`,
  });
};

const countEvents = async (aiRunId: string): Promise<number> => {
  const result = await database
    .prepare('SELECT COUNT(*) as cnt FROM ai_run_events WHERE ai_run_id = ?')
    .bind(aiRunId)
    .first<{ cnt: number }>();
  return result?.cnt ?? 0;
};

// ── ADR-004 Required tests ──────────────────────────────

describe('migration', () => {
  test('creates ai_runs, ai_run_events, and ai_run_posts tables', async () => {
    const tables = await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?) ORDER BY name",
      )
      .bind('ai_run_events', 'ai_run_posts', 'ai_runs')
      .all<{ name: string }>();

    expect(tables.results.map((r) => r.name)).toEqual([
      'ai_run_events',
      'ai_run_posts',
      'ai_runs',
    ]);
  });

  test('posts.parent_post_id column exists', async () => {
    const cols = await database
      .prepare("PRAGMA table_info('posts')")
      .all<{ name: string }>();
    const colNames = cols.results.map((c) => c.name);
    expect(colNames).toContain('parent_post_id');
  });
});

describe('createQueuedRun', () => {
  test('queued run と queued event が atomic に作られる', async () => {
    const run = await seedQueuedRun('create-1');

    expect(run.status).toBe('queued');
    expect(run.stage).toBe('initial');

    const events = await listAiRunEventsAfter(database, run.id, 0);
    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(1);
    expect(JSON.parse(events[0].data_json)).toEqual({ status: 'queued' });
  });

  test('同じ idempotency key で DbConflictError', async () => {
    await seedQueuedRun('idem-dup');

    await expect(
      createQueuedRun({
        db: database,
        id: 'run-idem-dup-2',
        threadId: 'thread-idem-dup',
        sourcePostId: 'post-idem-dup',
        idempotencyKey: 'idem-idem-dup', // 同じキー
        stage: 'initial',
        model: 'sakura-ai/gpt-oss-120b',
        promptVersion: 'initial-v1',
        queuedEventId: 'event-queued-idem-dup-2',
      }),
    ).rejects.toThrow(DbConflictError);
  });
});

describe('permitted transitions', () => {
  test('queued → admitted → generating → completed', async () => {
    const run = await seedQueuedRun('permit-1');

    const admitted = await markRunAdmitted({
      db: database,
      aiRunId: run.id,
      eventId: 'ev-admit-1',
    });
    expect(admitted.status).toBe('admitted');

    const generating = await markRunGenerating({
      db: database,
      aiRunId: run.id,
      eventId: 'ev-gen-1',
      flueRunId: 'flue-run-1',
    });
    expect(generating.status).toBe('generating');

    const result = await completeRunAtomic({
      db: database,
      aiRunId: run.id,
      resultHash: 'hash-1',
      completedEventId: 'ev-complete-1',
      replies: [{ postId: 'ai-post-1', body: 'AI reply 1' }],
    });
    expect(result.duplicate).toBe(false);
    expect(result.postIds).toEqual(['ai-post-1']);

    const finalRun = await getAiRunById(database, run.id);
    expect(finalRun?.status).toBe('completed');
  });

  test('generating → repairing → completed', async () => {
    const run = await seedQueuedRun('repair-1');

    await markRunAdmitted({ db: database, aiRunId: run.id, eventId: 'ev-a-r1' });
    await markRunGenerating({
      db: database,
      aiRunId: run.id,
      eventId: 'ev-g-r1',
      flueRunId: null,
    });
    const repairing = await markRunRepairing({
      db: database,
      aiRunId: run.id,
      eventId: 'ev-r-r1',
    });
    expect(repairing.status).toBe('repairing');
    expect(repairing.attempt_count).toBe(2); // 1 (generating) + 1 (repairing)

    const result = await completeRunAtomic({
      db: database,
      aiRunId: run.id,
      resultHash: 'hash-repair',
      completedEventId: 'ev-c-r1',
      replies: [
        { postId: 'ai-post-r1', body: 'reply after repair' },
      ],
    });
    expect(result.duplicate).toBe(false);
  });

  test('各非 terminal 状態から failed へ遷移可能', async () => {
    // queued → failed
    const run1 = await seedQueuedRun('fail-q');
    const failed1 = await failRun({
      db: database,
      aiRunId: run1.id,
      eventId: 'ev-fq',
      errorCode: 'AI_DISPATCH_FAILED',
      errorMessage: 'dispatch timeout',
    });
    expect(failed1.status).toBe('failed');

    // admitted → failed
    const run2 = await seedQueuedRun('fail-a');
    await markRunAdmitted({ db: database, aiRunId: run2.id, eventId: 'ev-fa-a' });
    const failed2 = await failRun({
      db: database,
      aiRunId: run2.id,
      eventId: 'ev-fa',
      errorCode: 'AI_PROVIDER_TIMEOUT',
      errorMessage: 'timeout',
    });
    expect(failed2.status).toBe('failed');
  });
});

describe('invalid transitions — row/event unchanged', () => {
  test('completed → failed は InvalidTransitionError', async () => {
    const run = await seedQueuedRun('inv-cf');
    await markRunAdmitted({ db: database, aiRunId: run.id, eventId: 'ev-a-cf' });
    await markRunGenerating({
      db: database,
      aiRunId: run.id,
      eventId: 'ev-g-cf',
      flueRunId: null,
    });
    await completeRunAtomic({
      db: database,
      aiRunId: run.id,
      resultHash: 'hash-cf',
      completedEventId: 'ev-c-cf',
      replies: [{ postId: 'ai-post-cf', body: 'done' }],
    });

    const eventsBefore = await countEvents(run.id);

    await expect(
      failRun({
        db: database,
        aiRunId: run.id,
        eventId: 'ev-f-cf',
        errorCode: 'AI_RUN_FAILED',
        errorMessage: 'should not work',
      }),
    ).rejects.toThrow(InvalidTransitionError);

    // event が増えていないことを確認
    const eventsAfter = await countEvents(run.id);
    expect(eventsAfter).toBe(eventsBefore);
  });

  test('queued → generating は InvalidTransitionError（admitted を飛ばせない）', async () => {
    const run = await seedQueuedRun('inv-qg');
    const eventsBefore = await countEvents(run.id);

    await expect(
      markRunGenerating({
        db: database,
        aiRunId: run.id,
        eventId: 'ev-g-qg',
        flueRunId: null,
      }),
    ).rejects.toThrow(InvalidTransitionError);

    const eventsAfter = await countEvents(run.id);
    expect(eventsAfter).toBe(eventsBefore);

    // run の status が変わっていないことも確認
    const runAfter = await getAiRunById(database, run.id);
    expect(runAfter?.status).toBe('queued');
  });

  test('admitted → repairing は InvalidTransitionError', async () => {
    const run = await seedQueuedRun('inv-ar');
    await markRunAdmitted({ db: database, aiRunId: run.id, eventId: 'ev-a-ar' });

    await expect(
      markRunRepairing({ db: database, aiRunId: run.id, eventId: 'ev-r-ar' }),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

describe('completion idempotency', () => {
  test('same hash → duplicate success', async () => {
    const run = await seedQueuedRun('dup-ok');
    await markRunAdmitted({ db: database, aiRunId: run.id, eventId: 'ev-a-dok' });
    await markRunGenerating({
      db: database,
      aiRunId: run.id,
      eventId: 'ev-g-dok',
      flueRunId: null,
    });

    const first = await completeRunAtomic({
      db: database,
      aiRunId: run.id,
      resultHash: 'hash-dup',
      completedEventId: 'ev-c-dok1',
      replies: [{ postId: 'ai-dup-1', body: 'reply' }],
    });
    expect(first.duplicate).toBe(false);

    const second = await completeRunAtomic({
      db: database,
      aiRunId: run.id,
      resultHash: 'hash-dup', // 同じ hash
      completedEventId: 'ev-c-dok2',
      replies: [{ postId: 'ai-dup-2', body: 'reply again' }],
    });
    expect(second.duplicate).toBe(true);
    expect(second.postIds).toEqual(['ai-dup-1']); // 最初の post IDs
  });

  test('different hash → DbConflictError', async () => {
    const run = await seedQueuedRun('dup-bad');
    await markRunAdmitted({ db: database, aiRunId: run.id, eventId: 'ev-a-db' });
    await markRunGenerating({
      db: database,
      aiRunId: run.id,
      eventId: 'ev-g-db',
      flueRunId: null,
    });

    await completeRunAtomic({
      db: database,
      aiRunId: run.id,
      resultHash: 'hash-original',
      completedEventId: 'ev-c-db1',
      replies: [{ postId: 'ai-db-1', body: 'reply' }],
    });

    await expect(
      completeRunAtomic({
        db: database,
        aiRunId: run.id,
        resultHash: 'hash-different', // 異なる hash
        completedEventId: 'ev-c-db2',
        replies: [{ postId: 'ai-db-2', body: 'different reply' }],
      }),
    ).rejects.toThrow(DbConflictError);
  });
});

describe('completeRunAtomic — ADR-004 fixed values', () => {
  test('AI post の author_type/author_name/role/parent_post_id が正しい', async () => {
    const run = await seedQueuedRun('fixed-val');
    await markRunAdmitted({ db: database, aiRunId: run.id, eventId: 'ev-a-fv' });
    await markRunGenerating({
      db: database,
      aiRunId: run.id,
      eventId: 'ev-g-fv',
      flueRunId: null,
    });

    await completeRunAtomic({
      db: database,
      aiRunId: run.id,
      resultHash: 'hash-fv',
      completedEventId: 'ev-c-fv',
      replies: [{ postId: 'ai-fv-1', body: 'fixed value reply' }],
    });

    const aiPost = await database
      .prepare(
        'SELECT author_type, author_name, role, parent_post_id, source_post_number FROM posts WHERE id = ?',
      )
      .bind('ai-fv-1')
      .first<{
        author_type: string;
        author_name: string;
        role: string | null;
        parent_post_id: string | null;
        source_post_number: number | null;
      }>();

    expect(aiPost).not.toBeNull();
    expect(aiPost!.author_type).toBe('ai');
    expect(aiPost!.author_name).toBe('名無しさん');
    expect(aiPost!.role).toBeNull();
    // dual-write: parent_post_id = source_post_id
    expect(aiPost!.parent_post_id).toBe('post-fixed-val');
    // dual-write: source_post_number = source post の post_number
    expect(aiPost!.source_post_number).toBe(1);
  });
});

describe('event sequence', () => {
  test('sequence は 1 から単調増加する', async () => {
    const run = await seedQueuedRun('seq-1');
    await markRunAdmitted({ db: database, aiRunId: run.id, eventId: 'ev-a-s1' });
    await markRunGenerating({
      db: database,
      aiRunId: run.id,
      eventId: 'ev-g-s1',
      flueRunId: null,
    });
    await markRunRepairing({ db: database, aiRunId: run.id, eventId: 'ev-r-s1' });
    await completeRunAtomic({
      db: database,
      aiRunId: run.id,
      resultHash: 'hash-seq',
      completedEventId: 'ev-c-s1',
      replies: [{ postId: 'ai-seq-1', body: 'done' }],
    });

    const events = await listAiRunEventsAfter(database, run.id, 0);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.map((e) => JSON.parse(e.data_json).status)).toEqual([
      'queued',
      'admitted',
      'generating',
      'repairing',
      'completed',
    ]);
  });
});

describe('getAiGenerationContext', () => {
  test('直近 8 件を昇順で返し legacy thinking を除外する', async () => {
    const threadId = 'thread-ctx';
    const sourcePostId = 'post-ctx-src';
    await seedThread(threadId);

    // 10 件の投稿を作成（post_number 1〜10）
    for (let i = 1; i <= 10; i++) {
      const role = i === 5 ? 'thinking' : null;
      const authorName = i === 6 ? '🤔 AIの思考' : '名無しさん';
      await database
        .prepare(
          'INSERT INTO posts (id, thread_id, post_number, author_type, author_name, role, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          `post-ctx-${i}`,
          threadId,
          i,
          i <= 5 ? 'human' : 'ai',
          authorName,
          role,
          `body ${i}`,
        )
        .run();
    }

    // source post = post_number 10
    const run = await createQueuedRun({
      db: database,
      id: 'run-ctx',
      threadId,
      sourcePostId: 'post-ctx-10',
      idempotencyKey: 'idem-ctx',
      stage: 'deep_dive',
      model: 'sakura-ai/gpt-oss-120b',
      promptVersion: 'deep-v1',
      queuedEventId: 'ev-q-ctx',
    });

    const ctx = await getAiGenerationContext(database, run.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.thread.id).toBe(threadId);
    expect(ctx!.sourcePost.post_number).toBe(10);

    // post 5 (role=thinking) と post 6 (author=🤔 AIの思考) は除外
    const postNumbers = ctx!.recentPosts.map((p) => p.post_number);
    expect(postNumbers).not.toContain(5);
    expect(postNumbers).not.toContain(6);

    // 最大 8 件
    expect(ctx!.recentPosts.length).toBeLessThanOrEqual(8);

    // 昇順
    for (let i = 1; i < ctx!.recentPosts.length; i++) {
      expect(ctx!.recentPosts[i].post_number).toBeGreaterThan(
        ctx!.recentPosts[i - 1].post_number,
      );
    }
  });
});
