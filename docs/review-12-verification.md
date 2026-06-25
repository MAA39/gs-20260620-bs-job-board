# #12 SSE レビュー裏どり結果（2026-06-25）

## 結論: 全8件すべて正しい

---

## 高1: terminal表示消失 ✅ 正しい

**証拠:**
- `threads.$id.tsx:77-81`: `progress.status === 'completed' || 'failed'` → `setAiRunId(null)`
- `use-ai-run-progress.ts:39-41`: `!aiRunId` → `setProgress({ status: 'idle' })`

**再現フロー:**
```
failed → setProgress(failed) → setAiRunId(null) → useEffect発火 → setProgress(idle)
```

結果: ユーザーにはfailedが一瞬表示→即座にidleで消える。completedも同様。

**修正方針:** `threads.$id.tsx:76-81` のuseEffect削除。hookは内部でsource.close()済み。aiRunIdをnullにせず保持すれば、useEffectのcleanupのみでEventSourceを正しく閉じる。新しいコメント投稿時は`setAiRunId(newId)`で依存変更→cleanup→新規EventSource。

---

## 高2: reconnecting復元失敗 ✅ 正しい

**証拠:**
- `use-ai-run-progress.ts:80-81`:
  ```js
  prev.status === 'reconnecting' ? { ...prev, status: prev.status } : prev
  ```
- `prev.status` が `'reconnecting'` のとき `{ ...prev, status: 'reconnecting' }` を返す。同値代入。

**修正方針:** lastDomainStatusをrefで保持。

```ts
const lastRunStatusRef = useRef<string>('connecting');

// handleEvent内:
if (parsed.status !== 'completed' && parsed.status !== 'failed') {
  lastRunStatusRef.current = parsed.status;
}
setProgress({ status: parsed.status, ... });

// onopen内:
source.onopen = () => {
  setProgress((prev) =>
    prev.status === 'reconnecting'
      ? { ...prev, status: lastRunStatusRef.current as AiRunProgress['status'] }
      : prev,
  );
};
```

---

## 高3: 壊れたJSON rowで永久再接続 ✅ 正しい

**証拠:**
- `ai-run-events.ts:42-49`:
  ```js
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(dataJson); } catch { return null; }
  const status = parsed.status as AiRunStatus | undefined;
  ```
- `JSON.parse('null')` → `null`。TS型は`Record<string, unknown>`だがランタイムは`null`
- `null.status` → TypeError（try/catch外）
- stream callback内にtry/catchなし → Honoがstreamを閉じる → EventSource再接続 → 同じrow → 永久ループ

**修正方針:** JSON.parse後にisRecord()チェック追加。

```ts
try {
  const raw = JSON.parse(dataJson);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  parsed = raw as Record<string, unknown>;
} catch {
  return null;
}
```

---

## 中4: 公開allow-list不完全 ✅ 正しい

**証拠:**
- `ai-run-events.ts:38`: `eventType: string` 引数を受け取るが一切使用していない
- `ai-run-events.ts:49-50`: `parsed.status`のみで判定。`eventType`と`status`の整合チェックなし
- `ai-run-events.ts:61-63`: `error_code`は`typeof === 'string'`のみ。内部callbackの`ALLOWED_ERROR_CODES`と独立
- `ai-run-events.ts:63`: missing時は`'UNKNOWN_ERROR'`（contractsで未定義の定数）

**修正方針:**
1. `eventType`と`status`の整合チェック（`eventType='status'`なのに`status='failed'`なら不整合）
2. `PublicAiErrorCode`をunion化してallow-list検証
3. contractsの`PublicAiRunEvent`に`error_code`型をunionで定義

---

## 中5: stream例外処理なし ✅ 正しい

**証拠:**
- `ai-run-events.ts:123-184`: `streamSSE(c, async (stream) => { ... })` 内にtry/catchなし
- D1 queryエラー（`listAiRunEventsAfter`行131）やmapper例外がHonoに任される
- Honoの`onError`が`e.message`を出力する可能性 → 内部メッセージ漏えい

**修正方針:** stream callback全体をtry/catch。

```ts
return streamSSE(c, async (stream) => {
  try {
    // ... existing loop
  } catch (error) {
    if (!stream.aborted) {
      console.error('ai-run SSE failed', {
        aiRunId,
        name: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
});
```

---

## 中6: テストACカバレッジ不足 ✅ 正しい

**未検証テスト項目:**
- heartbeat（15秒待つテストが必要）
- connection lifetime（MAX_POLLS到達）
- abort後のpoll停止
- malformed rowとcursor更新
- stream中のD1 error安全処理
- failed eventからraw message除外の証明
- Web hookのstatus・reconnect・unmount・投稿非再実行

**既存テストの弱点:**
- precedence test: `events.length === 0`でも成功する（weak assertion）
- allow-list test: seedにprompt/error_messageが最初から入っていない（除去の証明ではない）
- read-only test: run件数のみ比較（status更新やdispatch不在の証明不足）

---

## 中7: 共有contract不整合 ✅ 正しい

**証拠:**
1. `ai-run-events.ts:16-19`: `PublicAiRunEvent`をローカルで再定義。`@bs-job-board/contracts`からimportしていない
2. `contracts/src/api.ts`: `CreateThreadResponse = { id: string; title: string }` → `ai_run`がない
3. `contracts/src/api.ts`: `CreatePostResponse = { id: string; post_number: number }` → `ai_run`がない
4. Web側: 独自cast `as { id: string; ai_run: { id: string } }`（index.tsx:30, threads.$id.tsx:35）

**修正方針:**
1. API SSE routeで`@bs-job-board/contracts`から`PublicAiRunEvent`をimport
2. `CreateThreadResponse`に`ai_run: { id: string }`を追加
3. `CreatePostResponse`に`ai_run: { id: string }`を追加
4. Web側の独自castを共有型に置き換え

---

## 低8: idだけ進めるframeの空messageイベント発火 ✅ 正しい

**証拠:**
- `ai-run-events.ts:163`: `await stream.writeSSE({ id: String(event.sequence), data: '' })`
- Honoの`writeSSE`は`data:`行を出力 → WHATWG上、空文字dataのmessageイベントが発火する
- コメント（行148-149）「data なし frame → Last-Event-ID 更新、イベント未発火」は不正確

**修正方針:** `stream.write(`id: ${event.sequence}\n\n`)` で本当にIDだけ更新。
