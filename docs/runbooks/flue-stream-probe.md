# Flue Durable Streams probe runbook

## 目的

`generate-replies` workflowがFlue `session.prompt()`を通り、run streamへどのイベントを出すかを実測します。probeは公開生成文の`text_delta`を表示しますが、raw thinking本文は表示しません。

## 必要な環境変数

Agent Worker:

```dotenv
SAKURA_API_TOKEN=replace-with-secret
SAKURA_BASE_URL=https://api.ai.sakura.ad.jp/v1
SAKURA_MODEL_ID=gpt-oss-120b
INTERNAL_AGENT_TOKEN=replace-with-random-shared-secret
```

API Worker:

```dotenv
BETTER_AUTH_SECRET=replace-with-random-secret
INTERNAL_AGENT_TOKEN=must-match-agent-worker
```

値をGit、Issue、PR、ログへ貼り付けないでください。ローカルは`.env`/`.dev.vars`、本番は`wrangler secret put`を使います。

## ローカル実行

Agent Workerを起動します。

```bash
pnpm --filter @bs-job-board/agent-worker dev
```

D1に存在するthreadを使い、payload fileを作ります。

```json
{
  "threadId": "existing-thread-id",
  "threadTitle": "会議資料の転記作業",
  "targetBody": "毎週同じ情報を別システムへ転記している",
  "targetPostNumber": 1
}
```

probeを実行します。

```bash
export INTERNAL_AGENT_TOKEN='local-shared-secret'
pnpm probe:flue-stream -- \
  --base-url http://127.0.0.1:3583 \
  --payload-file ./tmp/flue-probe-payload.json
```

## 期待する出力

最低限、次を確認します。

```text
[event] run_start
[event] message_start
{"replies":[...                 # text_deltaの組み立て
[event] message_end
[event] run_end isError=false
```

summaryの期待値:

- `textDeltaEvents > 0`
- `textChars > 0`
- `terminalType = "run_end"`
- model/providerがthinking eventを出す場合、`thinkingDeltaEvents > 0`
- thinking本文そのものは出力されない

## Baselineとの比較

旧workflowはSakuraをraw `fetch()`していたため、Flueがmodel streamを観測できず、run streamには主に`run_start` / `run_end`しか現れませんでした。`session.prompt()`移行後に`text_delta`が確認できれば、Flue経由のstreamingが成立しています。

## エラー

### admissionが404

- `INTERNAL_AGENT_TOKEN`がAgent側とprobe側で一致しているか確認
- workflow routeがFlue buildでdiscoverされているか確認

### streamが404

- `runs` middlewareがexportされているか確認
- admissionの`runId`を使っているか確認
- run streamにもAuthorization headerを送っているか確認

### `AI_CONFIGURATION_ERROR`

- `SAKURA_API_TOKEN`が設定されているか確認
- `SAKURA_BASE_URL`は`/v1`までにし、`/chat/completions`を含めない

### `AI_PROVIDER_TIMEOUT`

45秒以内にprovider応答が完了しませんでした。無条件retryはせず、provider状態と入力サイズを確認します。

### `AI_OUTPUT_INVALID`

初回出力と1回のrepairの両方がschema検証に失敗しています。prompt/schemaを調整し、repair回数は増やしません。
