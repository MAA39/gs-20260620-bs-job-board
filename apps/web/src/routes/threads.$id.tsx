import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState, useEffect, useCallback } from 'react';
import type { ThreadDetail } from '@bs-job-board/contracts';

async function getApi() {
  try {
    const { env } = (await import('cloudflare:workers')) as { env: { API: { fetch: typeof fetch } } };
    return (url: string, init?: RequestInit) => env.API.fetch(`https://api${url}`, init);
  } catch {
    return (url: string, init?: RequestInit) => fetch(`http://localhost:8787${url}`, init);
  }
}

const fetchDetail = createServerFn({ method: 'GET' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const api = await getApi();
    const res = await api(`/api/v1/threads/${data.id}`);
    if (!res.ok) throw new Error('not found');
    return (await res.json()) as ThreadDetail;
  });

const addComment = createServerFn({ method: 'POST' })
  .validator((input: { threadId: string; body: string }) => input)
  .handler(async ({ data }) => {
    const api = await getApi();
    await api(`/api/v1/threads/${data.threadId}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author_type: 'human',
        author_name: '名無しさん',
        role: null,
        body: data.body,
      }),
    });
  });

export const Route = createFileRoute('/threads/$id')({
  loader: ({ params }) => fetchDetail({ data: { id: params.id } }),
  component: ThreadDetailPage,
});

function ThreadDetailPage() {
  const initialThread = Route.useLoaderData();
  const params = Route.useParams();
  const [thread, setThread] = useState(initialThread);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { setThread(initialThread); }, [initialThread]);

  useEffect(() => {
    const poll = setInterval(async () => {
      try { setThread(await fetchDetail({ data: { id: params.id } })); } catch {}
    }, 5000);
    return () => clearInterval(poll);
  }, [params.id]);

  const handleComment = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!comment.trim()) return;
    setSubmitting(true);
    try {
      await addComment({ data: { threadId: params.id, body: comment.trim() } });
      setComment('');
      setThread(await fetchDetail({ data: { id: params.id } }));
    } finally { setSubmitting(false); }
  }, [comment, params.id]);

  return (
    <div>
      <Link to="/" style={{ color: '#666', textDecoration: 'none', fontSize: '0.9rem' }}>← 一覧に戻る</Link>

      <div className="card" style={{ marginTop: '8px' }}>
        <h2>{thread.title}</h2>
        <p style={{ color: '#666', marginTop: '4px' }}>{thread.body}</p>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '16px 0 8px' }}>
        <h3>レス</h3>
        <span style={{ color: '#999', fontSize: '0.8rem' }}>{thread.posts.length}件 · 5秒で自動更新</span>
      </div>

      {thread.posts.map((post) => (
        <div key={post.id} className="post">
          <div className="post-header">
            <strong>#{post.post_number}</strong> {post.author_name}
          </div>
          <div style={{ marginTop: '6px', whiteSpace: 'pre-wrap' }}>{post.body}</div>
        </div>
      ))}

      <div className="card" style={{ marginTop: '16px' }}>
        <h3 style={{ marginBottom: '8px' }}>💬 レスする（AIも反応するよ）</h3>
        <form onSubmit={handleComment}>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="「うちもそう」「なんでそれ続いてるん？」..."
            required
            style={{ minHeight: '80px' }}
          />
          <button type="submit" disabled={submitting}>
            {submitting ? '投稿中...' : 'レスする'}
          </button>
        </form>
      </div>
    </div>
  );
}
