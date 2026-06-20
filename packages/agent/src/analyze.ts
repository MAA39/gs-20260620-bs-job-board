/**
 * ブルシット・ジョブ掲示板 AIレス生成
 * ADR-002 (slug:9afa44d21378) 準拠
 * structured output（JSON mode）でレスとthinkingを分離
 */

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
各レスは一文で30〜90文字。指定件数ぴったり。`;

export function buildReplyPrompt(params: {
  threadTitle: string;
  targetBody: string;
  recentPosts: Array<{ number: number; authorName: string; body: string; authorType: string }>;
  replyCount: number;
}): string {
  const history = params.recentPosts
    .slice(-8)
    .map((p) => `${p.number}. ${p.authorName}: ${p.body}`)
    .join('\n');

  return `スレッド名: ${params.threadTitle}
直近の流れ:
${history || '(最初の投稿)'}

返信対象: ${params.targetBody}

返信${params.replyCount}件をJSON形式で。`;
}

export type AiGenerationResult = {
  replies: string[];
  thinking: string;
  rawContent: string;
};

export async function generateReplies(params: {
  threadTitle: string;
  targetBody: string;
  recentPosts: Array<{ number: number; authorName: string; body: string; authorType: string }>;
  replyCount: number;
  sakuraApiToken: string;
}): Promise<AiGenerationResult> {
  const response = await fetch('https://api.ai.sakura.ad.jp/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${params.sakuraApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-oss-120b',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildReplyPrompt(params) },
      ],
      max_tokens: 1500,
      temperature: 0.7,
    }),
  });

  if (!response.ok) throw new Error(`Sakura AI error: ${response.status}`);

  const data = await response.json() as {
    choices: Array<{ message: { content: string | null; reasoning_content?: string }; finish_reason: string }>;
  };

  const thinking = data.choices[0]?.message?.reasoning_content ?? '';
  const rawContent = data.choices[0]?.message?.content ?? '';

  console.log('[AI] finish_reason:', data.choices[0]?.finish_reason);
  console.log('[AI Think]', thinking.slice(0, 300));
  console.log('[AI Content]', rawContent.slice(0, 300));

  // JSON パース（auto-reply-board の parseReplies 準拠）
  const replies = parseJsonReplies(rawContent, params.replyCount);

  return { replies, thinking, rawContent };
}

/** JSON形式のレスをパース */
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
    // JSON失敗時は行分割フォールバック
  }

  return parseLineReplies(raw, count);
}

/** フォールバック: 行分割 */
function parseLineReplies(raw: string, count: number): string[] {
  return raw.trim()
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*>]\s*|\d+[.)、:：]\s*)/, '').trim())
    .filter((line) => line.length >= 15)
    .filter((line) => /^[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(line))
    .slice(0, count);
}

export function assignAnchors(
  targetPostNumber: number,
  existingPostNumbers: number[],
  count: number,
): (number | null)[] {
  const anchors: (number | null)[] = [];
  for (let i = 0; i < count; i++) {
    const roll = Math.random();
    if (roll < 0.5) anchors.push(targetPostNumber);
    else if (roll < 0.75 && existingPostNumbers.length > 0) {
      anchors.push(existingPostNumbers[Math.floor(Math.random() * existingPostNumbers.length)]);
    } else {
      anchors.push(null);
    }
  }
  return anchors;
}

export function applyAnchors(replies: string[], anchors: (number | null)[]): string[] {
  return replies.map((reply, i) => {
    const anchor = anchors[i];
    return anchor != null ? `>>${anchor} ${reply}` : reply;
  });
}
