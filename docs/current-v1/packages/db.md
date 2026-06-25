# `packages/db` 現行仕様

> package: `@bs-job-board/db`
> database: Cloudflare D1 / SQLite
> entry: `src/index.ts`

## 責務

- application D1 migrationの保管
- thread / post / reaction query関数
- API Workerから利用されるD1操作

現行packageはCloudflareのglobal `D1Database`型へ直接依存する。DB client abstractionやtransaction command layerはまだない。Agent Workerはこのpackageを使わず、workflow内でD1 SQLを直接実行する。

## migration一覧

### `0001_init.sql`

#### `threads`

```text
id          TEXT PRIMARY KEY
title       TEXT NOT NULL
body        TEXT NOT NULL
status      TEXT NOT NULL DEFAULT 'open'
created_at  TEXT NOT NULL DEFAULT datetime('now')
```

statusのCHECK制約はない。

#### `posts`

```text
id           TEXT PRIMARY KEY
thread_id    TEXT NOT NULL REFERENCES threads(id)
post_number  INTEGER NOT NULL
author_type  TEXT NOT NULL
author_name  TEXT NOT NULL
role         TEXT
body         TEXT NOT NULL
created_at   TEXT NOT NULL DEFAULT datetime('now')
```

index:

```text
idx_posts_thread(thread_id, post_number)
```

### `0002_add_reactions.sql`

`threads.reaction_count INTEGER NOT NULL DEFAULT 0`を追加。

### `0003_user_reactions.sql`

#### `reactions`

```text
id          TEXT PRIMARY KEY
thread_id   TEXT NOT NULL REFERENCES threads(id)
user_id     TEXT NOT NULL
created_at  TEXT NOT NULL DEFAULT datetime('now')
UNIQUE(thread_id, user_id)
```

### `0004_source_post.sql`

`posts.source_post_number INTEGER`を追加。

post IDへのforeign keyではなく、同じthread内の表示番号を参照する想定。

### `0005_better_auth.sql`

Better Auth用の以下4tableを追加。

- `user`
- `session`
- `account`
- `verification`

Better Auth schemaのcolumn名はcamelCase。

### `0006_user_id.sql`

`posts.user_id TEXT REFERENCES "user"(id)`を追加。

### `0007_unique_post_number.sql`

```text
UNIQUE INDEX posts(thread_id, post_number)
```

post number競合防止。

## 現在の実質schema

### threads

```text
id
title
body
status
created_at
reaction_count
```

### posts

```text
id
thread_id
post_number
author_type
author_name
role
body
created_at
source_post_number
user_id
```

`parent_post_id`、viewpoint、public reasoning、AI run linkはない。

## query API

`src/index.ts`から8関数をexportする。

### `listThreads(db)`

- 全thread
- `created_at DESC`
- 現行API routeでは使用せず、`listThreadsSorted`を使用

### `listThreadsSorted(db, sort)`

- `new`: `created_at DESC`
- `hot`: `reaction_count DESC, created_at DESC`
- `Thread & { reaction_count: number }[]`

### `getThreadDetail(db, threadId)`

1. threadをIDで取得
2. postsを`post_number ASC`で全件取得
3. threadがなければnull

paginationや非公開role除外はない。

### `createThread(db, input)`

UUIDを2つ生成し、D1 `batch()`で以下を保存する。

1. thread
2. human initial post (`post_number=1`, `author_name='名無しさん'`)

返却:

```ts
{
  threadId: string;
  firstPostId: string;
}
```

owner/user ID、role、source relationは保存しない。

### `addPost(db, threadId, input)`

1. `MAX(post_number)`をSELECT
2. +1を次の番号とする
3. post INSERT
4. error時に最大5回再実行

保存値は`CreatePostInput`をほぼそのまま使用する。

現在のcatchはunique conflictかどうかを判定せず、**任意のINSERT errorを5回目までretryする**。

`SELECT MAX`とINSERTは単一transactionではない。unique indexとretryで競合を吸収する。

### `updateThreadStatus(db, threadId, status)`

statusをUPDATEする。affected row確認やowner検証はない。

### `incrementReaction(db, threadId)`

reaction countを無条件+1し、最新countを返す。現在のAPI routeでは使用しない。

### `toggleReaction(db, threadId, userId)`

1. reactionsで存在確認
2. 存在時: reaction DELETE + count -1をbatch
3. 非存在時: reaction INSERT + count +1をbatch
4. countを再取得

返却:

```ts
{
  reacted: boolean;
  count: number;
}
```

存在確認とbatchの間はatomicではないため、同じuser/threadの同時toggleでraceし得る。unique制約errorの明示処理はない。

## package export

```json
{
  ".": "./src/index.ts",
  "./migrations/*": "./migrations/*"
}
```

## test / build

現在のscript:

```bash
pnpm --filter @bs-job-board/db typecheck
```

以下はまだない。

- build script
- unit test
- D1 integration test
- migration test

## 現在の利用者

```text
API Worker
  list / detail / create / add / status / reaction

Agent Worker
  package関数は使わず、workflow内でD1 SQLを直接実行
```

AgentのSQLがpackageへ集約されていない。

## 既知の差分・負債

- `ai_runs` / `ai_run_events` / `ai_run_posts`なし
- DB command/state transition layerなし
- Agentがpackage外でD1へ直接SQL
- post parentがnumber参照
- status / author / roleのDB CHECK制約なし
- addPostが全errorをretry
- reaction toggleのlookupとwriteが分離
- paginationなし
- thread / post input validationなし
- migration integration testなし
- cascade方針がtable間で統一されていない
- application tableとBetter Auth tableでcolumn命名規則が混在
