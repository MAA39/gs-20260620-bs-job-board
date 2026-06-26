import { Hono } from 'hono';
import {
  listThreadsSorted,
  getThreadDetail,
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
import { getSessionResult } from '../auth.ts';
import { jsonBodyLimit, BODY_LIMITS } from '../middleware/body-limit.ts';

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
  // callback key 未設定チェック
  if (!callbackKey?.trim()) {
    try {
      await failRun({
        db: db as unknown as Parameters<typeof failRun>[0]['db'],
        aiRunId,
        eventId: crypto.randomUUID(),
        errorCode: 'AI_CONFIGURATION_ERROR',
        errorMessage: 'Internal callback key not configured',
      });
    } catch (failError) {
      console.error('failRun failed after missing callback key', {
        aiRunId,
        name: failError instanceof Error ? failError.name : 'UnknownError',
      });
      throw failError;
    }
    return;
  }

  // admitted 遷移
  await markRunAdmitted({
    db: db as unknown as Parameters<typeof markRunAdmitted>[0]['db'],
    aiRunId,
    eventId: crypto.randomUUID(),
  });

  // generation context 組み立て（ADR-004: API が context を構築する）
  let ctx: Awaited<ReturnType<typeof getAiGenerationContext>>;
  try {
    ctx = await getAiGenerationContext(
      db as unknown as Parameters<typeof getAiGenerationContext>[0],
      aiRunId,
    );
  } catch (contextError) {
    try {
      await failRun({
        db: db as unknown as Parameters<typeof failRun>[0]['db'],
        aiRunId,
        eventId: crypto.randomUUID(),
        errorCode: 'AI_DISPATCH_FAILED',
        errorMessage: 'Failed to build generation context',
      });
      return;
    } catch (failError) {
      console.error('failRun failed after context build error', {
        aiRunId,
        name: failError instanceof Error ? failError.name : 'UnknownError',
      });
      throw contextError;
    }
  }
  if (!ctx) {
    try {
      await failRun({
        db: db as unknown as Parameters<typeof failRun>[0]['db'],
        aiRunId,
        eventId: crypto.randomUUID(),
        errorCode: 'AI_DISPATCH_FAILED',
        errorMessage: 'generation context not found',
      });
    } catch (failError) {
      console.error('failRun failed after missing context', {
        aiRunId,
        name: failError instanceof Error ? failError.name : 'UnknownError',
      });
      throw failError;
    }
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
      try {
        await failRun({
          db: db as unknown as Parameters<typeof failRun>[0]['db'],
          aiRunId,
          eventId: crypto.randomUUID(),
          errorCode: 'AI_DISPATCH_FAILED',
          errorMessage: 'Workflow dispatch failed',
        });
      } catch (failError) {
        console.error('failRun failed after dispatch error', {
          aiRunId,
          name: failError instanceof Error ? failError.name : 'UnknownError',
        });
      }
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
  .post('/', jsonBodyLimit(BODY_LIMITS.publicLarge), async (context) => {
    // #29: session 必須 — fail-closed
    const session = await getSessionResult(
      context.env.DB,
      context.env.BETTER_AUTH_SECRET,
      new URL(context.req.url).origin,
      context.req.raw,
    );
    if (!session.ok) {
      if (session.reason === 'auth_misconfigured') {
        return context.json({ error: 'service not configured' }, 503);
      }
      if (session.reason === 'auth_failure') {
        return context.json({ error: 'authentication service error' }, 500);
      }
      return context.json({ error: 'authentication required' }, 401);
    }

    const input = await context.req.json<Record<string, unknown>>().catch(() => null);
    if (!input || typeof input !== 'object') {
      return context.json({ error: 'invalid JSON body' }, 400);
    }

    const ALLOWED_FIELDS = new Set(['title', 'body']);
    const unexpected = Object.keys(input).filter((k) => !ALLOWED_FIELDS.has(k));
    if (unexpected.length > 0) {
      return context.json(
        { error: `unexpected fields: ${unexpected.join(', ')}` },
        400,
      );
    }

    const { title, body } = input as { title: unknown; body: unknown };
    if (typeof title !== 'string' || typeof body !== 'string') {
      return context.json({ error: 'title and body must be strings' }, 400);
    }
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle || !trimmedBody) {
      return context.json({ error: 'title and body must not be empty' }, 400);
    }

    const authorName =
      session.user.name && session.user.name !== 'Anonymous'
        ? session.user.name
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
      thread: { id: threadId, title: trimmedTitle, body: trimmedBody },
      post: { id: postId, authorName, userId: session.user.id },
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
  .post('/:id/posts', jsonBodyLimit(BODY_LIMITS.publicLarge), async (context) => {
    const threadId = context.req.param('id');

    // #29: session 必須 — fail-closed
    const session = await getSessionResult(
      context.env.DB,
      context.env.BETTER_AUTH_SECRET,
      new URL(context.req.url).origin,
      context.req.raw,
    );
    if (!session.ok) {
      if (session.reason === 'auth_misconfigured') {
        return context.json({ error: 'service not configured' }, 503);
      }
      if (session.reason === 'auth_failure') {
        return context.json({ error: 'authentication service error' }, 500);
      }
      return context.json({ error: 'authentication required' }, 401);
    }

    // Strict payload validation: only { body: string } accepted (ADR-004)
    const raw = await context.req.json<unknown>().catch(() => null);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return context.json({ error: 'invalid payload' }, 400);
    }
    const record = raw as Record<string, unknown>;
    const extraKeys = Object.keys(record).filter((k) => k !== 'body');
    if (extraKeys.length > 0) {
      return context.json({ error: 'server-owned fields are not allowed' }, 400);
    }
    if (typeof record.body !== 'string' || !record.body.trim()) {
      return context.json({ error: 'body must be a non-empty string' }, 400);
    }
    const body = record.body.trim();

    const authorName =
      session.user.name && session.user.name !== 'Anonymous'
        ? session.user.name
        : '名無しさん';
    const userId = session.user.id;

    // ADR-004: 公開routeは常にhuman post。AI postはinternal callbackのみ
    const postId = crypto.randomUUID();
    const aiRunId = crypto.randomUUID();
    const idempotencyKey = await computeIdempotencyKey(
      postId,
      'deep_dive',
      PROMPT_VERSION,
    );

    const { postNumber } = await insertHumanPostWithQueuedRun({
      db: context.env.DB as unknown as Parameters<typeof insertHumanPostWithQueuedRun>[0]['db'],
      post: {
        id: postId,
        threadId,
        authorName,
        body,
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
  })
  .post('/:id/react', jsonBodyLimit(BODY_LIMITS.publicSmall), async (context) => {
    const threadId = context.req.param('id');

    // #49: session必須 — fail-closed
    const session = await getSessionResult(
      context.env.DB,
      context.env.BETTER_AUTH_SECRET,
      new URL(context.req.url).origin,
      context.req.raw,
    );
    if (!session.ok) {
      if (session.reason === 'auth_misconfigured') {
        return context.json({ error: 'service not configured' }, 503);
      }
      if (session.reason === 'auth_failure') {
        return context.json({ error: 'authentication service error' }, 500);
      }
      return context.json({ error: 'authentication required' }, 401);
    }

    // #49: userIdはsessionから導出。clientから受け取らない
    const result = await toggleReaction(context.env.DB, threadId, session.user.id);
    return context.json({ reacted: result.reacted, reaction_count: result.count });
  })
  .patch('/:id', jsonBodyLimit(BODY_LIMITS.publicSmall), async (context) => {
    const threadId = context.req.param('id');

    // #49: session必須 — fail-closed
    const session = await getSessionResult(
      context.env.DB,
      context.env.BETTER_AUTH_SECRET,
      new URL(context.req.url).origin,
      context.req.raw,
    );
    if (!session.ok) {
      if (session.reason === 'auth_misconfigured') {
        return context.json({ error: 'service not configured' }, 503);
      }
      if (session.reason === 'auth_failure') {
        return context.json({ error: 'authentication service error' }, 500);
      }
      return context.json({ error: 'authentication required' }, 401);
    }

    // #49: runtime payload validation
    const raw = await context.req.json<unknown>().catch(() => null);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return context.json({ error: 'invalid payload' }, 400);
    }
    const record = raw as Record<string, unknown>;
    const extraKeys = Object.keys(record).filter((k) => k !== 'status');
    if (extraKeys.length > 0) {
      return context.json({ error: 'server-owned fields are not allowed' }, 400);
    }
    const status = record.status;
    if (status !== 'open' && status !== 'fixed') {
      return context.json({ error: 'status must be open or fixed' }, 400);
    }

    await updateThreadStatus(context.env.DB, threadId, status);
    return context.json({ id: threadId, status });
  });
