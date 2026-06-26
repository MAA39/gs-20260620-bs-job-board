import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { authClient } from '../lib/auth-client';
import { createServerFn } from '@tanstack/react-start';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { ThreadDetail, Post, CreatePostResponse } from '@bs-job-board/contracts';
import { useAiRunProgress, getProgressLabel } from '../lib/use-ai-run-progress';
import { getApi, getAuthenticatedApi } from '../lib/api-fetch';

// ── Server Functions ────────────────────────────────────

const fetchDetail = createServerFn({ method: 'GET' }).validator((i: { id: string }) => i)
  .handler(async ({ data }) => {
    const api = await getApi();
    const r = await api(`/api/v1/threads/${data.id}`);
    if (!r.ok) throw new Error('not found');
    return (await r.json()) as ThreadDetail;
  });

const addComment = createServerFn({ method: 'POST' }).validator((i: { threadId: string; body: string }) => i)
  .handler(async ({ data }) => {
    // #29: Cookie/Authorization を API へ転送
    const api = await getAuthenticatedApi();
    const r = await api(`/api/v1/threads/${data.threadId}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: data.body }),
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(errBody.error ?? `post failed: ${r.status}`);
    }
    return (await r.json()) as CreatePostResponse;
  });

const fixThread = createServerFn({ method: 'POST' }).validator((i: { threadId: string; status: 'open' | 'fixed' }) => i)
  .handler(async ({ data }) => {
    // #29: Cookie/Authorization を API へ転送
    const api = await getAuthenticatedApi();
    const r = await api(`/api/v1/threads/${data.threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: data.status }),
    });
    try {
      if (!r.ok) throw new Error(`status update failed: ${r.status}`);
    } finally {
      await r.body?.cancel().catch(() => undefined);
    }
  });

// ── Run search validation ───────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type SearchParams = { run?: string };

export const Route = createFileRoute('/threads/$id')({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    run: typeof s.run === 'string' && UUID_RE.test(s.run) ? s.run : undefined,
  }),
  // #29: apiBaseUrl 撤去。SSE は same-origin /api/v1/... を使う。
  loader: async ({ params }) => {
    const detail = await fetchDetail({ data: { id: params.id } });
    return { detail };
  },
  component: ThreadDetailPage,
});

// ── Serial polling hook ─────────────────────────────────

function useSerialPolling(task: () => Promise<void>, intervalMs: number) {
  const taskRef = useRef(task);
  taskRef.current = task;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        if (typeof document === 'undefined' || !document.hidden) {
          await taskRef.current();
        }
      } catch { /* polling failure はUIを壊さない */ }
      finally { if (!stopped) timer = setTimeout(tick, intervalMs); }
    };
    timer = setTimeout(tick, intervalMs);
    return () => { stopped = true; clearTimeout(timer); };
  }, [intervalMs]);
}

// ── Auth helpers ────────────────────────────────────────

function getCachedUserId(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('bs-auth-user-id') ?? '';
}

type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; message: string };

async function authenticateAnonymous(): Promise<AuthResult> {
  try {
    const result = await authClient.signIn.anonymous();
    if (result.data?.user) {
      localStorage.setItem('bs-auth-user-id', result.data.user.id);
      localStorage.setItem('bs-auth-user-name', result.data.user.name || '名無しさん');
      return { ok: true, userId: result.data.user.id };
    }
    return { ok: false, message: '匿名認証に失敗しました。通信状態を確認してもう一度お試しください。' };
  } catch {
    return { ok: false, message: '匿名認証に失敗しました。通信状態を確認してもう一度お試しください。' };
  }
}

// ── Keyed wrapper ───────────────────────────────────────

function ThreadDetailPage() {
  const { detail } = Route.useLoaderData();
  const { id: threadId } = Route.useParams();
  const { run } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <ThreadDetailPageContent
      key={threadId}
      threadId={threadId}
      initial={detail}
      aiRunId={run ?? null}
      navigate={navigate}
    />
  );
}

type ContentProps = {
  threadId: string;
  initial: ThreadDetail;
  aiRunId: string | null;
  navigate: ReturnType<typeof useNavigate>;
};

