# Documentation

このディレクトリは、現行コードと一致する設計判断、監査結果、検証手順を置く正本です。

## Worker仕様（as-is）

- [`apps/README.md`](apps/README.md): 3 Worker構成概要・Service Binding・信頼境界
- [`apps/api/README.md`](apps/api/README.md): API Worker — route・binding・middleware・D1 schema
- [`apps/web/README.md`](apps/web/README.md): Web Worker — serverFn・proxy・SSE・認証フロー
- [`apps/agent/README.md`](apps/agent/README.md): Agent Worker — Flue workflow・validation・usage

## ADR

- `adr/003-flue-streaming-boundary.md`: FlueとSSEの責務境界
- `adr/004-ai-run-lifecycle-and-db-authority.md`: AI run状態機械、冪等性、DB書き込み権限
- `adr/005-ai-output-validation-relaxation.md`: AI出力validation緩和 + フォールバック
- `adr/006-api-boundary-bodylimit-cors.md`: bodyLimit + CORS適用範囲の分離

## コード解説（発表用）

- [`code-walkthrough.md`](code-walkthrough.md): コードベース全体の概要（ディレクトリ・定量データ・フロー図）
- [`details/web-worker.md`](details/web-worker.md): Web Worker — SSR・proxy・SSE Hook・認証クライアント
- [`details/api-worker.md`](details/api-worker.md): API Worker — 3境界・CRUD・dispatch・callback・SSE配信
- [`details/agent-worker.md`](details/agent-worker.md): Agent Worker — Flue・workflow・validation・さくらAI
- [`details/packages.md`](details/packages.md): packages — db(スキーマ・状態機械)・contracts(型)・agent(プロンプト)
- [`details/what-went-wrong.md`](details/what-went-wrong.md): うまくいかなかったこと10件 + うまくいったこと5件

## その他

- `architecture-audit.md`: V1 mainの監査結果と改修計画
- `runbooks/flue-stream-probe.md`: Flue Durable Streamsの検証手順
- `runbooks/same-origin-auth.md`: same-origin reverse proxy認証手順

## 運用ルール

- 未実装機能を実装済みのように書かない
- 設計変更とコード変更を同じPRで更新する
- 機密情報をドキュメントへ記録しない
- GitHub Actionsは検証とデプロイに使用する
- GitHub Actionsをリモートシェル代わりの編集用途に使わない
- 依存する変更は直列にマージする
