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
  // UNIQUE(thread_id, post_number) 制約があるため、重複時はリトライ
  for (let attempt = 0; attempt < 5; attempt++) {
    const postId = crypto.randomUUID();

    const lastPost = await db.prepare(
      'SELECT MAX(post_number) as max_num FROM posts WHERE thread_id = ?'
    ).bind(threadId).first<{ max_num: number | null }>();

    const postNumber = (lastPost?.max_num ?? 0) + 1;

    try {
      await db.prepare(
        'INSERT INTO posts (id, thread_id, post_number, author_type, author_name, role, body, source_post_number, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(postId, threadId, postNumber, input.author_type, input.author_name, input.role, input.body, input.source_post_number ?? null, input.user_id ?? null).run();

      return { postId, postNumber };
    } catch (err) {
      // UNIQUE制約違反の場合リトライ
      if (attempt === 4) throw err;
    }
  }
  throw new Error('Failed to assign post_number after 5 retries');
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

/** わかる！+1 */
export async function incrementReaction(
  db: D1Database,
  threadId: string,
): Promise<number> {
  await db.prepare(
    'UPDATE threads SET reaction_count = reaction_count + 1 WHERE id = ?'
  ).bind(threadId).run();
  const row = await db.prepare(
    'SELECT reaction_count FROM threads WHERE id = ?'
  ).bind(threadId).first<{ reaction_count: number }>();
  return row?.reaction_count ?? 0;
}

/** スレッド一覧（ソート対応） */
export async function listThreadsSorted(
  db: D1Database,
  sort: 'new' | 'hot' = 'new',
): Promise<(Thread & { reaction_count: number })[]> {
  const orderBy = sort === 'hot'
    ? 'reaction_count DESC, created_at DESC'
    : 'created_at DESC';
  const result = await db.prepare(
    `SELECT * FROM threads ORDER BY ${orderBy}`
  ).all<Thread & { reaction_count: number }>();
  return result.results;
}

/** わかる！（重複防止: 1ユーザー1スレッド1回） */
export async function toggleReaction(
  db: D1Database,
  threadId: string,
  userId: string,
): Promise<{ reacted: boolean; count: number }> {
  const existing = await db.prepare(
    'SELECT id FROM reactions WHERE thread_id = ? AND user_id = ?'
  ).bind(threadId, userId).first();

  if (existing) {
    // 既にリアクション済み → 取り消し
    await db.batch([
      db.prepare('DELETE FROM reactions WHERE thread_id = ? AND user_id = ?').bind(threadId, userId),
      db.prepare('UPDATE threads SET reaction_count = MAX(0, reaction_count - 1) WHERE id = ?').bind(threadId),
    ]);
    const row = await db.prepare('SELECT reaction_count FROM threads WHERE id = ?').bind(threadId).first<{ reaction_count: number }>();
    return { reacted: false, count: row?.reaction_count ?? 0 };
  } else {
    // 新規リアクション
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare('INSERT INTO reactions (id, thread_id, user_id) VALUES (?, ?, ?)').bind(id, threadId, userId),
      db.prepare('UPDATE threads SET reaction_count = reaction_count + 1 WHERE id = ?').bind(threadId),
    ]);
    const row = await db.prepare('SELECT reaction_count FROM threads WHERE id = ?').bind(threadId).first<{ reaction_count: number }>();
    return { reacted: true, count: row?.reaction_count ?? 0 };
  }
}
