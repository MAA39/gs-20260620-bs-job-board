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
import { getSessionUser } from '../auth.ts';

type Bindings = {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  AGENT: { fetch: typeof fetch };
};

async function dispatchAiReplies(
  agent: { fetch: typeof fetch },
  threadId: string,
  threadTitle: string,
  targetBody: string,
  targetPostNumber: number,
): Promise<void> {
  const response = await agent.fetch(
    new Request('http://agent/workflows/generate-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, threadTitle, targetBody, targetPostNumber }),
    }),
  );

  try {
    if (!response.ok) throw new Error(`Workflow dispatch failed with ${response.status}`);
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

function logDispatchFailure(error: unknown): void {
  if (error instanceof Error) {
    console.error('AI workflow dispatch failed', {
      name: error.name,
      message: error.message,
    });
    return;
  }
  console.error('AI workflow dispatch failed', { name: 'UnknownError' });
}

export const threadRoutes = new Hono<{ Bindings: Bindings }>()
  .get('/', async (context) => {
    const sort = (context.req.query('sort') ?? 'new') as 'new' | 'hot';
    return context.json(await listThreadsSorted(context.env.DB, sort));
  })
  .get('/:id', async (context) => {
    const detail = await getThreadDetail(context.env.DB, context.req.param('id'));
    if (!detail) return context.json({ error: 'not found' }, 404);
    return context.json(detail);
  })
  .post('/', async (context) => {
    const input = await context.req.json<CreateThreadInput>();
    const { threadId } = await createThread(context.env.DB, input);
    context.executionCtx.waitUntil(
      dispatchAiReplies(context.env.AGENT, threadId, input.title, input.body, 1)
        .catch(logDispatchFailure),
    );
    return context.json({ id: threadId, title: input.title }, 201);
  })
  .post('/:id/posts', async (context) => {
    const threadId = context.req.param('id');
    const input = await context.req.json<CreatePostInput>();
    const sessionUser = await getSessionUser(
      context.env.DB,
      context.env.BETTER_AUTH_SECRET || '',
      new URL(context.req.url).origin,
      context.req.raw,
    );
    const enrichedInput = {
      ...input,
      user_id: sessionUser?.id ?? null,
      author_name:
        sessionUser?.name && sessionUser.name !== 'Anonymous'
          ? sessionUser.name
          : input.author_name,
    };
    const { postId, postNumber } = await addPost(context.env.DB, threadId, enrichedInput);

    if (input.author_type === 'human') {
      const thread = await context.env.DB
        .prepare('SELECT title FROM threads WHERE id = ?')
        .bind(threadId)
        .first<{ title: string }>();
      if (thread) {
        context.executionCtx.waitUntil(
          dispatchAiReplies(
            context.env.AGENT,
            threadId,
            thread.title,
            input.body,
            postNumber,
          ).catch(logDispatchFailure),
        );
      }
    }

    return context.json({ id: postId, post_number: postNumber }, 201);
  })
  .post('/:id/react', async (context) => {
    const threadId = context.req.param('id');
    const { userId } = await context.req.json<{ userId: string }>();
    if (!userId) return context.json({ error: 'userId required' }, 400);
    return context.json(await toggleReaction(context.env.DB, threadId, userId));
  })
  .patch('/:id', async (context) => {
    const threadId = context.req.param('id');
    const { status } = await context.req.json<{ status: 'open' | 'fixed' }>();
    await updateThreadStatus(context.env.DB, threadId, status);
    return context.json({ id: threadId, status });
  });
