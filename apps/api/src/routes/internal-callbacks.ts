import { Hono } from 'hono';
import {
  markRunGenerating,
  markRunRepairing,
  completeRunAtomic,
  failRun,
} from '@bs-job-board/db/ai-pipeline';
import { DbConflictError, InvalidTransitionError } from '@bs-job-board/db';

// ── Types ───────────────────────────────────────────────

type Bindings = {
  DB: D1Database;
  INTERNAL_CALLBACK_KEY: string;
};

type CompletePayload = {
  resultHash: string;
  replies: Array<{ body: string }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    estimatedCostMicros?: number;
  };
  promptVersion?: string;
  model?: string;
};

type FailPayload = {
  errorCode: string;
  errorMessage: string;
};

// ── Callback key verification ───────────────────────────

function verifyCallbackKey(
  requestKey: string | undefined,
  expectedKey: string,
): boolean {
  if (!expectedKey || !requestKey) return false;
  // constant-time comparison to prevent timing attacks
  if (requestKey.length !== expectedKey.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expectedKey.length; i++) {
    mismatch |= requestKey.charCodeAt(i) ^ expectedKey.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── Routes ──────────────────────────────────────────────

export const internalCallbackRoutes = new Hono<{ Bindings: Bindings }>()
  .use('*', async (c, next) => {
    const key = c.req.header('X-Callback-Key');
    if (!verifyCallbackKey(key, c.env.INTERNAL_CALLBACK_KEY)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  })

  .post('/:aiRunId/generating', async (c) => {
    const aiRunId = c.req.param('aiRunId');
    try {
      await markRunGenerating({
        db: c.env.DB as unknown as Parameters<typeof markRunGenerating>[0]['db'],
        aiRunId,
        eventId: crypto.randomUUID(),
        flueRunId: null,
      });
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        return c.json({ error: 'invalid_transition' }, 409);
      }
      throw error;
    }
  })

  .post('/:aiRunId/repairing', async (c) => {
    const aiRunId = c.req.param('aiRunId');
    try {
      await markRunRepairing({
        db: c.env.DB as unknown as Parameters<typeof markRunRepairing>[0]['db'],
        aiRunId,
        eventId: crypto.randomUUID(),
      });
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        return c.json({ error: 'invalid_transition' }, 409);
      }
      throw error;
    }
  })

  .post('/:aiRunId/complete', async (c) => {
    const aiRunId = c.req.param('aiRunId');
    const payload = await c.req.json<CompletePayload>();

    if (!payload.resultHash || !Array.isArray(payload.replies)) {
      return c.json({ error: 'invalid payload' }, 400);
    }

    try {
      const result = await completeRunAtomic({
        db: c.env.DB as unknown as Parameters<typeof completeRunAtomic>[0]['db'],
        aiRunId,
        resultHash: payload.resultHash,
        completedEventId: crypto.randomUUID(),
        replies: payload.replies.map((r) => ({
          postId: crypto.randomUUID(),
          body: r.body,
        })),
        usage: payload.usage,
      });
      return c.json({ ok: true, duplicate: result.duplicate, postIds: result.postIds });
    } catch (error) {
      if (error instanceof DbConflictError) {
        return c.json({ error: 'conflict', message: error.message }, 409);
      }
      if (error instanceof InvalidTransitionError) {
        return c.json({ error: 'invalid_transition' }, 409);
      }
      throw error;
    }
  })

  .post('/:aiRunId/fail', async (c) => {
    const aiRunId = c.req.param('aiRunId');
    const payload = await c.req.json<FailPayload>();

    if (!payload.errorCode) {
      return c.json({ error: 'errorCode required' }, 400);
    }

    try {
      await failRun({
        db: c.env.DB as unknown as Parameters<typeof failRun>[0]['db'],
        aiRunId,
        eventId: crypto.randomUUID(),
        errorCode: payload.errorCode,
        errorMessage: (payload.errorMessage || '').slice(0, 500),
      });
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        return c.json({ error: 'invalid_transition' }, 409);
      }
      throw error;
    }
  });
