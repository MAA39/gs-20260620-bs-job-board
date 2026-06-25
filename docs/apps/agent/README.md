# Agent Worker仕様（as-is）

> implementation: `apps/agent/**`
> Cloudflare service: `bs-job-board-agent`
> framework: Flue Framework on Cloudflare Workers
> snapshot: main `d328bd1fe5dab740ed498f38ac2e585e215e768e`

## 責務

Agent Workerは現在、次を担当する。

- Flue workflow/run routeの提供
- Sakura AI Engine provider登録
- AI返信3件の生成
- AI JSON出力のruntime validation
- validation失敗時のrepair 1回
- application D1からthread履歴を取得
- application D1へAI postsを保存
- Flue Durable Objectsによるrun state保持

## HTTP入口

### `GET /health`

```json
{"ok":true}
```

公開health route。

### `/workflows/*`

Flue workflow route。Hono middlewareでrequest URLのhostnameを確認し、以下だけを許可する。

- `agent`
- `localhost`
- `127.0.0.1`
- `[::1]`
- `::1`

API WorkerのService Binding requestは`http://agent/...`なので許可される。公開Worker URLのhostnameはallow-list外となり404。

### `/runs/*`

Flue run resource。workflow routeと同じhost allow-listで制限される。内部debug用Durable Streamの取得に使用できる。

### Flue mount

`app.route('/', flue())`でFlue生成routeをrootへmountする。

## Cloudflare bindings

`apps/agent/wrangler.jsonc`:

| binding | 用途 |
|---|---|
| `DB` | API Workerと同じapplication D1 |
| `FLUE_ANALYST_AGENT` | Flue persistent agent Durable Object |
| `FLUE_GENERATE_REPLIES_WORKFLOW` | generate-replies workflow Durable Object |
| `FLUE_REGISTRY` | Flue registry Durable Object |

Agent Workerがapplication D1を持つのは現状仕様であり、API-only writerという目標設計には未移行。

## Environment variables

| name | 現行用途 |
|---|---|
| `SAKURA_API_TOKEN` | Sakura provider API key。未設定時`AI_CONFIGURATION_ERROR` |
| `SAKURA_BASE_URL` | provider base URL。default `https://api.ai.sakura.ad.jp/v1` |
| `SAKURA_MODEL_ID` | model ID。default `gpt-oss-120b` |

secret実値はrepositoryへ置かない。

## Workflow: `generate-replies`

実装: `apps/agent/src/workflows/generate-replies.ts`

### Input payload

```ts
type Payload = {
  threadId: string;
  threadTitle: string;
  targetBody: string;
  targetPostNumber: number;
};
```

runtimeで次を確認する。

- objectである
- string項目が空でない
- `targetPostNumber`が1以上のsafe integer

不正なら`AI_INPUT_INVALID`。

### Provider登録

Flue provider IDは`sakura-ai`。

```text
api: openai-completions
baseUrl: SAKURA_BASE_URLまたはdefault
model: SAKURA_MODEL_IDまたはgpt-oss-120b
maxTokens: 1500
```

URL末尾の`/chat/completions`と`/`を除去してFlueへ登録する。workflow内でSakuraへ直接`fetch()`はしない。

### Agent設定

- `createAgent()`を使用
- `thinkingLevel: minimal`
- JSON objectだけを返すようinstructionsを指定
- `session.prompt()`でmodelを呼ぶ
- request timeout: 45秒

### Promptの現行仕様

system promptの主な制約:

- 2chふう匿名掲示板の住民
- 判断・説教を避ける
- 投稿者の言葉を拾う
- 深掘り質問は3返信全体で最大1つ
- AIと名乗らない
- `>>`アンカーを書かない
- JSON `{"replies":[...3件...]}`だけを返す

履歴取得SQL:

```sql
SELECT post_number, author_name, body, author_type
FROM posts
WHERE thread_id = ? AND author_name != '🤔 AIの思考'
ORDER BY post_number DESC
LIMIT 8
```

取得後にreverseし、古い順でpromptへ入れる。

重要: **直近8件は現在の実装挙動であり、良い回答contextの最終仕様ではない。** thread root、会話branch、直前のAI質問と人間回答、既出論点を構造的に選ぶ処理はない。また`role='thinking'`のみの除外は行わず、旧thinking投稿者名だけを除外する。

### AI出力契約

返信数は固定3件。

検証内容:

- JSON objectである
- `replies`がarray
- 件数が3
- 全要素がstring
- 各返信5〜200文字
- 重複なし
- `?`と`？`の総数が最大1

### Repair

初回validation失敗時だけ、問題一覧と前回出力を渡して2回目の`session.prompt()`を行う。2回目も失敗すると`AI_OUTPUT_INVALID`。repairは最大1回。

### D1 read/write

生成前:

- 対象threadの直近8 postsを読む

生成後:

- AI返信3件を`db.batch()`で保存
- `author_type='ai'`
- `author_name='名無しさん'`
- `role=NULL`
- `source_post_number=targetPostNumber`
- `user_id=NULL`
- post IDは`crypto.randomUUID()`

post numberはbatch前に`MAX(post_number)+1`を取得し、連番を割り当てる。UNIQUE競合だけ最大5回retryする。

現行workflowはthinking本文をD1へ保存しない。

### Result

```ts
{
  repliesCount: 3,
  model: { provider: string, id: string },
  usage: { input: number, output: number }
}
```

このresultはFlue run resultであり、APIのthread作成responseには含まれない。

## エラーコード

workflow外へ投げるエラーmessageは次の短いcodeへ正規化する。

- `AI_CONFIGURATION_ERROR`
- `AI_INPUT_INVALID`
- `AI_PROVIDER_TIMEOUT`
- `AI_OUTPUT_INVALID`
- `AI_RUN_FAILED`

provider response本文や非公開thinkingは保存しない。

## Streaming

`session.prompt()`の生成eventはFlue Durable Streamsへ記録され得る。repositoryには`pnpm probe:flue-stream`用scriptとrunbookがある。

これは内部検証用で、Browserへ直接公開する製品SSEではない。Web Workerはrun IDを受け取らず、Flue streamを購読しない。

## 既知の負債

- Agent Workerがapplication D1を直接読み書きする
- APIとAgentの二重writer
- AI実行のidempotency keyと永続statusがない
- APIから受ける`threadTitle`、`targetBody`、`targetPostNumber`とD1内容の整合性を検証しない
- contextは単純な直近8件で、会話構造を理解しない
- host allow-listは内部routeの簡易gateで、明示的なcredential認証ではない
- failureをapplication D1へ保存しない
- completed postとrunの対応表がない

## 対応コード

- `apps/agent/src/app.ts`
- `apps/agent/src/workflows/generate-replies.ts`
- `apps/agent/flue.config.ts`
- `apps/agent/wrangler.jsonc`
- `scripts/probe-flue-stream.mjs`
- `docs/runbooks/flue-stream-probe.md`
