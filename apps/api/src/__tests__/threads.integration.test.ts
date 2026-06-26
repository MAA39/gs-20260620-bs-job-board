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

const makeEnv = (overrides?: Partial<Record<string, unknown>>) => ({
  DB: database,
  BETTER_AUTH_SECRET: 'test-secret-for-threads-integration',
  INTERNAL_CALLBACK_KEY: 'test-callback-key-for-integration',
  AGENT: { fetch: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) },
  ...overrides,
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

/**
 * anonymous sign-in して session cookie を取得する。
 * #29: テスト内で Better Auth session を作るヘルパー。
 */
const getAnonymousSessionCookie = async (): Promise<string> => {
  const { ctx, pending } = makeExecutionCtx();
  const res = await app.request(
    'http://localhost/api/auth/sign-in/anonymous',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
    makeEnv() as Record<string, unknown>,
    ctx,
  );
  await Promise.allSettled(pending);
  if (res.status !== 200) {
    throw new Error(`anonymous sign-in failed: ${res.status} ${await res.text()}`);
  }
  // Set-Cookie から session cookie を取得
  const setCookie = res.headers.get('set-cookie') ?? '';
  if (!setCookie) {
    throw new Error('no Set-Cookie in sign-in response');
  }
  // cookie name=value 部分だけ抽出（; 以降は属性）
  return setCookie.split(';')[0];
};

const postComment = async (
  threadId: string,
  body: unknown,
  options?: { raw?: boolean; cookie?: string; envOverrides?: Partial<Record<string, unknown>> },
) => {
  const { ctx, pending } = makeExecutionCtx();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.cookie) headers['Cookie'] = options.cookie;
  const res = await app.request(
    `http://localhost/api/v1/threads/${threadId}/posts`,
    {
      method: 'POST',
      headers,
      body: options?.raw ? (body as string) : JSON.stringify(body),
    },
    makeEnv(options?.envOverrides) as Record<string, unknown>,
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
  // ── #29: Auth fail-closed ──────────────────────────────

  describe('auth fail-closed (#29)', () => {
    test('no session → 401, no side effects', async () => {
      const tid = 'thr-noauth';
      await seedThread(tid);
      const postsBefore = await countRows('posts');
      const runsBefore = await countRows('ai_runs');

      const res = await postComment(tid, { body: '認証なし投稿' });
      expect(res.status).toBe(401);
      expect((await json(res)).error).toContain('authentication required');

      expect(await countRows('posts')).toBe(postsBefore);
      expect(await countRows('ai_runs')).toBe(runsBefore);
    });

    test('missing BETTER_AUTH_SECRET → 503', async () => {
      const tid = 'thr-nosecret';
      await seedThread(tid);

      const res = await postComment(tid, { body: '設定不足' }, {
        envOverrides: { BETTER_AUTH_SECRET: '' },
      });
      expect(res.status).toBe(503);
    });
  });

  // ── Rejection: server-owned fields ─────────────────────

  describe('rejects server-owned fields (ADR-004)', () => {
    test('author_type in body → 400, no side effects', async () => {
      const tid = 'thr-spoof-1';
      await seedThread(tid);
      const cookie = await getAnonymousSessionCookie();
      const postsBefore = await countRows('posts');
      const runsBefore = await countRows('ai_runs');

      const res = await postComment(tid, {
        body: 'テスト投稿です',
        author_type: 'ai',
      }, { cookie });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toContain('server-owned');

      expect(await countRows('posts')).toBe(postsBefore);
      expect(await countRows('ai_runs')).toBe(runsBefore);
    });

    test('role + source_post_number in body → 400', async () => {
      const tid = 'thr-spoof-2';
      await seedThread(tid);
      const cookie = await getAnonymousSessionCookie();

      const res = await postComment(tid, {
        body: '投稿テスト',
        role: 'thinking',
        source_post_number: 1,
      }, { cookie });
      expect(res.status).toBe(400);
    });

    test('user_id in body → 400', async () => {
      const tid = 'thr-spoof-3';
      await seedThread(tid);
      const cookie = await getAnonymousSessionCookie();

      const res = await postComment(tid, {
        body: '投稿テスト',
        user_id: 'injected-user',
      }, { cookie });
      expect(res.status).toBe(400);
    });
  });

  // ── Rejection: invalid body ────────────────────────────

  describe('rejects invalid body', () => {
    test('missing body field → 400', async () => {
      const tid = 'thr-nobody';
      await seedThread(tid);
      const cookie = await getAnonymousSessionCookie();
      const res = await postComment(tid, {}, { cookie });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toContain('body');
    });

    test('empty string body → 400', async () => {
      const tid = 'thr-empty';
      await seedThread(tid);
      const cookie = await getAnonymousSessionCookie();
      const res = await postComment(tid, { body: '   ' }, { cookie });
      expect(res.status).toBe(400);
    });

    test('non-string body → 400', async () => {
      const tid = 'thr-nonstr';
      await seedThread(tid);
      const cookie = await getAnonymousSessionCookie();
      const res = await postComment(tid, { body: 123 }, { cookie });
      expect(res.status).toBe(400);
    });

    test('non-JSON request → 400', async () => {
      const tid = 'thr-badjson';
      await seedThread(tid);
      const cookie = await getAnonymousSessionCookie();
      const res = await postComment(tid, 'not json', { raw: true, cookie });
      expect(res.status).toBe(400);
    });
  });

  // ── Success: valid human post with session ─────────────

  describe('valid post creates human post + queued run', () => {
    test('authenticated { body } → 201, human post with server-determined fields', async () => {
      const tid = 'thr-valid';
      await seedThread(tid);
      const cookie = await getAnonymousSessionCookie();

      const res = await postComment(tid, { body: '正常な投稿です' }, { cookie });
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
      expect(post?.role).toBeNull();
      expect(post?.body).toBe('正常な投稿です');
      // #29: user_id はsession由来（null ではない）
      expect(post?.user_id).not.toBeNull();

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
