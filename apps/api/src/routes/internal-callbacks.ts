import { Hono } from 'hono';
import {
  markRunGenerating,
  markRunRepairing,
  completeRunAtomic,
  failRun,
} from '@bs-job-board/db/ai-pipeline';
import { DbConflictError, InvalidTransitionError } from '@bs-job-board/db';
import { jsonBodyLimit, BODY_LIMITS } from '../middleware/body-limit.ts';

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

// ── Validation constants ────────────────────────────────

/** ADR-005: 1-5件に緩和（旧: 3件ちょうど） */
const MIN_REPLY_COUNT = 1;
const MAX_REPLY_COUNT = 5;
const MIN_REPLY_LENGTH = 1;
const MAX_REPLY_LENGTH = 500;
const HEX_HASH_PATTERN = /^[0-9a-f]{64}$/u;

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

function isSafeNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

async function safeParseJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** SHA-256 hash of content, returned as 64-char lowercase hex */
async function computeHash(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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

  .post('/:aiRunId/generating', jsonBodyLimit(BODY_LIMITS.internalSmall), async (c) => {
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

  .post('/:aiRunId/repairing', jsonBodyLimit(BODY_LIMITS.internalSmall), async (c) => {
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

  .post('/:aiRunId/complete', jsonBodyLimit(BODY_LIMITS.internalComplete), async (c) => {
    const aiRunId = c.req.param('aiRunId');
    const raw = await safeParseJson(c);

    // ── structural validation ──
    if (!isRecord(raw)) {
      return c.json({ error: 'invalid payload: expected JSON object' }, 400);
    }

    // protocolVersion: required
    if (raw.protocolVersion !== PROTOCOL_VERSION) {
      return c.json({ error: `invalid payload: protocolVersion "${PROTOCOL_VERSION}" required` }, 400);
    }
    // aiRunId: required, must match path
    if (raw.aiRunId !== aiRunId) {
      return c.json({ error: 'invalid payload: aiRunId required and must match path' }, 400);
    }
    // resultHash: 64-char hex
    if (typeof raw.resultHash !== 'string' || !HEX_HASH_PATTERN.test(raw.resultHash)) {
      return c.json({ error: 'invalid payload: resultHash must be 64-char hex string' }, 400);
    }

    // ── replies validation + normalization ──
    if (!Array.isArray(raw.replies) || raw.replies.length < MIN_REPLY_COUNT || raw.replies.length > MAX_REPLY_COUNT) {
      return c.json({ error: `invalid payload: ${MIN_REPLY_COUNT}-${MAX_REPLY_COUNT} replies required` }, 400);
    }
    const normalizedBodies: string[] = [];
    for (const reply of raw.replies) {
      if (!isRecord(reply) || typeof reply.body !== 'string') {
        return c.json({ error: 'invalid payload: each reply must have a body string' }, 400);
      }
      const trimmed = reply.body.trim();
      if (trimmed.length < MIN_REPLY_LENGTH || trimmed.length > MAX_REPLY_LENGTH) {
        return c.json({ error: `invalid payload: reply body must be ${MIN_REPLY_LENGTH}-${MAX_REPLY_LENGTH} chars after trim` }, 400);
      }
      normalizedBodies.push(trimmed);
    }

    // ── hash integrity: recompute from normalized bodies ──
    const expectedHash = await computeHash(JSON.stringify(normalizedBodies));
    if (raw.resultHash !== expectedHash) {
      return c.json({ error: 'invalid payload: resultHash does not match reply content' }, 400);
    }

    // ── usage validation: reject invalid values with 400 ──
    if (raw.usage !== undefined) {
      if (!isRecord(raw.usage)) {
        return c.json({ error: 'invalid payload: usage must be an object' }, 400);
      }
      for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'estimatedCostMicros'] as const) {
        if (raw.usage[field] !== undefined && !isSafeNonNegativeInt(raw.usage[field])) {
          return c.json({ error: `invalid payload: usage.${field} must be a non-negative integer` }, 400);
        }
      }
    }
    const usage = isRecord(raw.usage) ? {
      inputTokens: isSafeNonNegativeInt(raw.usage.inputTokens) ? raw.usage.inputTokens : undefined,
      outputTokens: isSafeNonNegativeInt(raw.usage.outputTokens) ? raw.usage.outputTokens : undefined,
      cacheReadTokens: isSafeNonNegativeInt(raw.usage.cacheReadTokens) ? raw.usage.cacheReadTokens : undefined,
      cacheWriteTokens: isSafeNonNegativeInt(raw.usage.cacheWriteTokens) ? raw.usage.cacheWriteTokens : undefined,
      estimatedCostMicros: isSafeNonNegativeInt(raw.usage.estimatedCostMicros) ? raw.usage.estimatedCostMicros : undefined,
    } : undefined;

    try {
      const result = await completeRunAtomic({
        db: c.env.DB as unknown as Parameters<typeof completeRunAtomic>[0]['db'],
        aiRunId,
        resultHash: raw.resultHash as string,
        completedEventId: crypto.randomUUID(),
        replies: normalizedBodies.map((body) => ({
          postId: crypto.randomUUID(),
          body,
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

  .post('/:aiRunId/fail', jsonBodyLimit(BODY_LIMITS.internalFail), async (c) => {
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

/** Exported for tests to compute canonical hashes */
export { computeHash };
