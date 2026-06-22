/**
 * ブルシット・ジョブ掲示板 — AI レス生成 workflow
 *
 * パターンB: Flue workflow 内でさくら AI を直接呼び出す。
 * messages 配列を user/assistant 交互に構築し、正式マルチターンで送信。
 * ADR-002 (slug:9afa44d21378) + 改修方針 (slug:c4130054bd66) 準拠。
 */

import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';

// HTTP 公開（ゲートキーパー）
export const route: WorkflowRouteHandler = async (_c, next) => next();

// ---- 定数 ----------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは2chふう匿名掲示板の住民です。ブルシット・ジョブについて投稿された内容に自然にレスします。

## 原則
- あなたは判断しない。材料を並べる。選ぶのは本人。
- 投稿者の言葉をそのまま拾って反応する。言い換えて上書きしない。
- 「起きてること」と「そう思ってること」を自然に分けて返す。
- 深掘りする時は1つだけ。なぜそれを聞くか理由を混ぜる。
- 質問で終わらせない。疑問を投げたら「〜気になるとこやな」「〜な気はする」で締める。
- 辛辣にしない。同意→疑問→同意かつ深掘り の流れが自然。

## 口調
- 相談員でも教師でもなく、同じスレにいる名無し。
- わかる、あるある、草、まじか 等は自然に使う。
- 説教しない。正論で締めない。
- >>記号は書かない（アプリ側で付ける）。

## 禁止
- 診断・助言・辛辣なツッコミ
- 「AIです」と名乗る

## 出力形式（厳守）
必ず以下のJSON形式だけを出力する。前置きや説明は一切不要。
{"replies": ["レス1", "レス2", ...]}
指定件数ぴったり返す。`;

// ---- 型 ------------------------------------------------------------------

type Payload = {
  threadId: string;
  threadTitle: string;
  targetBody: string;
  targetPostNumber: number;
};

type Env = {
  DB: D1Database;
  SAKURA_API_TOKEN: string;
};

type DbPost = {
  post_number: number;
  author_name: string;
  body: string;
  author_type: string;
};

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

type SakuraResponse = {
  choices: Array<{
    message: { content: string | null; reasoning_content?: string };
    finish_reason: string;
  }>;
};

// ---- メイン ---------------------------------------------------------------

export async function run({ payload, env }: FlueContext<Payload, Env>) {
  const { threadId, threadTitle, targetBody, targetPostNumber } = payload;

  const posts = await fetchThreadPosts(env.DB, threadId);
  const replyCount = 3 + Math.floor(Math.random() * 4); // 3〜6件
  const messages = buildMultiTurnMessages(posts, targetBody, replyCount);

  const sakura = await callSakuraCompletion(messages, env.SAKURA_API_TOKEN, {
    maxTokens: 1500,
    temperature: 0.7,
  });

  const replies = parseJsonReplies(sakura.content, replyCount);
  const existingNumbers = posts.map((p) => p.post_number);
  const anchors = assignRandomAnchors(targetPostNumber, existingNumbers, replies.length);
  const anchored = applyAnchorsToReplies(replies, anchors);

  await saveAiReplies(env.DB, threadId, anchored, sakura.thinking);

  return { repliesCount: anchored.length, thinking: sakura.thinking.slice(0, 100) };
}

// ---- D1 操作 --------------------------------------------------------------

/** D1 からスレッドの全投稿を取得（post_number 昇順） */
async function fetchThreadPosts(db: D1Database, threadId: string): Promise<DbPost[]> {
  const result = await db
    .prepare(
      'SELECT post_number, author_name, body, author_type FROM posts WHERE thread_id = ? ORDER BY post_number ASC',
    )
    .bind(threadId)
    .all<DbPost>();
  return result.results;
}

/** 生成された AI レスと thinking を D1 に保存（リトライ付き） */
async function saveAiReplies(
  db: D1Database,
  threadId: string,
  replies: string[],
  thinking: string,
): Promise<void> {
  for (const reply of replies) {
    await insertPost(db, threadId, 'ai', '名無しさん@AI', null, reply);
  }
  if (thinking) {
    await insertPost(db, threadId, 'ai', '🤔 AIの思考', 'thinking', thinking);
  }
}

/** post_number の UNIQUE 制約に対応したリトライ付き INSERT */
async function insertPost(
  db: D1Database,
  threadId: string,
  authorType: string,
  authorName: string,
  role: string | null,
  body: string,
): Promise<{ postId: string; postNumber: number }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const postId = crypto.randomUUID();
    const max = await db
      .prepare('SELECT MAX(post_number) as max_num FROM posts WHERE thread_id = ?')
      .bind(threadId)
      .first<{ max_num: number | null }>();
    const postNumber = (max?.max_num ?? 0) + 1;

    try {
      await db
        .prepare(
          `INSERT INTO posts (id, thread_id, post_number, author_type, author_name, role, body, source_post_number, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .bind(postId, threadId, postNumber, authorType, authorName, role, body)
        .run();
      return { postId, postNumber };
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  throw new Error('Failed to assign post_number after 5 retries');
}

