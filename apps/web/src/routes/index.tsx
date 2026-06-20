import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import type { Thread } from '@bs-job-board/contracts';

const fetchThreads = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    // Service Binding経由でAPI Workerを呼ぶ（CF Workers環境）
    const { env } = (await import('cloudflare:workers')) as { env: { API: { fetch: typeof fetch } } };
    const res = await env.API.fetch('https://api/api/v1/threads');
    if (!res.ok) return [] as Thread[];
    return (await res.json()) as Thread[];
  } catch {
    // ローカル開発時フォールバック
    try {
      const res = await fetch('http://localhost:8787/api/v1/threads');
      if (!res.ok) return [] as Thread[];
      return (await res.json()) as Thread[];
    } catch {
      return [] as Thread[];
    }
  }
});

export const Route = createFileRoute('/')({
  loader: () => fetchThreads(),
  component: HomePage,
});

function HomePage() {
  const threads = Route.useLoaderData();

  return (
    <div>
      <h2 style={{ marginBottom: '16px' }}>投稿一覧</h2>

      {threads.map((thread) => (
        <Link key={thread.id} to="/threads/$id" params={{ id: thread.id }} style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="card" style={{ cursor: 'pointer' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>{thread.title}</h3>
              <span className={`badge badge-${thread.status}`}>
                {thread.status === 'fixed' ? '✅ 整理完了' : '🔵 議論中'}
              </span>
            </div>
            <p style={{ color: '#666', marginTop: '4px', fontSize: '0.9rem' }}>
              {thread.body.length > 100 ? thread.body.slice(0, 100) + '...' : thread.body}
            </p>
          </div>
        </Link>
      ))}

      {threads.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: '#999' }}>
          まだ投稿がありません。
        </div>
      )}
    </div>
  );
}
