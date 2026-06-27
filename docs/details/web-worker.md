# Web Worker 詳細解説

Worker名: `bs-job-board-web`
コード量: 1,897行 / 14ファイル
技術: TanStack Start (SSR) + React on Cloudflare Workers

## 役割

ブラウザに面する唯一のWorkerで、3つの仕事をする。

1. React SSRによる画面描画
2. same-origin proxyによるAPI Workerへの中継
3. SSE EventSourceによるAI生成の進捗表示

## ファイル構成

```
apps/web/
├── src/
│   ├── routes/
│   │   ├── index.tsx           ← トップページ（一覧 + 作成）
│   │   ├── threads.$id.tsx     ← スレッド詳細（投稿 + SSE）
│   │   └── api/
│   │       └── $.ts            ← /api/* catch-all proxy
│   ├── lib/
│   │   ├── api-fetch.ts        ← Service Binding fetch
│   │   ├── api-proxy.ts        ← proxy本体
│   │   ├── use-ai-run-progress.ts ← SSE Hook
│   │   └── auth-client.ts      ← Better Auth client
│   ├── router.tsx
│   └── routeTree.gen.ts        ← TanStack自動生成
├── wrangler.jsonc
├── vite.config.ts
└── vitest.config.ts
```

## same-origin proxyの仕組み

ブラウザからの `/api/*` リクエストを、Service Binding経由でAPI Workerへ転送する。

```
ブラウザ → Web Worker /api/v1/threads
         → api-proxy.ts → Service Binding (env.API)
         → API Worker /api/v1/threads
         → レスポンスをそのままブラウザへ返す
```

TanStack StartのServer Route（`routes/api/$.ts`）でcatch-allハンドラを定義している。
GET/POST/PUT/PATCH/DELETE/OPTIONSの全メソッドを同じ関数で処理する。

### なぜproxyが必要か

Web WorkerとAPI Workerは別のCloudflare Workerとして動く。
ブラウザから見ると別origin。
Safari ITP（Intelligent Tracking Prevention）がthird-party cookieをブロックするため、API Workerに直接認証リクエストを送るとcookieが保存されない。

same-origin proxyにより、ブラウザからはWeb Workerのドメインしか見えない。
認証cookieもWeb Workerのドメインで発行される。

### proxyが処理する3つの問題

**hop-by-hopヘッダーの除去。**
`connection`、`transfer-encoding`等のプロキシで中継してはいけないヘッダーを除去する。

**Set-Cookieの透過。**
Cloudflare Workers環境では`Headers.getAll('Set-Cookie')`が使える。
WinterCG環境では`Headers.getSetCookie()`にフォールバックする。
複数のSet-Cookieヘッダーを個別に`append`して返す。

**X-Forwarded-Host/Protoの付与。**
API Worker側でBetter Authの`baseURL`を正しく組み立てるために、元のホスト名とプロトコルを転送する。

## SSE進捗表示

`use-ai-run-progress.ts`がEventSourceでAI生成の状態を監視する。

```typescript
const source = new EventSource(
  `/api/v1/ai-runs/${aiRunId}/events?after=0`
);
source.addEventListener('ai-run', handleEvent);
```

状態遷移に応じてUIラベルが変わる。

| 状態 | UIラベル |
|---|---|
| connecting | 接続中... |
| queued | 受付済み |
| admitted | AI受付完了 |
| generating | AIがレスを考えています... |
| repairing | 形式を整えています... |
| completed | 完了 |
| failed | エラーが発生しました |

`completed`を受信するとEventSourceを閉じ、`onCompleted`コールバックでスレッドを再取得する。
`failed`を受信するとEventSourceを閉じ、エラーバナーを表示する。

reconnection時は`reconnecting`状態を表示し、再接続後に前回の状態に復帰する。

## 認証フロー（クライアント側）

Better Auth clientの`signIn.anonymous()`で匿名認証を行う。

1. 投稿ボタンを押す
2. session cookieがなければ認証モーダルを表示
3. 「匿名で投稿する」を押す → `/api/auth/sign-in/anonymous` にPOST
4. session cookieが設定される
5. 以降の投稿ではcookieで自動認証

`localStorage`にuser_idをキャッシュするが、認証根拠としては使わない。
server sessionが唯一の認証根拠。

## serverFnによるデータ操作

TanStack Startの`createServerFn`で、サーバー側で実行される関数を定義する。

```typescript
const fetchThreads = createServerFn({ method: 'GET' })
  .validator((input: { sort: string }) => input)
  .handler(async ({ data }) => {
    const api = await getApi();
    const res = await api(`/api/v1/threads?sort=${data.sort}`);
    return res.ok ? await res.json() : [];
  });
```

GET系は`getApi()`（認証ヘッダーなし）、POST/PATCH系は`getAuthenticatedApi()`（Cookie/Authorization転送あり）を使う。

## テスト

```
src/lib/__tests__/
  ├── api-proxy.test.ts          ← hop-by-hop除去、Set-Cookie透過
  └── use-ai-run-progress.test.ts ← 状態遷移、reconnection
```

27ケース。proxy動作とSSE Hookの状態遷移を検証している。
