import { Hono } from 'hono';
import type { CreatePostInput } from '@bs-job-board/contracts';
import {
  listThreadsSorted,
  getThreadDetail,
  addPost,
  updateThreadStatus,
  toggleReaction,
} from '@bs-job-board/db';
import {
  createThreadWithInitialPostAndQueuedRun,
  insertHumanPostWithQueuedRun,
  markRunAdmitted,
  failRun,
  getAiRunById,
  getAiGenerationContext,
} from '@bs-job-board/db/ai-pipeline';
import { getSessionUser } from '../auth.ts';

// ── Constants ───────────────────────────────────────────

const AI_MODEL = 'sakura-ai/gpt-oss-120b';
const PROMPT_VERSION = 'initial-v1';

// ── Bindings ────────────────────────────────────────────

type Bindings = {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  INTERNAL_CALLBACK_KEY: string;
  AGENT: { fetch: typeof fetch };
};

// ── Idempotency key ─────────────────────────────────────

async function computeIdempotencyKey(
  sourcePostId: string,
  stage: string,
  promptVersion: string,
): Promise<string> {
  const input = `ai-run:v1:${sourcePostId}:${stage}:${promptVersion}`;
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Dispatch with run lifecycle ─────────────────────────
//
// HANDOFF #10:
// - dispatch 前に admitted へ遷移
// - dispatch 失敗時、completed でなければ failed へ遷移
// - Agent に ai_run_id を渡す（#11 で Agent 側が使う）
// - Hono ExecutionContext 全体ではなく waitUntil 能力だけ要求

type WaitUntilCapable = { waitUntil: (promise: Promise<unknown>) => void };

async function dispatchWithRunLifecycle(
  agent: { fetch: typeof fetch },
  db: D1Database,
  callbackKey: string,
  aiRunId: string,
): Promise<void> {
  // admitted 遷移
  await markRunAdmitted({
    db: db as unknown as Parameters<typeof markRunAdmitted>[0]['db'],
    aiRunId,
    eventId: crypto.randomUUID(),
  });

  // generation context 組み立て（ADR-004: API が context を構築する）
  const ctx = await getAiGenerationContext(
    db as unknown as Parameters<typeof getAiGenerationContext>[0],
    aiRunId,
  );
  if (!ctx) {
    await failRun({
      db: db as unknown as Parameters<typeof failRun>[0]['db'],
      aiRunId,
      eventId: crypto.randomUUID(),
      errorCode: 'AI_DISPATCH_FAILED',
      errorMessage: 'generation context not found',
    }).catch(() => undefined);
    return;
  }

  try {
    // Agent dispatch: context + callback key
    const response = await agent.fetch(
      new Request('http://agent/workflows/generate-replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aiRunId,
          callbackKey,
          context: {
            thread: ctx.thread,
            sourcePost: {
              id: ctx.sourcePost.id,
              postNumber: ctx.sourcePost.post_number,
              body: ctx.sourcePost.body,
            },
            recentPosts: ctx.recentPosts.map((p) => ({
              postNumber: p.post_number,
              authorType: p.author_type,
              body: p.body,
            })),
            replyCount: 3,
            promptVersion: PROMPT_VERSION,
            stage: ctx.aiRun.stage,
          },
        }),
      }),
    );

    try {
      if (!response.ok) {
        throw new Error(`Workflow dispatch failed with ${response.status}`);
      }
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch (error) {
    // dispatch 自体の失敗（ネットワーク等）: Agent callback が呼ばれていない
    const run = await getAiRunById(
      db as unknown as Parameters<typeof getAiRunById>[0],
      aiRunId,
    ).catch(() => null);
    if (run && run.status !== 'completed' && run.status !== 'failed') {
      await failRun({
        db: db as unknown as Parameters<typeof failRun>[0]['db'],
        aiRunId,
        eventId: crypto.randomUUID(),
        errorCode: 'AI_DISPATCH_FAILED',
        errorMessage:
          error instanceof Error ? error.message : 'Unknown dispatch error',
      }).catch(() => undefined);
    }
    throw error;
  }
}

function logDispatchFailure(error: unknown): void {
  if (error instanceof Error) {
    console.error('AI workflow dispatch failed', {
      name: error.name,
      message: error.message,
    });
    return;
  }
  console.error('AI workflow dispatch failed', { name: 'UnknownError' });
}

// ── Routes ──────────────────────────────────────────────

