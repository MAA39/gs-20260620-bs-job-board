import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

type Bindings = { INTERNAL_AGENT_TOKEN?: string };

const app = new Hono<{ Bindings: Bindings }>();
app.get('/health', (context) => context.json({ ok: true }));
app.use('/workflows/*', protectInternalRoutes);
app.use('/runs/*', protectInternalRoutes);
app.route('/', flue());

async function protectInternalRoutes(context: any, next: () => Promise<void>) {
  const expected = context.env?.INTERNAL_AGENT_TOKEN?.trim();
  const actual = context.req.header('authorization');
  if (!expected || actual !== `Bearer ${expected}`) return context.notFound();
  return next();
}

export default app;
