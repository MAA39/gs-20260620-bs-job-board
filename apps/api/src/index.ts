import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { threadRoutes } from './routes/threads.ts';
import { internalCallbackRoutes } from './routes/internal-callbacks.ts';
import { aiRunEventRoutes } from './routes/ai-run-events.ts';
import { createAuth } from './auth.ts';

type Bindings = {
  DB: D1Database;
  SAKURA_API_TOKEN: string;
  BETTER_AUTH_SECRET: string;
  INTERNAL_CALLBACK_KEY: string;
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
app.route('/api/v1/ai-runs', aiRunEventRoutes);
app.route('/internal/v1/ai-runs', internalCallbackRoutes);

app.on(['POST', 'GET'], '/api/auth/**', async (c) => {
  if (!c.env?.BETTER_AUTH_SECRET?.trim()) {
    return c.json({ error: 'service not configured' }, 503);
  }
  // #29: reverse proxy 経由の場合、X-Forwarded-Host から元の origin を復元する
  const forwardedHost = c.req.header('x-forwarded-host');
  const forwardedProto = c.req.header('x-forwarded-proto') ?? 'https';
  const baseURL = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : new URL(c.req.url).origin;
  const auth = createAuth(c.env.DB, {
    secret: c.env.BETTER_AUTH_SECRET,
    baseURL,
  });
  return auth.handler(c.req.raw);
});

export default app;
export type AppType = typeof app;
