# ADR-004: AI run lifecycle・冪等性・DB書き込み権限

- status: accepted
- date: 2026-06-25
- related: #8, #9, #10, #11, #12, HANDOFF #13

## Context

Phase 1でmodel呼び出しをFlue `session.prompt()`へ統一し、旧生成兼stream routeを撤去した。次のPhase 2Aでは、AI生成を一時的なHTTP処理ではなく、再試行・再読込・callback再送を扱える永続的なrunとして管理する必要がある。

V2の実装は参考にするが、その状態更新commandは前状態をSQLで制限していないため、V1へそのままコピーしない。V1にはlegacy列`source_post_number`と過去のthinking投稿も存在する。

## Decision

### 1. application D1のwriter

API Workerだけをapplication D1のwriterとする。Agent WorkerはFlue実行、model呼び出し、runtime validation、repair最大1回、構造化結果のcallbackだけを担当する。

### 2. run状態機械

採用する状態は以下だけとする。

```text
queued -> admitted -> generating -> completed
                            |      -> failed
                            -> repairing -> completed
                                         -> failed
queued -> failed
admitted -> failed
```

`completed`と`failed`はterminalであり、他状態へ戻さない。利用するcommandがない`completing`状態は導入しない。

各commandは期待する前状態をSQL条件で検証する。無効な遷移ではrun rowを変更せず、eventも追加しない。成功した状態遷移とevent追加は同一atomic operationに含める。

### 3. queued event

run作成時に`queued` eventも同じD1 batchで作成する。Phase 2A-2ではhuman post、queued run、queued eventを同じbatchへ組み込む。

### 4. completionの冪等性

完了callbackは`result_hash`で冪等性を判定する。

- 未完了run: AI posts、run-post links、usage、result hash、completed event、run更新を同一batchで保存
- completedかつ同じhash: duplicate successとして既存post IDsを返す
- completedかつ異なるhash: conflict
- failedまたは許可されない状態: conflict

### 5. DB commandへ渡してよい値

callbackやmodel出力から受け取るreply入力は、生成された内容とpost IDなど必要最小限に限定する。

DB commandは以下をcaller入力から受け取らない。

- `author_type`
- `author_name`
- `role`
- `thread_id`
- `source_post_number`
- runの`status`

AI postの`author_type='ai'`、`author_name='名無しさん'`、`role=NULL`はDB command側で固定する。threadと返信元は`ai_runs.thread_id`と`ai_runs.source_post_id`から導出する。

### 6. post親子関係の移行

0008 migrationでnullableな`posts.parent_post_id`を追加する。新しいAI postは以下をdual-writeする。

- `parent_post_id = ai_runs.source_post_id`
- `source_post_number = source postのpost_number`

既存UI互換のため`source_post_number`を直ちに削除しない。後続PRでcontracts・API・Webを`parent_post_id`へ移行し、その後legacy列廃止を判断する。

### 7. generation context

Agentへ渡すprior postsはsource postより前の直近8件に限定し、昇順で返す。legacy thinking投稿は`role='thinking'`または旧thinking投稿者名で除外する。非公開の生成本文を再びpromptへ混入させない。

### 8. event sequence

run内のsequenceは1から始まり単調増加する。unique `(ai_run_id, sequence)`をDBで保証する。競合時に状態だけ更新されeventが欠落する実装、またはeventだけ追加される実装を許可しない。

## Consequences

- callback再送と二重dispatchを安全に扱える。
- AgentからDB権限を撤去できる。
- 状態とSSE eventの不整合を防げる。
- legacy UIを壊さずIDベース親子関係へ移行できる。
- V2コードの単純移植ではなく、状態遷移SQLとintegration testの追加が必要になる。

## Required tests

- 各許可遷移
- 各不許可遷移でrow/eventが不変
- queued runとqueued eventのatomic作成
- completionのatomicity
- same hash duplicate success
- different hash conflict
- completedからfailedへ遷移しない
- source postとthreadの不一致を拒否
- prior postsが最大8件でlegacy thinkingを含まない