export const threadRoutes = new Hono<{ Bindings: Bindings }>()
  .get('/', async (context) => {
    const sort = (context.req.query('sort') ?? 'new') as 'new' | 'hot';
    return context.json(await listThreadsSorted(context.env.DB, sort));
  })
  .get('/:id', async (context) => {
    const detail = await getThreadDetail(context.env.DB, context.req.param('id'));
    if (!detail) return context.json({ error: 'not found' }, 404);
    return context.json(detail);
  })
  .post('/', async (context) => {
    const input = await context.req.json<{ title: string; body: string }>();

    const sessionUser = await getSessionUser(
      context.env.DB,
      context.env.BETTER_AUTH_SECRET || '',
      new URL(context.req.url).origin,
      context.req.raw,
    );
    const authorName =
      sessionUser?.name && sessionUser.name !== 'Anonymous'
        ? sessionUser.name
        : '名無しさん';

    const threadId = crypto.randomUUID();
    const postId = crypto.randomUUID();
    const aiRunId = crypto.randomUUID();
    const idempotencyKey = await computeIdempotencyKey(
      postId,
      'initial',
      PROMPT_VERSION,
    );

    // thread + initial post + queued run を原子的に作成
    await createThreadWithInitialPostAndQueuedRun({
      db: context.env.DB as unknown as Parameters<typeof createThreadWithInitialPostAndQueuedRun>[0]['db'],
      thread: { id: threadId, title: input.title, body: input.body },
      post: { id: postId, authorName, userId: sessionUser?.id ?? null },
      aiRun: {
        id: aiRunId,
        idempotencyKey,
        model: AI_MODEL,
        promptVersion: PROMPT_VERSION,
      },
      queuedEventId: crypto.randomUUID(),
    });

    // dispatch（waitUntil で非同期実行）
    context.executionCtx.waitUntil(
      dispatchWithRunLifecycle(
        context.env.AGENT,
        context.env.DB,
        context.env.INTERNAL_CALLBACK_KEY,
        aiRunId,
      ).catch(logDispatchFailure),
    );

    return context.json({ id: threadId, title: input.title, ai_run: { id: aiRunId } }, 201);
  })
  .post('/:id/posts', async (context) => {
    const threadId = context.req.param('id');
    const input = await context.req.json<CreatePostInput>();

    const sessionUser = await getSessionUser(
      context.env.DB,
      context.env.BETTER_AUTH_SECRET || '',
      new URL(context.req.url).origin,
      context.req.raw,
    );

    const authorName =
      sessionUser?.name && sessionUser.name !== 'Anonymous'
        ? sessionUser.name
        : input.author_name;
    const userId = sessionUser?.id ?? null;

    if (input.author_type === 'human') {
      // human 投稿: post + queued run を原子的に作成
      const postId = crypto.randomUUID();
      const aiRunId = crypto.randomUUID();
      const idempotencyKey = await computeIdempotencyKey(
        postId,
        'deep_dive',
        PROMPT_VERSION,
      );

      const { postNumber, threadTitle } = await insertHumanPostWithQueuedRun({
        db: context.env.DB as unknown as Parameters<typeof insertHumanPostWithQueuedRun>[0]['db'],
        post: {
          id: postId,
          threadId,
          authorName,
          body: input.body,
          userId,
        },
        aiRun: {
          id: aiRunId,
          idempotencyKey,
          model: AI_MODEL,
          promptVersion: PROMPT_VERSION,
        },
        queuedEventId: crypto.randomUUID(),
      });

      context.executionCtx.waitUntil(
        dispatchWithRunLifecycle(
          context.env.AGENT,
          context.env.DB,
          context.env.INTERNAL_CALLBACK_KEY,
          aiRunId,
        ).catch(logDispatchFailure),
      );

      return context.json(
        { id: postId, post_number: postNumber, ai_run: { id: aiRunId } },
        201,
      );
    }

    // AI 投稿（#11 で撤去予定: Agent callback に移行）
    const enrichedInput = {
      ...input,
      user_id: userId,
      author_name: authorName,
    };
    const { postId, postNumber } = await addPost(
      context.env.DB,
      threadId,
      enrichedInput,
    );

    return context.json({ id: postId, post_number: postNumber }, 201);
  })
  .post('/:id/react', async (context) => {
    const threadId = context.req.param('id');
    const { userId } = await context.req.json<{ userId: string }>();
    if (!userId) return context.json({ error: 'userId required' }, 400);
    return context.json(await toggleReaction(context.env.DB, threadId, userId));
  })
  .patch('/:id', async (context) => {
    const threadId = context.req.param('id');
    const { status } = await context.req.json<{ status: 'open' | 'fixed' }>();
    await updateThreadStatus(context.env.DB, threadId, status);
    return context.json({ id: threadId, status });
  });
