import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
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
    if (!res.ok) return [] as ThreadWithReactions[];
    return (await res.json()) as ThreadWithReactions[];
  });

const createThreadAction = createServerFn({ method: 'POST' })
  .validator((input: { title: string; body: string }) => input)
  .handler(async ({ data }) => {
    const api = await getApi();
    const res = await api('/api/v1/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return (await res.json()) as { id: string };
  });

const reactAction = createServerFn({ method: 'POST' })
  .validator((input: { threadId: string; userId: string }) => input)
  .handler(async ({ data }) => {
    const api = await getApi();
    const res = await api(`/api/v1/threads/${data.threadId}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: data.userId }),
    });
    return (await res.json()) as { reacted: boolean; reaction_count: number };
  });

function getUserId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem('bs-user-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('bs-user-id', id);
  }
  return id;
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    sort: (search.sort as string) ?? 'new',
  }),
  loaderDeps: ({ search }) => ({ sort: search.sort }),
  loader: ({ deps }) => fetchThreads({ data: { sort: deps.sort } }),
  component: HomePage,
});

function HomePage() {
  const initialThreads = Route.useLoaderData();
  const { sort } = Route.useSearch();
  const navigate = useNavigate();
  const [threads, setThreads] = useState(initialThreads);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [userId, setUserId] = useState('');

  useEffect(() => { setThreads(initialThreads); }, [initialThreads]);
  useEffect(() => { setUserId(getUserId()); }, []);

  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const fresh = await fetchThreads({ data: { sort } });
        setThreads(fresh);
      } catch {}
    }, 5000);
    return () => clearInterval(poll);
  }, [sort]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    setSubmitting(true);
    try {
      await createThreadAction({ data: { title: title.trim(), body: body.trim() } });
      setTitle('');
      setBody('');
      const fresh = await fetchThreads({ data: { sort } });
      setThreads(fresh);
    } finally {
      setSubmitting(false);
    }
  }, [title, body, sort]);

  const handleReact = useCallback(async (threadId: string) => {
    if (!userId) return;
    const result = await reactAction({ data: { threadId, userId } });
    setThreads(prev => prev.map(t =>
      t.id === threadId ? { ...t, reaction_count: result.reaction_count } : t
    ));
  }, [userId]);

  return (
    <div>
      <div className="card">
        <h3 style={{ marginBottom: '8px' }}>💬 うちのブルシット・ジョブを投稿</h3>
        <form onSubmit={handleSubmit}>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="タイトル（例: 週次報告書の二重入力）" required />
          <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="何が無駄？どのくらい時間溶けてる？なぜ廃止されない？" required />
          <button type="submit" disabled={submitting}>{submitting ? '投稿中...' : '投稿する'}</button>
        </form>
      </div>

      <div style={{ display: 'flex', gap: '8px', margin: '16px 0 8px' }}>
        <button onClick={() => navigate({ search: { sort: 'hot' } })} style={{ background: sort === 'hot' ? '#1a1a2e' : '#ccc', fontSize: '0.85rem', padding: '4px 12px' }}>🔥 わかる！順</button>
        <button onClick={() => navigate({ search: { sort: 'new' } })} style={{ background: sort === 'new' ? '#1a1a2e' : '#ccc', fontSize: '0.85rem', padding: '4px 12px' }}>🆕 新着順</button>
        <span style={{ color: '#999', fontSize: '0.8rem', alignSelf: 'center' }}>{threads.length}件 · 5秒で自動更新</span>
      </div>

      {threads.map((thread) => (
        <div key={thread.id} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Link to="/threads/$id" params={{ id: thread.id }} style={{ textDecoration: 'none', color: 'inherit', flex: 1 }}>
              <h3>{thread.title}</h3>
              <p style={{ color: '#666', marginTop: '4px', fontSize: '0.9rem' }}>{thread.body.length > 80 ? thread.body.slice(0, 80) + '...' : thread.body}</p>
            </Link>
            <button onClick={(e) => { e.preventDefault(); handleReact(thread.id); }} style={{ background: '#fff3e0', color: '#e65100', border: '1px solid #ffcc80', minWidth: '70px', padding: '8px', fontSize: '0.9rem' }}>
              👋 {thread.reaction_count}
            </button>
          </div>
        </div>
      ))}

      {threads.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: '#999' }}>まだ投稿がありません。最初のブルシット・ジョブを投稿してみよう！</div>
      )}
    </div>
  );
}
