import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { threadRoutes } from './routes/threads.ts';
import { createAuth } from './auth.ts';

type Bindings = {
  DB: D1Database;
  SAKURA_API_TOKEN: string;
  BETTER_AUTH_SECRET: string;
  AGENT: { fetch: typeof fetch };
};

const app = new Hono<{ Bindings: Bindings }>();
app.use('*', cors({
  origin: ['https://bs-job-board-web.masa-nekoshinshi39.workers.dev', 'http://localhost:5173'],
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/api/v1/threads', threadRoutes);

app.on(['POST', 'GET'], '/api/auth/**', async (c) => {
  if (!c.env.BETTER_AUTH_SECRET?.trim()) {
    return c.json({ error: 'service not configured' }, 503);
  }
  const auth = createAuth(c.env.DB, {
    secret: c.env.BETTER_AUTH_SECRET,
    baseURL: new URL(c.req.url).origin,
  });
  return auth.handler(c.req.raw);
});

export default app;
export type AppType = typeof app;
