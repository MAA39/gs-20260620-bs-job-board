import { Hono } from 'hono';
import type { CreateThreadInput, CreatePostInput } from '@bs-job-board/contracts';
import {
  listThreadsSorted,
  getThreadDetail,
  createThread,
  addPost,
  updateThreadStatus,
  incrementReaction,
} from '@bs-job-board/db';
import { generateDeepDiveQuestion, parseAnalysisResponse } from '@bs-job-board/agent';

type Bindings = {
  DB: D1Database;
  AGENT: Fetcher;
  SAKURA_API_TOKEN: string;
};

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

    // AI深掘り分析を非同期で実行
    if (c.env.SAKURA_API_TOKEN) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const raw = await generateDeepDiveQuestion(
              input.title,
              input.body,
              c.env.SAKURA_API_TOKEN,
            );
            const posts = parseAnalysisResponse(raw);
            for (const post of posts) {
              await addPost(c.env.DB, threadId, {
                author_type: 'ai',
                author_name: post.authorName,
                role: post.role as CreatePostInput['role'],
                body: post.body,
              });
            }
          } catch (err) {
            console.error('AI analysis failed:', err);
          }
        })()
      );
    }

    return c.json({ id: threadId, title: input.title }, 201);
  })

  .post('/:id/posts', async (c) => {
    const threadId = c.req.param('id');
    const input = await c.req.json<CreatePostInput>();
    const { postId, postNumber } = await addPost(c.env.DB, threadId, input);
    return c.json({ id: postId, post_number: postNumber }, 201);
  })

  .post('/:id/react', async (c) => {
    const threadId = c.req.param('id');
    const count = await incrementReaction(c.env.DB, threadId);
    return c.json({ reaction_count: count });
  })

  .patch('/:id', async (c) => {
    const threadId = c.req.param('id');
    const { status } = await c.req.json<{ status: 'open' | 'fixed' }>();
    await updateThreadStatus(c.env.DB, threadId, status);
    return c.json({ id: threadId, status });
  });
