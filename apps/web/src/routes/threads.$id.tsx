import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { authClient } from '../lib/auth-client';
import { createServerFn } from '@tanstack/react-start';
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ThreadDetail, Post, CreatePostResponse } from '@bs-job-board/contracts';
import { useAiRunProgress, getProgressLabel } from '../lib/use-ai-run-progress';

async function getApi() {
  try {
    const { env } = (await import('cloudflare:workers')) as unknown as { env: { API: { fetch: typeof fetch }; API_BASE_URL?: string } };
    return (url: string, init?: RequestInit) => env.API.fetch(`https://api${url}`, init);
  } catch {
    return (url: string, init?: RequestInit) => fetch(`http://localhost:8787${url}`, init);
  }
}

const resolveApiBaseUrl = createServerFn({ method: 'GET' })
  .handler(async () => {
    try {
      const { env } = (await import('cloudflare:workers')) as unknown as { env: { API_BASE_URL?: string } };
      return env.API_BASE_URL || 'http://localhost:8787';
    } catch {
      return 'http://localhost:8787';
    }
  });

const fetchDetail = createServerFn({ method: 'GET' }).validator((i: { id: string }) => i)
  .handler(async ({ data }) => { const api = await getApi(); const r = await api(`/api/v1/threads/${data.id}`); if (!r.ok) throw new Error('not found'); return (await r.json()) as ThreadDetail; });

const addComment = createServerFn({ method: 'POST' }).validator((i: { threadId: string; body: string }) => i)
  .handler(async ({ data }) => {
    const api = await getApi();
    const r = await api(`/api/v1/threads/${data.threadId}/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: data.body }) });
    if (!r.ok) throw new Error(`post failed: ${r.status}`);
    return (await r.json()) as CreatePostResponse;
  });

const fixThread = createServerFn({ method: 'POST' }).validator((i: { threadId: string; status: string }) => i)
  .handler(async ({ data }) => { const api = await getApi(); await api(`/api/v1/threads/${data.threadId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: data.status }) }); });

type SearchParams = { run?: string };

export const Route = createFileRoute('/threads/$id')({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    run: typeof s.run === 'string' ? s.run : undefined,
  }),
  loader: async ({ params }) => {
    const [detail, apiBaseUrl] = await Promise.all([
      fetchDetail({ data: { id: params.id } }),
      resolveApiBaseUrl(),
    ]);
    return { detail, apiBaseUrl };
  },
  component: ThreadDetailPage,
});

