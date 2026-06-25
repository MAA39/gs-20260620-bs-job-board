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

// ── Error code allow-list ───────────────────────────────

const ALLOWED_ERROR_CODES = new Set([
  'AI_CONFIGURATION_ERROR',
  'AI_PROVIDER_TIMEOUT',
  'AI_OUTPUT_INVALID',
  'AI_INPUT_INVALID',
  'AI_RUN_FAILED',
  'AI_DISPATCH_FAILED',
]);

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  AI_CONFIGURATION_ERROR: 'Agent configuration missing or invalid',
  AI_PROVIDER_TIMEOUT: 'AI provider did not respond within time limit',
  AI_OUTPUT_INVALID: 'AI output failed validation after repair attempt',
  AI_INPUT_INVALID: 'Dispatch payload missing required fields',
  AI_RUN_FAILED: 'AI workflow encountered an unexpected error',
  AI_DISPATCH_FAILED: 'Workflow dispatch failed',
};

// ── Protocol ────────────────────────────────────────────

const PROTOCOL_VERSION = '1';

// ── Helpers ─────────────────────────────────────────────

function verifyCallbackKey(
  requestKey: string | undefined,
  expectedKey: string,
): boolean {
  if (!expectedKey || !requestKey) return false;
  if (requestKey.length !== expectedKey.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expectedKey.length; i++) {
    mismatch |= requestKey.charCodeAt(i) ^ expectedKey.charCodeAt(i);
  }
  return mismatch === 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function safeParseJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
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
    const raw = await safeParseJson(c);

    // payload validation
    if (!isRecord(raw)) {
      return c.json({ error: 'invalid payload: expected JSON object' }, 400);
    }
    if (typeof raw.resultHash !== 'string' || !raw.resultHash) {
      return c.json({ error: 'invalid payload: resultHash string required' }, 400);
    }
    if (!Array.isArray(raw.replies) || raw.replies.length === 0) {
      return c.json({ error: 'invalid payload: replies array required' }, 400);
    }
    for (const reply of raw.replies) {
      if (!isRecord(reply) || typeof reply.body !== 'string' || !reply.body) {
        return c.json({ error: 'invalid payload: each reply must have a body string' }, 400);
      }
    }
    if (typeof raw.protocolVersion !== 'undefined' && raw.protocolVersion !== PROTOCOL_VERSION) {
      return c.json({ error: `unsupported protocol version: expected ${PROTOCOL_VERSION}` }, 400);
    }

    const usage = isRecord(raw.usage) ? {
      inputTokens: typeof raw.usage.inputTokens === 'number' ? raw.usage.inputTokens : undefined,
      outputTokens: typeof raw.usage.outputTokens === 'number' ? raw.usage.outputTokens : undefined,
      cacheReadTokens: typeof raw.usage.cacheReadTokens === 'number' ? raw.usage.cacheReadTokens : undefined,
      cacheWriteTokens: typeof raw.usage.cacheWriteTokens === 'number' ? raw.usage.cacheWriteTokens : undefined,
      estimatedCostMicros: typeof raw.usage.estimatedCostMicros === 'number' ? raw.usage.estimatedCostMicros : undefined,
    } : undefined;

    try {
      const result = await completeRunAtomic({
        db: c.env.DB as unknown as Parameters<typeof completeRunAtomic>[0]['db'],
        aiRunId,
        resultHash: raw.resultHash as string,
        completedEventId: crypto.randomUUID(),
        replies: (raw.replies as Array<{ body: string }>).map((r) => ({
          postId: crypto.randomUUID(),
          body: r.body,
        })),
        usage,
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
    const raw = await safeParseJson(c);

    if (!isRecord(raw)) {
      return c.json({ error: 'invalid payload: expected JSON object' }, 400);
    }
    if (typeof raw.errorCode !== 'string' || !raw.errorCode) {
      return c.json({ error: 'invalid payload: errorCode string required' }, 400);
    }

    // errorCode allow-list: 不明なコードは AI_RUN_FAILED に正規化
    const errorCode = ALLOWED_ERROR_CODES.has(raw.errorCode)
      ? raw.errorCode
      : 'AI_RUN_FAILED';
    // safe message: raw message を保存しない
    const errorMessage = SAFE_ERROR_MESSAGES[errorCode] || 'AI workflow encountered an unexpected error';

    try {
      await failRun({
        db: c.env.DB as unknown as Parameters<typeof failRun>[0]['db'],
        aiRunId,
        eventId: crypto.randomUUID(),
        errorCode,
        errorMessage,
      });
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        return c.json({ error: 'invalid_transition' }, 409);
      }
      throw error;
    }
  });
