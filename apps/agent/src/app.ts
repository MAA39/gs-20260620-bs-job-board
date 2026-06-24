import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

const INTERNAL_HOSTS = new Set(['agent', 'localhost', '127.0.0.1', '[::1]', '::1']);

const app = new Hono();
app.get('/health', (context) => context.json({ ok: true }));
app.use('/workflows/*', allowInternalHost);
app.use('/runs/*', allowInternalHost);
app.route('/', flue());

async function allowInternalHost(context: any, next: () => Promise<void>) {
  if (!INTERNAL_HOSTS.has(new URL(context.req.url).hostname)) return context.notFound();
  return next();
}

export default app;
