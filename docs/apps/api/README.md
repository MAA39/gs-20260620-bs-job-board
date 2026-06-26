# API Worker — as-is仕様

Worker名: `bs-job-board-api`
URL: `https://bs-job-board-api.masa-nekoshinshi39.workers.dev`
エントリ: `apps/api/src/index.ts`

## Bindings

| Binding | 種別 | 用途 |
|---------|------|------|
| DB | D1 Database | `bs-job-board-db` — threads/posts/reactions/ai_runs/Better Auth tables |
| AGENT | Service Binding | `bs-job-board-agent` — AI生成workflowのdispatch先 |
| BETTER_AUTH_SECRET | Secret | Better Auth署名鍵 |
| INTERNAL_CALLBACK_KEY | Secret | Agent→APIのcallback認証 |
| SAKURA_API_TOKEN | Secret | （Agent側で使用。API Workerでは未使用） |

## Middleware構成（ADR-006）

信頼境界をmiddleware適用範囲で表す。

```
/health               — CORSなし, bodyLimitなし（GET only）
/api/v1/*             — CORS あり（origin制限）, bodyLimit route単位
/api/auth/*           — CORS あり（origin制限）, bodyLimit POST のみ 10KB
/internal/v1/*        — CORS なし, callback key検証 → bodyLimit route単位
```

CORS許可origin: `bs-job-board-web.masa-nekoshinshi39.workers.dev`, `localhost:5173`

## Route一覧

### Public API (`/api/v1/threads`)

| Method | Path | bodyLimit | 認証 | 処理 |
|--------|------|-----------|------|------|
| GET | `/` | — | 不要 | スレッド一覧（reaction_count含む） |
| GET | `/:id` | — | 不要 | スレッド詳細（posts含む） |
| POST | `/` | 10KB | session必須 | スレッド作成 + initial post + AI run queue |
| POST | `/:id/posts` | 10KB | session必須 | レス投稿 + AI run queue |
| POST | `/:id/react` | 1KB | session必須 | リアクションtoggle（userIdはsessionから導出） |
| PATCH | `/:id` | 1KB | session必須 | status変更（open/fixed）+ runtime validation |

session guard: `getSessionResult()` → `SessionResult` DU → 401/503/500の3分岐。
全mutation routeで#29/#49で確立されたパターンを使用。

### SSE (`/api/v1/ai-runs`)

| Method | Path | 処理 |
|--------|------|------|
| GET | `/:aiRunId/events` | AI run進捗のSSE stream（generating/repairing/completed/failed） |

### Auth (`/api/auth/**`)

Better Auth handler。GET（session取得）とPOST（anonymous sign-in等）を処理。
POST のみ bodyLimit 10KB。

### Internal Callback (`/internal/v1/ai-runs`)

Agent Worker → API Worker のcallback。`.use('*')` で `X-Callback-Key` をbody parseより先に検証。

| Method | Path | bodyLimit | 処理 |
|--------|------|-----------|------|
| POST | `/:aiRunId/generating` | 1KB | run status → generating |
| POST | `/:aiRunId/repairing` | 1KB | run status → repairing, attempt_count+1 |
| POST | `/:aiRunId/complete` | 20KB | run完了。replies保存 + hash検証 + usage保存 |
| POST | `/:aiRunId/fail` | 2KB | run失敗。error_code/message保存 |

complete handler: replies 1-5件、各1-500文字（ADR-005で緩和）。hash照合で改竄防止。

## D1 Schema

| Table | 用途 |
|-------|------|
| threads | スレッド（id, title, body, status, reaction_count） |
| posts | 投稿（thread_id, post_number, body, author_type, source_post_number） |
| reactions | リアクション（thread_id, user_id） |
| ai_runs | AI生成run（status, model, usage, error_code, result_hash） |
| ai_run_events | run状態遷移イベント（SSE配信元） |
| ai_run_posts | run→posts紐づけ（ordinal） |
| user/session/account/verification | Better Auth管理テーブル |

## データフロー: スレッド作成→AI生成

```
Browser POST /api/v1/threads
  → Web Worker (serverFn) → Service Binding → API Worker
  → session guard
  → createThreadWithInitialPostAndQueuedRun (D1)
  → waitUntil: dispatchWithRunLifecycle
    → API → Agent Worker (Service Binding)
    → Agent: Flue workflow起動
    → Agent: Sakura AI Engine prompt
    → Agent: callback POST /internal/v1/ai-runs/:id/generating
    → Agent: callback POST /internal/v1/ai-runs/:id/complete
  → Browser: SSE GET /api/v1/ai-runs/:id/events でpolling
  → completed → refreshThread
```

## 既知の負債

- `getCachedUserId()` がindex.tsx/threads.$id.tsxに重複定義（#63）
- reaction atomicity未対応（#61）
- fallback_used をDBに記録していない（#60）
- stale run reconciliation未実装（#41）
