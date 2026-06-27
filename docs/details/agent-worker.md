# Agent Worker 詳細解説

Worker名: `bs-job-board-agent`
コード量: 359行 / 4ファイル
技術: Flue Framework + さくらAI Engine (gpt-oss-120b)

## 役割

AI生成に専念するWorker。
D1への直接アクセス権を持たない。
生成結果はAPI Workerへのcallbackで返す。

外部に公開されていない（`workers_dev: false`）。
API WorkerからのService Binding経由でのみアクセスできる。

## ファイル構成

```
apps/agent/
├── src/
│   ├── app.ts                         ← Hono + Flue routing
│   ├── workflows/
│   │   └── generate-replies.ts        ← AI生成ワークフロー本体
│   └── agents/
│       └── analyst.ts                 ← Flue Agent定義（将来用）
├── flue.config.ts                     ← target: cloudflare
├── wrangler.jsonc                     ← Durable Objects定義
├── .env.example
└── .dev.vars.example
```

## Flue Frameworkとは

Astroチーム（ウェブフレームワーク「Astro」の開発元）が作ったAIエージェントフレームワーク。
2026年6月16日に1.0 Betaがリリースされた。

Cloudflare WorkersのDurable Objectsをバックエンドに使い、AIエージェントの状態管理、ワークフロー実行、Durable Execution（途中で止まっても再開できる永続実行）を提供する。

このアプリではFlueの**Workflow**機能だけを使っている。
Agent（対話型）機能やChannel（リアルタイム通信）機能は使っていない。

## Durable Objects

wrangler.jsoncに3つのDurable Objectsを定義している。

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "FLUE_ANALYST_AGENT", "class_name": "FlueAnalystAgent" },
    { "name": "FLUE_GENERATE_REPLIES_WORKFLOW", "class_name": "FlueGenerateRepliesWorkflow" },
    { "name": "FLUE_REGISTRY", "class_name": "FlueRegistry" }
  ]
}
```

FlueRegistryはFlue内部のルーティングに使われる。
FlueAnalystAgentは将来の拡張用で、現在は使われていない。
FlueGenerateRepliesWorkflowが実際のAI生成を実行するDO。

DOの内部にはSQLiteが内蔵されている。
ここにはFlueのワークフロー実行状態（run ID、ステップ進捗）だけが保存される。
ビジネスデータ（スレッド、投稿）はAPI WorkerのD1に保存される。

## AI生成ワークフロー（generate-replies.ts）

ワークフローの全体フロー:

```
1. payload解析（aiRunId, context）
2. さくらAI Engineのプロバイダー登録
3. callback: generating状態を通知
4. プロンプト組み立て → さくらAI Engine呼び出し
5. レスポンスのJSON validation
6. validation失敗 → callback: repairing → repair prompt → 再validation
7. repair後も失敗 → フォールバックレスで続行
8. SHA-256ハッシュ計算
9. callback: complete（結果 + usage）
```

### プロンプト

SYSTEM_PROMPTで口調と制約を定義する。

```
2chふう匿名掲示板の住民として返答する。
判断や説教をせず、投稿者の言葉を拾って材料を並べる。
深掘り質問は全体で最大1つ。AIを名乗らず、>>記号も書かない。
必ずJSONオブジェクトだけを返す: {"replies":["レス1","レス2","レス3"]}
```

ユーザープロンプトにスレッドタイトル、直近の投稿履歴、返信対象の本文を含める。

### validation（ADR-005）

当初は3件ちょうど、各5-200文字、全件ユニーク、疑問符最大1つを要求していた。
AIの出力バラツキでこの条件を満たせない場合があり、失敗率が25%に達した。

ADR-005で以下に緩和した。

- 件数: 1-5件（旧: 3件ちょうど）
- 文字数: 1-500文字（旧: 5-200文字）
- ユニーク制約: 撤廃
- 疑問符制約: 撤廃

### フォールバック

repair（修正プロンプトで再試行）後もvalidationに失敗した場合、定型レスで続行する。

```typescript
const FALLBACK_REPLIES = [
  'ちょっと拾いきれんかったわ。もう少し具体例あるとレスしやすい気がする。',
];
```

ブラウザにはエラーバナーではなく通常のレスとして表示される。

### usage累積

repair時にusageが上書きされないよう、加算で管理する。

```typescript
const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const accumulateUsage = (usage) => {
  totalUsage.input += nonNegative(usage.input);
  totalUsage.output += nonNegative(usage.output);
  // ...
};
```

初回prompt + repair promptの両方のtoken消費を合算してcallbackに含める。

### エラーハンドリング

エラーはallow-listのコードに正規化する。
rawなerror.messageは保存しない。

| コード | 意味 |
|---|---|
| AI_CONFIGURATION_ERROR | API token等の設定不備 |
| AI_PROVIDER_TIMEOUT | さくらAI Engineの応答タイムアウト（45秒） |
| AI_OUTPUT_INVALID | validation + repair + fallback全失敗 |
| AI_INPUT_INVALID | dispatch payloadの不備 |
| AI_DISPATCH_FAILED | dispatchそのものの失敗 |
| AI_RUN_FAILED | その他の想定外エラー |

## callbackの仕組み

Agent WorkerからAPI Workerへ、Service Binding経由でPOSTを送る。

```typescript
await api.fetch(
  new Request(`http://api/internal/v1/ai-runs/${aiRunId}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Callback-Key': callbackKey,
    },
    body: body ? JSON.stringify(body) : '{}',
  })
);
```

`http://api` はService Bindingのダミーorigin。
実際のネットワーク通信は発生せず、同一データセンター内のWorker間呼び出しとして処理される。

## さくらAI Engineプロバイダー登録

Flueの`registerProvider`でOpenAI互換APIとして登録する。

```typescript
registerProvider('sakura-ai', {
  api: 'openai-completions',
  baseUrl: 'https://api.ai.sakura.ad.jp/v1',
  apiKey: env.SAKURA_API_TOKEN,
  models: { 'gpt-oss-120b': { contextWindow: 128_000, maxTokens: 1_500 } },
});
```

contextWindowは128,000 tokens（OCI公式値）。
当初0に設定していたためFlueのproactive compactionが効かず、全AI生成が失敗する問題があった（#38）。

## CIガード

Agent WorkerがD1に直接アクセスしないことをCIで検査している。

```yaml
- name: Agent D1 isolation guard
  run: |
    test -z "$(grep -RE 'env\.DB|D1Database' apps/agent/src/workflows || true)"
    test -z "$(grep -R '"d1_databases"' apps/agent/wrangler.jsonc || true)"
    grep -Eq '"workers_dev"[[:space:]]*:[[:space:]]*false' apps/agent/wrangler.jsonc
```

`env.DB`が1行でも登場するとCIが落ちる。
