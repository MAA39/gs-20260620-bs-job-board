# ADR-006: API boundary — bodyLimit + CORS適用範囲の分離

- status: proposed
- date: 2026-06-26
- related: #28, #29, #49, ADR-005

## Context

### 現状の問題

**CORS が全ルートに適用されている。**

```typescript
// apps/api/src/index.ts（現行）
app.use('*', cors({ ... }));
```

`'*'`で `/internal/v1/*` にもbrowser向け `Access-Control-Allow-Origin` が付く。internal callbackはAgent Worker（Service Binding経由）からのWorker間通信であり、ブラウザからアクセスされることはない。

**bodyLimit が未設定。**

全mutation routeがJSON bodyを上限なしで読み込む。Cloudflare側にもrequest body size上限はあるが、上限はアカウントプラン依存（Free/Proは100MB）であり、アプリとしてはそれより十分小さい上限をbodyLimitでroute単位に設定すべき。

**信頼境界がmiddleware構成に表れていない。**

現行のroute構成は1つの`app`にCORSもrouteも全部並んでいる。「どれがブラウザ向けで、どれがWorker間専用か」がコードから読み取りづらい。

### Hono公式ドキュメントの裏付け

- **CORS**: 公式は `app.use('/api/*', cors())` のようにpath限定でrouteの前に登録する例を示している（[CORS Middleware](https://hono.dev/docs/middleware/builtin/cors)）
- **Better Auth**: 公式Hono integration例は `app.use('/api/auth/*', cors({...}))` をauth handlerの前に登録している（[Better Auth Hono](https://better-auth.com/docs/integrations/hono)）
- **bodyLimit**: `hono/body-limit` の `bodyLimit()` はContent-Lengthを先に使い、なければstreamを読んで超過時にonErrorを実行する（[Body Limit Middleware](https://hono.dev/docs/middleware/builtin/body-limit)）
- **bodyLimit bypass脆弱性**: v4.9.7で修正済み（Transfer-Encoding優先）。現行hono ^4.12.0で対応済み（[GHSA-92vj-g62v-jqhh](https://github.com/honojs/hono/security/advisories/GHSA-92vj-g62v-jqhh)）
- **middleware実行順序**: 登録順に実行される（[Middleware](https://hono.dev/docs/guides/middleware)）

## Decision

### 1. 3つの信頼境界をmiddleware構成で表す

| 境界 | path | CORS | bodyLimit | 認証 |
|------|------|------|-----------|------|
| browser-facing public API | `/api/v1/*` | ✅ origin制限 | route単位で設定 | session guard |
| browser-facing auth API | `/api/auth/*` | ✅ origin制限 | POST のみ10KB | Better Auth |
| Worker-to-Worker internal | `/internal/v1/*` | ❌ 適用しない | route単位で設定 | callback key |
| healthcheck | `/health` | ❌ 適用しない | なし（GET only） | なし |

### 2. CORS適用範囲の限定

```typescript
// 変更後: /api/v1/* と /api/auth/* にのみ適用
const corsMiddleware = cors({
  origin: [
    'https://bs-job-board-web.masa-nekoshinshi39.workers.dev',
    'http://localhost:5173',
  ],
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

app.use('/api/v1/*', corsMiddleware);
app.use('/api/auth/*', corsMiddleware);
// /internal/v1/* と /health にはCORS適用なし
```

`/api/*` ではなく `/api/v1/*` + `/api/auth/*` に分ける理由: 将来 `/api/internal/*` のようなpathを追加した場合に境界がぼやけるのを防ぐ。Issue #28のACとも一致する。

### 3. bodyLimit設計

共通helper:

```typescript
import { bodyLimit } from 'hono/body-limit';

const jsonBodyLimit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: 'payload too large' }, 413),
  });
```

route別の上限値:

| Route | 上限 | 根拠 |
|-------|------|------|
| POST /api/v1/threads | 10KB | title(200文字×3B) + body(2000文字×3B) + JSON overhead |
| POST /api/v1/threads/:id/posts | 10KB | body(2000文字×3B) + JSON overhead。日本語UTF-8は1文字≒3B |
| POST /api/v1/threads/:id/react | 1KB | bodyなし（#49で廃止）。安全弁 |
| PATCH /api/v1/threads/:id | 1KB | `{ status: "open" }` のみ |
| POST /api/auth/** | 10KB | anonymous sign-in等のPOST body |
| internal generating | 1KB | ほぼ空 |
| internal repairing | 1KB | ほぼ空 |
| internal complete | 20KB | ADR-005: 最大5件×500文字 + usage + meta |
| internal fail | 2KB | errorCode + message |

### 4. middleware実行順序

**public API**: CORS → bodyLimit → session guard → handler

bodyLimitは各route handlerの引数として渡す:

```typescript
export const threadRoutes = new Hono<{ Bindings }>()
  .get('/', listThreadsHandler)
  .get('/:id', getThreadHandler)
  .post('/', jsonBodyLimit(10 * 1024), createThreadHandler)
  .post('/:id/posts', jsonBodyLimit(10 * 1024), createPostHandler)
  .post('/:id/react', jsonBodyLimit(1024), reactHandler)
  .patch('/:id', jsonBodyLimit(1024), patchHandler);
```

**internal callback**: callback key検証 → bodyLimit → handler

key検証がbodyLimitより前にあることが重要。unauthorized巨大bodyを読まずに401で即返す。

```typescript
export const internalCallbackRoutes = new Hono<{ Bindings }>()
  .use('*', verifyCallbackKeyMiddleware)  // key検証が先
  .post('/:aiRunId/generating', jsonBodyLimit(1024), generatingHandler)
  .post('/:aiRunId/repairing', jsonBodyLimit(1024), repairingHandler)
  .post('/:aiRunId/complete', jsonBodyLimit(20 * 1024), completeHandler)
  .post('/:aiRunId/fail', jsonBodyLimit(2 * 1024), failHandler);
```

**auth**: CORS → bodyLimit（POSTのみ）→ handler

```typescript
app.on(['GET'], '/api/auth/**', authHandler);
app.on(['POST'], '/api/auth/**', jsonBodyLimit(10 * 1024), authHandler);
```

### 5. 変更後のindex.ts全体構造

```typescript
import { cors } from 'hono/cors';
import { jsonBodyLimit, BODY_LIMITS } from './middleware/body-limit.ts';

const corsMiddleware = cors({ ... });

const app = new Hono<{ Bindings }>();

// ── healthcheck ──
app.get('/health', (c) => c.json({ status: 'ok' }));

// ── browser-facing public API ── CORS あり
app.use('/api/v1/*', corsMiddleware);
app.route('/api/v1/threads', threadRoutes);   // bodyLimit は threadRoutes 内
app.route('/api/v1/ai-runs', aiRunEventRoutes); // GET only, bodyLimit不要

// ── browser-facing auth ── CORS あり
app.use('/api/auth/*', corsMiddleware);
app.on(['GET'], '/api/auth/**', authHandler);
app.on(['POST'], '/api/auth/**', jsonBodyLimit(10 * 1024), authHandler);

// ── Worker-to-Worker internal ── CORS なし
app.route('/internal/v1/ai-runs', internalCallbackRoutes);
// callback key検証 + bodyLimit は internalCallbackRoutes 内
```

## 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `apps/api/src/index.ts` | CORS適用範囲限定 + auth bodyLimit + jsonBodyLimit helper |
| `apps/api/src/routes/threads.ts` | 各mutation routeにbodyLimit追加 |
| `apps/api/src/routes/internal-callbacks.ts` | 各routeにbodyLimit追加（key検証の後） |
| テスト | CORS範囲 + bodyLimit 413 + unauthorized oversized callback |

## テスト設計

### CORS

- OPTIONS /api/v1/threads allowed origin → Access-Control-Allow-Origin あり
- OPTIONS /api/auth/sign-in/anonymous allowed origin → CORS あり
- rejected origin → Access-Control-Allow-Origin に含まれない
- /internal/v1/ai-runs/... response に Access-Control-Allow-Origin がない
- /health response に Access-Control-Allow-Origin がない

### bodyLimit

- POST /api/v1/threads oversized authenticated → 413 + DB副作用なし
- POST /api/v1/threads/:id/posts oversized authenticated → 413
- POST /api/v1/threads/:id/react oversized → 413
- PATCH /api/v1/threads/:id oversized → 413
- internal complete authorized oversized → 413 + run未完了
- internal callback unauthorized oversized → 401（key検証が先なのでbodyLimitに到達しない）

## デプロイ

API Worker のみ再デプロイ。Web Worker・Agent Workerの変更は不要。

## Consequences

### 良い結果

- 信頼境界がコードを見ただけで分かる（browser-facing / auth / internal）
- `/internal/v1/*` に不要なCORS headerが付かない
- 巨大POST bodyによるWorker実行時間消費を防止
- unauthorized巨大callbackはkey検証で即返し（body読まず）
- 将来routeを追加する人が「どの世界に属するか」を考えやすい

### 受け入れるトレードオフ

- bodyLimitのroute単位設定はグローバル設定より記述量が増える
- 上限値の変更時に複数箇所を修正する必要がある（定数化で軽減）

### Non-scope

- Worker物理分割（Service Binding private Worker化）は今回やらない
- `/internal/v1/*` はpath上privateなだけでpublic URLから到達可能。callback key検証は必須のまま
