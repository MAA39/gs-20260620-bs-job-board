# Flue Durable Streams probe runbook

## 目的

`generate-replies` workflowがFlue `session.prompt()`を使い、run streamへ生成イベントを出すことを内部環境で確認する。

## 事前準備

- `apps/agent/.dev.vars.example`を参考に、ローカル専用設定を作る
- 共有値は安全な入力方法でshell環境へ設定する
- 実値をGit、Issue、PR、logへ記録しない
- D1に存在するthread IDを検証payloadへ指定する

## 実行

```bash
pnpm --filter @bs-job-board/agent-worker dev
pnpm probe:flue-stream -- \
  --base-url http://127.0.0.1:3583 \
  --payload-file ./tmp/flue-probe-payload.json
```

## 確認項目

- `run_start`を観測する
- `text_delta`を1件以上観測する
- 最後に`run_end`を観測する
- stream終了を検出する
- 非公開の生成本文を標準出力しない
- control frameのoffsetを追跡する

## 主なエラー

- admission 404: workflow routeと内部認証設定を確認する
- stream 404: `runs` middleware、run ID、同じ認証headerを確認する
- provider timeout: 無条件retryせず、provider状態と入力サイズを確認する
- invalid output: promptとschemaを見直し、repair回数は増やさない
