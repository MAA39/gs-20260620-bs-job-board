# Documentation

このディレクトリは、現行コードと一致する仕様、設計判断、監査結果、検証手順を置く正本です。

## 現行仕様

- `apps/README.md`: V1 Worker構成と現行データフロー
- `apps/web/README.md`: Web Workerのas-is仕様
- `apps/api/README.md`: API Workerのas-is仕様
- `apps/agent/README.md`: Agent Workerのas-is仕様

## 設計・監査

- `architecture-audit.md`: V1 mainの監査結果と改修計画
- `adr/003-flue-streaming-boundary.md`: FlueとSSEの責務境界
- `adr/004-ai-run-lifecycle-and-db-authority.md`: AI run状態機械、冪等性、DB書き込み権限

## Runbook

- `runbooks/flue-stream-probe.md`: Flue Durable Streamsの検証手順

## 運用ルール

- `docs/apps/**`にはmainの現在動作を記録する
- 目標設計と変更理由はADRへ記録する
- 未実装機能を実装済みのように書かない
- 設計変更とコード変更を同じPRで更新する
- GitHub Actionsは検証とデプロイに使用する
- GitHub Actionsをリモートシェル代わりの編集用途に使わない
- 依存する変更は直列にマージする
