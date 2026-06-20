import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { threadRoutes } from './routes/threads.ts';

type Bindings = {
  DB: D1Database;
  SAKURA_API_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/*', cors());
app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/api/v1/threads', threadRoutes);

export default app;
export type AppType = typeof app;
