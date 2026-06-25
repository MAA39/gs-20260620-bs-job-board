import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import app from '../index.ts';

const database = env.DB;

// ── Helpers ─────────────────────────────────────────────

type AnyJson = Record<string, unknown>;
const json = async (res: Response): Promise<AnyJson> => res.json() as Promise<AnyJson>;

const seedThread = async (threadId: string) => {
  await database
    .prepare('INSERT INTO threads (id, title, body) VALUES (?, ?, ?)')
    .bind(threadId, `title-${threadId}`, `body-${threadId}`)
    .run();
};

const makeEnv = () => ({
  DB: database,
  BETTER_AUTH_SECRET: 'test-secret-for-threads-integration',
  INTERNAL_CALLBACK_KEY: 'test-callback-key-for-integration',
  AGENT: { fetch: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) },
});

const makeExecutionCtx = () => {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
    pending,
  };
};

const postComment = async (
  threadId: string,
  body: unknown,
  options?: { raw?: boolean },
) => {
  const { ctx, pending } = makeExecutionCtx();
  const res = await app.request(
    `http://localhost/api/v1/threads/${threadId}/posts`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: options?.raw ? (body as string) : JSON.stringify(body),
    },
    makeEnv() as Record<string, unknown>,
    ctx,
  );
  // Wait for dispatch to settle (no dangling promises)
  await Promise.allSettled(pending);
  return res;
};

const countRows = async (table: string, where?: string): Promise<number> => {
  const q = where
    ? `SELECT COUNT(*) as cnt FROM ${table} WHERE ${where}`
    : `SELECT COUNT(*) as cnt FROM ${table}`;
  const result = await database.prepare(q).first<{ cnt: number }>();
  return result?.cnt ?? 0;
};

// ── Tests ───────────────────────────────────────────────

describe('POST /api/v1/threads/:id/posts', () => {
  // ── Rejection: server-owned fields ─────────────────────

  describe('rejects server-owned fields (ADR-004)', () => {
    test('author_type in body → 400, no side effects', async () => {
      const tid = 'thr-spoof-1';
      await seedThread(tid);
      const postsBefore = await countRows('posts');
      const runsBefore = await countRows('ai_runs');

      const res = await postComment(tid, {
        body: 'テスト投稿です',
        author_type: 'ai',
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toContain('server-owned');

      expect(await countRows('posts')).toBe(postsBefore);
      expect(await countRows('ai_runs')).toBe(runsBefore);
    });

    test('role + source_post_number in body → 400', async () => {
      const tid = 'thr-spoof-2';
      await seedThread(tid);

      const res = await postComment(tid, {
        body: '投稿テスト',
        role: 'thinking',
        source_post_number: 1,
      });
      expect(res.status).toBe(400);
    });

    test('user_id in body → 400', async () => {
      const tid = 'thr-spoof-3';
      await seedThread(tid);

      const res = await postComment(tid, {
        body: '投稿テスト',
        user_id: 'injected-user',
      });
      expect(res.status).toBe(400);
    });
  });

  // ── Rejection: invalid body ────────────────────────────

  describe('rejects invalid body', () => {
    test('missing body field → 400', async () => {
      const tid = 'thr-nobody';
      await seedThread(tid);
      const res = await postComment(tid, {});
      expect(res.status).toBe(400);
      expect((await json(res)).error).toContain('body');
    });

    test('empty string body → 400', async () => {
      const tid = 'thr-empty';
      await seedThread(tid);
      const res = await postComment(tid, { body: '   ' });
      expect(res.status).toBe(400);
    });

    test('non-string body → 400', async () => {
      const tid = 'thr-nonstr';
      await seedThread(tid);
      const res = await postComment(tid, { body: 123 });
      expect(res.status).toBe(400);
    });

    test('non-JSON request → 400', async () => {
      const tid = 'thr-badjson';
      await seedThread(tid);
      const res = await postComment(tid, 'not json', { raw: true });
      expect(res.status).toBe(400);
    });
  });

  // ── Success: valid human post ──────────────────────────

  describe('valid post creates human post + queued run', () => {
    test('{ body } → 201, human post with server-determined fields', async () => {
      const tid = 'thr-valid';
      await seedThread(tid);

      const res = await postComment(tid, { body: '正常な投稿です' });
      expect(res.status).toBe(201);
      const result = await json(res);
      expect(result.id).toBeDefined();
      expect(result.post_number).toBeDefined();
      expect(result.ai_run).toBeDefined();
      expect((result.ai_run as AnyJson).id).toBeDefined();

      // Verify post: author_type=human, role=null, server-determined name
      const post = await database
        .prepare('SELECT author_type, author_name, role, source_post_number, user_id, body FROM posts WHERE id = ?')
        .bind(result.id as string)
        .first<{ author_type: string; author_name: string; role: string | null; source_post_number: number | null; user_id: string | null; body: string }>();
      expect(post?.author_type).toBe('human');
      expect(post?.author_name).toBe('名無しさん');
      expect(post?.role).toBeNull();
      expect(post?.body).toBe('正常な投稿です');

      // Verify ai_run exists and points to this post
      const run = await database
        .prepare('SELECT id, source_post_id, status FROM ai_runs WHERE id = ?')
        .bind((result.ai_run as AnyJson).id as string)
        .first<{ id: string; source_post_id: string; status: string }>();
      expect(run).not.toBeNull();
      expect(run?.source_post_id).toBe(result.id);
    });
  });
});
