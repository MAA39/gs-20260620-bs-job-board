# API Worker 詳細解説

Worker名: `bs-job-board-api`
コード量: 2,913行 / 16ファイル
技術: Hono + Better Auth + Cloudflare D1

## 役割

データの正本管理を担う。3つの境界にまたがるリクエストを処理する。

1. ブラウザ向けpublic API（CRUD + SSE配信）
2. ブラウザ向けauth API（Better Auth handler）
3. Agent Worker向けinternal API（生成結果の受け取り）

D1データベースへの書き込み権限はこのWorkerだけが持つ。

## ファイル構成

```
apps/api/
├── src/
│   ├── index.ts                    ← エントリポイント（ルート定義）
│   ├── auth.ts                     ← Better Auth factory + session取得
│   ├── routes/
│   │   ├── threads.ts              ← スレッドCRUD + AI dispatch
│   │   ├── ai-run-events.ts        ← SSE配信ルート
│   │   ├── pump-ai-run-events.ts   ← SSEポンプ本体
│   │   └── internal-callbacks.ts   ← Agent→API callback
│   ├── middleware/
│   │   └── body-limit.ts           ← ADR-006 bodyLimit定義
│   └── __tests__/
│       ├── threads.integration.test.ts
│       ├── ai-run-events.integration.test.ts
│       ├── ai-run-events.unit.test.ts
│       ├── internal-callbacks.integration.test.ts
│       └── api-boundary.integration.test.ts
├── wrangler.jsonc
└── migrations/                     ← D1用（packages/dbと共有）
```

## 3つの境界（ADR-006）

`index.ts`でルートを3層に分けている。

```typescript
// 1. public API: CORSあり、session認証
app.use('/api/v1/*', corsMiddleware);
app.route('/api/v1/threads', threadRoutes);
app.route('/api/v1/ai-runs', aiRunEventRoutes);

// 2. auth API: CORSあり、POST bodyLimit
app.use('/api/auth/*', corsMiddleware);
app.on(['POST'], '/api/auth/**', jsonBodyLimit(BODY_LIMITS.auth), authHandler);

// 3. internal API: CORSなし、X-Callback-Key認証
app.route('/internal/v1/ai-runs', internalCallbackRoutes);
```

| 境界 | CORS | bodyLimit | 認証 |
|---|---|---|---|
| `/api/v1/*` | origin制限 | ルート単位 | session |
| `/api/auth/*` | origin制限 | POST 10KB | Better Auth |
| `/internal/v1/*` | なし | ルート単位 | X-Callback-Key |

## スレッドCRUD（threads.ts）

5つのルートを定義している。

**GET /**: スレッド一覧。`sort=new`（新着順）または`sort=hot`（リアクション順）。

**GET /:id**: スレッド詳細。全投稿を含む。

**POST /**: スレッド作成。session必須。
D1に3レコードを原子的に作成し、`waitUntil`でAgent Workerへ非同期dispatch。
レスポンスは`{id, title, ai_run: {id}}`。ブラウザはai_run.idでSSEを開始する。

**POST /:id/posts**: コメント投稿。session必須。
投稿+ai_run作成を原子的に実行し、Agentへdispatch。

**POST /:id/react**: リアクション（トグル）。session必須。
userIdはsessionから導出する。clientから受け取らない（#49）。

**PATCH /:id**: スレッド状態変更。session必須。
statusは`open`か`fixed`のみ許可。

全mutation routeで`getSessionResult()`を呼び、sessionがなければ401を返す（fail-closed）。

## AI dispatch（dispatchWithRunLifecycle）

スレッド作成/コメント投稿時に、AI生成をAgent Workerへ依頼する関数。

```
admitted → Agent fetch → 成功: Agentがcallbackで結果を返す
                       → 失敗: failRunでDB状態をfailedに
```

1. callback key未設定チェック → failRun
2. ai_runを`admitted`状態に遷移
3. `getAiGenerationContext`でD1からcontext組み立て（スレッド情報、直近8投稿）
4. Agent Workerへ`POST /workflows/generate-replies`
5. dispatch失敗時、非terminal状態ならfailRun

`waitUntil`内で実行されるため、ブラウザへのレスポンスはdispatch開始前に返っている。

## SSE配信（ai-run-events.ts）

ブラウザのEventSourceからのGETリクエストに対し、D1をポーリングしてイベントを配信する。

```
GET /api/v1/ai-runs/:aiRunId/events?after=0
→ D1のai_run_eventsテーブルをポーリング
→ text/event-stream で status/completed/failed を配信
```

ポーリング間隔は1.5秒。最大32回ポーリング（約48秒）でストリームを終了する。
ハートビートは15秒間隔で`:heartbeat\n\n`を送信し、接続維持する。

terminal状態（completed/failed）のイベントを送信したらストリームを閉じる。

## Internal callback（internal-callbacks.ts）

Agent WorkerからAI生成結果を受け取る4つのエンドポイント。

**POST /:aiRunId/generating**: status→generating遷移。
**POST /:aiRunId/repairing**: status→repairing遷移。
**POST /:aiRunId/complete**: 結果保存。protocol version/hash/replies/usageの検証後、D1に原子的に保存。
**POST /:aiRunId/fail**: エラー記録。error code allow-listで正規化。

全エンドポイントにX-Callback-Key検証ミドルウェアが入る。
定数時間比較（`mismatch |= a ^ b`）でタイミング攻撃を防ぐ。

completeのvalidation:
- protocolVersion: "1"必須
- aiRunId: パスと一致
- resultHash: 64文字hex（SHA-256）
- replies: 1-5件、各1-500文字
- hash整合性: normalized bodiesからSHA-256を再計算して一致確認

## 認証（auth.ts）

Better Authのfactory関数。リクエストごとにインスタンスを生成する。

Workers環境ではD1バインディングがリクエストコンテキスト内でのみ有効なため、モジュールスコープでのシングルトンは使えない。

```typescript
export function createAuth(d1: D1Database, config: { secret; baseURL }) {
  const db = new Kysely({ dialect: new D1Dialect({ database: d1 }) });
  return betterAuth({ database: { db, type: 'sqlite' }, plugins: [anonymous()] });
}
```

`resolveExternalBaseURL`は、same-origin proxy経由のリクエストからX-Forwarded-Hostを読み取り、元のWeb Workerのoriginを復元する。
信頼するホスト名は`api`、`localhost`、`127.0.0.1`の3つだけ。

## テスト

69ケース（unit 18 + integration 51）。

threads.integration.test.ts: CRUD、session必須、payload validation
ai-run-events: SSEストリーム配信、ポーリング、terminal状態
internal-callbacks: callback key検証、validation、hash整合性、冪等complete
api-boundary: bodyLimit上限、CORS origin制限
