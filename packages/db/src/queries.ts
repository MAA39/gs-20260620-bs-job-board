import type {
  Thread,
  Post,
  ThreadDetail,
  CreateThreadInput,
  CreatePostInput,
} from '@bs-job-board/contracts';

/** スレッド一覧を新着順で取得 */
export async function listThreads(db: D1Database): Promise<Thread[]> {
  const result = await db.prepare(
    'SELECT * FROM threads ORDER BY created_at DESC'
  ).all<Thread>();
  return result.results;
}

/** スレッド詳細（posts込み）を取得 */
export async function getThreadDetail(
  db: D1Database,
  threadId: string,
): Promise<ThreadDetail | null> {
  const thread = await db.prepare(
    'SELECT * FROM threads WHERE id = ?'
  ).bind(threadId).first<Thread>();

  if (!thread) return null;

  const posts = await db.prepare(
    'SELECT * FROM posts WHERE thread_id = ? ORDER BY post_number ASC'
  ).bind(threadId).all<Post>();

  return { ...thread, posts: posts.results };
}

/** スレッド作成（最初のpostも同時に作る） */
export async function createThread(
  db: D1Database,
  input: CreateThreadInput,
): Promise<{ threadId: string; firstPostId: string }> {
  const threadId = crypto.randomUUID();
  const firstPostId = crypto.randomUUID();

  await db.batch([
    db.prepare(
      'INSERT INTO threads (id, title, body) VALUES (?, ?, ?)'
    ).bind(threadId, input.title, input.body),
    db.prepare(
      'INSERT INTO posts (id, thread_id, post_number, author_type, author_name, body) VALUES (?, ?, 1, ?, ?, ?)'
    ).bind(firstPostId, threadId, 'human', '名無しさん', input.body),
  ]);

  return { threadId, firstPostId };
}

/** レス追加（post_number自動採番） */
export async function addPost(
  db: D1Database,
  threadId: string,
  input: CreatePostInput,
): Promise<{ postId: string; postNumber: number }> {
  const postId = crypto.randomUUID();

  const lastPost = await db.prepare(
    'SELECT MAX(post_number) as max_num FROM posts WHERE thread_id = ?'
  ).bind(threadId).first<{ max_num: number | null }>();

  const postNumber = (lastPost?.max_num ?? 0) + 1;

  await db.prepare(
    'INSERT INTO posts (id, thread_id, post_number, author_type, author_name, role, body) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(postId, threadId, postNumber, input.author_type, input.author_name, input.role, input.body).run();

  return { postId, postNumber };
}

/** スレッドのステータスを更新 */
export async function updateThreadStatus(
  db: D1Database,
  threadId: string,
  status: 'open' | 'fixed',
): Promise<void> {
  await db.prepare(
    'UPDATE threads SET status = ? WHERE id = ?'
  ).bind(status, threadId).run();
}
