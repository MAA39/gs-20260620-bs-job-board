# `packages/contracts` 現行仕様

> package: `@bs-job-board/contracts`
> runtime依存: なし
> entry: `src/index.ts`

## 責務

Web / API / DB間で共有するTypeScript型をexportする。

runtime validation、JSON schema、Effect Schema、Zod schemaは提供しない。すべてcompile-time型のみ。

## thread型

```ts
type ThreadStatus = 'open' | 'fixed';
type AuthorType = 'human' | 'ai';
type PostRole =
  | 'analyst'
  | 'structure'
  | 'transform'
  | 'comment'
  | 'thinking'
  | null;
```

### `Thread`

```ts
type Thread = {
  id: string;
  title: string;
  body: string;
  status: ThreadStatus;
  created_at: string;
};
```

D1には`reaction_count`も存在するが、基本`Thread`型には含まれない。Web側で交差型を追加して扱う。

### `Post`

```ts
type Post = {
  id: string;
  thread_id: string;
  post_number: number;
  author_type: AuthorType;
  author_name: string;
  role: PostRole;
  body: string;
  source_post_number: number | null;
  user_id: string | null;
  created_at: string;
};
```

現在の親子表現は`source_post_number`。post IDベースの`parent_post_id`はまだ型にない。

### `ThreadDetail`

```ts
type ThreadDetail = Thread & { posts: Post[] };
```

## input型

### `CreateThreadInput`

```ts
type CreateThreadInput = {
  title: string;
  body: string;
};
```

### `CreatePostInput`

```ts
type CreatePostInput = {
  author_type: AuthorType;
  author_name: string;
  role: PostRole;
  body: string;
  source_post_number?: number | null;
  user_id?: string | null;
};
```

`CreatePostInput`はserver-ownedであるべき値もclient inputとして公開している。

- author type
- author name
- role
- source relation
- user ID

APIは`user_id`をsession値/nullへ上書きするが、その他は現在client-controlled。

## API response型

```ts
type ApiError = { error: string };

type CreateThreadResponse = {
  id: string;
  title: string;
};

type CreatePostResponse = {
  id: string;
  post_number: number;
};
```

reaction、thread list、thread detail、auth、workflow receipt、AI runの共有response型は定義されていない。

## export

`src/index.ts`から以下をre-exportする。

- thread status / author / role
- Thread / Post / ThreadDetail
- CreateThreadInput / CreatePostInput
- ApiError / CreateThreadResponse / CreatePostResponse

## ビルド

```bash
pnpm --filter @bs-job-board/contracts typecheck
```

package単体の`build`、`test` scriptはない。

## 既知の差分・負債

- runtime validationなし
- server-owned fieldをinput型へ含めている
- `reaction_count`が基本Thread型にない
- reaction response型なし
- `parent_post_id`なし
- AI run / event / callback型なし
- APIとWebのresponse field差異を検出できない
- protocol version管理なし
