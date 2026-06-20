import { Hono } from 'hono';
import type { CreateThreadInput, CreatePostInput } from '@bs-job-board/contracts';
import {
  listThreads,
  getThreadDetail,
  createThread,
  addPost,
  updateThreadStatus,
} from '@bs-job-board/db';

type Bindings = {
  DB: D1Database;
  AGENT: Fetcher; // Service Binding to agent Worker
};

export const threadRoutes = new Hono<{ Bindings: Bindings }>()

  // スレッド一覧
  .get('/', async (c) => {
    const threads = await listThreads(c.env.DB);
    return c.json(threads);
  })

  // スレッド詳細（posts込み）
  .get('/:id', async (c) => {
    const detail = await getThreadDetail(c.env.DB, c.req.param('id'));
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  })

  // スレッド作成 → agent にAI分析を非同期依頼
  .post('/', async (c) => {
    const input = await c.req.json<CreateThreadInput>();
    const { threadId } = await createThread(c.env.DB, input);

    // agent Worker に分析依頼（非同期、レスポンスは待たない）
    c.executionCtx.waitUntil(
      c.env.AGENT.fetch(new Request('https://agent/dispatch-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, title: input.title, body: input.body }),
      })).catch((err) => console.error('Agent dispatch failed:', err))
    );

    return c.json({ id: threadId, title: input.title }, 201);
  })

  // レス追加（人間コメント or AI分析レス）
  .post('/:id/posts', async (c) => {
    const threadId = c.req.param('id');
    const input = await c.req.json<CreatePostInput>();
    const { postId, postNumber } = await addPost(c.env.DB, threadId, input);
    return c.json({ id: postId, post_number: postNumber }, 201);
  })

  // スレッドステータス更新（Fix/確定）
  .patch('/:id', async (c) => {
    const threadId = c.req.param('id');
    const { status } = await c.req.json<{ status: 'open' | 'fixed' }>();
    await updateThreadStatus(c.env.DB, threadId, status);
    return c.json({ id: threadId, status });
  });
