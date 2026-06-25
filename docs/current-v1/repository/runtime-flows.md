# cross-worker runtime flow 現行仕様

## 1. スレッド一覧

```text
Browser
  -> TanStack loader / Server Function
  -> Web Worker `env.API.fetch()`
  -> API GET /api/v1/threads?sort=new|hot
  -> D1 SELECT threads
  -> Browser render
```

Webは5秒ごとに同じAPIをpollingする。

## 2. スレッド作成とAI返信

```text
Browser
  -> Web Server Function POST
  -> API POST /api/v1/threads
  -> D1 batch
       threads INSERT
       initial human post INSERT
  -> API response 201
  -> API waitUntil
       Service Binding POST http://agent/workflows/generate-replies
  -> Agent workflow
       D1 SELECT recent 8 posts
       Flue session.prompt()
       validation
       invalidならrepair 1回
       D1 batch AI posts x3 INSERT
  -> Web 5秒pollingでAI postsを取得
```

API responseにはworkflow run IDや進捗URLを含めない。

## 3. 人間返信とAI返信

```text
Browser
  -> Web Server Function
  -> API POST /api/v1/threads/:id/posts
  -> Better Auth session lookup
  -> D1 INSERT human post
  -> API response 201
  -> API waitUntil Agent workflow
  -> Agent D1 INSERT AI posts x3
  -> Web polling
```

sessionが取得できなくても投稿を拒否しない。clientのauthor nameが使用され、user IDはnullになる。

## 4. anonymous認証

```text
Browser authClient
  -> public API origin /api/auth/**
  -> Better Auth anonymous plugin
  -> D1 user/session/account tables
  -> browser localStorageへuser ID/name保存
```

認証失敗時、browserがUUIDを生成してlocalStorageへ保存する。このUUIDはBetter Auth sessionではない。

通常のthread/post Server FunctionはWeb WorkerからService BindingでAPIへ送るが、browser cookieを明示転送しない。

## 5. reaction

```text
Browser localStorage user ID
  -> Web Server Function
  -> API POST /api/v1/threads/:id/react
  -> D1 reactions lookup
  -> insert/delete + reaction_count update
```

APIはsession userと入力user IDを照合しない。

## 6. thread status

```text
Browser calculates next status
  -> Web Server Function
  -> API PATCH /api/v1/threads/:id
  -> D1 UPDATE threads.status
```

認証・所有者検証なし。

## 7. Flue内部stream probe

```text
CLI
  -> local/internal Agent workflow admission
  -> admission receipt runId/streamUrl
  -> GET run stream as SSE
  -> frame/event count summary
```

製品画面からは利用しない。

## write ownershipの現状

```text
API Worker writes:
  threads
  initial/human/client-supplied posts
  reactions
  thread counters/status
  Better Auth tables

Agent Worker writes:
  generated AI posts

Flue Durable Objects write:
  Flue registry/agent/workflow state
```

API-only writerは未成立。

## failure behavior

### API -> Agent dispatch failure

- human dataはすでにD1へcommit済み
- console errorのみ
- retry statusなし
- userへAI failureを返さない
- run recordなし

### provider / validation failure

- workflow runはerror
- application D1へerror recordなし
- Webはpollingを続けるだけ
- UIへfailed状態なし

### Web polling failure

- exceptionを無視
- 最後に成功した表示を維持

### auth failure

- API session helperはnullへ変換
- Webはbrowser UUID fallbackを使用

## consistencyの現状

- thread + initial postはD1 batch
- AI replies 3件はD1 batch
- human replyとAI run admissionはatomicではない
- AI generationの二重dispatchを防ぐkeyなし
- reaction存在確認とtoggle writeはatomicではない
- post numberはMAX+1 + unique index + retry
