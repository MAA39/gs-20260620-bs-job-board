# ADR-005: AI出力validation緩和とフォールバック導入

- status: accepted
- date: 2026-06-26
- related: ADR-004, #39 (usage集計), generate-replies.ts, internal-callbacks.ts
- note: #38 (contextWindow 0→128000) は既にclosed。今回の主因ではない

## Context

### 不具合の事象

本番環境（bs-job-board-web.masa-nekoshinshi39.workers.dev）でスレッド投稿後のAI生成が一定確率で失敗し、UIに「⚠ エラーが発生しました」が表示される。ユーザーから見ると、投稿はできたがAIレスが返ってこない状態になる。

### 不具合の定量データ

D1 `ai_runs` テーブルの全履歴（2026-06-26時点）:

| 時刻 (UTC) | stage | status | error_code |
|------------|-------|--------|------------|
| 6/25 09:19 | initial | completed | — |
| 6/26 07:03 | initial | **failed** | **AI_OUTPUT_INVALID** |
| 6/26 07:22 | deep_dive | completed | — |
| 6/26 07:23 | deep_dive | **failed** | **AI_OUTPUT_INVALID** |
| 6/26 07:47 | initial | completed | — |
| 6/26 07:47 | deep_dive | completed | — |
| 6/26 07:47 | deep_dive | completed | — |
| 6/26 07:48 | deep_dive | completed | — |

8回中2回失敗。失敗率 **25%**。全て `AI_OUTPUT_INVALID`。rate limit (`AI_PROVIDER_TIMEOUT`) やdispatch失敗 (`AI_DISPATCH_FAILED`) ではない。

### 不具合の根本原因

Agent Worker内の `generate-replies.ts` の `decodeReplies()` が、Sakura AI Engine (`gpt-oss-120b`) の出力に対して厳しすぎるvalidation条件を課している。repair promptで修正を試みるが、1回のrepairでは修正しきれないケースがある。

現行のvalidation条件（`decodeReplies`）:

| # | 条件 | 失敗パターン |
|---|------|-------------|
| 1 | valid JSON | AIがJSON以外のテキストを返す |
| 2 | `replies` 配列が存在 | 構造の崩れ |
| 3 | **3件ちょうど** | AIが2件や4件を返す |
| 4 | 全てstring | 型の崩れ |
| 5 | **各5-200文字** | 「わかる」(3文字)や長文を弾く |
| 6 | **全件ユニーク** | 似た表現の重複 |
| 7 | **疑問符（?？）が全体で最大1つ** | 「どうなん？具体的には？」を弾く |

太字の4条件がSakura AIの出力バラツキと噛み合わず、実用上の失敗を引き起こしている。

さらに、validation失敗時のフローにも問題がある:

```
prompt → decodeReplies
  ❌ → repair prompt(1回) → decodeReplies
    ❌ → throw AI_OUTPUT_INVALID → UIにエラー表示
```

- repairは1回しか試行しない
- repair後も失敗したらフォールバックなくエラー終了

### validationが2箇所に存在する

同等の検証が Agent 側と API 側の両方にある。

| 箇所 | ファイル | 検証内容 |
|------|---------|---------|
| Agent | `generate-replies.ts` `decodeReplies()` | 件数3/文字数5-200/ユニーク/疑問符 |
| API | `internal-callbacks.ts` complete handler | 件数3 (`EXPECTED_REPLY_COUNT`)/文字数5-200/hash検証 |

Agent側だけ緩めてもAPI側のcomplete handlerで400が返り、Agentから見ると `AI_CALLBACK_COMPLETE_FAILED` → `AI_RUN_FAILED` になる。両方同時に変更する必要がある。

### プロダクトの現在のフェーズ

bs-job-boardはG's Academy DEV courseの課題プロダクトであり、現在のフェーズは「動くものを見せる」段階。AI生成が25%の確率でエラーになるのはユーザー体験として致命的。validationの品質保証よりも可用性を優先する。

## Decision

### 1. validation条件の緩和

`decodeReplies`（Agent側）と complete handler（API側）の両方で、以下のように変更する。

