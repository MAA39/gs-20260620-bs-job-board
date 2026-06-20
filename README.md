# ブルシット・ジョブ解体掲示板

G's Academy福岡19期DEVコース課題「アンケートアプリ（登録・表示）」。  
ブルシット・ジョブを投稿すると、AIが多角的に分析して整理してくれる掲示板。

## アーキテクチャ

3 Workers 完全分離型モノレポ。

```
apps/web    → CF Worker #1: TanStack Start SSR（UI描画）
apps/api    → CF Worker #2: Hono API（D1 holder、データの正本管理）
apps/agent  → CF Worker #3: Flue Agent（AI分析処理）
```

### データフロー

```
① web → api:   POST /api/v1/threads（スレッド作成）
② api → agent: POST /dispatch-analysis（AI分析依頼、非同期）
③ agent:       Flue Agent が さくらAI で分析レス生成
④ agent → api: POST /api/v1/threads/:id/posts（tool経由でAIレス保存）
⑤ web → api:   GET /api/v1/threads/:id（一覧+AIレス取得）
```

### packages

| パッケージ | 責務 |
|---|---|
| `packages/contracts` | 共有型定義（Thread, Post, API types）。依存ゼロ |
| `packages/db` | D1マイグレーション + CRUDクエリ関数 |
| `packages/config` | 共有 tsconfig |

## セットアップ

```bash
pnpm install
```

### D1データベース作成

```bash
cd apps/api
npx wrangler d1 create bs-job-board-db
# 出力された database_id を wrangler.jsonc に反映
npx wrangler d1 migrations apply bs-job-board-db --local
```

### 開発

```bash
# 全体（turbo）
pnpm dev

# 個別
cd apps/api && pnpm dev      # localhost:8787
cd apps/web && pnpm dev      # localhost:5173
cd apps/agent && pnpm dev    # localhost:3583
```

### デプロイ

```bash
cd apps/api && pnpm deploy
cd apps/web && pnpm deploy
```

## 技術スタック

- **フロント**: TanStack Start (SSR) on Cloudflare Workers
- **API**: Hono on Cloudflare Workers
- **DB**: Cloudflare D1 (SQLite)
- **AI**: Flue Framework Agent + さくらAI Engine (gpt-oss-120b)
- **モノレポ**: Turborepo + pnpm workspaces

## 知識配置（Zenn記事準拠）

| 知識の種類 | 配置先 |
|---|---|
| How（どう動くか） | コード（型、命名） |
| What（何をすべきか） | テスト名 |
| Why / Why not | Linear ADR |

## 関連リンク

- [Linear プロジェクト](https://linear.app/100days100prd/project/ブルシットジョブ解体掲示板-0a51388bf751)
- [ADR-001: 技術選定](https://linear.app/100days100prd/document/adr-001-技術選定-cf-workers-tanstack-start-hono-d1-flue-baa3151180a1)

## 残タスク

### [Bug] UIグルーピング表示の修正
- post_number重複（race condition対策）
- thinkingが人間コメント直上に出るケースの修正
- AIレスのインデント明確化
- 既存データ（source_post_number null）のグルーピング安定化

### [Phase2] Better Auth — GS-9
- GitHub OAuth App設定（PCから）
- 匿名ログイン + GitHubログイン
- 投稿時のダイアログUI

### [Enhancement] スレッド上部にAI概要表示
- 対話が進んだ後にCBTカード的な概要を生成
- aimani-chat の CbtCardArtifact 構造を参考
