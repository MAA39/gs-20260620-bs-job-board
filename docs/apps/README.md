# V1 Worker仕様（as-is）

> snapshot: 2026-06-25
> source of truth: `main` at `d328bd1fe5dab740ed498f38ac2e585e215e768e`
> scope: 現在存在するコードの仕様。目標設計や未merge PRは含めない。

このディレクトリは、`apps/`の構成に対応して現行V1のWorker仕様を記録する。

- [`web/README.md`](./web/README.md): TanStack Start UI Worker
- [`api/README.md`](./api/README.md): Hono API Worker
- [`agent/README.md`](./agent/README.md): Flue Agent Worker

## Worker構成

```text
Browser
  ├─ page / server function ──> Web Worker
  │                               └─ Service Binding `API`
  │                                    └─ API Worker
  │                                         ├─ D1 `DB`
  │                                         └─ Service Binding `AGENT`
  │                                              └─ Agent Worker
  │                                                   ├─ Flue workflow / run
  │                                                   ├─ Sakura AI provider
  │                                                   └─ D1 `DB`
  └─ Better Auth client ──────> API Worker public origin
```

## デプロイ名と公開範囲

| Worker | Cloudflare service | 現在の公開入口 |
|---|---|---|
| Web | `bs-job-board-web` | UI全体 |
| API | `bs-job-board-api` | REST API、Better Auth、health |
| Agent | `bs-job-board-agent` | health。workflow/run routeはhost allow-listで制限 |

Web WorkerとAPI Worker間、API WorkerとAgent Worker間にはService Bindingがある。Better Auth clientだけはWebと同一originではなく、API Workerの公開URLへ直接接続する。

## 現行の主要データフロー

### スレッド作成

```text
Web server function
  -> POST /api/v1/threads
API
  -> threads + 最初のhuman postをD1 batchで保存
  -> waitUntilでAgent workflowをdispatch
Agent
  -> D1から直近8件を取得
  -> Flue session.prompt()で3返信を生成
  -> D1へAI post 3件を保存
Web
  -> 5秒pollingでthread detailを再取得
```

### 人間返信

```text
Web server function
  -> POST /api/v1/threads/:id/posts
API
  -> Better Auth session取得を試行
  -> human postをD1へ保存
  -> clientのauthor_typeがhumanならAgent workflowをdispatch
Agent
  -> AI post 3件をD1へ保存
```

### AI進捗表示

製品向けSSEは現在存在しない。Webは5秒pollingで結果を取得する。AgentにはFlue Durable Streamsのrun streamがあるが、内部検証用途であり、Webからは購読していない。

## 現行のデータ所有

| データ | 現在のwriter |
|---|---|
| thread / human post / reaction / status | API Worker |
| AI post | Agent Worker |
| Better Auth tables | API Worker / Better Auth |
| Flue run state | Agent WorkerのDurable Objects |

APIとAgentが同じapplication D1へ書き込む二重writer構成である。これは現状仕様であり、目標設計ではない。

## 現行D1の主なテーブル

- `threads`
- `posts`
- `reactions`
- Better Authの`user`、`session`、`account`、`verification`

`posts`のAI返信先は`source_post_number`で表現している。IDベースの`parent_post_id`と`ai_runs`関連テーブルは、未mergeのPR #15で提案中のため、このas-is仕様には含めない。

## 共通の既知制約

- runtime request schemaとbody size上限が十分ではない
- WebのlocalStorage identityとAPIのBetter Auth sessionが併存する
- clientが`author_type`、表示名、reaction `userId`、thread statusを指定できる
- AI実行を表す永続runと冪等性管理がない
- Agent Workerがapplication D1を直接読み書きする
- 製品向けのAI進捗SSE、再接続、失敗状態表示がない
- E2E、staging smoke test、rollback実証は未整備

## 更新ルール

各Workerの挙動を変えるPRでは、対応する`docs/apps/<worker>/README.md`を同じPRで更新する。目標設計はADRへ、現行挙動はこのディレクトリへ記録する。
