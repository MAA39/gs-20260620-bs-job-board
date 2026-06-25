import {
  createAgent,
  registerProvider,
  type FlueContext,
  type WorkflowRouteHandler,
} from '@flue/runtime';

// ── Constants ───────────────────────────────────────────

const PROVIDER_ID = 'sakura-ai';
const DEFAULT_MODEL_ID = 'gpt-oss-120b';
const DEFAULT_BASE_URL = 'https://api.ai.sakura.ad.jp/v1';
const REPLY_COUNT = 3;
const TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = `2chふう匿名掲示板の住民として返答する。
判断や説教をせず、投稿者の言葉を拾って材料を並べる。
深掘り質問は全体で最大1つ。AIを名乗らず、>>記号も書かない。
必ずJSONオブジェクトだけを返す: {"replies":["レス1","レス2","レス3"]}`;

// ── Types ───────────────────────────────────────────────

/** API が組み立てた generation context + callback 情報 */
type DispatchPayload = {
  aiRunId: string;
  context: {
    thread: { id: string; title: string; body: string };
    sourcePost: { id: string; postNumber: number; body: string };
    recentPosts: Array<{
      postNumber: number;
      authorType: string;
      body: string;
    }>;
    replyCount: number;
    promptVersion: string;
    stage: string;
  };
};

type Env = {
  API: { fetch: typeof fetch };
  SAKURA_API_TOKEN?: string;
  SAKURA_BASE_URL?: string;
  SAKURA_MODEL_ID?: string;
  INTERNAL_CALLBACK_KEY?: string;
};

type ReplyBundle = { replies: string[] };

type RunResult = {
  repliesCount: number;
  model: { provider: string; id: string };
  usage: { input: number; output: number };
};

class SafeWorkflowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SafeWorkflowError';
  }
}

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  AI_CONFIGURATION_ERROR: 'Agent configuration missing or invalid',
  AI_PROVIDER_TIMEOUT: 'AI provider did not respond within time limit',
  AI_OUTPUT_INVALID: 'AI output failed validation after repair attempt',
  AI_INPUT_INVALID: 'Dispatch payload missing required fields',
  AI_RUN_FAILED: 'AI workflow encountered an unexpected error',
  AI_DISPATCH_FAILED: 'Workflow dispatch failed',
};


// ── Agent definition ────────────────────────────────────

const replyAgent = createAgent<unknown, Env>(({ env }) => ({
  model: `${PROVIDER_ID}/${env.SAKURA_MODEL_ID?.trim() || DEFAULT_MODEL_ID}`,
  thinkingLevel: 'minimal',
  instructions: 'Return only the requested JSON object and follow the supplied constraints.',
}));

export const route: WorkflowRouteHandler = async (_context, next) => next();

// ── Main workflow ───────────────────────────────────────

export async function run({ payload, env, init }: FlueContext<unknown, Env>): Promise<RunResult> {
  const input = parsePayload(payload);
  const callbackKey = env.INTERNAL_CALLBACK_KEY?.trim();
  if (!callbackKey) throw new SafeWorkflowError('AI_CONFIGURATION_ERROR');

  try {
    const modelId = registerSakura(env);

    // callback: generating
    await callbackToApi(env.API, input.aiRunId, 'generating', callbackKey);

    const harness = await init(replyAgent);
    const session = await harness.session();

    let response = await session.prompt(buildPrompt(input), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      thinkingLevel: 'minimal',
    });
    let decoded = decodeReplies(response.text);

    if (!decoded.ok) {
      // callback: repairing
      await callbackToApi(env.API, input.aiRunId, 'repairing', callbackKey);

      response = await session.prompt(buildRepairPrompt(decoded.issues, response.text), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        thinkingLevel: 'minimal',
      });
      decoded = decodeReplies(response.text);
    }

    if (!decoded.ok) throw new SafeWorkflowError('AI_OUTPUT_INVALID');

    const resultHash = await computeHash(decoded.value.replies.join('\n'));

    // callback: complete (full contract per #11 AC)
    await callbackToApi(env.API, input.aiRunId, 'complete', callbackKey, {
      protocolVersion: '1',
      aiRunId: input.aiRunId,
      stage: input.context.stage,
      promptVersion: input.context.promptVersion,
      model: `${response.model?.provider || PROVIDER_ID}/${response.model?.id || modelId}`,
      resultHash,
      replies: decoded.value.replies.map((body) => ({ body })),
      usage: {
        inputTokens: nonNegative(response.usage?.input),
        outputTokens: nonNegative(response.usage?.output),
      },
    });

    return {
      repliesCount: decoded.value.replies.length,
      model: {
        provider: response.model?.provider || PROVIDER_ID,
        id: response.model?.id || modelId,
      },
      usage: {
        input: nonNegative(response.usage?.input),
        output: nonNegative(response.usage?.output),
      },
    };
  } catch (error) {
    const errorCode = toSafeErrorCode(error);
    // ADR-004: raw error.message を保存しない。allow-list code + safe message のみ
    await callbackToApi(env.API, input.aiRunId, 'fail', callbackKey, {
      errorCode,
      errorMessage: SAFE_ERROR_MESSAGES[errorCode] || 'AI workflow encountered an unexpected error',
    }).catch(() => undefined);

    throw new SafeWorkflowError(errorCode);
  }
}

