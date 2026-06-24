# ADR-003: Flue streamと製品SSEの責務境界

- status: accepted
- date: 2026-06-24

## Context

Flue workflowはDurable Streamsへrun lifecycleとmodel generation eventを保存・配信できる。一方、旧実装ではAPIのstream routeがprovider呼び出しと配信を兼ね、通常workflowとは別の生成入口になっている。

## Decision

1. model呼び出しはFlue `session.prompt()`へ統一する。
2. AI生成開始は通常投稿後のworkflow dispatchだけにする。
3. Flue run streamは内部検証と運用デバッグに限定する。
4. workflowとrunのHTTP routeはService Binding用hostとlocalhostだけに限定する。
5. probeはイベント種別と公開可能なtext deltaを確認する。
6. 製品向けSSEは後続Phaseで`ai_run_events`のallow-list済み状態だけを配信する。
7. 公開可能な根拠は別のruntime schemaで検証する。

## Consequences

- 二重生成を防ぎやすくなる。
- Flueのprovider、timeout、event streamを一箇所で観測できる。
- 内部debug streamと製品データの境界が明確になる。
- Phase 1ではリアルタイム表示が一時的に減る。
- 製品向け進捗表示には`ai_runs`とAPI SSEが必要になる。

## Rejected alternatives

### APIがprovider streamを直接proxyする

生成入口が増え、workflowと保存処理が競合するため採用しない。

### 非公開APIへcastして独自eventを送る

Flue標準eventとの互換性を失うため採用しない。

### modelが返す内部情報をそのままUIへ表示する

安全性とデータ契約上の問題が残るため採用しない。
