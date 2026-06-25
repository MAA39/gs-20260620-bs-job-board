# V1 source map

現行仕様調査で確認した主要source fileと責務。

```text
.
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── scripts/
│   └── probe-flue-stream.mjs
├── apps/
│   ├── web/
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   ├── wrangler.jsonc
│   │   └── src/
│   │       ├── router.tsx
│   │       ├── lib/
│   │       │   └── auth-client.ts
│   │       └── routes/
│   │           ├── __root.tsx
│   │           ├── index.tsx
│   │           └── threads.$id.tsx
│   ├── api/
│   │   ├── package.json
│   │   ├── wrangler.jsonc
│   │   └── src/
│   │       ├── index.ts
│   │       ├── auth.ts
│   │       └── routes/
│   │           └── threads.ts
│   └── agent/
│       ├── package.json
│       ├── flue.config.ts
│       ├── wrangler.jsonc
│       └── src/
│           ├── app.ts
│           ├── agents/
│           │   └── analyst.ts
│           └── workflows/
│               └── generate-replies.ts
├── packages/
│   ├── contracts/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── thread.ts
│   │       └── api.ts
│   ├── db/
│   │   ├── migrations/
│   │   │   ├── 0001_init.sql
│   │   │   ├── 0002_add_reactions.sql
│   │   │   ├── 0003_user_reactions.sql
│   │   │   ├── 0004_source_post.sql
│   │   │   ├── 0005_better_auth.sql
│   │   │   ├── 0006_user_id.sql
│   │   │   └── 0007_unique_post_number.sql
│   │   └── src/
│   │       ├── index.ts
│   │       └── queries.ts
│   ├── agent/
│   │   └── src/
│   │       ├── index.ts
│   │       └── analyze.ts
│   └── config/
│       └── tsconfig.base.json
├── docs/
│   ├── architecture-audit.md
│   ├── adr/
│   │   ├── 003-flue-streaming-boundary.md
│   │   └── 004-ai-run-lifecycle-and-db-authority.md
│   ├── runbooks/
│   │   └── flue-stream-probe.md
│   └── current-v1/
└── .github/
    └── workflows/
        └── ci.yml
```

## entrypoint対応

| layer | entrypoint | 実際の役割 |
|---|---|---|
| Web Worker | TanStack Start server entry | SSR、route、Server Function |
| API Worker | `apps/api/src/index.ts` | Hono router、auth、thread API |
| Agent Worker | Flue generated build | health、Flue workflow/agent routing |
| Contracts | `packages/contracts/src/index.ts` | compile-time共有型 |
| DB | `packages/db/src/index.ts` | query export |
| Legacy Agent package | `packages/agent/src/index.ts` | 未使用AI utility export |

## generated / build artifact

- `apps/web/src/routeTree.gen.ts`: TanStack Router generated file
- `apps/agent/dist/**`: Flue Cloudflare build output
- `.flue-vite/**`, `.wrangler/**`, `.output/**`: local/build artifact

これらは現行仕様の正本ではなく、source/configから生成される。
