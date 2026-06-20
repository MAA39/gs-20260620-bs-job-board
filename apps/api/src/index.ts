import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { threadRoutes } from './routes/threads.ts';

type Bindings = {
  DB: D1Database;
  AGENT: Fetcher;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS: web Worker からのリクエストを許可
app.use('/api/*', cors());

// Health
app.get('/health', (c) => c.json({ status: 'ok' }));

// API routes
app.route('/api/v1/threads', threadRoutes);

export default app;
export type AppType = typeof app;