function ThreadDetailPageContent({ threadId, initial, aiRunId, navigate }: ContentProps) {
  const [thread, setThread] = useState(initial);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // loader更新を同期（key={threadId}と併用でcross-thread問題は再発しない）
  const refreshVersionRef = useRef(0);
  useEffect(() => {
    refreshVersionRef.current += 1;
    setThread(initial);
  }, [initial]);

  // ── latest-wins refresh ─────────────────────────────
  const refreshThread = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    const next = await fetchDetail({ data: { id: threadId } });
    if (version === refreshVersionRef.current) setThread(next);
  }, [threadId]);

  // ── SSE進捗: same-origin 化（apiBaseUrl 引数なし）────
  const progress = useAiRunProgress(aiRunId, refreshThread);

  // ── Serial polling（detail のみ）────────────────────
  useSerialPolling(refreshThread, 5_000);

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // ── 投稿: submittingRefで同期ガード + 成功と表示同期失敗を分離 ──
  const submittingRef = useRef(false);
  const handleComment = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const body = comment.trim();
    if (!body) return;
    if (!getCachedUserId()) { setShowAuthModal(true); return; }
    submittingRef.current = true;
    setSubmitting(true); setError('');

    let result: CreatePostResponse;
    try {
      result = await addComment({ data: { threadId, body } });
    } catch (cause) {
      // 401 = session切れ → 認証モーダル
      if (cause instanceof Error && cause.message.includes('authentication required')) {
        localStorage.removeItem('bs-auth-user-id');
        setShowAuthModal(true);
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }
      setError(cause instanceof Error ? cause.message : '投稿に失敗しました');
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }

    // ここから先は投稿済み。再投稿を防ぐ。
    setComment('');
    try {
      await navigate({ to: '/threads/$id', params: { id: threadId }, search: { run: result.ai_run.id }, replace: true });
      await refreshThread();
    } catch {
      setError('投稿は完了しましたが、画面の更新に失敗しました。再投稿せず再読み込みしてください。');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [comment, threadId, navigate, refreshThread]);

  const handleAnonAuth = useCallback(async () => {
    setAuthError('');
    setAuthLoading(true);
    try {
      const authResult = await authenticateAnonymous();
      if (!authResult.ok) {
        setAuthError(authResult.message);
        return;
      }
      setShowAuthModal(false);
      // #29: 認証成功後に自動再投稿しない。モーダルを閉じてユーザーが再投稿。
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const fixingRef = useRef(false);
  const handleFix = useCallback(async () => {
    if (fixingRef.current) return;
    fixingRef.current = true;
    try {
      setError('');
      await fixThread({ data: { threadId, status: thread.status === 'fixed' ? 'open' : 'fixed' } });
      await refreshThread();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'スレッドの状態更新に失敗しました');
    } finally {
      fixingRef.current = false;
    }
  }, [thread.status, threadId, refreshThread]);

  const displayItems = useMemo(() => {
    const posts = [...thread.posts].sort((a, b) => a.post_number - b.post_number);
    const grouped = new Set<string>();
    const items: Array<{ type: 'post'; post: Post; indent: boolean }> = [];
    for (const post of posts) {
      if (grouped.has(post.id) || post.role === 'thinking') continue;
      items.push({ type: 'post', post, indent: false }); grouped.add(post.id);
      if (post.author_type === 'human') {
        for (const c of posts.filter(p => p.source_post_number === post.post_number && p.role !== 'thinking' && !grouped.has(p.id)))
          { items.push({ type: 'post', post: c, indent: true }); grouped.add(c.id); }
        const next = posts.find(p => p.author_type === 'human' && p.post_number > post.post_number);
        const ceil = next ? next.post_number : Infinity;
        for (const c of posts.filter(p => !grouped.has(p.id) && p.author_type === 'ai' && p.role !== 'thinking' && p.source_post_number == null && p.post_number > post.post_number && p.post_number < ceil))
          { items.push({ type: 'post', post: c, indent: true }); grouped.add(c.id); }
      }
    }
    return items;
  }, [thread.posts]);

  const progressLabel = getProgressLabel(progress);

  return (
    <div>
      <Link to="/" search={{ sort: 'new' }} style={{ color: '#555041', textDecoration: 'none', fontSize: '0.9rem' }}>← 一覧に戻る</Link>
      <div className="card" style={{ marginTop: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <p className="eyebrow">Thread detail</p>
            <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '1.4rem', marginTop: '4px' }}>{thread.title}</h2>
          </div>
          <button className="status-btn" onClick={handleFix} style={{ background: thread.status === 'fixed' ? '#eef5ef' : '#fffaf0' }}>
            {thread.status === 'fixed' ? '✅ 整理完了' : '🔓 議論中'}
          </button>
        </div>
      </div>

      {progressLabel && (
        <div className="card" role="status" aria-live="polite" style={{
          marginTop: '8px',
          background: progress.status === 'failed' || progress.status === 'connection_failed' ? '#fff0f0' : '#f0f5ff',
          borderLeft: `3px solid ${progress.status === 'failed' || progress.status === 'connection_failed' ? '#c00' : '#4a90d9'}`,
          padding: '8px 12px', fontSize: '0.85rem',
        }}>
          <span style={{ marginRight: '8px' }}>
            {progress.status === 'generating' || progress.status === 'repairing' ? '🤖' : progress.status === 'failed' || progress.status === 'connection_failed' ? '⚠️' : progress.status === 'completed' ? '✅' : '⏳'}
          </span>
          {progressLabel}
          {progress.status === 'connection_failed' && (
            <button onClick={() => window.location.reload()} style={{ marginLeft: '8px', fontSize: '0.8rem' }}>再読み込み</button>
          )}
        </div>
      )}

      <div className="section-header"><span>Posts</span><span>{thread.posts.filter(p => p.role !== 'thinking').length}件</span></div>

      {displayItems.map((item) => {
        const post = item.post;
        return (
          <div key={post.id}>
            <div className={`post ${post.author_type === 'ai' ? 'post-ai' : ''}`} style={item.indent ? { borderLeft: '3px solid #c4b89a' } : undefined}>
              <div className="post-header"><strong>{post.post_number}</strong><span>{post.author_name}</span></div>
              <div className="post-body">{post.body}</div>
            </div>
          </div>
        );
      })}

      {error && <div className="card" style={{ marginTop: '8px', background: '#fff0f0', color: '#c00' }}>{error}</div>}

      <div className="card" style={{ marginTop: '16px' }}>
        <p className="eyebrow">Reply</p>
        <form onSubmit={handleComment} style={{ marginTop: '8px' }}>
          <input value={comment} onChange={e => setComment(e.target.value)} placeholder="名無しさんとしてレスを書く" required />
          <button type="submit" disabled={submitting}>{submitting ? '送信中...' : 'レスする'}</button>
        </form>
      </div>

      {showAuthModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', zIndex: 100 }} onClick={() => { setShowAuthModal(false); setAuthError(''); }}>
          <div className="card" style={{ maxWidth: '360px', margin: '16px', boxShadow: '8px 8px 0 rgba(32,33,29,0.86)' }} onClick={e => e.stopPropagation()}>
            <p className="eyebrow">First post</p>
            <h3 style={{ fontFamily: 'Georgia, serif', margin: '8px 0 16px' }}>投稿するには</h3>
            {authError && (
              <p style={{ color: '#c53030', fontSize: '0.85rem', marginBottom: '12px', padding: '8px', background: '#fff5f5', border: '1px solid #feb2b2' }}>
                {authError}
              </p>
            )}
            <button onClick={handleAnonAuth} disabled={authLoading} style={{ width: '100%', marginBottom: '8px' }}>
              {authLoading ? '認証中...' : '👤 匿名で投稿する'}
            </button>
            <button disabled style={{ width: '100%', background: '#ddd', color: '#999' }}>
              🔗 GitHubでログイン（準備中）
            </button>
            <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '12px' }}>匿名認証はブラウザ単位のcookieで管理されます。</p>
          </div>
        </div>
      )}
    </div>
  );
}
