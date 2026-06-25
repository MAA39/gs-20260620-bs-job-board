# `apps/api` 現行仕様

> Worker名: `bs-job-board-api`
> runtime: Cloudflare Workers + Hono
> entry: `src/index.ts`

## 責務

- application D1のHTTP API
- thread / post / reaction / statusのCRUD
- Better Auth endpoint
- Agent WorkerへのFlue workflow dispatch
- CORS設定

現時点ではAPI Workerだけがwriterではない。Agent Workerも同じapplication D1へAI postを書き込む。

## Cloudflare binding

`apps/api/wrangler.jsonc`:

| binding | 種別 | 接続先 |
|---|---|---|
| `DB` | D1 | `bs-job-board-db` |
| `AGENT` | Service Binding | `bs-job-board-agent` |

コード上のBindings型には`SAKURA_API_TOKEN`が残っているが、現行API routeでは使用しない。model呼び出しはAgent Workerへ移行済み。

Better Authには`BETTER_AUTH_SECRET`が必要。未設定時、`/api/auth/**`は503を返す。

## middleware

### CORS

許可origin:

- `https://bs-job-board-web.masa-nekoshinshi39.workers.dev`
- `http://localhost:5173`

設定:

- credentials: true
- headers: `Content-Type`, `Authorization`
- methods: GET / POST / PUT / PATCH / DELETE / OPTIONS

### health

```http
GET /health
```

```json
{"status":"ok"}
```

## thread API

base path:

```text
/api/v1/threads
```

### `GET /api/v1/threads`

query:

```text
sort=new | hot
```

未指定時は`new`。

- `new`: `created_at DESC`
- `hot`: `reaction_count DESC, created_at DESC`

入力値のruntime validationはなく、型castで`new | hot`として扱う。

### `GET /api/v1/threads/:id`

- threadと全postsを返す
- postsは`post_number ASC`
- threadがなければ404

### `POST /api/v1/threads`

入力:

```json
{
  "title": "string",
  "body": "string"
}
```

処理:

1. `threads`をINSERT
2. `post_number=1`のhuman postを同じD1 batchでINSERT
3. `waitUntil()`でAgent workflowへ非同期dispatch
4. HTTP responseはAI生成完了を待たず201

response:

```json
{
  "id": "thread UUID",
  "title": "..."
}
```

このrouteではsession取得、owner保存、入力長制限、runtime schema validationを行わない。

### `POST /api/v1/threads/:id/posts`

入力型はclientから以下を受ける。

```json
{
  "author_type": "human | ai",
  "author_name": "string",
  "role": "analyst | structure | transform | comment | thinking | null",
  "body": "string",
  "source_post_number": "number | null",
  "user_id": "string | null"
}
```

処理:

1. Better Auth sessionを取得しようとする
2. `user_id`はsession user ID、なければnullへ上書き
3. session user名が`Anonymous`以外なら`author_name`をsession値へ上書き
4. それ以外ではclientの`author_name`を採用
5. `addPost()`でpost numberを採番してINSERT
6. client入力の`author_type === 'human'`の場合のみAgent workflowをdispatch

`author_type`、`role`、`source_post_number`はclient-controlled。clientが`author_type='ai'`を送れば、AI生成を起動せずAI投稿として保存できる。

response:

```json
{
  "id": "post UUID",
  "post_number": 2
}
```

### `POST /api/v1/threads/:id/react`

入力:

```json
{
  "userId": "client supplied string"
}
```

`reactions`の存在を確認し、toggleする。

- 未登録: reaction INSERT + thread count +1
- 登録済み: reaction DELETE + thread count -1

responseはDB実装上、次の形。

```json
{
  "reacted": true,
  "count": 1
}
```

sessionとの照合はなく、任意のuser IDをclientが指定できる。

### `PATCH /api/v1/threads/:id`

入力:

```json
{
  "status": "open | fixed"
}
```

thread ownerやsessionを検証せず更新する。存在しないthreadでも明示的な404判定はない。

## Agent workflow dispatch

送信先:

```text
http://agent/workflows/generate-replies
```

payload:

```json
{
  "threadId": "...",
  "threadTitle": "...",
  "targetBody": "...",
  "targetPostNumber": 1
}
```

- Cloudflare Service Binding経由
- dispatch responseがnon-2xxならerror
- response bodyは`finally`でcancel
- `runId`や`streamUrl`は保存しない
- dispatch failureはconsole logのみ
- D1上にqueued / failed状態を残さない
- retry / idempotency管理なし

thread作成時・human返信時の2箇所から同じworkflowへdispatchする。

## Better Auth

base path:

```text
/api/auth/**
```

構成:

- Better Auth
- Kysely + `kysely-d1`
- anonymous plugin
- requestごとにauth instanceを生成
- trusted originsはproduction Web Workerとlocalhost

`getSessionUser()`は例外をすべてcatchしてnullを返す。このため認証障害と未認証を区別しない。

## D1アクセス

主に`@bs-job-board/db`を使用するが、human返信時のthread title取得はroute内で直接SQLを実行する。

現在のwrite経路:

```text
API Worker
  threads INSERT
  human/任意post INSERT
  reaction INSERT/DELETE
  thread reaction_count UPDATE
  thread status UPDATE

Agent Worker
  AI posts INSERT
```

## 入力処理の現状

- Effect / Zod等のruntime validationなし
- `request.json()`相当で全bodyを読み込む
- content-length上限なし
- chunked bodyの上限付きreaderなし
- title / bodyの文字数制限なし
- 空文字検証はWeb UIのHTML requiredに依存

## ビルド・デプロイ

```bash
pnpm --filter @bs-job-board/api dev
pnpm --filter @bs-job-board/api typecheck
pnpm --filter @bs-job-board/api build
pnpm --filter @bs-job-board/api deploy
```

`build`は`wrangler deploy --dry-run`。

## 既知の差分・負債

- API-only writer未成立
- `ai_runs` / event / idempotencyなし
- dispatch結果をDBへ記録しない
- client-controlled author identity / role / source / reaction user ID / status
- thread ownershipなし
- anonymous auth failureと未認証を区別しない
- request size limitなし
- API response contractのruntime検証なし
- stale dependency `@bs-job-board/agent`とstale binding type `SAKURA_API_TOKEN`あり
- internal callback endpointなし
- 製品向けSSEなし
