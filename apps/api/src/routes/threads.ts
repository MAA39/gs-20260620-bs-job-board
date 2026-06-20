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
  })

  // SSEストリーミング: AIレス生成をリアルタイムで返す
  .post('/:id/ai-stream', async (c) => {
    const threadId = c.req.param('id');
    const thread = await c.env.DB.prepare('SELECT title FROM threads WHERE id = ?').bind(threadId).first<{ title: string }>();
    if (!thread) return c.json({ error: 'not found' }, 404);

    const existingPosts = await c.env.DB.prepare(
      'SELECT post_number, author_name, body, author_type FROM posts WHERE thread_id = ? ORDER BY post_number ASC'
    ).bind(threadId).all<{ post_number: number; author_name: string; body: string; author_type: string }>();

    const recentPosts = existingPosts.results.map((p) => ({
      number: p.post_number, authorName: p.author_name, body: p.body, authorType: p.author_type,
    }));

    const lastHumanPost = [...recentPosts].reverse().find(p => p.authorType === 'human');
    const targetBody = lastHumanPost?.body ?? thread.title;
    const targetNumber = lastHumanPost?.number ?? 1;

    const { buildReplyPrompt } = await import('@bs-job-board/agent');
    const replyCount = 3 + Math.floor(Math.random() * 4);
    const userPrompt = buildReplyPrompt({ threadTitle: thread.title, targetBody, recentPosts, replyCount });

    const SYSTEM = `あなたは2chふう匿名掲示板の住民です。判断しない。材料を並べる。質問で終わらせない。辛辣にしない。JSON形式で{"replies":["レス1","レス2",...]}を返す。指定件数ぴったり返す。`;

    const sakuraRes = await fetch('https://api.ai.sakura.ad.jp/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.SAKURA_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-oss-120b', stream: true, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt }],
        max_tokens: 1500, temperature: 0.7,
      }),
    });

    if (!sakuraRes.ok || !sakuraRes.body) return c.text('AI error', 502);

    // SSEをプロキシしつつ、完了時にDBに保存
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let fullContent = '';
    let fullThinking = '';

    c.executionCtx.waitUntil((async () => {
      const reader = sakuraRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          buffer += text;

          // クライアントにそのまま転送
          await writer.write(encoder.encode(text));

          // content/reasoning を蓄積
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
            try {
              const chunk = JSON.parse(line.slice(6));
              const delta = chunk?.choices?.[0]?.delta || {};
              if (delta.content) fullContent += delta.content;
              if (delta.reasoning_content) fullThinking += delta.reasoning_content;
            } catch {}
          }
        }

        // 残りバッファ処理
        if (buffer.trim()) {
          for (const line of buffer.split('\n')) {
            if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
            try {
              const chunk = JSON.parse(line.slice(6));
              const delta = chunk?.choices?.[0]?.delta || {};
              if (delta.content) fullContent += delta.content;
              if (delta.reasoning_content) fullThinking += delta.reasoning_content;
            } catch {}
          }
        }

        // DB保存
        const { assignAnchors, applyAnchors } = await import('@bs-job-board/agent');
        let replies: string[] = [];
        try {
          const parsed = JSON.parse(fullContent);
          if (Array.isArray(parsed?.replies)) replies = parsed.replies.filter((r: string) => r.length >= 5);
        } catch {}

        const existingNumbers = recentPosts.map(p => p.number);
        const anchors = assignAnchors(targetNumber, existingNumbers, replies.length);
        const withAnchors = applyAnchors(replies, anchors);

        for (const reply of withAnchors) {
          await addPost(c.env.DB, threadId, { author_type: 'ai', author_name: '名無しさん@AI', role: null, body: reply });
        }
        if (fullThinking) {
          await addPost(c.env.DB, threadId, { author_type: 'ai', author_name: '🤔 AIの思考', role: 'thinking', body: fullThinking });
        }
      } finally {
        await writer.close();
      }
    })());

    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' },
    });
  })
