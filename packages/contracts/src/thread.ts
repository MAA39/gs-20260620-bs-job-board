/** スレッドの公開状態 */
export type ThreadStatus = 'open' | 'fixed';

/** 投稿者の種別 */
export type AuthorType = 'human' | 'ai';

/** AI分析レスの役割。人間コメントはnull */
export type PostRole = 'analyst' | 'structure' | 'transform' | 'comment' | null;

/** threads テーブルの行 */
export type Thread = {
  id: string;
  title: string;
  body: string;
  status: ThreadStatus;
  created_at: string;
};

/** posts テーブルの行 */
export type Post = {
  id: string;
  thread_id: string;
  post_number: number;
  author_type: AuthorType;
  author_name: string;
  role: PostRole;
  body: string;
  created_at: string;
};

/** スレッド詳細（posts込み） */
export type ThreadDetail = Thread & {
  posts: Post[];
};

/** スレッド作成の入力 */
export type CreateThreadInput = {
  title: string;
  body: string;
};

/** レス作成の入力 */
export type CreatePostInput = {
  author_type: AuthorType;
  author_name: string;
  role: PostRole;
  body: string;
};
