import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import type { ThreadDetail } from '@bs-job-board/contracts';

const fetchThreadDetail = createServerFn({ method: 'GET' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    try {
      const { env } = (await import('cloudflare:workers')) as { env: { API: { fetch: typeof fetch } } };
      const res = await env.API.fetch(`https://api/api/v1/threads/${data.id}`);
      if (!res.ok) throw new Error('not found');
      return (await res.json()) as ThreadDetail;
    } catch {
      const res = await fetch(`http://localhost:8787/api/v1/threads/${data.id}`);
      if (!res.ok) throw new Error('not found');
      return (await res.json()) as ThreadDetail;
    }
  });

export const Route = createFileRoute('/threads/$id')({
  loader: ({ params }) => fetchThreadDetail({ data: { id: params.id } }),
  component: ThreadDetailPage,
});

function ThreadDetailPage() {
  const thread = Route.useLoaderData();

  return (
    <div>
      <Link to="/" style={{ color: '#666', textDecoration: 'none', fontSize: '0.9rem' }}>← 一覧に戻る</Link>
      <div className="card" style={{ marginTop: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>{thread.title}</h2>
          <span className={`badge badge-${thread.status}`}>
            {thread.status === 'fixed' ? '✅ 整理完了' : '🔵 議論中'}
          </span>
        </div>
      </div>
      <h3 style={{ margin: '16px 0 8px' }}>レス一覧</h3>
      {thread.posts.map((post) => (
        <div key={post.id} className={`post ${post.author_type === 'ai' ? 'post-ai' : ''}`}>
          <div className="post-header">
            <strong>#{post.post_number}</strong>{' '}
            <span className={`badge badge-${post.author_type}`}>
              {post.author_type === 'ai' ? '🤖 AI' : '👤 人間'}
            </span>{' '}
            {post.author_name}
            {post.role && <span style={{ marginLeft: '8px', color: '#999' }}>({post.role})</span>}
          </div>
          <div style={{ marginTop: '8px', whiteSpace: 'pre-wrap' }}>{post.body}</div>
        </div>
      ))}
    </div>
  );
}
