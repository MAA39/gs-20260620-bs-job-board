# `apps/web` 現行仕様

> Worker名: `bs-job-board-web`
> runtime: Cloudflare Workers + TanStack Start SSR
> entry: `@tanstack/react-start/server-entry`

## 責務

- スレッド一覧と作成フォームの表示
- スレッド詳細・投稿一覧の表示
- 人間返信の送信
- 匿名認証モーダル
- reaction送信
- thread status変更
- API WorkerへのServer Function経由アクセス
- 5秒pollingによる画面更新

## Cloudflare binding

`apps/web/wrangler.jsonc`:

| binding / var | 現在の値・接続先 | 使用状況 |
|---|---|---|
| `API` service binding | `bs-job-board-api` | `getApi()`から使用 |
| `API_BASE_URL` var | production API URL | 現行routeコードでは未使用 |

ローカルではService Binding importに失敗した場合、`http://localhost:8787`へfallbackする。

## route構成

```text
/
  スレッド作成
  スレッド一覧
  new / hot sort
  reaction

/threads/:id
  スレッド詳細
  投稿一覧
  人間返信
  status toggle
```

共通shellは`src/routes/__root.tsx`にあり、ヘッダー、最大幅720pxのcontainer、ページ全体のCSSを定義する。

## `/` スレッド一覧

実装: `src/routes/index.tsx`

### 読み込み

- search param `sort`を受ける
- defaultは`new`
- Server Functionから`GET /api/v1/threads?sort=...`
- 5秒間隔で同じ一覧を再取得する
- API失敗時は空配列として扱う

### スレッド作成

送信body:

```json
{
  "title": "...",
  "body": "..."
}
```

処理:

1. browser localStorageに`bs-user-id`がなければ認証モーダルを開く
2. Server Functionから`POST /api/v1/threads`
3. API responseの作成IDは画面遷移に直接使用しない
4. 新着一覧を再取得し、先頭のthread IDへ遷移する

このため、同時投稿があった場合は自分が作成したthread以外へ遷移する可能性がある。

### anonymous認証

`authClient.signIn.anonymous()`をpublic API originへ直接送る。

成功時:

- `bs-user-id`
- `bs-user-name`

をlocalStorageへ保存する。

失敗またはuserを返さない場合はbrowserで`crypto.randomUUID()`を作成し、認証済みとしてlocalStorageへ保存する。これはBetter Auth sessionではない。

### reaction

Server Functionから次を送る。

```json
{
  "userId": "localStorageのbs-user-id"
}
```

clientがuser IDを決定している。API responseの型注釈は`reaction_count`だが、API/DB実装は`count`を返すため、現行コード間でresponse field名が一致していない。

## `/threads/:id` スレッド詳細

実装: `src/routes/threads.$id.tsx`

### 読み込み

- loaderから`GET /api/v1/threads/:id`
- 通常時は5秒間隔で再取得
- APIがnon-2xxなら`not found` error

### 人間返信

Server Functionが以下を固定値込みで送る。

```json
{
  "author_type": "human",
  "author_name": "名無しさん",
  "role": null,
  "body": "user input"
}
```

clientが`author_type`と`author_name`を指定している。browser側の投稿可否判定はlocalStorageの`bs-user-id`有無だけで行う。

### status toggle

現在のstatusに応じて`open` / `fixed`をclientで反転し、`PATCH /api/v1/threads/:id`へ送る。所有者判定はない。

### 投稿グルーピング

表示は`post_number`昇順を基準にする。

1. human postを通常表示
2. `source_post_number`がhuman postの`post_number`と一致するAI postを直後にインデント表示
3. `role='thinking'`はthinking表示として別扱い
4. `source_post_number IS NULL`のlegacy AI postは、post number上で次のhuman postまでの範囲に属するものとして推定表示

現在の親子関係はpost IDではなく`source_post_number`に依存する。

## 残っている旧streamコード

`startAiStream()`、`streamThinking`、`streamContent`など、削除済みAPI route

```text
POST /api/v1/threads/:id/ai-stream
```

を読むコードが残っている。

ただし通常のUI操作から`startAiStream()`は呼ばれないため、現時点では実行されないdead pathである。もし呼ばれるようになるとAPI側は404となる。

同コードは`delta.reasoning_content`をUIへ表示する実装を含むため、再利用は禁止し、削除対象として扱う。

## 認証とcookieの現状

- Better Auth clientはAPI Workerのpublic originを直接指定
- 投稿Server FunctionはWeb WorkerからService BindingでAPIへアクセス
- Server Functionの`getApi()`はbrowser request headers/cookieを明示的に転送しない
- そのためAPI側`getSessionUser()`へBetter Auth sessionが届かない可能性が高い
- UIの認証済み判定はBetter Auth sessionではなくlocalStorage UUID

## ビルド・デプロイ

```bash
pnpm --filter @bs-job-board/web dev
pnpm --filter @bs-job-board/web typecheck
pnpm --filter @bs-job-board/web build
pnpm --filter @bs-job-board/web deploy
```

## 既知の差分・負債

- same-origin API/auth proxyなし
- browser UUID fallbackあり
- Server Functionからcookie転送なし
- client-controlled identityあり
- reaction response field名不一致
- thread作成後の遷移がreturned IDではなく一覧先頭
- pollingのみで製品向けSSEなし
- 削除済みstream route用dead codeあり
- legacy thinking表示コードあり
- GitHub loginはdisabled表示のみ
- status変更にauthorizationなし
