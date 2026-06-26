import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { authClient } from '../lib/auth-client';
import { createServerFn } from '@tanstack/react-start';
import { useState, useEffect, useCallback } from 'react';
import type { Thread } from '@bs-job-board/contracts';
import type { CreateThreadResponse } from '@bs-job-board/contracts';
import { getApi, getAuthenticatedApi } from '../lib/api-fetch';

type ThreadWithReactions = Thread & { reaction_count: number };

// ── Server Functions ────────────────────────────────────

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
    // #29: Cookie/Authorization を API へ転送
    const api = await getAuthenticatedApi();
    const r = await api('/api/v1/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(errBody.error ?? `create thread failed: ${r.status}`);
    }
    return (await r.json()) as CreateThreadResponse;
  });

// #49: serverがsessionからuserIdを導出。clientからuserIdを送らない
const reactAction = createServerFn({ method: 'POST' })
  .validator((input: { threadId: string }) => input)
  .handler(async ({ data }) => {
    const api = await getAuthenticatedApi();
    const r = await api(`/api/v1/threads/${data.threadId}/react`, {
      method: 'POST',
    });
    // #49 hardening: 401はbodyに依存せず即throw
    if (r.status === 401) {
      await r.body?.cancel().catch(() => undefined);
      throw new Error('authentication required');
    }
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(errBody.error ?? `reaction failed: ${r.status}`);
    }
    return (await r.json()) as { reacted: boolean; reaction_count: number };
  });

// ── Auth helpers ────────────────────────────────────────

/**
 * #29: localStorage を認証根拠にしない。
 * Better Auth session cookie が存在するかどうかで判定する。
 * bs-auth-user-id は「表示用キャッシュ」として残すが、
 * 認証済み判定には使わない。
 */
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
      const userId = result.data.user.id;
      // 表示用キャッシュのみ。認証根拠ではない。
      localStorage.setItem('bs-auth-user-id', userId);
      localStorage.setItem('bs-auth-user-name', result.data.user.name || '名無しさん');
      return { ok: true, userId };
    }
    // #29: UUID fallback しない
    return { ok: false, message: '匿名認証に失敗しました。通信状態を確認してもう一度お試しください。' };
  } catch {
    return { ok: false, message: '匿名認証に失敗しました。通信状態を確認してもう一度お試しください。' };
  }
}

// ── Route ───────────────────────────────────────────────

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
  useEffect(() => { setUserId(getCachedUserId()); }, []);
  useEffect(() => {
    const poll = setInterval(async () => {
      try { setThreads(await fetchThreads({ data: { sort } })); } catch {}
    }, 5000);
    return () => clearInterval(poll);
  }, [sort]);

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<'post' | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    // 常に認証モーダルを出す（認証状態はserver session依存）
    // ただしcachedUserIdがあれば直接投稿を試みる
    if (!getCachedUserId()) {
      setPendingAction('post');
      setShowAuthModal(true);
      return;
    }
    setSubmitting(true);
    try {
      const result = await createThreadAction({ data: { title: title.trim(), body: body.trim() } });
      setTitle(''); setBody('');
      navigate({ to: '/threads/$id', params: { id: result.id }, search: { run: result.ai_run.id } });
    } catch (error) {
      // 401 = session切れ → 認証モーダル
      if (error instanceof Error && error.message.includes('authentication required')) {
        localStorage.removeItem('bs-auth-user-id');
        setUserId('');
        setPendingAction('post');
        setShowAuthModal(true);
        return;
      }
      throw error;
    } finally {
      setSubmitting(false);
    }
  }, [title, body, sort, navigate]);

  const handleAnonymousAuth = useCallback(async () => {
    setAuthError('');
    setAuthLoading(true);
    try {
      const authResult = await authenticateAnonymous();
      if (!authResult.ok) {
        setAuthError(authResult.message);
        return;
      }
      setUserId(authResult.userId);
      setShowAuthModal(false);
      if (pendingAction === 'post' && title.trim() && body.trim()) {
        setSubmitting(true);
        try {
          const result = await createThreadAction({ data: { title: title.trim(), body: body.trim() } });
          setTitle(''); setBody('');
          navigate({ to: '/threads/$id', params: { id: result.id }, search: { run: result.ai_run.id } });
        } catch (postError) {
          setAuthError(postError instanceof Error ? postError.message : '投稿に失敗しました。もう一度お試しください。');
          setShowAuthModal(true);
        } finally { setSubmitting(false); }
      }
      setPendingAction(null);
    } finally {
      setAuthLoading(false);
    }
  }, [pendingAction, title, body, sort, navigate]);

  // #49: getCachedUserId() はUX用cache。server sessionが唯一の認証根拠
  const handleReact = useCallback(async (threadId: string) => {
    if (!getCachedUserId()) {
      setShowAuthModal(true);
      return;
    }
    try {
      const r = await reactAction({ data: { threadId } });
      setThreads(prev => prev.map(t => t.id === threadId ? { ...t, reaction_count: r.reaction_count } : t));
    } catch (error) {
      if (error instanceof Error && error.message.includes('authentication required')) {
        localStorage.removeItem('bs-auth-user-id');
        setUserId('');
        setShowAuthModal(true);
        return;
      }
    }
  }, []);

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
          <button onClick={() => navigate({ to: '/', search: { sort: 'hot' } })} className="badge" style={{ background: sort === 'hot' ? '#f0b429' : '#fff', cursor: 'pointer', border: '1px solid #20211d' }}>🔥 わかる！順</button>
          <button onClick={() => navigate({ to: '/', search: { sort: 'new' } })} className="badge" style={{ background: sort === 'new' ? '#f0b429' : '#fff', cursor: 'pointer', border: '1px solid #20211d' }}>🆕 新着順</button>
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', zIndex: 100 }} onClick={() => { setShowAuthModal(false); setAuthError(''); }}>
          <div className="card" style={{ maxWidth: '360px', margin: '16px', boxShadow: '8px 8px 0 rgba(32,33,29,0.86)' }} onClick={e => e.stopPropagation()}>
            <p className="eyebrow">First post</p>
            <h3 style={{ fontFamily: 'Georgia, serif', margin: '8px 0 16px' }}>投稿するには</h3>
            {authError && (
              <p style={{ color: '#c53030', fontSize: '0.85rem', marginBottom: '12px', padding: '8px', background: '#fff5f5', border: '1px solid #feb2b2' }}>
                {authError}
              </p>
            )}
            <button onClick={handleAnonymousAuth} disabled={authLoading} style={{ width: '100%', marginBottom: '8px' }}>
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