// ── API callback ────────────────────────────────────────

async function callbackToApi(
  api: { fetch: typeof fetch },
  aiRunId: string,
  action: 'generating' | 'repairing' | 'complete' | 'fail',
  callbackKey: string,
  body?: Record<string, unknown>,
): Promise<void> {
  const response = await api.fetch(
    new Request(`http://api/internal/v1/ai-runs/${aiRunId}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Callback-Key': callbackKey,
      },
      body: body ? JSON.stringify(body) : '{}',
    }),
  );

  try {
    if (!response.ok) {
      throw new SafeWorkflowError(
        action === 'fail' ? 'AI_RUN_FAILED' : `AI_CALLBACK_${action.toUpperCase()}_FAILED`,
      );
    }
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

// ── Prompt building ─────────────────────────────────────

function buildPrompt(input: DispatchPayload): string {
  const ctx = input.context;
  const history = ctx.recentPosts
    .map((p) => `${p.postNumber}. ${p.body}`)
    .join('\n');

  return [
    SYSTEM_PROMPT,
    `スレッド名: ${ctx.thread.title}`,
    history || '(最初の投稿)',
    `返信対象: ${ctx.sourcePost.body}`,
    `返信を${ctx.replyCount}件返す。`,
  ].join('\n\n');
}

function buildRepairPrompt(issues: string[], output: string): string {
  return [
    '直前のJSONを契約に合わせて修正する。説明は書かない。',
    `問題: ${issues.join('; ')}`,
    '{"replies":["レス1","レス2","レス3"]}',
    output,
  ].join('\n\n');
}

// ── Reply decoding ──────────────────────────────────────

function decodeReplies(textValue: string):
  | { ok: true; value: ReplyBundle }
  | { ok: false; issues: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(textValue.trim());
  } catch {
    return { ok: false, issues: ['valid JSON required'] };
  }
  if (!isRecord(value) || !Array.isArray(value.replies)) {
    return { ok: false, issues: ['replies array required'] };
  }

  const issues: string[] = [];
  if (value.replies.length !== REPLY_COUNT) issues.push(`expected ${REPLY_COUNT} replies`);
  const replies = value.replies
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim());
  if (replies.length !== value.replies.length) issues.push('all replies must be strings');
  if (replies.some((r) => r.length < 5 || r.length > 200)) {
    issues.push('reply length must be 5-200');
  }
  if (new Set(replies).size !== replies.length) issues.push('replies must be unique');
  const questionMarks = replies.reduce(
    (count, r) => count + (r.match(/[?？]/gu)?.length ?? 0),
    0,
  );
  if (questionMarks > 1) issues.push('at most one question is allowed');
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { replies } };
}

// ── Helpers ─────────────────────────────────────────────

function registerSakura(env: Env): string {
  const apiKey = env.SAKURA_API_TOKEN?.trim();
  if (!apiKey) throw new SafeWorkflowError('AI_CONFIGURATION_ERROR');

  const modelId = env.SAKURA_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
  const baseUrl = (env.SAKURA_BASE_URL?.trim() || DEFAULT_BASE_URL)
    .replace(/\/chat\/completions\/?$/u, '')
    .replace(/\/$/u, '');

  registerProvider(PROVIDER_ID, {
    api: 'openai-completions',
    baseUrl,
    apiKey,
    models: { [modelId]: { contextWindow: 0, maxTokens: 1_500 } },
  });
  return modelId;
}

function parsePayload(value: unknown): DispatchPayload {
  if (!isRecord(value)) throw new SafeWorkflowError('AI_INPUT_INVALID');
  if (!value.aiRunId || !value.context) throw new SafeWorkflowError('AI_INPUT_INVALID');
  return value as DispatchPayload;
}

async function computeHash(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toSafeErrorCode(error: unknown): string {
  if (error instanceof SafeWorkflowError) return error.code;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'AI_PROVIDER_TIMEOUT';
  if (error instanceof Error && /timeout/iu.test(error.message)) return 'AI_PROVIDER_TIMEOUT';
  return 'AI_RUN_FAILED';
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
