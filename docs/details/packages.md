# packages 詳細解説

`packages/`ディレクトリには、3つのWorkerが共有するコードを置く。
Worker間で型やロジックを共有しつつ、Workerのデプロイ単位とは独立にコードを管理できる。

```
packages/
├── db/           (2,065行) ← D1スキーマ + クエリ関数
├── contracts/    (113行)   ← API型定義（依存ゼロ）
├── agent/        (162行)   ← AIプロンプト + JSON解析
└── config/                 ← 共有tsconfig
```

## packages/db — D1スキーマとクエリ

D1（SQLite）のマイグレーションとクエリ関数を管理するパッケージ。
API Workerが直接importして使う。

### テーブル構成

8段階のマイグレーション（`0001_init.sql`〜`0008_ai_runs.sql`）で構築されたスキーマ。

```
threads          ← スレッド本体
posts            ← 人間投稿 + AI生成レス
user             ← Better Auth ユーザー
session          ← Better Auth セッション
account          ← Better Auth アカウント
verification     ← Better Auth 検証
user_reaction    ← リアクション記録
ai_runs          ← AI実行管理（状態機械）
ai_run_events    ← SSE配信用イベントログ
ai_run_posts     ← AI runと生成レスの紐付け
```

### ai_runsの状態機械（ADR-004）

`status`カラムにCHECK制約で6つの状態を定義している。

```sql
status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
  'queued', 'admitted', 'generating', 'repairing', 'completed', 'failed'
))
```

遷移ルール:
- `queued → admitted`: API WorkerがAgent Workerへdispatch時
- `admitted → generating`: Agent WorkerがAI呼び出し開始時
- `generating → repairing`: validation失敗でrepair開始時
- `generating/repairing → completed`: 生成成功時
- 任意の非terminal → `failed`: エラー発生時
- `completed`/`failed`からの遷移は禁止

### 冪等性

`idempotency_key`（SHA-256）で同一のAI実行要求を識別する。
`result_hash`で生成結果の重複を検知する。

`completeRunAtomic`は、同一hashの二重完了をエラーではなく`duplicate: true`として返す。
異なるhashでの二重完了はDbConflictErrorを投げる。

### D1抽象化

`D1DatabaseClient`型でD1のインターフェースを抽象化している。
テストではFakeDbを注入し、D1なしで状態遷移や冪等性を検証できる。

```typescript
export type D1DatabaseClient = {
  prepare: (query: string) => D1PreparedStatementLike;
  batch: (statements) => Promise<D1BatchResultLike[]>;
};
```

### 主要ファイル

| ファイル | 役割 |
|---|---|
| `src/queries.ts` | スレッドCRUD（listThreadsSorted, getThreadDetail, toggleReaction） |
| `src/ai-pipeline.ts` | AI run lifecycle。原子的作成、状態遷移、冪等complete、failRun |
| `src/types.ts` | 型定義。AiRunStatus、AiRunRow、Command入出力型、Error型 |
| `migrations/*.sql` | D1マイグレーション（8段階） |

### テスト

`ai-pipeline.integration.test.ts`で183行のテストを実行。
状態遷移の正当性、不正な遷移の拒否、冪等complete、batch失敗時のロールバックを検証。

## packages/contracts — API型定義

Worker間の型契約を定義するパッケージ。
外部依存がゼロで、全Workerからimportできる。

### 主要な型

**Thread/Post**: スレッドと投稿のデータ型。
`AuthorType`は`'human' | 'ai'`。
`PostRole`は`'analyst' | 'structure' | 'transform' | 'comment' | 'thinking' | null`。

**PublicAiRunEvent**: SSEで配信するイベント型（allow-list済み）。

```typescript
export type PublicAiRunEvent =
  | { status: 'queued' | 'admitted' | 'generating' | 'repairing' }
  | { status: 'completed'; post_ids: readonly string[] }
  | { status: 'failed'; error_code: PublicAiErrorCode };
```

**AiRunProgress**: Web WorkerのSSE Hook内部状態。
SSEの接続状態（connecting/reconnecting/connection_failed）とAI runの状態を統合した型。

**PublicAiErrorCode**: 公開エラーコードのallow-list。
ランタイム配列（`as const`）から型を導出し、type guardを提供する。

```typescript
export const PUBLIC_AI_ERROR_CODES = [ ... ] as const;
export type PublicAiErrorCode = (typeof PUBLIC_AI_ERROR_CODES)[number];
export function isPublicAiErrorCode(value: unknown): value is PublicAiErrorCode { ... }
```

## packages/agent — 共有AIロジック

SYSTEM_PROMPTの定義とプロンプト組み立て関数を提供する。

初期のアーキテクチャでは、API WorkerがこのパッケージのgenerateReplies()を直接呼び出してさくらAI Engineを叩いていた。
Agent Worker（Flue）に移行した後も、SYSTEM_PROMPTやプロンプト組み立てのロジックはここに残っている。

Agent Workerの`generate-replies.ts`は独自のSYSTEM_PROMPTとprompt builderを持っており、このパッケージの関数は現在では使われていない。
整理候補として残っている。

### 主要な関数

**buildReplyPrompt**: スレッドタイトル、直近投稿、返信対象からプロンプト文字列を組み立てる。

**generateReplies**: さくらAI Engineにfetch → JSON parse → フォールバック行分割の2段構えでレスを抽出する。初期実装で使っていた関数。

**assignAnchors/applyAnchors**: レスに対するアンカー（`>>番号`）を確率的に割り当てる。現在のAgent Worker側では使っていない。

## packages/config — 共有tsconfig

`tsconfig.base.json`を提供する。
各Workerとパッケージのtsconfigがこれをextendsする。
