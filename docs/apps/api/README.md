# API Worker仕様（as-is）

> implementation: `apps/api/**`
> Cloudflare service: `bs-job-board-api`
> entrypoint: `apps/api/src/index.ts`
> snapshot: main `d328bd1fe5dab740ed498f38ac2e585e215e768e`

## 責務

API Workerは現在、次を担当する。

- thread一覧・詳細・作成
- human/任意postの追加
- reactionのtoggle
- thread status更新
- Better Auth anonymous session
- Agent WorkerへのAI生成dispatch
- application D1の主要CRUD

AI postの保存は現在Agent Workerが直接行うため、APIは唯一のD1 writerではない。

## Bindingsと設定

`apps/api/wrangler.jsonc`:

| binding / value | 用途 |
|---|---|
| `DB` | application D1 `bs-job-board-db` |
| `AGENT` | `bs-job-board-agent`へのService Binding |
| `nodejs_compat` | Better Auth等のNode互換 |
| observability | Cloudflare observability有効 |

実行時型には`BETTER_AUTH_SECRET`と`SAKURA_API_TOKEN`がある。`BETTER_AUTH_SECRET`は認証で使用する。`SAKURA_API_TOKEN`はAPI Workerでは現在使用せず、model呼び出しはAgent Worker側にある。

## Middleware

### CORS

全routeにCORSを適用する。

許可origin:

- `https://bs-job-board-web.masa-nekoshinshi39.workers.dev`
- `http://localhost:5173`

`credentials: true`。許可headerは`Content-Type`と`Authorization`、methodはGET/POST/PUT/PATCH/DELETE/OPTIONS。

### Request validation

現状は`c.req.json<T>()`のTypeScript型指定が中心で、runtime schema validationや共通body size上限はない。

## Routes

### `GET /health`

```json
{"status":"ok"}
```

認証不要。

### `GET /api/v1/threads?sort=new|hot`

thread一覧を返す。

- `new`: `created_at DESC`
- `hot`: `reaction_count DESC, created_at DESC`
- 不明値もTypeScript castされ、そのままDB関数へ渡る

Responseはthread rowの配列で、`reaction_count`を含む。

### `GET /api/v1/threads/:id`

threadと、そのthreadの全postsを`post_number ASC`で返す。threadがなければ404。

### `POST /api/v1/threads`

Request:

```json
{
  "title": "string",
  "body": "string"
}
```

動作:

1. `threads`へthreadをINSERT
2. `posts`へ`post_number=1`、`author_type=human`、`author_name=名無しさん`の最初のpostを同じD1 batchでINSERT
3. `executionCtx.waitUntil()`でAgentの`POST /workflows/generate-replies`をdispatch
4. dispatch完了を待たず201を返す

Response:

```json
{
  "id": "thread id",
  "title": "thread title"
}
```

認証確認は行わない。dispatch失敗はログだけで、thread作成結果やDB statusへ反映しない。

### `POST /api/v1/threads/:id/posts`

現行Request:

```json
{
  "author_type": "human | ai",
  "author_name": "string",
  "role": "string | null",
  "body": "string",
  "source_post_number": "number | null",
  "user_id": "string | null"
}
```

動作:

1. Better Auth session取得を試みる
2. sessionがあれば`user_id`をsession user IDで上書き
3. session nameが`Anonymous`以外なら`author_name`を上書き
4. それ以外の`author_type`、`role`、本文、source番号はclient入力を使用
5. `MAX(post_number)+1`で採番し、UNIQUE競合時に最大5回retry
6. client入力の`author_type === human`ならAgent workflowをdispatch

Response:

```json
{
  "id": "post id",
  "post_number": 2
}
```

session取得失敗は握り潰され、未認証postとして処理される。現状、clientは`author_type`を指定できる。

### `POST /api/v1/threads/:id/react`

Request:

```json
{"userId":"client supplied id"}
```

`reactions(thread_id, user_id)`の存在でtoggleし、`threads.reaction_count`を増減する。user IDはsessionではなくclient入力を信用する。

Response:

```json
{"reacted":true,"count":1}
```

Web側は`reaction_count`という名前を期待しており、現行APIの`count`と不一致がある。

### `PATCH /api/v1/threads/:id`

Request:

```json
{"status":"open | fixed"}
```

thread statusを更新する。所有者・session・権限確認はない。

### `GET|POST /api/auth/**`

Better Auth handlerへ委譲する。

- adapter: Kysely + D1Dialect
- plugin: anonymous
- trusted origin: production Web Worker、localhost:5173
- `BETTER_AUTH_SECRET`未設定時は503 `service not configured`

`getSessionUser()`は例外をすべて握り潰し、sessionが取れなければ`null`を返す。

## Agent dispatch契約

APIからService Bindingで以下を送る。

```http
POST http://agent/workflows/generate-replies
Content-Type: application/json
```

```json
{
  "threadId": "string",
  "threadTitle": "string",
  "targetBody": "string",
  "targetPostNumber": 1
}
```

成功条件はHTTP 2xx。response bodyは成功・失敗とも`finally`でcancelする。失敗ログにはerror name/messageを記録するが、永続的なrun failureは保存しない。

## D1書き込み

APIが現在書くもの:

- threads
- 最初のhuman post
- human/任意post
- reactions
- thread status
- Better Auth tables

AI postはAgent Workerが書く。

## エラーと整合性

- thread/post作成とAgent dispatchは同一transactionではない
- dispatch失敗後のretry/idempotency keyはない
- post採番は`MAX+1`とretry
- request body上限なし
- route単位のruntime validationなし
- Agent dispatchは非同期で、API responseにrun IDを含めない
- product SSE endpointは存在しない

## 既知の負債

- client authorityが強く、`author_type`、表示名、reaction user ID、statusを指定できる
- thread作成は未認証でも可能
- session cookieとWeb server functionの転送経路が一致していない
- APIとAgentが同じD1へ書く
- `ai_runs`と失敗状態の永続化がない
- owner modelがない
- error response形式が統一されていない

## 対応コード

- `apps/api/src/index.ts`
- `apps/api/src/routes/threads.ts`
- `apps/api/src/auth.ts`
- `apps/api/wrangler.jsonc`
- `packages/db/src/queries.ts`