// ---- messages 構築 --------------------------------------------------------

/**
 * 投稿履歴を正式マルチターンの messages 配列に変換。
 * author_type: 'human' → role: 'user'
 * author_type: 'ai'    → role: 'assistant'
 * 直近 8 件を使用。最後に返信指示を付与。
 */
function buildMultiTurnMessages(
  posts: DbPost[],
  targetBody: string,
  replyCount: number,
): Message[] {
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];

  // 直近 8 件を user/assistant に変換
  for (const post of posts.slice(-8)) {
    // thinking ロールは会話に含めない
    if (post.author_type === 'ai' && post.author_name === '🤔 AIの思考') continue;

    messages.push({
      role: post.author_type === 'human' ? 'user' : 'assistant',
      content: post.body,
    });
  }

  // messages が system だけ or 最後が assistant → 返信対象を user として追加
  const lastRole = messages[messages.length - 1].role;
  if (lastRole === 'assistant' || lastRole === 'system') {
    messages.push({ role: 'user', content: targetBody });
  }

  // 最後の user メッセージに件数指示を追記
  const lastMsg = messages[messages.length - 1];
  lastMsg.content += `\n\n返信${replyCount}件をJSON形式で。`;

  return messages;
}

// ---- さくら AI 呼び出し ---------------------------------------------------

/** さくら AI Engine にマルチターン messages を送信して応答を取得 */
async function callSakuraCompletion(
  messages: Message[],
  apiToken: string,
  config: { maxTokens: number; temperature: number },
): Promise<{ content: string; thinking: string }> {
  const response = await fetch('https://api.ai.sakura.ad.jp/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-oss-120b',
      response_format: { type: 'json_object' },
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    }),
  });

  if (!response.ok) {
    throw new Error(`Sakura AI error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as SakuraResponse;
  return {
    content: data.choices[0]?.message?.content ?? '',
    thinking: data.choices[0]?.message?.reasoning_content ?? '',
  };
}

// ---- パース・アンカー -----------------------------------------------------

/** AI 応答の JSON から replies 配列をパース */
function parseJsonReplies(raw: string, count: number): string[] {
  if (!raw) return [];
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed?.replies)) {
      return parsed.replies
        .map((r: unknown) => String(r).trim())
        .filter((r: string) => r.length >= 5)
        .slice(0, count);
    }
  } catch {
    /* JSON 失敗時はフォールバック */
  }
  return parseLineReplies(raw, count);
}

/** フォールバック: 行分割でレスを抽出 */
function parseLineReplies(raw: string, count: number): string[] {
  return raw
    .trim()
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*>]\s*|\d+[.)、:：]\s*)/, '').trim())
    .filter((line) => line.length >= 15)
    .filter((line) => /^[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(line))
    .slice(0, count);
}

/** レスにランダムでアンカー（>>N）を割り当て */
function assignRandomAnchors(
  targetPostNumber: number,
  existingPostNumbers: number[],
  count: number,
): (number | null)[] {
  return Array.from({ length: count }, () => {
    const roll = Math.random();
    if (roll < 0.5) return targetPostNumber;
    if (roll < 0.75 && existingPostNumbers.length > 0) {
      return existingPostNumbers[Math.floor(Math.random() * existingPostNumbers.length)];
    }
    return null;
  });
}

/** アンカーをレス本文の先頭に付加 */
function applyAnchorsToReplies(replies: string[], anchors: (number | null)[]): string[] {
  return replies.map((reply, i) => {
    const anchor = anchors[i];
    return anchor != null ? `>>${anchor} ${reply}` : reply;
  });
}
