# V1 architecture audit

> audited: 2026-06-24
> target: `MAA39/gs-20260620-bs-job-board`
> reference: `MAA39/bs-job-board-v2`

## 結論

Web、API、Agentの3 Worker構成は維持する。現在はAI生成経路、DB更新責務、認証処理が複数箇所へ分散しているため、直列の小さいPRで整理する。

## 主な問題

| 優先度 | 問題 | 改修方向 |
|---|---|---|
| Critical | 通常workflowと旧stream routeの両方がAI生成を開始する | 投稿後のworkflow dispatchだけを生成入口にする |
| Critical | workflowがmodel providerを直接呼ぶ | Flue providerと`session.prompt()`へ統一する |
| Critical | APIとAgentの双方がapplication D1を更新する | 最終的にAPIだけをwriterにする |
| High | 生成中データを保存・表示する責務が広い | 製品向けデータと内部観測を分離する |
| High | 認証設定不足時のfallbackがある | 設定不足を明示的なエラーにする |
| High | 投稿者情報とreaction IDをclient入力から受け取る | sessionからserverが決定する |
| Medium | Service Binding responseを未処理で終える箇所がある | `finally`でbodyを解放する |
| Medium | Agent Workerがroot検証の対象外 | build/typecheck scriptを追加する |
| Medium | READMEと実装経路が一致しない | 実装済みと計画を区別する |

## 改修順序

1. CI、Docs、設定のfail-closed
2. Flue native model callと内部stream probe
3. 旧AI生成経路の撤去
4. `ai_runs`、冪等性、API-only writer、状態SSE
5. same-origin auth proxyとserver側identity決定
6. 所有者認可、reaction、E2E、staging smoke test

## Phase 1の一時構成

Phase 1では二重生成と直接provider呼び出しを先に止める。Agent WorkerからD1への書き込みは一時的に残るが、最終設計ではない。

```text
API: human postを保存
  -> Service Binding
Agent: Flue workflow
  -> Flue session.prompt
  -> runtime validation
  -> application D1へAI postを保存（暫定）
```

## 最終構成

```text
API: human post + ai_run queued
  -> Agent: structured result only
  -> API internal callback
  -> API: AI posts + completed eventを原子的に保存
  -> Browser: ai_run status SSEを購読
```

## Done判定

- `pnpm typecheck`
- `pnpm build`
- 該当するunit、integration、E2E
- staging smoke test
- Docsがコードと一致
- rollback方法がPRへ記載
