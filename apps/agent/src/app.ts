import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

// さくらAI Engine provider（gs-20260619から移植）
registerProvider('sakura', {
  api: 'openai-completions',
  baseUrl: 'https://api.ai.sakura.ad.jp/v1',
  apiKey: process.env.SAKURA_API_TOKEN,
});

const app = new Hono();

// Health
app.get('/health', (c) => c.json({ status: 'ok' }));

// 分析依頼エンドポイント（api Worker から呼ばれる）
app.post('/dispatch-analysis', async (c) => {
  const { threadId, title, body } = await c.req.json<{
    threadId: string;
    title: string;
    body: string;
  }>();

  // Flue の dispatch で analyst agent を非同期起動
  const { dispatch } = await import('@flue/runtime');
  await dispatch('analyst', {
    id: `thread-${threadId}`,
    input: `## 投稿タイトル\n${title}\n\n## 投稿内容\n${body}`,
  });

  return c.json({ dispatched: true, threadId });
});

// Flue routes（agents, workflows）
app.route('/', flue());

export default app;
