# V1 現行仕様スナップショット

> 対象: `MAA39/gs-20260620-bs-job-board`
> 調査基準: `main` at `d328bd1fe5dab740ed498f38ac2e585e215e768e`
> 記録日: 2026-06-25

このディレクトリは、理想設計や移行後の仕様ではなく、**現在のmainブランチで実際に動くコード・残っているコードをそのまま記録する**。

未実装の計画は「現行仕様」に混ぜず、各ページの「既知の差分・負債」に分離する。

## リポジトリ対応表

```text
apps/
  web/    -> docs/current-v1/apps/web.md
  api/    -> docs/current-v1/apps/api.md
  agent/  -> docs/current-v1/apps/agent.md

packages/
  contracts/ -> docs/current-v1/packages/contracts.md
  db/        -> docs/current-v1/packages/db.md
  agent/     -> docs/current-v1/packages/agent.md
  config/    -> docs/current-v1/packages/config.md

scripts/
  probe-flue-stream.mjs -> docs/current-v1/scripts/flue-stream-probe.md

.github/workflows/
  ci.yml -> docs/current-v1/repository/build-and-ci.md

repository横断:
  runtime flow        -> docs/current-v1/repository/runtime-flows.md
  env / bindings      -> docs/current-v1/repository/environment-and-bindings.md
  code inconsistencies -> docs/current-v1/repository/known-inconsistencies.md
```

## 現在の実行構成

```text
Browser
  -> Web Worker (TanStack Start)
  -> API Worker (Hono)
       -> application D1
       -> Service Binding: AGENT
  -> Agent Worker (Flue)
       -> Flue workflow generate-replies
       -> Sakura AI provider through session.prompt()
       -> application D1へAI投稿を保存
```

## 現在の主要フロー

### スレッド作成

```text
Web POST server function
  -> API POST /api/v1/threads
  -> threads + 最初のhuman postをD1 batchで保存
  -> waitUntilでAgent workflowを非同期dispatch
  -> AgentがAI返信を3件生成
  -> Agentがapplication D1へ3件をbatch INSERT
  -> Webは5秒pollingで更新を取得
```

### 人間返信

```text
Web POST server function
  -> API POST /api/v1/threads/:id/posts
  -> human postをD1へ保存
  -> author_typeがhumanならAgent workflowをdispatch
  -> AgentがAI返信を3件保存
  -> Webは5秒pollingで更新を取得
```

## 現在成立している境界

- Web / API / Agentの3 Worker構成
- Web -> API、API -> AgentはCloudflare Service Bindingを使用
- model呼び出しはAgent WorkerのFlue `session.prompt()`経由
- APIの旧生成兼SSE routeは削除済み
- AI返信数は3件固定
- model timeoutは45秒
- JSON検証に失敗した場合のrepairは最大1回
- CIでAPI / workflow内の直接provider fetchと`reasoning_content`再混入を検出

## 現在成立していない境界

- Agent Workerはまだapplication D1 bindingを持ち、D1を直接読み書きする
- `ai_runs`、冪等性、製品向け状態SSEは未実装
- Webには削除済みAPI routeを呼ぶ古いstream用コードが残る
- 認証失敗時にbrowser UUIDへfallbackするコードが残る
- clientが`author_type`、`author_name`、reaction `userId`、thread statusを指定できる
- READMEの一部データフローは現行コードと一致していない

## 読み方

- 現在のHTTP/UI挙動: `apps/*.md`
- current D1 schema/query: `packages/db.md`
- Worker間の実際の順序: `repository/runtime-flows.md`
- 意図しない差異・dead path: `repository/known-inconsistencies.md`
- 移行後の判断: `docs/adr/**`

## 関連する設計資料

- `docs/architecture-audit.md`
- `docs/adr/003-flue-streaming-boundary.md`
- `docs/adr/004-ai-run-lifecycle-and-db-authority.md`
- `docs/runbooks/flue-stream-probe.md`

このスナップショットはコード変更と同じPRで更新する。将来仕様を記載する場合は、ADRまたはIssueへ分離する。
