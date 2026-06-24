import {
  createAgent,
  registerProvider,
  type FlueContext,
  type WorkflowRouteHandler,
  type WorkflowRunsHandler,
} from '@flue/runtime';

const PROVIDER_ID = 'sakura-ai';
const MODEL_ID = 'gpt-oss-120b';
const BASE_URL = 'https://api.ai.sakura.ad.jp/v1';
const REPLY_COUNT = 3;
const TIMEOUT_MS = 45_000;

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

type Result = {
  repliesCount: number;
  model: { provider: string; id: string };
};

const agent = createAgent<unknown, Env>(({ env }) => ({
  model: `${PROVIDER_ID}/${env.SAKURA_MODEL_ID?.trim() || MODEL_ID}`,
  thinkingLevel: 'minimal',
  instructions: 'Return only the requested JSON object.',
}));

export const route: WorkflowRouteHandler = async (_context, next) => next();
export const runs: WorkflowRunsHandler = async (_context, next) => next();

export async function run({ payload, env, init }: FlueContext<unknown, Env>): Promise<Result> {
  const input = parsePayload(payload);
  const modelId = registerSakura(env);
  const posts = await fetchPosts(env.DB, input.threadId);
  const harness = await init(agent);
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

  if (!decoded.ok) throw new Error('AI_OUTPUT_INVALID');

  for (const reply of decoded.value.replies) {
    await insertReply(env.DB, input.threadId, input.targetPostNumber, reply);
  }

  return {
    repliesCount: decoded.value.replies.length,
    model: {
      provider: response.model?.provider || PROVIDER_ID,
      id: response.model?.id || modelId,
    },
  };
}

function registerSakura(env: Env): string {
  const apiKey = env.SAKURA_API_TOKEN?.trim();
  if (!apiKey) throw new Error('AI_CONFIGURATION_ERROR');
  const modelId = env.SAKURA_MODEL_ID?.trim() || MODEL_ID;
  const baseUrl = (env.SAKURA_BASE_URL?.trim() || BASE_URL)
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
  if (!isRecord(value)) throw new Error('AI_INPUT_INVALID');
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
    throw new Error('AI_INPUT_INVALID');
  }
  return { threadId, threadTitle, targetBody, targetPostNumber };
}

function buildPrompt(posts: DbPost[], input: Payload): string {
  const history = posts
    .filter((post) => post.author_name !== '🤔 AIの思考')
    .slice(-8)
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
  const questions = replies.reduce(
    (count, reply) => count + (reply.match(/[?？]/gu)?.length ?? 0),
    0,
  );
  if (questions > 1) issues.push('at most one question is allowed');
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { replies } };
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error('invalid JSON');
  }
}

async function fetchPosts(db: D1Database, threadId: string): Promise<DbPost[]> {
  const result = await db
    .prepare('SELECT post_number, author_name, body, author_type FROM posts WHERE thread_id = ? ORDER BY post_number ASC')
    .bind(threadId)
    .all<DbPost>();
  return result.results;
}

async function insertReply(
  db: D1Database,
  threadId: string,
  sourcePostNumber: number,
  body: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db
      .prepare('SELECT MAX(post_number) AS max_num FROM posts WHERE thread_id = ?')
      .bind(threadId)
      .first<{ max_num: number | null }>();
    const postNumber = (row?.max_num ?? 0) + 1;
    try {
      await db
        .prepare(`INSERT INTO posts
          (id, thread_id, post_number, author_type, author_name, role, body, source_post_number, user_id)
          VALUES (?, ?, ?, 'ai', '名無しさん', NULL, ?, ?, NULL)`)
        .bind(crypto.randomUUID(), threadId, postNumber, body, sourcePostNumber)
        .run();
      return;
    } catch (error) {
      const conflict = error instanceof Error && /UNIQUE constraint failed/iu.test(error.message);
      if (!conflict || attempt === 4) throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
