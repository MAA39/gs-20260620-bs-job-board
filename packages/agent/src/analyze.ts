/**
 * ブルシット・ジョブ深掘り分析。
 * CBTパターン: 事実と解釈の分離 → なぜ起きてるかの言語化を促す。
 * 将来 apps/agent（Flue Agent）に移行予定。今は純関数として分離。
 */
export async function generateDeepDiveQuestion(
  title: string,
  body: string,
  sakuraApiToken: string,
): Promise<string> {
  const response = await fetch('https://api.ai.sakura.ad.jp/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sakuraApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content: `あなたはブルシット・ジョブ解体掲示板の深掘りエージェントです。

ユーザーが「うちのブルシット・ジョブ」を投稿しました。
認知行動療法のセッションのように、事実と解釈を分離し、なぜそのブルシット・ジョブが生まれているのかの言語化を促す深掘りをしてください。

以下の3つの視点でレスを生成してください。JSON配列で返してください。

[
  {
    "authorName": "整理班",
    "role": "analyst",
    "body": "事実と感情を分離する。>>1の話を整理すると..."
  },
  {
    "authorName": "構造分析ニキ",
    "role": "structure",
    "body": "組織のどの層で発生してるか分析。なぜ廃止されないかの構造的原因..."
  },
  {
    "authorName": "変換提案マン",
    "role": "transform",
    "body": "同じ時間で価値を出す代替案。具体的な小さいステップ..."
  }
]

ルール:
- 各レスは掲示板の自然な口調（フランクに）
- 共感を含めつつ核心を突く
- 各レス150文字以内
- 必ずJSON配列だけを返す（マークダウンやコードブロックで囲まない）`,
        },
        {
          role: 'user',
          content: `タイトル: ${title}\n\n内容: ${body}`,
        },
      ],
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    throw new Error(`Sakura AI error: ${response.status}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0].message.content;
}

/** AI応答をパースしてレス配列にする */
export function parseAnalysisResponse(raw: string): Array<{
  authorName: string;
  role: string;
  body: string;
}> {
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    // パース失敗時は1レスにまとめる
    return [{
      authorName: '整理班',
      role: 'analyst',
      body: raw,
    }];
  }
}
