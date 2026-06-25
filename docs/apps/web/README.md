# Web Worker仕様（as-is）

> implementation: `apps/web/**`
> Cloudflare service: `bs-job-board-web`
> framework: TanStack Start + React
> snapshot: main `d328bd1fe5dab740ed498f38ac2e585e215e768e`

## 責務

Web Workerは現在、次を担当する。

- thread一覧と作成フォームのSSR/UI
- thread詳細とhuman返信UI
- reaction UI
- thread status切替UI
- anonymous auth開始UI
- API Workerを呼ぶTanStack server functions
- 5秒pollingによる表示更新
- `source_post_number`ベースのpost grouping

製品向けSSEは現在使用していない。

## Cloudflare bindings

`apps/web/wrangler.jsonc`:

| binding / value | 用途 |
|---|---|
| `API` | `bs-job-board-api`へのService Binding |
| `API_BASE_URL` | API公開URL。現行server function実装では直接参照していない |
| `nodejs_compat` | TanStack Start実行 |
| observability | Cloudflare observability有効 |

entrypointは`@tanstack/react-start/server-entry`。

## API呼び出し方式

各route file内の`getApi()`は、Cloudflare環境では`env.API.fetch()`を返す。ローカルfallbackは`http://localhost:8787`。

```text
Browser
  -> TanStack server function on Web Worker
  -> Service Binding API.fetch()
  -> API Worker
```

server functionは現在、元のbrowser request header/cookieをAPI requestへ明示的に引き継がない。

Better Auth clientは別経路で、API Workerの公開URLを直接base URLにする。

```text
Browser authClient
  -> https://bs-job-board-api.../api/auth/**
```

このため、API originのauth cookieとWeb server functionのService Binding requestが一つのsession経路として統合されていない。

## Route: `/`

実装: `apps/web/src/routes/index.tsx`

### Loader

`GET /api/v1/threads?sort=<search sort>`をserver functionから呼ぶ。API error時は空配列を返す。

search parameter:

- `sort=new` default
- `sort=hot`

### Polling

thread一覧を5秒ごとに再取得する。失敗は握り潰し、最後に取得できた一覧を維持する。

### Thread作成

フォーム項目:

- title
- body

未認証判定はBetter Auth sessionではなく、`localStorage['bs-user-id']`の有無。

作成処理:

1. localStorage IDがなければauth modalを表示
2. `POST /api/v1/threads`をserver functionから呼ぶ
3. API responseのthread IDは変数へ受けるが、遷移には使用しない
4. thread一覧を`sort=new`で再取得
5. 取得結果の先頭threadへ遷移

並行作成があると、自分が作成したthreadではなく新着先頭へ遷移する可能性がある。

### Anonymous auth

`authClient.signIn.anonymous()`をAPI公開originへ直接実行する。

成功時:

- `bs-user-id`
- `bs-user-name`

をlocalStorageへ保存する。

API接続失敗またはuserが返らない場合、browserで`crypto.randomUUID()`を生成し、localStorageへ保存するfallbackがある。このIDはBetter Auth sessionではない。

### Reaction

localStorageの`bs-user-id`をbodyの`userId`としてAPIへ送る。

Web側はAPI responseを次の型として扱う。

```ts
{ reacted: boolean; reaction_count: number }
```

API実装は`{ reacted, count }`を返すため、`reaction_count`がundefinedになる不一致がある。

## Route: `/threads/$id`

実装: `apps/web/src/routes/threads.$id.tsx`

### Loader

`GET /api/v1/threads/:id`を呼び、失敗時は`not found`例外。

### Polling

thread detailを5秒ごとに再取得する。失敗は握り潰す。

### Human reply

送信body:

```json
{
  "author_type": "human",
  "author_name": "名無しさん",
  "role": null,
  "body": "入力本文"
}
```

`POST /api/v1/threads/:id/posts`をserver functionから呼ぶ。未認証判定はlocalStorage IDの有無。

### Status toggle

画面上のbuttonで`open`と`fixed`を切り替え、`PATCH /api/v1/threads/:id`へ送る。所有者判定UIはない。

### Post grouping

postsを`post_number ASC`で並べる。

人間postごとに、次をその直後へ配置する。

1. `source_post_number === human post_number`のAI post
2. 同じsource番号の`role=thinking` post
3. `source_post_number IS NULL`で、現在のhuman postと次のhuman postの間にあるAI post
4. 同範囲のorphan thinking post

legacy dataを表示するためのfallbackロジックであり、IDベースの親子関係ではない。

### Legacy thinking表示

`role='thinking'`のpostは`<details>`で「AIの思考過程」として表示する。Phase 1以降のAgent workflowは新しいthinking postを保存しないが、既存D1データは表示される。

### 残存する旧stream code

component内に次のstate/functionが残っている。

- `streaming`
- `streamThinking`
- `streamContent`
- `streamSourceNum`
- `startAiStream()`

`startAiStream()`は削除済みAPI `/api/v1/threads/:id/ai-stream`を直接fetchするコードだが、現在のUIイベントから呼ばれていない。到達不能なdead codeである。

`streaming`は通常falseのままなので、生成中カードや思考stream表示は現行動作には出ない。

## Auth client

実装: `apps/web/src/lib/auth-client.ts`

```text
baseURL = API Worker public URL
plugin = anonymousClient
```

GitHub OAuth UIはdisabledで「準備中」。

## Error handling

- polling errorは握り潰す
- server functionのAPI response statusを十分確認しない箇所がある
- anonymous auth失敗時にlocal UUIDへfallback
- user向けerror message表示はほぼない
- AI生成失敗状態を受け取る仕組みがない

## 現行の表示更新

```text
thread/post作成
  -> APIが即時response
  -> Agentが非同期生成
  -> Webが5秒polling
  -> AI postがD1へ入った後に表示
```

run ID、queued、generating、repairing、failed等の状態はWebへ渡らない。

## 既知の負債

- localStorage IDとBetter Auth sessionが二重化
- auth失敗時にbrowser-only UUIDへfallback
- Service Binding requestにauth cookieを転送しない
- API responseの作成thread IDを遷移に使わない
- reaction response field名がAPIと不一致
- clientがauthor metadataとreaction user IDを送る
- status toggleに所有者認可がない
- product SSEなし
- dead `/ai-stream` client codeが残る
- groupingが`source_post_number`と時系列heuristic依存
- UI componentが大きく、データ取得・auth・表示ロジックがroute fileへ集中

## 対応コード

- `apps/web/src/routes/index.tsx`
- `apps/web/src/routes/threads.$id.tsx`
- `apps/web/src/lib/auth-client.ts`
- `apps/web/wrangler.jsonc`
