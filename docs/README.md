# Documentation

このディレクトリは、現行コードと一致する設計判断、監査結果、検証手順を置く正本です。

- `architecture-audit.md`: V1 mainの監査結果と改修計画
- `adr/003-flue-streaming-boundary.md`: FlueとSSEの責務境界
- `adr/004-ai-run-lifecycle-and-db-authority.md`: AI run状態機械、冪等性、DB書き込み権限
- `runbooks/flue-stream-probe.md`: Flue Durable Streamsの検証手順

## 運用ルール

- 未実装機能を実装済みのように書かない
- 設計変更とコード変更を同じPRで更新する
- 機密情報をドキュメントへ記録しない
- GitHub Actionsは検証とデプロイに使用する
- GitHub Actionsをリモートシェル代わりの編集用途に使わない
- 依存する変更は直列にマージする