function ThreadDetailPage() {
  const { detail: initial, apiBaseUrl } = Route.useLoaderData();
  const params = Route.useParams();
  const { run: searchRunId } = Route.useSearch();
  const navigate = useNavigate();
  const [thread, setThread] = useState(initial);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [aiRunId, setAiRunId] = useState<string | null>(searchRunId ?? null);

  useEffect(() => { setThread(initial); }, [initial]);

  // search.run 変更時に tracked run を同期
  useEffect(() => {
    if (searchRunId) setAiRunId(searchRunId);
  }, [searchRunId]);

  // ── SSE 進捗 ──────────────────────────────────────────
  const refreshThread = useCallback(async () => {
    try { setThread(await fetchDetail({ data: { id: params.id } })); } catch { /* noop */ }
  }, [params.id]);

  const progress = useAiRunProgress(aiRunId, apiBaseUrl, refreshThread);

  // terminal 表示消失バグ修正: setAiRunId(null) は行わない。
  // hook は内部で source.close() 済み。aiRunId を保持しても再接続しない。

  // ── 5秒ポーリング（他ユーザーの投稿を拾う） ─────────
  useEffect(() => {
    const p = setInterval(refreshThread, 5000);
    return () => clearInterval(p);
  }, [refreshThread]);

  const [showAuthModal, setShowAuthModal] = useState(false);

  const isAuth = typeof window !== 'undefined' && !!localStorage.getItem('bs-user-id');

  const handleComment = useCallback(async (e: React.FormEvent) => {
    e.preventDefault(); if (!comment.trim()) return;
    if (!isAuth) { setShowAuthModal(true); return; }
    setSubmitting(true); setError('');
    try {
      const result = await addComment({ data: { threadId: params.id, body: comment.trim() } });
      setComment('');
      // 新しい ai_run.id → SSE 接続開始 + URL search を replace で反映
      const newRunId = result.ai_run.id;
      setAiRunId(newRunId);
      navigate({
        to: '/threads/$id',
        params: { id: params.id },
        search: { run: newRunId },
        replace: true,
      });
      const fresh = await fetchDetail({ data: { id: params.id } });
      setThread(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : '投稿に失敗しました');
    } finally { setSubmitting(false); }
  }, [comment, params.id, isAuth, navigate]);

  const handleAnonAuth = useCallback(async () => {
    try {
      const result = await authClient.signIn.anonymous();
      if (result.data?.user) {
        localStorage.setItem('bs-user-id', result.data.user.id);
        localStorage.setItem('bs-user-name', result.data.user.name || '名無しさん');
      } else {
        const id = crypto.randomUUID();
        localStorage.setItem('bs-user-id', id);
        localStorage.setItem('bs-user-name', '名無しさん');
      }
    } catch {
      const id = crypto.randomUUID();
      localStorage.setItem('bs-user-id', id);
      localStorage.setItem('bs-user-name', '名無しさん');
    }
    setShowAuthModal(false);
  }, []);

  const handleFix = useCallback(async () => {
    await fixThread({ data: { threadId: params.id, status: thread.status === 'fixed' ? 'open' : 'fixed' } });
    setThread(await fetchDetail({ data: { id: params.id } }));
  }, [thread.status, params.id]);

  const displayItems = useMemo(() => {
    const posts = [...thread.posts].sort((a, b) => a.post_number - b.post_number);
    const grouped = new Set<string>();
    const items: Array<{ type: 'post'; post: Post; indent: boolean }> = [];

    for (const post of posts) {
      if (grouped.has(post.id)) continue;
      if (post.role === 'thinking') continue;

      items.push({ type: 'post', post, indent: false });
      grouped.add(post.id);

      if (post.author_type === 'human') {
        const children = posts.filter(p => p.source_post_number === post.post_number && p.role !== 'thinking' && !grouped.has(p.id));
        for (const child of children) {
          items.push({ type: 'post', post: child, indent: true });
          grouped.add(child.id);
        }
        const nextHuman = posts.find(p => p.author_type === 'human' && p.post_number > post.post_number);
        const ceiling = nextHuman ? nextHuman.post_number : Infinity;
        const orphanChildren = posts.filter(p =>
          !grouped.has(p.id) && p.author_type === 'ai' && p.role !== 'thinking' &&
          p.source_post_number == null && p.post_number > post.post_number && p.post_number < ceiling
        );
        for (const child of orphanChildren) {
          items.push({ type: 'post', post: child, indent: true });
          grouped.add(child.id);
        }
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
        <div className="card" style={{
          marginTop: '8px',
          background: progress.status === 'failed' ? '#fff0f0' : '#f0f5ff',
          borderLeft: `3px solid ${progress.status === 'failed' ? '#c00' : '#4a90d9'}`,
          padding: '8px 12px',
          fontSize: '0.85rem',
        }}>
          <span style={{ marginRight: '8px' }}>
            {progress.status === 'generating' || progress.status === 'repairing' ? '🤖' : progress.status === 'failed' ? '⚠️' : progress.status === 'completed' ? '✅' : '⏳'}
          </span>
          {progressLabel}
        </div>
      )}

      <div className="section-header">
        <span>Posts</span>
        <span>{thread.posts.filter(p => p.role !== 'thinking').length}件 · 5秒で自動更新</span>
      </div>

      {displayItems.map((item) => {
        const post = item.post;
        const indentStyle = item.indent ? { borderLeft: '3px solid #c4b89a' } : undefined;
        return (
          <div key={post.id}>
            <div className={`post ${post.author_type === 'ai' ? 'post-ai' : ''}`} style={indentStyle}>
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', zIndex: 100 }} onClick={() => setShowAuthModal(false)}>
          <div className="card" style={{ maxWidth: '360px', margin: '16px', boxShadow: '8px 8px 0 rgba(32,33,29,0.86)' }} onClick={e => e.stopPropagation()}>
            <p className="eyebrow">First post</p>
            <h3 style={{ fontFamily: 'Georgia, serif', margin: '8px 0 16px' }}>投稿するには</h3>
            <button onClick={handleAnonAuth} style={{ width: '100%', marginBottom: '8px' }}>👤 匿名で投稿する</button>
            <button disabled style={{ width: '100%', background: '#ddd', color: '#999' }}>🔗 GitHubでログイン（準備中）</button>
            <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '12px' }}>匿名IDはこのブラウザに保存されます。</p>
          </div>
        </div>
      )}
    </div>
  );
}
