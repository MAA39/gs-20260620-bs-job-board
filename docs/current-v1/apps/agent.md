# `apps/agent` 現行仕様

> Worker名: `bs-job-board-agent`
> runtime: Cloudflare Workers + Flue
> entry: Flue build生成物 `dist/bs_job_board_agent/index.js`

## 責務

- Flue workflowのHTTP admission
- Sakura AI provider登録
- `session.prompt()`によるAI返信生成
- AI出力のruntime validationとrepair
- application D1から会話履歴取得
- application D1へAI postを保存
- Flue run eventの保持

現時点ではAgent Workerがmodel実行だけでなくapplication DB reader/writerも担当する。

## Cloudflare binding

`apps/agent/wrangler.jsonc`:

| binding | 種別 | 用途 |
|---|---|---|
| `DB` | D1 | thread履歴取得、AI post保存 |
| `FLUE_ANALYST_AGENT` | Durable Object | discovered agent |
| `FLUE_GENERATE_REPLIES_WORKFLOW` | Durable Object | workflow実行 |
| `FLUE_REGISTRY` | Durable Object | Flue registry |

Durable Object migration:

- v1: `FlueRegistry`, `FlueAnalystAgent`
- v2: `FlueGenerateRepliesWorkflow`

## 環境変数

| name | 必須 | default | 用途 |
|---|---|---|---|
| `SAKURA_API_TOKEN` | yes | なし | Sakura provider認証 |
| `SAKURA_BASE_URL` | no | `https://api.ai.sakura.ad.jp/v1` | OpenAI-compatible base URL |
| `SAKURA_MODEL_ID` | no | `gpt-oss-120b` | model ID |

実値はWorker secretまたはlocal `.dev.vars`で設定する。

## HTTP route

### `GET /health`

```json
{"ok":true}
```

### Flue routes

`app.route('/', flue())`でFlue generated routerをmountする。

app-level middlewareは以下をhost制限する。

- `/workflows/*`
- `/runs/*`

許可hostname:

- `agent`（Service Binding request）
- `localhost`
- `127.0.0.1`
- `[::1]`
- `::1`

production public worker hostnameからの直接アクセスは404となる。

`generate-replies.ts`は`route` middlewareをexportするが、現行moduleには`runs` middleware exportがない。FlueのHTTP run resourceを明示公開する構成にはなっていないため、`/runs/:id` streamがbuilt runtimeで404になる可能性がある。`scripts/probe-flue-stream.mjs`との整合は実環境で再確認が必要。

## workflow: `generate-replies`

route:

```text
POST /workflows/generate-replies
```

### admission payload

```json
{
  "threadId": "non-empty string",
  "threadTitle": "non-empty string",
  "targetBody": "non-empty string",
  "targetPostNumber": 1
}
```

validation:

- payloadはobject
- 3つのstringはtrim後non-empty
- `targetPostNumber`は1以上のsafe integer

不正時は`AI_INPUT_INVALID`。

## AI provider

runごとに`registerProvider('sakura-ai', ...)`を呼ぶ。

```text
api: openai-completions
base URL: envまたはSakura /v1
model: envまたはgpt-oss-120b
maxTokens: 1500
```

`SAKURA_API_TOKEN`未設定時は`AI_CONFIGURATION_ERROR`。

Flue agent設定:

- model: `sakura-ai/<model id>`
- thinkingLevel: `minimal`
- instruction: JSON objectのみ返す

## prompt仕様

system promptの現在値は短い固定文。

- 2chふう匿名掲示板住民
- 判断・説教をしない
- 投稿者の言葉を拾う
- 深掘り質問は全体で最大1つ
- AIを名乗らない
- `>>`を書かない
- `{"replies":[...]}`だけを返す

context:

1. thread title
2. DBから取得した履歴
3. target body
4. 返信3件の指示

### 履歴取得の現行仕様

```sql
SELECT post_number, author_name, body, author_type
FROM posts
WHERE thread_id = ? AND author_name != '🤔 AIの思考'
ORDER BY post_number DESC
LIMIT 8
```

取得後にreverseし、昇順でpromptへ入れる。

つまり現行仕様は:

- thread内の直近8post
- target source postより後のpostも、dispatch時点で存在すれば含み得る
- `role='thinking'`ではなくlegacy author nameだけで除外
- thread rootを常に保持する保証なし
- parent/branch/relevance選択なし
- AIの質問とhuman回答をpairとして保持する保証なし

これは現在の実装事実であり、望ましい最終回答contextではない。

## model呼び出し

初回:

```text
session.prompt(prompt)
timeout: 45 seconds
thinkingLevel: minimal
```

初回出力が不正なら、validation issueと直前出力を含むrepair promptを同じsessionへ1回送る。

2回目も不正なら`AI_OUTPUT_INVALID`。

## AI出力契約

```json
{
  "replies": ["...", "...", "..."]
}
```

validation:

- JSON全体を`JSON.parse(trimmed text)`できる
- `replies`配列がある
- exactly 3件
- 全要素string
- trim後5〜200文字
- 3件が重複しない
- `?`と`？`の合計が全体で最大1個

Markdown fenceやJSON前後の説明文は許容しない。

## AI post保存

1回のrunで3件を同じD1 `batch()`へ渡す。

保存値:

```text
id                 = crypto.randomUUID()
thread_id          = payload.threadId
post_number         = current MAX + index
post author_type    = ai
post author_name    = 名無しさん
role                = NULL
body                = generated reply
source_post_number  = payload.targetPostNumber
user_id             = NULL
```

post number unique conflict時のみ最大5回batch全体をretryする。

保存前にrunのthread IDとsource postの実在・対応関係は検証しない。

## run result

成功時:

```json
{
  "repliesCount": 3,
  "model": {
    "provider": "...",
    "id": "..."
  },
  "usage": {
    "input": 0,
    "output": 0
  }
}
```

usageは非負有限数のみ整数化し、それ以外を0とする。

## error code

workflow外へ投げるerror messageは以下へ正規化する。

- `AI_CONFIGURATION_ERROR`
- `AI_INPUT_INVALID`
- `AI_OUTPUT_INVALID`
- `AI_PROVIDER_TIMEOUT`
- `AI_RUN_FAILED`

DBへerror状態は保存しない。

## Durable Streams probe

root script `probe:flue-stream`がworkflow admission後、`streamUrl`または`/runs/:id`へ接続する。

集計対象:

- event総数
- text delta件数・文字数
- thinking delta件数・文字数
- next offset
- terminal run_end / error

`--show-text`なしではtext本文を表示しない。thinking本文は常に表示しない。

## dormant agent: `analyst`

`src/agents/analyst.ts`にpersistent agent definitionが残る。

- HTTP route exportなし
- model IDは`'sakura/gpt-oss-120b'`
- 現行appでprovider ID `sakura`は登録されない
- production flowから参照されないlegacy definition

## ビルド・デプロイ

```bash
pnpm --filter @bs-job-board/agent-worker dev
pnpm --filter @bs-job-board/agent-worker typecheck
pnpm --filter @bs-job-board/agent-worker build
pnpm --filter @bs-job-board/agent-worker deploy
```

## 既知の差分・負債

- Agentがapplication D1を直接読み書きする
- `ai_runs`、callback、idempotencyなし
- contextが単純な直近8post
- source post / thread整合性検証なし
- generated postのparent IDなし
- event stream HTTP公開設定とprobeの整合が未確認
- provider登録がworkflow内に閉じる
- dormant `analyst` agentのmodel provider ID不整合
- run失敗状態をapplication DBへ記録しない
- retryはpost number競合だけで、run単位の重複生成を防がない
