# `scripts/probe-flue-stream.mjs` 現行仕様

## 目的

Flue workflowをHTTP admissionし、Durable StreamsのSSE frameを読み、model生成eventが流れるかを確認する内部debug CLI。

製品UI向けSSE clientではない。

## 実行

root script:

```bash
pnpm probe:flue-stream -- \
  --base-url http://127.0.0.1:3583 \
  --payload-file ./tmp/flue-probe-payload.json
```

option:

- `--base-url`: default `http://127.0.0.1:3583`
- `--payload-file`: 必須
- `--show-text`: `text_delta`本文をstdoutへ表示

## admission

```http
POST /workflows/generate-replies
Content-Type: application/json
```

payload fileのJSONをそのまま送る。

responseに`runId`がなければerror。

## stream URL

優先順位:

1. admission responseの`streamUrl`
2. fallback `/runs/:runId`

query:

```text
offset=<admission offset or -1>
live=sse
```

accept header:

```text
text/event-stream
```

## frame parser

- CRLFをLFへ正規化
- blank lineでSSE frame分割
- comment frameを無視
- `event:`と複数`data:` lineを読む
- dataをJSON parse

### `event: control`

`streamNextOffset`を`summary.nextOffset`へ保存。

### `event: data`

payloadはevent配列であることを期待する。

集計:

```text
events
textDeltaEvents
textChars
thinkingDeltaEvents
thinkingChars
terminalType
terminalError
```

- `text_delta.text`は`--show-text`時のみ表示
- `thinking_delta.delta`は文字数だけ集計し、本文を表示しない
- その他event typeはstderrへevent名だけ表示
- `run_end`からterminal状態を取る

## exit code

以下のどれかならnon-zero。

- terminal typeが`run_end`でない
- terminal error=true
- text deltaが0件

## 現行の制約

- reconnectは実装せず、offsetを表示するだけ
- timeoutなし
- abort handlingなし
- payload schema validationなし
- public deployment向け認証なし
- Agent appはhost gateを持つ
- workflow moduleに`runs` exportがないため、実buildでrun stream routeが404となる可能性がある
- integration CIではsyntax checkのみで、実Agent/Sakura接続は行わない

## 関連

- `docs/runbooks/flue-stream-probe.md`
- `docs/adr/003-flue-streaming-boundary.md`
