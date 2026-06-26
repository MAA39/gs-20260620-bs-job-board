# Apps — Worker構成

bs-job-boardは3つのCloudflare Workersで構成される。

```
Browser
  ↓ HTTPS
Web Worker (TanStack Start SSR)
  ↓ Service Binding
API Worker (Hono)
  ↓ Service Binding       ↓ D1
Agent Worker (Flue)    bs-job-board-db
  ↓ HTTPS
Sakura AI Engine
```

## Worker一覧

| Worker | 役割 | Public URL | 主要技術 |
|--------|------|-----------|---------|
| [Web](web/README.md) | SSR + reverse proxy | ✅ あり | TanStack Start, React |
| [API](api/README.md) | データAPI + auth + internal callback | ✅ あり | Hono, Better Auth, D1 |
| [Agent](agent/README.md) | AI生成workflow | ❌ なし | Flue Framework, Sakura AI |

## Service Binding構成

```
Web ──(env.API)──→ API ──(env.AGENT)──→ Agent
                    ↑                      │
                    └──────────────────────┘
                    (callback POST /internal/v1/ai-runs/...)
```

Web→API: serverFn経由のデータ操作 + catch-all proxy（SSE/auth）
API→Agent: AI生成workflowのdispatch
Agent→API: 生成結果のcallback（X-Callback-Key認証）

## 信頼境界（ADR-006）

| 境界 | CORS | bodyLimit | 認証 |
|------|------|-----------|------|
| Browser → Web | — | — | — |
| Web → API `/api/v1/*` | origin制限 | route単位 | session |
| Web → API `/api/auth/*` | origin制限 | POST 10KB | Better Auth |
| API → Agent | — | — | Service Binding |
| Agent → API `/internal/v1/*` | なし | route単位 | X-Callback-Key |

## ADR

| ADR | 概要 |
|-----|------|
| [003](../adr/003-flue-streaming-boundary.md) | Flue streaming境界 |
| [004](../adr/004-ai-run-lifecycle-and-db-authority.md) | AI run lifecycle・DB書き込み権限 |
| [005](../adr/005-ai-output-validation-relaxation.md) | AI出力validation緩和 + フォールバック |
| [006](../adr/006-api-boundary-bodylimit-cors.md) | bodyLimit + CORS適用範囲の分離 |

## デプロイ

wrangler v4のGradual Deploymentsにより `wrangler deploy` 後に `versions deploy @100%` が必要な場合がある（#59）。

```bash
# 各Worker
npx wrangler deploy
npx wrangler versions deploy "<version-id>@100%" --name <worker-name> --yes
```
