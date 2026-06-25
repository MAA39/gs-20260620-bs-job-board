# `packages/agent` 現行仕様

> package: `@bs-job-board/agent`
> entry: `src/index.ts`
> status: legacy shared package

## 責務として残っているコード

- bulletin-board reply prompt作成
- Sakura AIへの直接HTTP呼び出し
- JSON/line fallback parser
- reply anchorのランダム割当
- generated content / thinkingの返却

ただし現行mainの`apps/**`からこれらのexportを参照するコードはない。production AI生成は`apps/agent/src/workflows/generate-replies.ts`へ移行済み。

## export

```ts
generateReplies
buildReplyPrompt
assignAnchors
applyAnchors
AiGenerationResult
```

## `buildReplyPrompt`

入力:

```ts
{
  threadTitle: string;
  targetBody: string;
  recentPosts: Array<{
    number: number;
    authorName: string;
    body: string;
    authorType: string;
  }>;
  replyCount: number;
}
```

`recentPosts.slice(-8)`を履歴にしてpromptを作る。

## `generateReplies`

Sakura APIを直接fetchするlegacy implementation。

```text
POST https://api.ai.sakura.ad.jp/v1/chat/completions
model: gpt-oss-120b
response_format: json_object
max_tokens: 1500
temperature: 0.7
```

戻り値:

```ts
type AiGenerationResult = {
  replies: string[];
  thinking: string;
  rawContent: string;
};
```

model responseの`reasoning_content`を`thinking`として取得し、以下をconsole logする。

- finish reason
- thinking先頭300文字
- content先頭300文字

この挙動は現行アーキテクチャの安全境界に反するが、production pathからは参照されていない。

## parser

1. JSON fenceを除去
2. `JSON.parse`
3. `replies`をstring化
4. 5文字以上
5. 指定件数までslice

JSON parse失敗時は行分割fallbackを使用する。

- 箇条書きprefixを除去
- 15文字以上
- 先頭が日本語文字
- 指定件数までslice

厳密な件数一致、重複、質問数、最大長の検証はない。

## anchor

`assignAnchors()`は各replyごとに乱数で決める。

- 50%: target post
- 25%: existing postからランダム
- 25%: null

`applyAnchors()`は本文先頭へ`>>N`を付ける。

現在のAgent workflowはこの関数を使わず、`source_post_number`だけを保存する。

## package設定

- `@bs-job-board/contracts`へ依存するが、現行`analyze.ts`ではimportしない
- `typecheck`以外のscriptなし
- testなし

## 既知の差分・負債

- production pathでは未使用
- direct provider fetchを含む
- non-public model dataをlog/returnする
- 現行workflowとprompt・validation仕様が二重管理
- random anchor仕様が現行保存方式と不一致
- stale dependencyあり

削除または安全なpure utilityだけへ縮小する候補。再利用する場合は直接AI呼び出し部分を復活させない。
