# Web Worker — as-is仕様

Worker名: `bs-job-board-web`
URL: `https://bs-job-board-web.masa-nekoshinshi39.workers.dev`
エントリ: `@tanstack/react-start/server-entry`（TanStack Start SSR）

## Bindings

| Binding | 種別 | 用途 |
|---------|------|------|
| API | Service Binding | `bs-job-board-api` — 全APIリクエストの転送先 |

Web WorkerはD1やSecretを直接持たない。全てのデータアクセスはAPI Worker経由。

## ページ構成

| Path | ファイル | 内容 |
|------|---------|------|
| `/` | `routes/index.tsx` | スレッド一覧 + 新規作成フォーム + リアクション |
| `/threads/:id` | `routes/threads.$id.tsx` | スレッド詳細 + レス投稿 + SSE進捗 + status変更 |
| `/api/*` | `routes/api/$.ts` | catch-all reverse proxy（→ API Worker） |

## ServerFn一覧

TanStack Start serverFnでサーバーサイド処理を実行。Service Binding経由でAPI Workerを呼ぶ。

### index.tsx

| serverFn | Method | 認証 | 処理 |
|----------|--------|------|------|
| `fetchThreads` | GET | 不要 | スレッド一覧取得 |
| `createThreadAction` | POST | `getAuthenticatedApi()` | スレッド作成 |
| `reactAction` | POST | `getAuthenticatedApi()` | リアクションtoggle |

### threads.$id.tsx

| serverFn | Method | 認証 | 処理 |
|----------|--------|------|------|
| `fetchDetail` | GET | 不要 | スレッド詳細取得 |
| `addComment` | POST | `getAuthenticatedApi()` | レス投稿 |
| `fixThread` | POST | `getAuthenticatedApi()` | status変更 |

## API通信パターン

2つの経路がある。

**serverFn経由（データ操作）:**

```
Browser → Web Worker (serverFn handler)
  → getApi() or getAuthenticatedApi()
  → Service Binding env.API.fetch("https://api/api/v1/...")
  → API Worker
```

`getAuthenticatedApi()` は incoming requestの Cookie/Authorization/X-Forwarded-* を転送する。

**catch-all proxy経由（SSE・auth）:**

```
Browser fetch("/api/v1/ai-runs/:id/events")
  → Web Worker /api/* catch-all
  → proxyApiRequest()
  → Service Binding env.API.fetch("https://api/api/v1/ai-runs/:id/events")
  → SSE stream を透過的に転送
```

SSEとBetter Auth（`/api/auth/*`）はブラウザから直接 `/api/*` にアクセスし、catch-all proxyがService Binding経由で透過転送する。

## 認証フロー

```
1. 初回アクセス → 認証モーダル表示
2. 「匿名で参加」→ POST /api/auth/sign-in/anonymous（catch-all proxy経由）
3. Better Auth → session cookie発行（Set-Cookie転送）
4. localStorage にbs-auth-user-id/bs-auth-user-name をUX用cacheとして保存
5. 以降のmutation → serverFnでCookie転送 → API Workerでsession検証
```

`getCachedUserId()` はUX用のcache。server sessionが唯一の認証根拠。
401時はlocalStorage cache削除 + 認証モーダル再表示。

## SSE進捗表示

`useAiRunProgress` hookでAI生成進捗をSSE受信。
表示位置: リプライフォーム内のインライン進捗バー（上部バーは削除済み）。
投稿後のスクロール位置は `navigate({ resetScroll: false })` で維持。

状態遷移: `queued → admitted → generating → repairing → completed / failed`

## displayItemsのレンダリング

投稿リストは `useMemo` で構築。human投稿の下にAIレスをインデントして表示。
`childrenBySource` MapでO(1)ルックアップ + 前方スキャンでorphan AI postsを回収（O(n)）。

## 既知の負債

- `getCachedUserId()` が index.tsx/threads.$id.tsx に重複定義（#63）
- res.okチェックが一部不統一（#62）
