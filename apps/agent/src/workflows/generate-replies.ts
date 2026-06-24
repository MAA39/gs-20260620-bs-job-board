import {
  createAgent,
  registerProvider,
  type FlueContext,
  type WorkflowRouteHandler,
} from '@flue/runtime';

const PROVIDER_ID = 'sakura-ai';
const DEFAULT_MODEL_ID = 'gpt-oss-120b';
const DEFAULT_BASE_URL = 'https://api.ai.sakura.ad.jp/v1';
const REPLY_COUNT = 3;
const TIMEOUT_MS = 45_000;
const LEGACY_THINKING_AUTHOR = '🤔 AIの思考';

const SYSTEM_PROMPT = `2chふう匿名掲示板の住民として返答する。
判断や説教をせず、投稿者の言葉を拾って材料を並べる。
深掘り質問は全体で最大1つ。AIを名乗らず、>>記号も書かない。
必ずJSONオブジェクトだけを返す: {"replies":["レス1","レス2","レス3"]}`;

type Payload = {
  threadId: string;
  threadTitle: string;
  targetBody: string;
  targetPostNumber: number;
};

type Env = {
  DB: D1Database;
  SAKURA_API_TOKEN?: string;
  SAKURA_BASE_URL?: string;
  SAKURA_MODEL_ID?: string;
};

type DbPost = {
  post_number: number;
  author_name: string;
  body: string;
  author_type: string;
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

const replyAgent = createAgent<unknown, Env>(({ env }) => ({
  model: `${PROVIDER_ID}/${env.SAKURA_MODEL_ID?.trim() || DEFAULT_MODEL_ID}`,
  thinkingLevel: 'minimal',
  instructions: 'Return only the requested JSON object and follow the supplied constraints.',
}));

export const route: WorkflowRouteHandler = async (_context, next) => next();

export async function run({ payload, env, init }: FlueContext<unknown, Env>): Promise<RunResult> {
  try {
    const input = parsePayload(payload);
    const modelId = registerSakura(env);
    const posts = await fetchPosts(env.DB, input.threadId);
    const harness = await init(replyAgent);
    const session = await harness.session();

    let response = await session.prompt(buildPrompt(posts, input), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      thinkingLevel: 'minimal',
    });
    let decoded = decodeReplies(response.text);

    if (!decoded.ok) {
      response = await session.prompt(buildRepairPrompt(decoded.issues, response.text), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        thinkingLevel: 'minimal',
      });
      decoded = decodeReplies(response.text);
    }

    if (!decoded.ok) throw new SafeWorkflowError('AI_OUTPUT_INVALID');

    await insertReplyBatch(
      env.DB,
      input.threadId,
      input.targetPostNumber,
      decoded.value.replies,
    );

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
    throw new SafeWorkflowError(toSafeErrorCode(error));
  }
}

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

function parsePayload(value: unknown): Payload {
  if (!isRecord(value)) throw new SafeWorkflowError('AI_INPUT_INVALID');
  const threadId = text(value.threadId);
  const threadTitle = text(value.threadTitle);
  const targetBody = text(value.targetBody);
  const targetPostNumber = value.targetPostNumber;
  if (
    !threadId ||
    !threadTitle ||
    !targetBody ||
    typeof targetPostNumber !== 'number' ||
    !Number.isSafeInteger(targetPostNumber) ||
    targetPostNumber < 1
  ) {
    throw new SafeWorkflowError('AI_INPUT_INVALID');
  }
  return { threadId, threadTitle, targetBody, targetPostNumber };
}

function buildPrompt(posts: DbPost[], input: Payload): string {
  const history = posts
    .map((post) => `${post.post_number}. ${post.author_name}: ${post.body}`)
    .join('\n');

  return [
    SYSTEM_PROMPT,
    `スレッド名: ${input.threadTitle}`,
    history || '(最初の投稿)',
    `返信対象: ${input.targetBody}`,
    `返信を${REPLY_COUNT}件返す。`,
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

function decodeReplies(textValue: string):
  | { ok: true; value: ReplyBundle }
  | { ok: false; issues: string[] } {
  let value: unknown;
  try {
    value = parseJson(textValue);
  } catch {
    return { ok: false, issues: ['valid JSON required'] };
  }
  if (!isRecord(value) || !Array.isArray(value.replies)) {
    return { ok: false, issues: ['replies array required'] };
  }

  const issues: string[] = [];
  if (value.replies.length !== REPLY_COUNT) issues.push(`expected ${REPLY_COUNT} replies`);
  const replies = value.replies
    .filter((reply): reply is string => typeof reply === 'string')
    .map((reply) => reply.trim());
  if (replies.length !== value.replies.length) issues.push('all replies must be strings');
  if (replies.some((reply) => reply.length < 5 || reply.length > 200)) {
    issues.push('reply length must be 5-200');
  }
  if (new Set(replies).size !== replies.length) issues.push('replies must be unique');
  const questionMarks = replies.reduce(
    (count, reply) => count + (reply.match(/[?？]/gu)?.length ?? 0),
    0,
  );
  if (questionMarks > 1) issues.push('at most one question is allowed');
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { replies } };
}

function parseJson(value: string): unknown {
  return JSON.parse(value.trim());
}

async function fetchPosts(db: D1Database, threadId: string): Promise<DbPost[]> {
  const result = await db
    .prepare(
      'SELECT post_number, author_name, body, author_type FROM posts WHERE thread_id = ? AND author_name != ? ORDER BY post_number DESC LIMIT 8',
    )
    .bind(threadId, LEGACY_THINKING_AUTHOR)
    .all<DbPost>();
  return result.results.reverse();
}

async function insertReplyBatch(
  db: D1Database,
  threadId: string,
  sourcePostNumber: number,
  replies: string[],
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db
      .prepare('SELECT MAX(post_number) AS max_num FROM posts WHERE thread_id = ?')
      .bind(threadId)
      .first<{ max_num: number | null }>();
    const firstPostNumber = (row?.max_num ?? 0) + 1;
    const statements = replies.map((body, index) =>
      db
        .prepare(`INSERT INTO posts
          (id, thread_id, post_number, author_type, author_name, role, body, source_post_number, user_id)
          VALUES (?, ?, ?, 'ai', '名無しさん', NULL, ?, ?, NULL)`)
        .bind(
          crypto.randomUUID(),
          threadId,
          firstPostNumber + index,
          body,
          sourcePostNumber,
        ),
    );

    try {
      await db.batch(statements);
      return;
    } catch (error) {
      const conflict = error instanceof Error &&
        /UNIQUE constraint failed: posts\.thread_id, posts\.post_number/iu.test(error.message);
      if (!conflict || attempt === 4) throw error;
    }
  }
}

function toSafeErrorCode(error: unknown): string {
  if (error instanceof SafeWorkflowError) return error.code;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'AI_PROVIDER_TIMEOUT';
  }
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || /timeout/iu.test(error.name) || /timeout/iu.test(error.message))
  ) {
    return 'AI_PROVIDER_TIMEOUT';
  }
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

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
