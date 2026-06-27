# コード解説

ブルシット・ジョブ解体掲示板のコードベース全体を、ディレクトリ構成とファイル単位で対応づけて解説する。

## プロダクト概要

ブルシット・ジョブ（無意味な仕事）を投稿すると、AIが2ch風の匿名住民として反応してくれる掲示板。
判断や助言はしない。投稿者の言葉を拾い、材料を並べる。選ぶのは本人。

G's Academy福岡19期DEVコース課題「アンケートアプリ（登録・表示）」として開発した。

## 定量データ

| 指標 | 数値 |
|---|---|
| 総コード行数 | 7,509行 |
| TypeScriptファイル数 | 48 |
| Cloudflare Workers数 | 3（Web / API / Agent） |
| テストファイル | 8（96ケース） |
| D1マイグレーション | 8段階 |
| ADR（設計判断記録） | 4本 |
| CIガードステップ | 7 |

## ディレクトリ構成

```
bs-job-board/
├── apps/                    ← 3つのCloudflare Workers
│   ├── web/    (1,897行)    ← Worker #1: 画面描画（SSR）
│   ├── api/    (2,913行)    ← Worker #2: データAPI + 認証
│   └── agent/  (359行)      ← Worker #3: AI生成
├── packages/                ← 共有ライブラリ
│   ├── db/     (2,065行)    ← D1スキーマ + クエリ関数
│   ├── contracts/ (113行)   ← API型定義（依存ゼロ）
│   ├── agent/  (162行)      ← AIプロンプト + JSON解析
│   └── config/              ← 共有tsconfig
├── docs/                    ← 設計判断・運用手順
│   ├── adr/                 ← ADR-003〜006
│   ├── apps/                ← Worker別仕様書
│   └── runbooks/            ← 運用手順書
├── scripts/                 ← 検証用スクリプト
└── .github/workflows/       ← CI定義
```

Turborepo + pnpm workspaces によるモノレポ構成。
`apps/*` が各Worker、`packages/*` が共有コード。

## 3-Worker構成

3つのCloudflare Workersに責務を分離している。

```
Browser
  │ HTTPS
  ▼
┌─────────────────────────────────────┐
│  Web Worker (bs-job-board-web)       │
│  TanStack Start SSR + React         │
│  画面描画、same-origin proxy        │
└──────────┬──────────────────────────┘
           │ Service Binding (env.API)
           ▼
┌─────────────────────────────────────┐
│  API Worker (bs-job-board-api)       │
│  Hono + Better Auth + D1            │
│  データの正本管理、認証、SSE配信     │
└──────────┬──────────────────────────┘
           │ Service Binding (env.AGENT)
           ▼
┌─────────────────────────────────────┐
│  Agent Worker (bs-job-board-agent)   │
│  Flue Framework + さくらAI Engine    │
│  AI生成ワークフロー                  │
└──────────┬──────────────────────────┘
           │ callback POST (X-Callback-Key認証)
           ▼
         API Worker（結果をD1に保存）
```

Worker間の通信にはCloudflare Service Bindingを使う。
同一データセンター内で完結するため、ネットワーク越しのHTTPリクエストは発生しない。

### なぜ3つに分けたのか

API WorkerだけがD1データベースへの書き込み権限を持つ。
Agent WorkerはAI生成に専念し、D1に直接触れない。
この分離により、AIの生成結果がDBに入る経路がcallback POST 1本に限定される。

CIでもこの境界を検査している。
Agent Worker内に `env.DB` や `D1Database` が登場するとCIが失敗する。

## データフロー：投稿からAI返信まで

ユーザーが「スレッドを立てる」を押してからAIのレスが表示されるまでの流れ。

### 1. スレッド作成

```
ブラウザ → Web Worker (createServerFn)
         → API Worker POST /api/v1/threads
```

API Workerは1回のD1トランザクションで3つを原子的に作成する。

- `threads` レコード（スレッド本体）
- `posts` レコード（最初の投稿）
- `ai_runs` レコード（AI実行の管理、status=queued）

### 2. AI生成のdispatch

API Workerは `context.executionCtx.waitUntil()` でAgent Workerへ非同期に依頼する。
レスポンスはすでにブラウザへ返っている。

```
API Worker → Agent Worker POST /workflows/generate-replies
```

### 3. AI生成

Agent WorkerはFlue Frameworkのワークフローとして動作する。

