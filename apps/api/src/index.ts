import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { threadRoutes } from './routes/threads.ts';
import { internalCallbackRoutes } from './routes/internal-callbacks.ts';
import { aiRunEventRoutes } from './routes/ai-run-events.ts';
import { createAuth, resolveExternalBaseURL } from './auth.ts';
import { jsonBodyLimit, BODY_LIMITS } from './middleware/body-limit.ts';

type Bindings = {
  DB: D1Database;
  SAKURA_API_TOKEN: string;
  BETTER_AUTH_SECRET: string;
  INTERNAL_CALLBACK_KEY: string;
  AGENT: { fetch: typeof fetch };
};

// ── ADR-006: browser-facing origin制限 ──────────────────
const corsMiddleware = cors({
  origin: ['https://bs-job-board-web.masa-nekoshinshi39.workers.dev', 'http://localhost:5173'],
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

const app = new Hono<{ Bindings: Bindings }>();

// ── healthcheck ── CORSなし
app.get('/health', (c) => c.json({ status: 'ok' }));

// ── browser-facing public API ── CORSあり
app.use('/api/v1/*', corsMiddleware);
app.route('/api/v1/threads', threadRoutes);
app.route('/api/v1/ai-runs', aiRunEventRoutes);

// ── browser-facing auth API ── CORSあり + POST bodyLimit
app.use('/api/auth/*', corsMiddleware);

const authHandler = async (c: { env: Bindings; req: { raw: Request; url: string }; json: (data: unknown, status?: number) => Response }) => {
  if (!c.env?.BETTER_AUTH_SECRET?.trim()) {
    return c.json({ error: 'service not configured' }, 503);
  }
  const baseURL = resolveExternalBaseURL(c.req.raw, new URL(c.req.url).origin);
  const auth = createAuth(c.env.DB, {
    secret: c.env.BETTER_AUTH_SECRET,
    baseURL,
  });
  return auth.handler(c.req.raw);
};

app.on(['GET'], '/api/auth/**', authHandler);
app.on(['POST'], '/api/auth/**', jsonBodyLimit(BODY_LIMITS.auth), authHandler);

// ── Worker-to-Worker internal ── CORSなし
// callback key検証 + bodyLimit は internalCallbackRoutes 内
app.route('/internal/v1/ai-runs', internalCallbackRoutes);

export default app;
export type AppType = typeof app;
