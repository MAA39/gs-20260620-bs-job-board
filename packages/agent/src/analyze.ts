/**
 * ブルシット・ジョブ掲示板 AI返信生成
 * auto-reply-board のプロンプト設計を移植。2ch風住民レス。
 */

const SYSTEM_PROMPT = `あなたは2chふう匿名掲示板の住民として、ブルシット・ジョブについて投稿された内容に自然にレスします。
あなたは相談員でも教師でもなく、助言ではなく反応を返す名無しです。
返信文だけを指定件数ぴったりの行数で返します。
JSON、行頭の「1.」「2.」のような箇条書き番号、説明は禁止です。
各返信は30文字以上90文字以内の一文にし、質問で終わらせません。

ブルシット・ジョブ掲示板としての特別ルール:
- 投稿者のモヤモヤに共感しつつ、「なんでそれ続いてるん？」と自然に深掘りする
- 事実と感情を分ける視点を、掲示板の雑談として自然に混ぜる
- 同じ経験を持つ住民として「うちはこうだった」的な具体例を混ぜる
- 説教や正論で締めない。草、ワロタ、わかる、あるある等は自然に使う
- >>記号は書かない（アプリ側で付ける）
- 煽りすぎ、人格攻撃、差別表現は禁止`;

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
必要な返信数: ${params.replyCount}件

直近の流れ:
${history || '(最初の投稿)'}

返信対象:
${params.targetBody}

返信文だけを ${params.replyCount} 行で返す。番号やJSON禁止。本文のみ。`;
}

export async function generateReplies(params: {
  threadTitle: string;
  targetBody: string;
  recentPosts: Array<{ number: number; authorName: string; body: string; authorType: string }>;
  replyCount: number;
  sakuraApiToken: string;
}): Promise<string[]> {
  const response = await fetch('https://api.ai.sakura.ad.jp/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${params.sakuraApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-oss-120b',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildReplyPrompt(params) },
      ],
      max_tokens: 800,
      temperature: 0.7,
    }),
  });

  if (!response.ok) throw new Error(`Sakura AI error: ${response.status}`);

  const data = await response.json() as {
    choices: Array<{ message: { content: string | null; reasoning_content?: string } }>;
  };

  // content が null の場合は reasoning_content を使う（さくらAIのreasoningモデル対応）
  const content = data.choices[0]?.message?.content
    ?? data.choices[0]?.message?.reasoning_content
    ?? '';

  return parseReplies(content, params.replyCount);
}

export function parseReplies(raw: string, count: number): string[] {
  if (!raw) return [];
  const text = raw.trim();

  // Strategy 1: 思考ノイズ混入時 — "日本語テキスト" を抽出
  const quoted = [...text.matchAll(/"([^"]*[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+[^"]*)"/g)]
    .map(m => m[1].trim())
    .filter(s => s.length >= 15 && /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(s));

  if (quoted.length >= count) return quoted.slice(0, count);

  // Strategy 2: 純粋な日本語行分割（思考ノイズなし時）
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*>]\s*|\d+[.)、:：]\s*)/, '').trim())
    .filter((line) => line.length >= 15)
    .filter((line) => !/(d+)/.test(line)) // character countノイズ除去
    .filter((line) => /^[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF>>]/.test(line)) // 日本語or>>で始まる
    .filter((line) => !/JSON|System|Line\d|Count|Check|Sentence|^We |^Let|^Need/.test(line));

  return (lines.length > 0 ? lines : quoted).slice(0, count);
}

export function assignAnchors(
  targetPostNumber: number,
  existingPostNumbers: number[],
  count: number,
): (number | null)[] {
  const anchors: (number | null)[] = [];
  const allNumbers = [...existingPostNumbers];
  for (let i = 0; i < count; i++) {
    const roll = Math.random();
    if (roll < 0.5) anchors.push(targetPostNumber);
    else if (roll < 0.75 && allNumbers.length > 0) anchors.push(allNumbers[Math.floor(Math.random() * allNumbers.length)]);
    else anchors.push(null);
  }
  return anchors;
}

export function applyAnchors(replies: string[], anchors: (number | null)[]): string[] {
  return replies.map((reply, i) => {
    const anchor = anchors[i];
    return anchor != null ? `>>${anchor} ${reply}` : reply;
  });
}