1. さくらAI Engine（gpt-oss-120b）にプロンプトを送信
2. JSON形式でレスを受け取る
3. validation失敗時はrepairプロンプトで再試行
4. repair後も失敗したらフォールバックレスで続行

### 4. 結果のcallback

Agent WorkerがAPI Workerの内部エンドポイントにPOSTで結果を返す。

```
Agent Worker → API Worker POST /internal/v1/ai-runs/:id/complete
```

X-Callback-Keyヘッダーで認証する（定数時間比較）。
API WorkerはD1に、AIが生成したレスとai_runの完了状態を原子的に保存する。

### 5. SSE配信

ブラウザはスレッド作成時からSSE（Server-Sent Events）で進捗を監視している。

```
ブラウザ → EventSource → Web Worker /api/v1/ai-runs/:id/events
         → API Worker → D1からai_run_eventsをポーリング
```

状態機械は `queued → admitted → generating → repairing → completed` と遷移する。
`completed` イベントを受信するとブラウザがスレッドを再取得し、AIレスが表示される。

## 主要ファイル対応表

### apps/web — Web Worker

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/routes/index.tsx` | 260 | トップページ。スレッド一覧 + 作成フォーム + 匿名認証モーダル |
| `src/routes/threads.$id.tsx` | 310 | スレッド詳細。投稿一覧 + コメント + SSE進捗バー + 状態切替 |
| `src/routes/api/$.ts` | 40 | `/api/*` catch-all。Service Binding経由でAPI Workerへ転送 |
| `src/lib/api-fetch.ts` | 70 | serverFnからAPI Workerを呼ぶヘルパー。Cookie/Authorizationを転送 |
| `src/lib/api-proxy.ts` | 80 | proxy本体。hop-by-hopヘッダー除去、Set-Cookie透過、X-Forwarded-* 付与 |
| `src/lib/use-ai-run-progress.ts` | 120 | SSE EventSource Hook。状態遷移を管理し、completedで自動リフレッシュ |
| `src/lib/auth-client.ts` | 10 | Better Auth client。same-originで`/api/auth/*`に接続 |
| `wrangler.jsonc` | — | Worker名、Service Binding `API` の定義 |

### apps/api — API Worker

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/index.ts` | 60 | Honoエントリポイント。ルート定義、CORS設定、bodyLimit適用 |
| `src/routes/threads.ts` | 300 | CRUD + AI dispatch。投稿作成時にai_runを生成してAgentへ依頼 |
| `src/routes/ai-run-events.ts` | 160 | SSE配信ルート。D1をポーリングしてイベントをストリーム |
| `src/routes/pump-ai-run-events.ts` | — | SSEポンプのコアロジック。ハートビート、最大ポーリング回数管理 |
| `src/routes/internal-callbacks.ts` | 200 | Agent→APIのcallbackエンドポイント。generating/repairing/complete/fail |
| `src/auth.ts` | 90 | Better Auth factory。Kysely + D1。resolveExternalBaseURLで元origin復元 |
| `src/middleware/body-limit.ts` | — | ADR-006準拠のbodyLimit定義。3境界で異なるサイズ |
| `wrangler.jsonc` | — | Worker名、D1バインディング `DB`、Service Binding `AGENT` |

### apps/agent — Agent Worker

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/app.ts` | 15 | Hono + Flue routing。内部ホストからのみ `/workflows/*` を許可 |
| `src/workflows/generate-replies.ts` | 280 | AI生成ワークフロー本体。prompt生成→AI呼出→validation→repair→callback |
| `src/agents/analyst.ts` | 10 | Flue Agent定義（未使用、将来拡張用） |
| `flue.config.ts` | 5 | Flue CLI設定。target: cloudflare |
| `wrangler.jsonc` | — | Durable Objects（FlueRegistry, FlueAnalystAgent, FlueGenerateRepliesWorkflow） |

### packages/db — D1スキーマとクエリ

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/queries.ts` | — | スレッドCRUD（listThreadsSorted, getThreadDetail, toggleReaction） |
| `src/ai-pipeline.ts` | — | AI run lifecycle commands。原子的作成、状態遷移、冪等complete |
| `src/types.ts` | 250 | 型定義。AiRunStatus状態機械、D1抽象化、Command入出力型 |
| `migrations/0001_init.sql` | — | threads, postsテーブル |
| `migrations/0005_better_auth.sql` | — | Better Auth用テーブル（user, session, account） |
| `migrations/0008_ai_runs.sql` | — | ai_runs, ai_run_events, ai_run_postsテーブル。CHECK制約で状態を強制 |

### packages/contracts — API型定義

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/thread.ts` | 30 | Thread, Post, ThreadDetail型。AuthorType('human'|'ai') |
| `src/api.ts` | 80 | APIレスポンス型。SSEイベント型（PublicAiRunEvent）。error code allow-list |

### packages/agent — 共有AIロジック

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/analyze.ts` | 130 | SYSTEM_PROMPT定義。プロンプト生成関数。JSON/行分割パーサー |

## 認証の仕組み

Better Authの匿名認証（anonymous plugin）を使う。

初回投稿時にモーダルが開き、「匿名で投稿する」を押すと、Better Authが匿名ユーザーをD1に作成してsession cookieを発行する。
以降の投稿ではcookieで認証される。

```
ブラウザ → /api/auth/sign-in/anonymous
         → Web Worker (same-origin proxy)
         → API Worker (Better Auth handler)
         → D1 (user + session作成)
         → Set-Cookie をブラウザへ返す
```

same-origin proxyを通すのは、Safari ITP（Intelligent Tracking Prevention）がthird-party cookieをブロックするため。
Web WorkerとAPI Workerは別originだが、ブラウザからはWeb Workerのoriginで完結するように見える。

## 設計判断（ADR）

4本のADR（Architecture Decision Record）で設計判断を記録している。

**ADR-003：FlueのSSEを使わず、API側でD1ポーリングするSSEを採用**
FlueのDurable Streamsは、Agent Worker→ブラウザの直接配信を前提としている。
しかしAgent Workerは外部公開していない。
APIが正本（D1）を持つ設計と整合するため、API側のSSEを選択した。

**ADR-004：AI runの状態機械と冪等性**
`queued → admitted → generating → repairing → completed/failed` の6状態。
terminal状態（completed/failed）に達したら他の状態へ戻さない。
idempotency_keyとresult_hashで二重保存を防ぐ。

**ADR-005：AI出力のvalidation緩和**
当初はレス3件ちょうどを要求していたが、AIの出力は件数が安定しない。
1〜5件に緩和し、repair後も失敗したらフォールバックレスで続行する。
失敗率25%が解消した。

**ADR-006：bodyLimitとCORSの3境界分離**
public API（ブラウザ→API）、auth API、internal API（Agent→API）で適用ルールが異なる。
CORSはpublic/authのみ、bodyLimitはルート単位で設定。

## テストとCI

### テスト構成

```
apps/api/src/__tests__/
  ├── threads.integration.test.ts        ← スレッドCRUD
  ├── ai-run-events.integration.test.ts  ← SSE配信
  ├── ai-run-events.unit.test.ts         ← イベントマッパー単体
  ├── internal-callbacks.integration.test.ts ← callback検証
  └── api-boundary.integration.test.ts   ← bodyLimit/CORS境界

apps/web/src/lib/__tests__/
  ├── api-proxy.test.ts                  ← proxy動作
  └── use-ai-run-progress.test.ts        ← SSE Hook

packages/db/src/
  └── ai-pipeline.integration.test.ts    ← 状態遷移・冪等性
```

### CIガード

GitHub Actions（`.github/workflows/ci.yml`）で7つのガードを実行する。

1. **typecheck**：型検査
2. **build**：全Worker + packages ビルド
3. **test**：単体テスト
4. **test:integration**：統合テスト
5. **AI route guards**：Agent/API内のfetch直接呼出、chat/completions、reasoning_contentを禁止
6. **Agent D1 isolation guard**：Agent Worker内のenv.DB / D1Databaseを禁止
7. **Public route authority guard**：公開ルートでのlegacy addPost禁止

## 技術スタック一覧

| レイヤー | 技術 | 選定理由 |
|---|---|---|
| フロントエンド | TanStack Start (SSR) | Cloudflare Workers上でReact SSRを動かせる |
| API | Hono | Cloudflare Workers上で動くEdge対応フレームワーク |
| DB | Cloudflare D1 (SQLite) | Workers内蔵のSQLiteベースDB。追加料金なし |
| 認証 | Better Auth (anonymous) | D1対応、匿名認証プラグインあり |
| AI生成 | Flue Framework | Astroチーム開発のAIエージェントフレームワーク |
| AIモデル | さくらAI Engine (gpt-oss-120b) | 日本語対応、無償枠あり |
| モノレポ | Turborepo + pnpm | ビルド順序の自動解決、workspace間の型共有 |
| CI | GitHub Actions | PR/pushごとに自動検証 |
