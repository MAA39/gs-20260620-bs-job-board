import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { authClient } from '../lib/auth-client';
import { createServerFn } from '@tanstack/react-start';
import { useState, useEffect, useCallback } from 'react';
import type { Thread } from '@bs-job-board/contracts';

type ThreadWithReactions = Thread & { reaction_count: number };

async function getApi() {
  try {
    const { env } = (await import('cloudflare:workers')) as { env: { API: { fetch: typeof fetch } } };
    return (url: string, init?: RequestInit) => env.API.fetch(`https://api${url}`, init);
  } catch {
    return (url: string, init?: RequestInit) => fetch(`http://localhost:8787${url}`, init);
  }
}

const fetchThreads = createServerFn({ method: 'GET' })
  .validator((input: { sort: string }) => input)
  .handler(async ({ data }) => {
    const api = await getApi();
    const res = await api(`/api/v1/threads?sort=${data.sort}`);
    return res.ok ? (await res.json()) as ThreadWithReactions[] : [];
  });

const createThreadAction = createServerFn({ method: 'POST' })
  .validator((input: { title: string; body: string }) => input)
  .handler(async ({ data }) => {
    const api = await getApi();
    return (await (await api('/api/v1/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json()) as { id: string };
  });

const reactAction = createServerFn({ method: 'POST' })
  .validator((input: { threadId: string; userId: string }) => input)
  .handler(async ({ data }) => {
    const api = await getApi();
    return (await (await api(`/api/v1/threads/${data.threadId}/react`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: data.userId }) })).json()) as { reacted: boolean; reaction_count: number };
  });

function getUserId(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('bs-user-id') ?? '';
}

function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false;
  return !!localStorage.getItem('bs-user-id');
}

async function authenticateAnonymous(): Promise<string> {
  const result = await authClient.signIn.anonymous();
  if (result.data?.user) {
    const userId = result.data.user.id;
    localStorage.setItem('bs-user-id', userId);
    localStorage.setItem('bs-user-name', result.data.user.name || '名無しさん');
    return userId;
  }
  // フォールバック（API接続失敗時）
  const id = crypto.randomUUID();
  localStorage.setItem('bs-user-id', id);
  localStorage.setItem('bs-user-name', '名無しさん');
  return id;
}

export const Route = createFileRoute('/')({
  validateSearch: (s: Record<string, unknown>) => ({ sort: (s.sort as string) ?? 'new' }),
  loaderDeps: ({ search }) => ({ sort: search.sort }),
  loader: ({ deps }) => fetchThreads({ data: { sort: deps.sort } }),
  component: HomePage,
});

function HomePage() {
  const initial = Route.useLoaderData();
  const { sort } = Route.useSearch();
  const navigate = useNavigate();
  const [threads, setThreads] = useState(initial);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [userId, setUserId] = useState('');

  useEffect(() => { setThreads(initial); }, [initial]);
  useEffect(() => { setUserId(getUserId()); }, []);
  useEffect(() => {
    const poll = setInterval(async () => { try { setThreads(await fetchThreads({ data: { sort } })); } catch {} }, 5000);
    return () => clearInterval(poll);
  }, [sort]);

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<'post' | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    if (!isAuthenticated()) { setPendingAction('post'); setShowAuthModal(true); return; }
    setSubmitting(true);
    try { await createThreadAction({ data: { title: title.trim(), body: body.trim() } }); setTitle(''); setBody(''); setThreads(await fetchThreads({ data: { sort } })); }
    finally { setSubmitting(false); }
  }, [title, body, sort]);

  const handleAnonymousAuth = useCallback(async () => {
    const id = await authenticateAnonymous();
    setUserId(id);
    setShowAuthModal(false);
    if (pendingAction === 'post' && title.trim() && body.trim()) {
      setSubmitting(true);
      try { await createThreadAction({ data: { title: title.trim(), body: body.trim() } }); setTitle(''); setBody(''); setThreads(await fetchThreads({ data: { sort } })); }
      finally { setSubmitting(false); }
    }
    setPendingAction(null);
  }, [pendingAction, title, body, sort]);

  const handleReact = useCallback(async (threadId: string) => {
    if (!userId) return;
    const r = await reactAction({ data: { threadId, userId } });
    setThreads(prev => prev.map(t => t.id === threadId ? { ...t, reaction_count: r.reaction_count } : t));
  }, [userId]);

  return (
    <div>
      <div className="card">
        <p className="eyebrow">New thread</p>
        <h3 style={{ marginBottom: '12px', fontFamily: 'Georgia, serif' }}>スレッドを立てる</h3>
        <form onSubmit={handleSubmit}>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="スレタイ（例: 週次報告書の二重入力）" required />
          <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="何が無駄？どのくらい時間溶けてる？なぜ廃止されない？" required />
          <button type="submit" disabled={submitting}>{submitting ? '作成中...' : 'スレッドを立てる'}</button>
        </form>
      </div>

      <div className="section-header">
        <span>Threads</span>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => navigate({ search: { sort: 'hot' } })} className="badge" style={{ background: sort === 'hot' ? '#f0b429' : '#fff', cursor: 'pointer', border: '1px solid #20211d' }}>🔥 わかる！順</button>
          <button onClick={() => navigate({ search: { sort: 'new' } })} className="badge" style={{ background: sort === 'new' ? '#f0b429' : '#fff', cursor: 'pointer', border: '1px solid #20211d' }}>🆕 新着順</button>
        </div>
      </div>

      {threads.map((t) => (
        <div key={t.id} className="thread-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Link to="/threads/$id" params={{ id: t.id }} style={{ flex: 1 }}>
              <div className="thread-title">{t.title}</div>
              <div className="thread-preview">{t.body.length > 60 ? t.body.slice(0, 60) + '...' : t.body}</div>
            </Link>
            <button className="react-btn" onClick={(e) => { e.preventDefault(); handleReact(t.id); }}>
              👋 {t.reaction_count}
            </button>
          </div>
        </div>
      ))}

      {threads.length === 0 && <div className="card" style={{ textAlign: 'center', color: '#555041' }}>まだスレッドがありません。</div>}

      {/* 匿名認証モーダル */}
      {showAuthModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', zIndex: 100 }} onClick={() => setShowAuthModal(false)}>
          <div className="card" style={{ maxWidth: '360px', margin: '16px', boxShadow: '8px 8px 0 rgba(32,33,29,0.86)' }} onClick={e => e.stopPropagation()}>
            <p className="eyebrow">First post</p>
            <h3 style={{ fontFamily: 'Georgia, serif', margin: '8px 0 16px' }}>投稿するには</h3>
            <button onClick={handleAnonymousAuth} style={{ width: '100%', marginBottom: '8px' }}>
              👤 匿名で投稿する
            </button>
            <button disabled style={{ width: '100%', background: '#ddd', color: '#999' }}>
              🔗 GitHubでログイン（準備中）
            </button>
            <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '12px' }}>匿名IDはこのブラウザに保存されます。</p>
          </div>
        </div>
      )}
    </div>
  );
}
