# Agent Worker — as-is仕様

Worker名: `bs-job-board-agent`
URL: なし（`workers_dev: false`）
エントリ: Flue CLIビルド出力 `dist/bs_job_board_agent/index.js`

## Bindings

| Binding | 種別 | 用途 |
|---------|------|------|
| API | Service Binding | `bs-job-board-api` — callback送信先 |
| FLUE_ANALYST_AGENT | Durable Object | Flue Agent DO |
| FLUE_GENERATE_REPLIES_WORKFLOW | Durable Object | Flue Workflow DO |
| FLUE_REGISTRY | Durable Object | Flue Registry DO |
| SAKURA_API_TOKEN | Secret | Sakura AI Engine認証トークン |
| SAKURA_MODEL_ID | Variable (optional) | モデルID（default: `gpt-oss-120b`） |
| INTERNAL_CALLBACK_KEY | Secret | API callbackの認証key |

## アクセス制限

public URLなし。API WorkerからのService Binding経由のみ到達可能。
Hono app内で `allowInternalHost` middlewareがhostnameを制限（`agent`, `localhost`等）。

## ソースファイル

| ファイル | 役割 |
|---------|------|
| `src/app.ts` | Hono app + Flue routing mount |
| `src/agents/analyst.ts` | Flue Agent定義（Sakura AI provider登録） |
| `src/workflows/generate-replies.ts` | AI生成workflow本体 |

## Workflow: generate-replies

### トリガー

API WorkerがPOST `/threads` or `/threads/:id/posts` で投稿受付後、`waitUntil` 内で Agent WorkerにService Binding経由でdispatchする。

### 実行フロー

```
1. parsePayload(payload) — aiRunId, context取得
2. callbackToApi('generating') — run状態更新
3. session.prompt(buildPrompt(input)) — Sakura AI呼び出し
4. decodeReplies(response.text) — validation (1-5件, 1-500文字)
5. 失敗 → callbackToApi('repairing') → repair prompt → re-validate
6. 再失敗 → フォールバックレス1件で続行（ADR-005）
7. callbackToApi('complete') — replies + usage送信
```

### プロンプト構成

```
SYSTEM: 2ch風匿名掲示板の住民として返答。判断や説教をしない。
        必ず JSON {"replies":["レス1","レス2","レス3"]} で返す。

スレッド名: {thread.title}
{recentPosts or "(最初の投稿)"}
返信対象: {sourcePost.body}
返信を3件返す。
```

REPLY_COUNT=3はプロンプト指示。validation上限は1-5件（ADR-005）。

### Validation (decodeReplies)

| 条件 | 値 | 備考 |
|------|-----|------|
| JSON parse | 必須 | |
| replies配列 | 必須 | |
| 件数 | 1-5 | ADR-005で3→1-5に緩和 |
| 型 | 全てstring | |
| 文字数 | 1-500 | ADR-005で5-200→1-500に緩和 |
| ユニーク | 撤廃 | ADR-005 |
| 疑問符上限 | 撤廃 | ADR-005 |

### フォールバック（ADR-005）

repair後もvalidation失敗した場合、フォールバック用レス1件で `completed` として返す。

```typescript
const FALLBACK_REPLIES = [
  'ちょっと拾いきれんかったわ。もう少し具体例あるとレスしやすい気がする。',
];
```

### Usage集計（#39）

`totalUsage` 累積変数で初回prompt + repair promptのusageを加算管理。
complete callbackに `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` を送信。
`attempt_count` はDB側で状態遷移時に自動管理（generating=1, repairing+1）。

### Callback通信

Agent → API Worker へ Service Binding 経由でPOST。

```typescript
await api.fetch(
  new Request(`http://api/internal/v1/ai-runs/${aiRunId}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Callback-Key': callbackKey },
    body: JSON.stringify(body),
  })
);
```

### エラーハンドリング

| エラー | 処理 |
|--------|------|
| `SafeWorkflowError` | callbackToApi('fail') + error_code保存 |
| `AbortSignal.timeout(45s)` | AI_PROVIDER_TIMEOUT |
| validation 2回失敗 | フォールバック用レスで続行（throwしない） |
| unknown error | AI_RUN_FAILED |

### Flue依存バージョン（#40）

```
@flue/runtime: 1.0.0-beta.2 (exact)
@flue/cli: 1.0.0-beta.1 (exact)
```

## 既知の負債

- Flue run IDをai_runs.flue_run_idに保存していない（#42）
- stale run reconciliation未実装（#41）
- fallback使用をDBに記録していない（#60）
