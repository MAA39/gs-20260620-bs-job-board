import { Hono } from 'hono';
import type { CreateThreadInput, CreatePostInput } from '@bs-job-board/contracts';
import {
  listThreadsSorted,
  getThreadDetail,
  createThread,
  addPost,
  updateThreadStatus,
  toggleReaction,
} from '@bs-job-board/db';
import { generateReplies, assignAnchors, applyAnchors } from '@bs-job-board/agent';

type Bindings = {
  DB: D1Database;
  SAKURA_API_TOKEN: string;
};

async function dispatchAiReplies(
  db: D1Database,
  sakuraToken: string,
  threadId: string,
  threadTitle: string,
  targetBody: string,
  targetPostNumber: number,
) {
  const existingPosts = await db.prepare(
    'SELECT post_number, author_name, body, author_type FROM posts WHERE thread_id = ? ORDER BY post_number ASC'
  ).bind(threadId).all<{ post_number: number; author_name: string; body: string; author_type: string }>();

  const recentPosts = existingPosts.results.map((p) => ({
    number: p.post_number,
    authorName: p.author_name,
    body: p.body,
    authorType: p.author_type,
  }));

  const replyCount = 3 + Math.floor(Math.random() * 4); // 3〜6件

  const result = await generateReplies({
    threadTitle,
    targetBody,
    recentPosts,
    replyCount,
    sakuraApiToken: sakuraToken,
  });

  // アンカー割り当て + レス保存
  const existingNumbers = recentPosts.map((p) => p.number);
  const anchors = assignAnchors(targetPostNumber, existingNumbers, result.replies.length);
  const repliesWithAnchors = applyAnchors(result.replies, anchors);

  for (const reply of repliesWithAnchors) {
    await addPost(db, threadId, {
      author_type: 'ai',
      author_name: '名無しさん@AI',
      role: null,
      body: reply,
    });
  }

  // Thinkingを最後のpostとして保存（思考過程の可視化）
  if (result.thinking) {
    await addPost(db, threadId, {
      author_type: 'ai',
      author_name: '🤔 AIの思考',
      role: 'thinking',
      body: result.thinking,
    });
  }
}

export const threadRoutes = new Hono<{ Bindings: Bindings }>()

  .get('/', async (c) => {
    const sort = (c.req.query('sort') ?? 'new') as 'new' | 'hot';
    const threads = await listThreadsSorted(c.env.DB, sort);
    return c.json(threads);
  })

  .get('/:id', async (c) => {
    const detail = await getThreadDetail(c.env.DB, c.req.param('id'));
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  })

  .post('/', async (c) => {
    const input = await c.req.json<CreateThreadInput>();
    const { threadId } = await createThread(c.env.DB, input);

    if (c.env.SAKURA_API_TOKEN) {
      c.executionCtx.waitUntil(
        dispatchAiReplies(
          c.env.DB, c.env.SAKURA_API_TOKEN,
          threadId, input.title, input.body, 1,
        ).catch((err) => console.error('AI reply failed:', err))
      );
    }

    return c.json({ id: threadId, title: input.title }, 201);
  })

  .post('/:id/posts', async (c) => {
    const threadId = c.req.param('id');
    const input = await c.req.json<CreatePostInput>();
    const { postId, postNumber } = await addPost(c.env.DB, threadId, input);

    if (input.author_type === 'human' && c.env.SAKURA_API_TOKEN) {
      const thread = await c.env.DB.prepare(
        'SELECT title FROM threads WHERE id = ?'
      ).bind(threadId).first<{ title: string }>();

      if (thread) {
        c.executionCtx.waitUntil(
          dispatchAiReplies(
            c.env.DB, c.env.SAKURA_API_TOKEN,
            threadId, thread.title, input.body, postNumber,
          ).catch((err) => console.error('AI reply failed:', err))
        );
      }
    }

    return c.json({ id: postId, post_number: postNumber }, 201);
  })

  .post('/:id/react', async (c) => {
    const threadId = c.req.param('id');
    const { userId } = await c.req.json<{ userId: string }>();
    if (!userId) return c.json({ error: 'userId required' }, 400);
    const result = await toggleReaction(c.env.DB, threadId, userId);
    return c.json(result);
  })

  .patch('/:id', async (c) => {
    const threadId = c.req.param('id');
    const { status } = await c.req.json<{ status: 'open' | 'fixed' }>();
    await updateThreadStatus(c.env.DB, threadId, status);
    return c.json({ id: threadId, status });
  });