| # | 条件 | 変更前 | 変更後 | 理由 |
|---|------|--------|--------|------|
| 1 | JSON parse | 維持 | 維持 | JSONでなければ話にならない |
| 2 | `replies`配列 | 維持 | 維持 | 構造の最低保証 |
| 3 | 件数 | 3件ちょうど | **1-5件** | 2件や4件も掲示板として自然 |
| 4 | 型 | string | 維持 | コストゼロの型ガード |
| 5 | 文字数 | 5-200 | **1-500** | 短い相槌も長めの意見も許容 |
| 6 | ユニーク | 必須 | **撤廃** | 重複レスよりエラー全滅が致命的 |
| 7 | 疑問符 | 最大1 | **撤廃** | プロンプト側で制御すべき |

残る条件: JSON parse成功 + `replies`配列存在 + 1-5件 + 全てstring + 各1-500文字。

### 2. repairの位置づけ変更

validationを十分緩めたことで、repairが発動するのは「JSONとして壊れていた場合」のみになる。repair回数は **1回のまま維持**。件数・文字数でrepairを走らせる意味がなくなるため、実質的にrepair発動率が大幅に下がる。

### 3. フォールバック応答の導入

repair後もvalidation失敗した場合（JSON parseが2回連続で壊れるケース）、`AI_OUTPUT_INVALID` でエラー終了するのではなく、定型レス1件で `completed` として返す。

```typescript
const FALLBACK_REPLIES = [
  'ちょっと拾いきれんかったわ。もう少し具体例あるとレスしやすい気がする。',
];
```

UIはエラーバナーではなくレスとして表示される。ユーザー体験として「エラーが発生しました」より良い。

通常出力として採用するにはJSON parse成功を必須とする。ただし2回連続でJSON parseすら失敗した場合は、フォールバックレスを生成し `completed` として返す。つまりフォールバックはvalidation条件の「外側」に位置する最終安全弁である。

フォールバック使用時の `resultHash` はフォールバックレス自体から通常通り計算する。callback bodyに `"fallback": true` を含めてもよいが、**今回はDB列を増やさない**。`ai_runs` への永続化や集計は後続Issue「fallback_used記録とAI品質モニタリング」で扱う。

### 4. REPLY_COUNT定数の扱い

プロンプトに「返信を3件返す」と指示する `REPLY_COUNT = 3` はそのまま維持。validationの件数チェックとプロンプトの指示は独立した関心事として分離する。

### 5. hash計算の整合性

Agent側・API側ともに `resultHash` は **trim後のreplies配列をJSON.stringify** したものからSHA-256で計算する。この計算対象はAgent/APIで必ず一致させる。現行の `internal-callbacks.ts` が `normalizedBodies`（trim済み）からhashを再計算して照合する構造はそのまま維持する。

## 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `packages/agent/src/workflows/generate-replies.ts` | `decodeReplies` 緩和 + フォールバック追加 |
| `apps/api/src/routes/internal-callbacks.ts` | complete handler の件数・文字数定数を緩和 |
| 既存テスト | validation条件変更に伴う期待値修正 |

## デプロイ

Agent Worker + API Worker の2つを再デプロイ。Web Workerの変更は不要。

## Consequences

### 良い結果

- AI生成の失敗率が実質ゼロになる
- ユーザーは常に何らかのAIレスを受け取れる
- repair発動頻度が下がり、Sakura AI無償枠（3,000回/月）の消費が減る

### 受け入れるトレードオフ

- AI出力品質の下限が下がる（2件の短いレスや、似た表現の重複が許容される）
- フォールバックレスは定型文であり、「AI生成」と呼べる品質ではない
- validationで弾いていたゴミ出力がDBに保存される可能性がある

### 将来の改善余地

- プロンプトの改善で品質を制御する方向へ移行（validationからプロンプトへの責務移動）
- Sakura AI以外のモデルへのフォールバック
- 後続Issue「fallback_used記録とAI品質モニタリング」: `ai_runs.fallback_used` 列追加、集計基盤
- フォールバックレスを複数パターン用意してランダム選択
- #39 usage集計問題（repair時のusage上書き、cache token未送信、prompt call count未記録）との接続
