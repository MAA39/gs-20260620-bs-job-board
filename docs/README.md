# Documentation

このディレクトリは、現行コードと一致する仕様、設計判断、監査結果、検証手順を置く正本です。

- `current-v1/README.md`: V1 mainの現行仕様スナップショット。Worker / package / runtime flow別
- `architecture-audit.md`: V1 mainの監査結果と改修計画
- `adr/003-flue-streaming-boundary.md`: FlueとSSEの責務境界
- `adr/004-ai-run-lifecycle-and-db-authority.md`: AI run状態機械、冪等性、DB書き込み権限
- `runbooks/flue-stream-probe.md`: Flue Durable Streamsの検証手順

## ドキュメント種別

- `current-v1/**`: 今のmainに存在する実装事実
- `adr/**`: 採用する設計判断と不変条件
- `runbooks/**`: 実行・検証手順
- `architecture-audit.md`: 問題点と段階的移行計画

## 運用ルール

- 未実装機能を実装済みのように書かない
- 設計変更とコード変更を同じPRで更新する
- 現行仕様と将来仕様を同じ文章で混同しない
- 機密情報をドキュメントへ記録しない
- GitHub Actionsは検証とデプロイに使用する
- GitHub Actionsをリモートシェル代わりの編集用途に使わない
- 依存する変更は直列にマージする
